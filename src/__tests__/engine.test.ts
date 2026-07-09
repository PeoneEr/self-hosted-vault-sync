import { SyncEngine, VaultAdapter } from '../engine';
import { SyncClient } from '../client';
import { createState, StateStorage } from '../state';
import { sha256hex } from '../util';

function makeVault(files: Record<string, string> = {}): jest.Mocked<VaultAdapter> {
  const store: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) {
    store[k] = new TextEncoder().encode(v);
  }
  return {
    readFile: jest.fn(async (path) => store[path]?.buffer as ArrayBuffer ?? new ArrayBuffer(0)),
    writeFile: jest.fn(async (path, data) => { store[path] = new Uint8Array(data); }),
    deleteFile: jest.fn(async (path) => { delete store[path]; }),
    listAll: jest.fn(async () => Object.keys(store)),
  };
}

function makeStorage(initial: any = {}): StateStorage {
  let data = { ...initial };
  return {
    load: jest.fn(async () => ({ ...data })),
    save: jest.fn(async (d) => { data = { ...d }; }),
  };
}

function makeClient(overrides: Partial<Record<keyof SyncClient, any>> = {}): SyncClient {
  return {
    getChanges: jest.fn(async () => []),
    getFile: jest.fn(async () => new ArrayBuffer(0)),
    putFile: jest.fn(async () => ({ conflict: false })),
    deleteFile: jest.fn(async () => {}),
    ...overrides,
  } as any;
}

test('pull: downloads modified files and updates state', async () => {
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  const content = new TextEncoder().encode('new content').buffer as ArrayBuffer;
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'notes/foo.md', hash: 'abc', ts: 200, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => content),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(client.getChanges).toHaveBeenCalledWith(0);
  expect(client.getFile).toHaveBeenCalledWith('notes/foo.md');
  expect(vault.writeFile).toHaveBeenCalledWith('notes/foo.md', content);
  expect(state.files['notes/foo.md']).toBe('abc');
});

test('pull: deletes files marked as deleted', async () => {
  const vault = makeVault({ 'old.md': 'content' });
  const state = await createState(makeStorage({ files: { 'old.md': 'hash' }, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'old.md', hash: '', ts: 300, action: 'deleted' as const },
    ]),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(vault.deleteFile).toHaveBeenCalledWith('old.md');
  expect(state.files['old.md']).toBeUndefined();
});

test('pull: silently skips server update when user modified locally', async () => {
  // Simulates user typing while pull is downloading: file changes between
  // the last sync and writeFile. Must not overwrite user's work.
  const originalContent = 'original text';
  const userContent = 'user typed this';
  const serverContent = 'server version';
  
  const originalData = new TextEncoder().encode(originalContent).buffer;
  const originalHash = await sha256hex(originalData);
  
  const vault = makeVault({ 'notes/race.md': userContent });
  const state = await createState(makeStorage({ 
    files: { 'notes/race.md': originalHash },
    lastSyncTimestamp: 100 
  }));
  
  const serverData = new TextEncoder().encode(serverContent).buffer;
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'notes/race.md', hash: 'server-hash', ts: 200, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => serverData),
  });

  const onConflict = jest.fn();
  const engine = new SyncEngine(client, vault, state, onConflict, '.obsidian');
  await engine.pull();

  // No conflict notification (silent skip), file NOT overwritten
  expect(onConflict).not.toHaveBeenCalled();
  expect(vault.writeFile).not.toHaveBeenCalled();
  
  // User's content preserved
  const finalContent = new TextDecoder().decode(await vault.readFile('notes/race.md'));
  expect(finalContent).toBe(userContent);
});

test('push: uploads file with correct base hash', async () => {
  const vault = makeVault({ 'notes/bar.md': 'hello' });
  const state = await createState(makeStorage({ files: { 'notes/bar.md': 'old-hash' }, lastSyncTimestamp: 0 }));
  const client = makeClient();

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.push('notes/bar.md');

  expect(client.putFile).toHaveBeenCalledWith(
    'notes/bar.md',
    expect.any(ArrayBuffer),
    'old-hash',
  );
});

test('push: skips when content matches last-synced hash (breaks pull→push echo loop)', async () => {
  // pull writes a file and records its hash in state. The resulting Obsidian
  // 'modify' event triggers a push — which must be a no-op, or every pulled
  // file gets re-uploaded, re-changelogged, and re-pulled forever.
  const content = 'identical bytes';
  const data = new TextEncoder().encode(content).buffer as ArrayBuffer;
  const hash = await sha256hex(data);
  const vault = makeVault({ 'a.md': content });
  const state = await createState(makeStorage({ files: { 'a.md': hash }, lastSyncTimestamp: 0 }));
  const client = makeClient();

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.push('a.md');

  expect(client.putFile).not.toHaveBeenCalled();
});

test('push: still uploads when content actually changed', async () => {
  const vault = makeVault({ 'a.md': 'new content' });
  // state holds a stale hash that won't match the current bytes
  const state = await createState(makeStorage({ files: { 'a.md': 'stale-hash' }, lastSyncTimestamp: 0 }));
  const client = makeClient();

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.push('a.md');

  expect(client.putFile).toHaveBeenCalledTimes(1);
});

test('push: notifies on conflict', async () => {
  const vault = makeVault({ 'notes/foo.md': 'local' });
  const state = await createState(makeStorage({ files: { 'notes/foo.md': 'stale' }, lastSyncTimestamp: 0 }));
  const client = makeClient({ putFile: jest.fn(async () => ({ conflict: true })) });

  const onConflict = jest.fn();
  const engine = new SyncEngine(client, vault, state, onConflict, '.obsidian');
  await engine.push('notes/foo.md');

  expect(onConflict).toHaveBeenCalledWith('notes/foo.md');
});

test('initialSync: uploads all when server is empty', async () => {
  const vault = makeVault({ 'notes/a.md': 'content', 'notes/b.md': 'more' });
  const state = await createState(makeStorage({}));
  const client = makeClient({ getChanges: jest.fn(async () => []) });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.initialSync();

  expect(client.putFile).toHaveBeenCalledTimes(2);
});

test('initialSync: server wins — overwrites local files', async () => {
  const vault = makeVault({ 'notes/a.md': 'old local content' });
  const state = await createState(makeStorage({}));
  const serverContent = new TextEncoder().encode('server content').buffer as ArrayBuffer;
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'notes/a.md', hash: 'server-hash', ts: 1, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => serverContent),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.initialSync();

  expect(vault.writeFile).toHaveBeenCalledWith('notes/a.md', serverContent);
  expect(state.files['notes/a.md']).toBe('server-hash');
});

test('pull: advances lastSyncTimestamp to max server ts (never NaN)', async () => {
  // The server emits `ts`, not `mtime`. Using the wrong field yields NaN,
  // which collapses lastSyncTimestamp to 0 and re-pulls the whole changelog
  // on every poll.
  const vault = makeVault({});
  const state = await createState(makeStorage({ lastSyncTimestamp: 100 }));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'a.md', hash: 'h1', ts: 200, action: 'modified' as const },
      { path: 'b.md', hash: 'h2', ts: 350, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => new ArrayBuffer(0)),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(Number.isNaN(state.lastSyncTimestamp)).toBe(false);
  expect(state.lastSyncTimestamp).toBe(350);
});

test('pull: one failing file does not abort the whole pull', async () => {
  const vault = makeVault({});
  const state = await createState(makeStorage({ lastSyncTimestamp: 0 }));
  const good = new TextEncoder().encode('ok').buffer as ArrayBuffer;
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'bad.md', hash: 'hb', ts: 10, action: 'modified' as const },
      { path: 'good.md', hash: 'hg', ts: 20, action: 'modified' as const },
    ]),
    getFile: jest.fn(async (path: string) => {
      if (path === 'bad.md') throw new Error('getFile failed: 404');
      return good;
    }),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await expect(engine.pull()).resolves.toBeUndefined();

  // The healthy file is still written, and the broken one is skipped — not fatal.
  expect(vault.writeFile).toHaveBeenCalledWith('good.md', good);
  expect(state.files['good.md']).toBe('hg');
  expect(state.files['bad.md']).toBeUndefined();
  // Timestamp advances so a permanently-missing blob doesn't wedge sync forever.
  expect(state.lastSyncTimestamp).toBe(20);
});

test('pull: skips unsafe paths from server', async () => {
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: '.obsidian/community-plugins.json', hash: 'h', ts: 1, action: 'modified' as const },
      { path: '../escape.md', hash: 'h2', ts: 2, action: 'modified' as const },
      { path: 'safe/note.md', hash: 'h3', ts: 3, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => new TextEncoder().encode('content').buffer as ArrayBuffer),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  // Only safe/note.md should be written
  expect(vault.writeFile).toHaveBeenCalledTimes(1);
  expect(vault.writeFile).toHaveBeenCalledWith('safe/note.md', expect.any(ArrayBuffer));
  expect(vault.writeFile).not.toHaveBeenCalledWith('.obsidian/community-plugins.json', expect.anything());
});

test('pull: torn-write skip advances state to server hash (prevents conflict storm)', async () => {
  // Scenario: server has H1, client state tracks H0, user edits to H_user during download.
  // The skip must record H1 (server hash) in state so the next push sends
  // X-Base-Hash: H1 (correct), not H0 (stale — causes infinite conflict storm).
  const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

  const originalContent = 'original text';
  const originalData = enc(originalContent);
  const originalHash = await sha256hex(originalData);

  const serverContent = 'server version v2';
  const serverData = enc(serverContent);
  const serverHash = await sha256hex(serverData);

  // Vault has the user's in-progress version (different from both original and server)
  const vault = makeVault({ 'notes/daily.md': 'user edits in flight' });
  // State tracks the original hash (last successful sync — pre-edit)
  const state = await createState(makeStorage({
    files: { 'notes/daily.md': originalHash },
    lastSyncTimestamp: 0,
  }));

  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'notes/daily.md', hash: serverHash, ts: 100, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => serverData),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  // Server write must be skipped — user's content preserved
  expect(vault.writeFile).not.toHaveBeenCalled();
  // Base hash MUST advance to server hash so the next push sends the correct X-Base-Hash
  expect(state.files['notes/daily.md']).toBe(serverHash);
});

test('pull: mass-change guard blocks a batch deleting >=50% of known files when declined', async () => {
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`note${i}.md`, 'content']));
  const knownFiles = Object.fromEntries(Object.keys(files).map(p => [p, 'hash']));
  const vault = makeVault(files);
  const state = await createState(makeStorage({ files: knownFiles, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => Array.from({ length: 6 }, (_, i) => (
      { path: `note${i}.md`, hash: '', ts: 10 + i, action: 'deleted' as const }
    ))),
  });

  const onMassChange = jest.fn(async () => false);
  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', onMassChange);
  await engine.pull();

  expect(onMassChange).toHaveBeenCalledWith(6, 10);
  expect(vault.deleteFile).not.toHaveBeenCalled();
  expect(state.lastSyncTimestamp).toBe(0);
  expect(Object.keys(state.files)).toHaveLength(10);
});

test('pull: mass-change guard applies the batch normally when approved', async () => {
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`note${i}.md`, 'content']));
  const knownFiles = Object.fromEntries(Object.keys(files).map(p => [p, 'hash']));
  const vault = makeVault(files);
  const state = await createState(makeStorage({ files: knownFiles, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => Array.from({ length: 6 }, (_, i) => (
      { path: `note${i}.md`, hash: '', ts: 10 + i, action: 'deleted' as const }
    ))),
  });

  const onMassChange = jest.fn(async () => true);
  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', onMassChange);
  await engine.pull();

  expect(onMassChange).toHaveBeenCalledWith(6, 10);
  expect(vault.deleteFile).toHaveBeenCalledTimes(6);
  expect(state.lastSyncTimestamp).toBe(15);
});

test('pull: mass-change guard does not fire under the absolute floor even at high ratio', async () => {
  // 2 known files, both deleted = 100% but under MASS_CHANGE_MIN_AFFECTED (5).
  const vault = makeVault({ 'a.md': 'x', 'b.md': 'y' });
  const state = await createState(makeStorage({ files: { 'a.md': 'ha', 'b.md': 'hb' }, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'a.md', hash: '', ts: 1, action: 'deleted' as const },
      { path: 'b.md', hash: '', ts: 2, action: 'deleted' as const },
    ]),
  });

  const onMassChange = jest.fn(async () => false);
  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', onMassChange);
  await engine.pull();

  expect(onMassChange).not.toHaveBeenCalled();
  expect(vault.deleteFile).toHaveBeenCalledTimes(2);
});

test('pull: mass-change guard does not fire under the ratio even with many known files', async () => {
  // 10 known files, 4 deleted = 40%, under the 50% ratio (even though 4 < floor too,
  // this asserts the ratio math itself, not just the floor).
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`note${i}.md`, 'content']));
  const knownFiles = Object.fromEntries(Object.keys(files).map(p => [p, 'hash']));
  const vault = makeVault(files);
  const state = await createState(makeStorage({ files: knownFiles, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => Array.from({ length: 4 }, (_, i) => (
      { path: `note${i}.md`, hash: '', ts: 10 + i, action: 'deleted' as const }
    ))),
  });

  const onMassChange = jest.fn(async () => false);
  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', onMassChange);
  await engine.pull();

  expect(onMassChange).not.toHaveBeenCalled();
  expect(vault.deleteFile).toHaveBeenCalledTimes(4);
});

test('pull: default onMassChange (unset) applies batches normally', async () => {
  // No 6th arg passed — matches every pre-existing call site in this file.
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`note${i}.md`, 'content']));
  const knownFiles = Object.fromEntries(Object.keys(files).map(p => [p, 'hash']));
  const vault = makeVault(files);
  const state = await createState(makeStorage({ files: knownFiles, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => Array.from({ length: 6 }, (_, i) => (
      { path: `note${i}.md`, hash: '', ts: 10 + i, action: 'deleted' as const }
    ))),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(vault.deleteFile).toHaveBeenCalledTimes(6);
});

test('pull: conflict files from server are not written to vault', async () => {
  // Conflict copies (.conflict.<ts>.md) are server-side artefacts; they must not
  // land in the client vault as real notes or trigger modify events.
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      {
        path: 'Daily notes/🗓️ 2026-06-23.conflict.2026-06-23T12-09-01.000000000.md',
        hash: 'ch1',
        ts: 10,
        action: 'modified' as const,
      },
      { path: 'Daily notes/🗓️ 2026-06-23.md', hash: 'h1', ts: 11, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => new TextEncoder().encode('content').buffer as ArrayBuffer),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  // Conflict file must be silently skipped; only the canonical note is written
  expect(vault.writeFile).toHaveBeenCalledTimes(1);
  expect(vault.writeFile).toHaveBeenCalledWith('Daily notes/🗓️ 2026-06-23.md', expect.any(ArrayBuffer));
  expect(vault.writeFile).not.toHaveBeenCalledWith(
    expect.stringContaining('.conflict.'), expect.anything(),
  );
});
