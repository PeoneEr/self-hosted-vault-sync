import { sha256hex } from '../util';

test('sha256hex produces correct digest', async () => {
  const data = new TextEncoder().encode('hello');
  const hash = await sha256hex(data.buffer as ArrayBuffer);
  expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('sha256hex empty input', async () => {
  const hash = await sha256hex(new ArrayBuffer(0));
  expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
