import type { SyncClient } from './client';
import type { SyncState } from './state';
import { sha256hex } from './util';

function isSafeSyncPath(path: string, configDir: string): boolean {
  if (!path || path.length === 0) return false;
  if (path.startsWith('/')) return false;
  if (path.includes('..')) return false;
  if (path.startsWith(`${configDir}/`)) return false;
  // Conflict copies (.conflict.<timestamp>.md) are server-side artefacts for
  // conflict resolution. They must not be synced back to the client vault:
  // they would appear as real notes, trigger modify events, and in edge cases
  // create secondary push cycles. The server stores them; the client ignores them.
  if (/\.conflict\.\d{4}-\d{2}-\d{2}T[\d.-]+\.md$/.test(path)) return false;
  // eslint-disable-next-line no-control-regex -- deliberately matches control chars/null bytes to reject unsafe sync paths, not a mistake
  if (/[\x00-\x1f]/.test(path)) return false;
  return true;
}

export interface VaultAdapter {
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listAll(): Promise<string[]>;
}

// Circuit breaker for pull(): if a single batch would touch this fraction of
// already-known files (or more)...
const MASS_CHANGE_RATIO = 0.5;
// ...AND at least this many files, ask before applying. The absolute floor
// keeps small vaults from tripping the breaker on one ordinary delete (2
// known files, 1 deleted = 50%).
const MASS_CHANGE_MIN_AFFECTED = 5;

export class SyncEngine {
  constructor(
    private client: SyncClient,
    private vault: VaultAdapter,
    private state: SyncState,
    private onConflict: (path: string) => void,
    private configDir: string,
    // Called when a pull batch would delete/overwrite an unusually large
    // fraction of already-known files — e.g. a server-side bug reporting
    // most of the vault as deleted. Resolving false aborts the whole batch
    // (nothing applied, lastSyncTimestamp not advanced, so it's re-evaluated
    // next poll); resolving true applies it normally.
    private onMassChange: (affected: number, known: number) => Promise<boolean> = async () => true,
  ) {}

  async pull(): Promise<void> {
    const changes = await this.client.getChanges(this.state.lastSyncTimestamp);
    if (changes.length === 0) return;

    const known = Object.keys(this.state.files).length;
    const affected = new Set(
      changes
        .filter(c => c.action === 'deleted' || c.action === 'modified')
        .map(c => c.path)
        .filter(path => path in this.state.files),
    ).size;

    if (affected >= MASS_CHANGE_MIN_AFFECTED && affected / known >= MASS_CHANGE_RATIO) {
      const proceed = await this.onMassChange(affected, known);
      if (!proceed) return;
    }

    // Track the high-water mark from the server's `ts` field. We advance it even
    // past entries that fail below, so a single permanently-missing blob can't
    // wedge sync into re-pulling the whole changelog on every poll forever.
    let maxTs = this.state.lastSyncTimestamp;
    let failures = 0;

    for (const change of changes) {
      if (typeof change.ts === 'number' && change.ts > maxTs) maxTs = change.ts;

      if (!isSafeSyncPath(change.path, this.configDir)) {
        console.warn(`[vault-sync] pull: skipping unsafe path from server: ${change.path}`);
        continue;
      }

      // Isolate each entry: one bad file (missing blob, write failure) must not
      // abort the whole pull. Without this, sync dies with a generic error and
      // never tells you which file broke.
      try {
        if (change.action === 'deleted') {
          await this.vault.deleteFile(change.path).catch(() => {});
          await this.state.removeFileHash(change.path);
        } else {
          const data = await this.client.getFile(change.path);
          
          // Check if file was modified locally while we were fetching from server.
          // If it changed (user typed during the download), treat it as a conflict
          // rather than silently overwriting user's work with server data.
          const currentHash = this.state.files[change.path];
          if (currentHash) {
            try {
              const localData = await this.vault.readFile(change.path);
              const localHash = await sha256hex(localData);
              if (localHash !== currentHash) {
                // File changed locally while the server version was downloading.
                // Don't overwrite user's work, but DO advance our stored base hash to
                // the server's version. Without this, every future push sends the old
                // X-Base-Hash; the server conflicts every time and spawns a new
                // .conflict.* copy on each debounce cycle — an infinite storm.
                await this.state.setFileHash(change.path, change.hash);
                continue;
              }
            } catch {
              // File doesn't exist locally or read failed — safe to write
            }
          }
          
          await this.vault.writeFile(change.path, data);
          await this.state.setFileHash(change.path, change.hash);
        }
      } catch (e) {
        failures++;
        console.error(`[vault-sync] pull: failed on ${change.action} "${change.path}":`, e);
      }
    }

    if (failures > 0) {
      console.warn(`[vault-sync] pull: ${failures}/${changes.length} entries failed (see errors above)`);
    }
    await this.state.setLastSyncTimestamp(maxTs);
  }

  async push(path: string): Promise<void> {
    const data = await this.vault.readFile(path);
    const hash = await sha256hex(data);

    // Echo guard: if the file already matches what we last synced, this push
    // was triggered by our own pull write (writing a file fires Obsidian's
    // 'modify' event), not a real user edit. Pushing it would create a server
    // changelog entry → SSE → pull → write → 'modify' → push … an endless loop
    // that re-uploads every file on a cycle. Nothing changed; do nothing.
    if (this.state.files[path] === hash) return;

    const baseHash = this.state.files[path] ?? '';
    const result = await this.client.putFile(path, data, baseHash);
    if (result.conflict) {
      this.onConflict(path);
    } else {
      await this.state.setFileHash(path, hash);
    }
  }

  async pushDelete(path: string): Promise<void> {
    const baseHash = this.state.files[path] ?? '';
    await this.client.deleteFile(path, baseHash);
    await this.state.removeFileHash(path);
  }

  async initialSync(): Promise<void> {
    const changes = await this.client.getChanges(0);

    // Build server file set
    const serverFiles = new Map<string, string>(); // path → hash
    for (const c of changes) {
      if (c.action === 'modified') serverFiles.set(c.path, c.hash);
      else serverFiles.delete(c.path);
    }

    // Download server files (server wins on conflict)
    for (const [path, hash] of serverFiles) {
      try {
        const data = await this.client.getFile(path);
        await this.vault.writeFile(path, data);
        await this.state.setFileHash(path, hash);
      } catch (e) {
        console.error(`[vault-sync] initial sync: failed to download ${path}:`, e);
      }
    }

    // Upload local files not on server
    const localPaths = await this.vault.listAll();
    for (const path of localPaths) {
      if (serverFiles.has(path)) continue; // already handled above
      try {
        const data = await this.vault.readFile(path);
        await this.client.putFile(path, data, '');
        const hash = await sha256hex(data);
        await this.state.setFileHash(path, hash);
      } catch (e) {
        console.error(`[vault-sync] initial sync: failed to upload ${path}:`, e);
      }
    }

    await this.state.setLastSyncTimestamp(Math.floor(Date.now() / 1000));
  }
}
