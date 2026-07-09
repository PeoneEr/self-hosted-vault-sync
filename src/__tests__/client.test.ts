import { SyncClient, Change } from '../client';
import { requestUrl } from 'obsidian';

function mockRequestUrl(responses: Array<{ status: number; body?: any; headers?: Record<string, string> }>) {
  let i = 0;
  (requestUrl as jest.Mock).mockClear();
  (requestUrl as jest.Mock).mockImplementation(async () => {
    const r = responses[i++];
    return {
      status: r.status,
      headers: r.headers ?? {},
      json: r.body,
      arrayBuffer: new TextEncoder().encode(String(r.body ?? '')).buffer as ArrayBuffer,
      text: String(r.body ?? ''),
    };
  });
}

const client = new SyncClient('http://localhost:8080', 'test-token');

test('getChanges returns parsed entries', async () => {
  const changes: Change[] = [
    { path: 'a.md', hash: 'h1', ts: 100, action: 'modified' },
  ];
  mockRequestUrl([{ status: 200, body: changes }]);
  const result = await client.getChanges(0);
  expect(result).toEqual(changes);
  const params = (requestUrl as jest.Mock).mock.calls[0][0];
  expect(params.url).toContain('/changes?since=0');
});

test('getFile returns ArrayBuffer', async () => {
  mockRequestUrl([{ status: 200, body: 'file content' }]);
  const buf = await client.getFile('notes/foo.md');
  expect(new TextDecoder().decode(buf)).toBe('file content');
});

test('putFile sends correct headers', async () => {
  mockRequestUrl([{ status: 200, headers: { 'x-conflict': 'false' } }]);
  const result = await client.putFile('notes/foo.md', new TextEncoder().encode('hello').buffer as ArrayBuffer, 'base-hash');
  expect(result.conflict).toBe(false);
  const params = (requestUrl as jest.Mock).mock.calls[0][0];
  expect(params.headers['X-Base-Hash']).toBe('base-hash');
  expect(params.method).toBe('PUT');
});

test('putFile detects conflict', async () => {
  mockRequestUrl([{ status: 200, headers: { 'x-conflict': 'true' } }]);
  const result = await client.putFile('notes/foo.md', new TextEncoder().encode('v2').buffer as ArrayBuffer, 'stale');
  expect(result.conflict).toBe(true);
});

test('deleteFile sends base hash', async () => {
  mockRequestUrl([{ status: 200 }]);
  await client.deleteFile('notes/foo.md', 'hash-abc');
  const params = (requestUrl as jest.Mock).mock.calls[0][0];
  expect(params.headers['X-Base-Hash']).toBe('hash-abc');
  expect(params.method).toBe('DELETE');
});

test('deleteFile accepts 404 without throwing', async () => {
  mockRequestUrl([{ status: 404 }]);
  await expect(client.deleteFile('notes/gone.md', 'h')).resolves.toBeUndefined();
});
