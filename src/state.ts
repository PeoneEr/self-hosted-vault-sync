export interface SyncState {
  lastSyncTimestamp: number;
  files: Record<string, string>;
  setFileHash(path: string, hash: string): Promise<void>;
  removeFileHash(path: string): Promise<void>;
  setLastSyncTimestamp(ts: number): Promise<void>;
}

// The on-disk shape of what StateStorage persists — separate from SyncState
// itself, which also carries the mutator methods below.
export interface PersistedSyncState {
  lastSyncTimestamp?: number;
  files?: Record<string, string>;
}

export interface StateStorage {
  load(): Promise<PersistedSyncState | undefined>;
  save(data: PersistedSyncState): Promise<void>;
}

export async function createState(storage: StateStorage): Promise<SyncState> {
  const raw = await storage.load();
  const state: SyncState = {
    lastSyncTimestamp: raw?.lastSyncTimestamp ?? 0,
    files: raw?.files ?? {},
    async setFileHash(path, hash) {
      state.files[path] = hash;
      await storage.save({ lastSyncTimestamp: state.lastSyncTimestamp, files: state.files });
    },
    async removeFileHash(path) {
      delete state.files[path];
      await storage.save({ lastSyncTimestamp: state.lastSyncTimestamp, files: state.files });
    },
    async setLastSyncTimestamp(ts) {
      state.lastSyncTimestamp = ts;
      await storage.save({ lastSyncTimestamp: state.lastSyncTimestamp, files: state.files });
    },
  };
  return state;
}
