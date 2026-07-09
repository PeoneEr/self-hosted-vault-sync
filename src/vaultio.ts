// Resilient vault writes that bypass Obsidian's metadata cache.
//
// At plugin startup the in-memory cache (getFolderByPath / getFileByPath) is
// populated asynchronously and lags the filesystem: it reports "not found" for
// paths that already exist on disk, and the Vault-API createFolder/createBinary
// then throw "already exists". A cold-start pull writing many files into the
// same folder hits this constantly — it's what produced "Folder already exists"
// mid-pull.
//
// We write through vault.adapter, which talks to disk directly and is immune to
// cache lag: mkdir is idempotent-ish (we create parents progressively and treat
// "already exists" as success), and writeBinary overwrites unconditionally so
// there's no create-vs-modify decision to get wrong. Obsidian's file watcher
// reconciles its cache afterwards.

export interface VaultAdapterIO {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

export interface MinimalVault {
  adapter: VaultAdapterIO;
}

function isAlreadyExists(e: unknown): boolean {
  return e instanceof Error && /already exists/i.test(e.message);
}

// ensureFolder creates `dir` and any missing parents. Existing segments are
// skipped; a concurrent/cache-lagged "already exists" is treated as success.
export async function ensureFolder(vault: MinimalVault, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (await vault.adapter.exists(cur)) continue;
    try {
      await vault.adapter.mkdir(cur);
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
  }
}

export async function writeFileResilient(
  vault: MinimalVault,
  path: string,
  data: ArrayBuffer,
): Promise<void> {
  const dir = path.split('/').slice(0, -1).join('/');
  await ensureFolder(vault, dir);
  await vault.adapter.writeBinary(path, data);
}
