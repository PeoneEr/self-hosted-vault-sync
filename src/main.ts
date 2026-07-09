import { Notice, ObsidianProtocolData, Platform, Plugin, TFile } from 'obsidian';
import { SyncSettings, SyncSettingTab, DEFAULT_SETTINGS, defaultExcludePatterns } from './settings';
import { createState, PersistedSyncState, StateStorage } from './state';
import { SyncClient } from './client';
import { SyncEngine, VaultAdapter } from './engine';
import { SSEClient } from './sse';
import { writeFileResilient } from './vaultio';
import { PairingClient, PairResult, PAIRING_PROTOCOL_ACTION, parsePairingParams } from './pairing';
import { errorMessage } from './errors';
import { OnboardingModal } from './onboardingWizard';
import { MassChangeModal } from './massChangeModal';

// The full shape of what this plugin persists via loadData()/saveData() —
// settings fields plus the sync engine's own state, stored together under
// one JSON blob (Obsidian's plugin data.json). Typing this boundary
// explicitly (instead of leaving loadData()'s `any` to propagate) is what
// lets everything downstream — settings fields, syncState — stay fully typed.
interface PluginData {
  serverUrl?: string;
  authToken?: string;
  syncInterval?: number;
  exclude?: string[];
  syncState?: PersistedSyncState;
}

export default class VaultSyncPlugin extends Plugin {
  settings!: SyncSettings;
  private engine!: SyncEngine;
  private sseClient!: SSEClient;
  private statusBarItem!: HTMLElement;
  private pollIntervalId?: number;
  private listenersRegistered = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SyncSettingTab(this.app, this));

    this.statusBarItem = this.addStatusBarItem();
    this.setStatus('idle');

    this.registerObsidianProtocolHandler(PAIRING_PROTOCOL_ACTION, this.handlePairingUri.bind(this));

    if (!this.settings.serverUrl || !this.settings.authToken) {
      new OnboardingModal(this.app, this).open();
      return;
    }
    await this.initEngine();

    // Defer the first pull until the workspace is ready. Pulling during onload
    // both blocks startup (a full pull can write hundreds of files) and races
    // Obsidian's not-yet-populated file/folder cache. onLayoutReady fires once
    // the vault is indexed, so file writes land cleanly and startup stays fast.
    this.app.workspace.onLayoutReady(() => this.startSyncLoop());
  }

  onunload(): void {
    window.clearInterval(this.pollIntervalId);
    this.sseClient?.disconnect();
  }

  async saveSettings(): Promise<void> {
    const cur = ((await this.loadData()) as PluginData | undefined) ?? {};
    await this.saveData({ ...cur, ...this.settings });
  }

  async runInitialSync(): Promise<void> {
    if (!this.engine) await this.initEngine();
    this.setStatus('syncing');
    try {
      await this.engine.initialSync();
      this.setStatus('synced');
      new Notice('Initial sync complete');
    } catch (e) {
      this.setStatus('error');
      new Notice(`Initial sync failed: ${errorMessage(e)}`);
    }
  }

  /** Issues a new device token from the currently configured server. Called by the settings tab's "Pair new device" action. */
  async pairNewDevice(label: string): Promise<PairResult> {
    const client = new PairingClient(this.settings.serverUrl, this.settings.authToken);
    return client.pair(label);
  }

  /**
   * Handles an obsidian://self-hosted-vault-sync pairing link. This is how an
   * unconfigured device (no serverUrl/authToken yet) gets set up: scanning the
   * QR from an already-paired device opens Obsidian and lands here with no
   * manual field entry required. Runs a full initialSync (not just a pull) so
   * that a device which already has local-only notes — e.g. created before
   * pairing — gets them uploaded, not just server files downloaded.
   */
  private async handlePairingUri(params: ObsidianProtocolData): Promise<void> {
    const parsed = parsePairingParams(params);
    if (!parsed) {
      new Notice('Invalid pairing link');
      return;
    }
    await this.connectToServer(parsed.server, parsed.token);
  }

  /**
   * Applies a server/token pair and brings the sync engine up from a cold
   * start: save settings, (re)build the engine and SSE client against the
   * new server, run a full initial sync, then start the poll/SSE loop.
   * Shared by the obsidian:// protocol handler (handlePairingUri) and the
   * onboarding wizard's manual-entry and paste-link steps, so there's one
   * place that defines what "connected" means.
   */
  async connectToServer(serverUrl: string, authToken: string): Promise<void> {
    this.settings.serverUrl = serverUrl;
    this.settings.authToken = authToken;
    await this.saveSettings();
    new Notice('Paired — starting sync');
    await this.initEngine();
    await this.runInitialSync();
    await this.startSyncLoop();
  }

  /**
   * Starts pulling, attaches file-change listeners, and starts the poll/SSE loop.
   * Called once the vault is ready to receive writes — either at startup
   * (onLayoutReady) or right after a fresh pairing (handlePairingUri), so this
   * must be safe to call more than once in one session:
   *
   * - File-change listeners and the visibility listener read `this.engine`
   *   fresh on every event (never captured at registration time), so they
   *   stay correct across a re-pair without needing to be re-attached —
   *   `listenersRegistered` guards them so re-pairing doesn't stack a second
   *   set of listeners on top of the first.
   * - The poll timer and SSE connection are NOT guarded: `initEngine` builds
   *   a brand-new `SyncEngine`/`SSEClient` bound to the (possibly new)
   *   server/token, so the timer is unconditionally cleared and restarted and
   *   `connect()` is called on the current `sseClient` every time, ensuring a
   *   re-pair actually starts talking to the new server. `initEngine`
   *   disconnects the previous `sseClient` before replacing it, so no
   *   connection is leaked.
   */
  private async startSyncLoop(): Promise<void> {
    // Run the first pull to completion BEFORE attaching file listeners.
    // Pull writes via the adapter, which fires Obsidian 'create'/'modify'
    // events; if listeners were already live they'd push every pulled file
    // straight back. The per-file echo guard in push() also covers this, but
    // ordering avoids a pointless burst of no-op pushes at startup.
    await this.runPull();

    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      this.registerEvent(this.app.vault.on('modify', this.onFileModify.bind(this)));
      this.registerEvent(this.app.vault.on('create', this.onFileModify.bind(this)));
      this.registerEvent(this.app.vault.on('delete', this.onFileDelete.bind(this)));

      if (Platform.isMobile) {
        this.registerDomEvent(activeDocument, 'visibilitychange', () => {
          if (activeDocument.visibilityState === 'visible') this.runPull().catch(console.error);
        });
      }
    }

    window.clearInterval(this.pollIntervalId);
    this.pollIntervalId = window.setInterval(
      () => { this.runPull().catch(console.error); },
      this.settings.syncInterval * 1000,
    );

    if (!Platform.isMobile) {
      this.sseClient.connect();
    }
  }

  private async initEngine(): Promise<void> {
    // Tear down any previously-connected SSE client before replacing it —
    // otherwise re-pairing to a different server (see startSyncLoop) leaks a
    // live connection to the old one.
    this.sseClient?.disconnect();

    const storage: StateStorage = {
      load: async () => {
        const d = (await this.loadData()) as PluginData | undefined;
        return d?.syncState;
      },
      save: async (d: PersistedSyncState) => {
        const cur = ((await this.loadData()) as PluginData | undefined) ?? {};
        await this.saveData({ ...cur, syncState: d });
      },
    };
    const state = await createState(storage);
    const client = new SyncClient(this.settings.serverUrl, this.settings.authToken);
    const vault = this.makeVaultAdapter();

    this.engine = new SyncEngine(client, vault, state, (path) => {
      new Notice(`Sync conflict: ${path}`);
      this.setStatus('conflict');
    }, this.app.vault.configDir, (affected, known) => {
      return new MassChangeModal(this.app, affected, known).waitForChoice();
    });

    this.sseClient = new SSEClient(
      this.settings.serverUrl,
      this.settings.authToken,
      (_path, _action) => { this.runPull().catch(console.error); },
      () => { /* SSE disconnected — fall back to polling */ },
    );
  }

  private makeVaultAdapter(): VaultAdapter {
    const vault = this.app.vault;

    return {
      readFile: async (path) => {
        // getAbstractFileByPath (not the newer getFileByPath, which needs
        // Obsidian 1.5.7+) for compatibility with older mobile builds that
        // can't be updated past ~1.12.x.
        const file = vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        return vault.readBinary(file);
      },
      writeFile: async (path, data) => {
        // Write through the adapter to dodge Obsidian's startup cache lag
        // (otherwise sequential writes into one folder throw "already exists").
        // No cast needed: Vault's real `adapter` (DataAdapter) already
        // structurally satisfies MinimalVault's narrower shape.
        await writeFileResilient(vault, path, data);
      },
      deleteFile: async (path) => {
        const file = vault.getAbstractFileByPath(path);
        // vault.trash (not the newer FileManager.trashFile, which needs
        // Obsidian 1.6.6+) for the same older-mobile-build reason. `false`
        // sends it to Obsidian's own .trash rather than the OS trash — a
        // fixed choice instead of trashFile's "respect the user's system
        // vs. Obsidian trash preference", but still recoverable, not a
        // permanent delete.
        // (see eslint.config.js for the corresponding rule override)
        if (file instanceof TFile) await vault.trash(file, false);
      },
      listAll: async () => {
        return vault.getFiles()
          .map((f: TFile) => f.path)
          .filter((p: string) => !this.isExcluded(p));
      },
    };
  }

  private debounceMap = new Map<string, number>();

  private onFileModify(file: { path: string }): void {
    if (this.isExcluded(file.path)) return;
    window.clearTimeout(this.debounceMap.get(file.path));
    this.debounceMap.set(file.path, window.setTimeout(() => {
      this.runPush(file.path).catch(console.error);
    }, 2000));
  }

  private onFileDelete(file: { path: string }): void {
    if (this.isExcluded(file.path)) return;
    // Cancel pending push debounce for this file
    const pending = this.debounceMap.get(file.path);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      this.debounceMap.delete(file.path);
    }
    this.engine?.pushDelete(file.path).catch(console.error);
  }

  private async runPull(): Promise<void> {
    if (!this.engine) return;
    this.setStatus('syncing');
    try {
      await this.engine.pull();
      this.setStatus('synced');
    } catch (e) {
      this.setStatus('error');
      console.error('Vault sync pull error:', e);
    }
  }

  private async runPush(path: string): Promise<void> {
    if (!this.engine) return;
    this.setStatus('syncing');
    try {
      await this.engine.push(path);
      this.setStatus('synced');
    } catch (e) {
      this.setStatus('error');
      console.error(`Sync push error (${path}):`, e);
    }
  }

  private isExcluded(path: string): boolean {
    return this.settings.exclude.some(pat => matchGlob(pat, path));
  }

  private setStatus(status: 'idle' | 'syncing' | 'synced' | 'error' | 'conflict'): void {
    const icons: Record<string, string> = {
      idle: '↕ idle',
      syncing: '↕ syncing…',
      synced: '↕ synced',
      error: '✗ sync error',
      conflict: '⚠ conflict',
    };
    this.statusBarItem.setText(icons[status]);
  }

  private async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) as PluginData | undefined) ?? {};
    this.settings = {
      serverUrl: data.serverUrl ?? DEFAULT_SETTINGS.serverUrl,
      authToken: data.authToken ?? DEFAULT_SETTINGS.authToken,
      syncInterval: data.syncInterval ?? DEFAULT_SETTINGS.syncInterval,
      exclude: data.exclude ?? defaultExcludePatterns(this.app.vault.configDir),
    };
  }
}

function matchGlob(pattern: string, path: string): boolean {
  const regex = new RegExp(
    '^' +
    pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.*')       // ** matches across path separators
      .replace(/(?<!\.\*)\*/g, '[^/]*')  // single * matches within one segment
    + '$'
  );
  return regex.test(path);
}
