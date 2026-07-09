import { PairingClient, HttpError, buildPairingUri, parsePairingParams, parsePastedPairingLink, PAIRING_PROTOCOL_ACTION } from '../pairing';
import { requestUrl } from 'obsidian';

function mockRequestUrl(responses: Array<{ status: number; body?: any }>) {
  let i = 0;
  (requestUrl as jest.Mock).mockClear();
  (requestUrl as jest.Mock).mockImplementation(async () => {
    const r = responses[i++];
    return {
      status: r.status,
      headers: {},
      json: r.body,
    };
  });
}

const client = new PairingClient('http://localhost:8080', 'test-token');

test('pair sends label and returns id/token', async () => {
  mockRequestUrl([{ status: 200, body: { id: 'dev_ab12', token: 'newtoken' } }]);
  const result = await client.pair('phone');
  expect(result).toEqual({ id: 'dev_ab12', token: 'newtoken' });

  const params = (requestUrl as jest.Mock).mock.calls[0][0];
  expect(params.url).toBe('http://localhost:8080/pair');
  expect(params.method).toBe('POST');
  expect(JSON.parse(params.body)).toEqual({ label: 'phone' });
  expect(params.headers.Authorization).toBe('Bearer test-token');
});

test('pair throws on non-ok response', async () => {
  mockRequestUrl([{ status: 401 }]);
  await expect(client.pair('phone')).rejects.toThrow('pair failed: 401');
});

test('listDevices returns parsed devices', async () => {
  const devices = [{ id: 'dev_1', label: 'desktop', createdAt: 't1', lastSeenAt: 't2' }];
  mockRequestUrl([{ status: 200, body: devices }]);
  const result = await client.listDevices();
  expect(result).toEqual(devices);
});

test('revokeDevice sends DELETE to the right path', async () => {
  mockRequestUrl([{ status: 200 }]);
  await client.revokeDevice('dev_ab12');
  const params = (requestUrl as jest.Mock).mock.calls[0][0];
  expect(params.url).toBe('http://localhost:8080/devices/dev_ab12');
  expect(params.method).toBe('DELETE');
});

test('revokeDevice throws on non-ok response', async () => {
  mockRequestUrl([{ status: 404 }]);
  await expect(client.revokeDevice('dev_missing')).rejects.toThrow('revokeDevice failed: 404');
});

test('buildPairingUri encodes server, token, and label', () => {
  const uri = buildPairingUri('https://sync.example.com', 'abc123', 'my phone');
  expect(uri.startsWith(`obsidian://${PAIRING_PROTOCOL_ACTION}?`)).toBe(true);
  const params = new URL(uri.replace('obsidian://', 'https://x/')).searchParams;
  expect(params.get('server')).toBe('https://sync.example.com');
  expect(params.get('token')).toBe('abc123');
  expect(params.get('label')).toBe('my phone');
});

test('parsePairingParams returns server/token/label when present', () => {
  const result = parsePairingParams({ server: 'https://sync.example.com', token: 'abc123', label: 'phone' });
  expect(result).toEqual({ server: 'https://sync.example.com', token: 'abc123', label: 'phone' });
});

test('parsePairingParams tolerates a missing label', () => {
  const result = parsePairingParams({ server: 'https://sync.example.com', token: 'abc123' });
  expect(result).toEqual({ server: 'https://sync.example.com', token: 'abc123', label: undefined });
});

test('parsePairingParams returns null when server or token is missing', () => {
  expect(parsePairingParams({ token: 'abc123' })).toBeNull();
  expect(parsePairingParams({ server: 'https://sync.example.com' })).toBeNull();
  expect(parsePairingParams({})).toBeNull();
});

test('parsePastedPairingLink parses a full obsidian:// pairing link', () => {
  const uri = buildPairingUri('https://sync.example.com', 'abc123', 'my phone');
  const result = parsePastedPairingLink(uri);
  expect(result).toEqual({ server: 'https://sync.example.com', token: 'abc123', label: 'my phone' });
});

test('parsePastedPairingLink trims surrounding whitespace', () => {
  const uri = buildPairingUri('https://sync.example.com', 'abc123', 'my phone');
  const result = parsePastedPairingLink(`  ${uri}  \n`);
  expect(result).toEqual({ server: 'https://sync.example.com', token: 'abc123', label: 'my phone' });
});

test('parsePastedPairingLink returns null for a link missing token', () => {
  const result = parsePastedPairingLink('obsidian://self-hosted-vault-sync?server=https://sync.example.com');
  expect(result).toBeNull();
});

test('parsePastedPairingLink returns null for garbage text', () => {
  expect(parsePastedPairingLink('not a link at all')).toBeNull();
  expect(parsePastedPairingLink('')).toBeNull();
});

test('parsePastedPairingLink returns null for a well-formed but unrelated URL', () => {
  expect(parsePastedPairingLink('https://example.com/some/page?foo=bar')).toBeNull();
});

test('pair failure throws an HttpError carrying the status code', async () => {
  mockRequestUrl([{ status: 401 }]);
  await expect(client.pair('phone')).rejects.toBeInstanceOf(HttpError);
});

test('listDevices failure throws an HttpError carrying the status code', async () => {
  mockRequestUrl([{ status: 500 }]);
  let caught: unknown;
  try {
    await client.listDevices();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(500);
});
