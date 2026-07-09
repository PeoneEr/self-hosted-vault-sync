import { writeFileResilient, ensureFolder, MinimalVault } from '../vaultio';

// Fake adapter backed by a flat path set, modelling Obsidian's DataAdapter.
// `mkdirThrowsOnExisting` reproduces the platforms where mkdir on an existing
// folder rejects with "already exists" instead of being a silent no-op.
function makeFakeVault(opts: { mkdirThrowsOnExisting?: boolean } = {}) {
  const dirs = new Set<string>();
  const files = new Map<string, Uint8Array>();
  const vault: MinimalVault & { _dirs: Set<string>; _files: Map<string, Uint8Array> } = {
    _dirs: dirs,
    _files: files,
    adapter: {
      exists: jest.fn(async (p: string) => dirs.has(p) || files.has(p)),
      mkdir: jest.fn(async (p: string) => {
        if (dirs.has(p) && opts.mkdirThrowsOnExisting) throw new Error('Folder already exists.');
        dirs.add(p);
      }),
      writeBinary: jest.fn(async (p: string, data: ArrayBuffer) => {
        files.set(p, new Uint8Array(data));
      }),
    },
  };
  return vault;
}

const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

test('writeFileResilient: creates missing parent folders then writes', async () => {
  const vault = makeFakeVault();
  await writeFileResilient(vault, 'wiki/meta/a.md', buf('A'));
  expect(vault._dirs.has('wiki')).toBe(true);
  expect(vault._dirs.has('wiki/meta')).toBe(true);
  expect(new TextDecoder().decode(vault._files.get('wiki/meta/a.md'))).toBe('A');
});

test('writeFileResilient: sequential files in same folder do not double-create or throw', async () => {
  // mkdir would throw on the already-existing folder for the 2nd file — must be tolerated.
  const vault = makeFakeVault({ mkdirThrowsOnExisting: true });
  await expect(writeFileResilient(vault, 'wiki/meta/a.md', buf('A'))).resolves.toBeUndefined();
  await expect(writeFileResilient(vault, 'wiki/meta/b.md', buf('B'))).resolves.toBeUndefined();
  expect(vault._files.has('wiki/meta/a.md')).toBe(true);
  expect(vault._files.has('wiki/meta/b.md')).toBe(true);
  // wiki + wiki/meta created exactly once each (exists() guards the rest).
  expect(vault.adapter.mkdir).toHaveBeenCalledTimes(2);
});

test('writeFileResilient: overwrites an existing file unconditionally', async () => {
  const vault = makeFakeVault();
  vault._files.set('note.md', new Uint8Array());
  await writeFileResilient(vault, 'note.md', buf('hello'));
  expect(new TextDecoder().decode(vault._files.get('note.md'))).toBe('hello');
});

test('writeFileResilient: top-level file needs no folder creation', async () => {
  const vault = makeFakeVault();
  await writeFileResilient(vault, 'root.md', buf('r'));
  expect(vault.adapter.mkdir).not.toHaveBeenCalled();
  expect(vault._files.has('root.md')).toBe(true);
});

test('ensureFolder: rethrows non-"already exists" errors', async () => {
  const vault = makeFakeVault();
  (vault.adapter.mkdir as jest.Mock).mockRejectedValueOnce(new Error('EACCES: permission denied'));
  await expect(ensureFolder(vault, 'locked')).rejects.toThrow('EACCES');
});
