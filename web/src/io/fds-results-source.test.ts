import { afterEach, expect, it, vi } from 'vitest';
import { readShellResult } from './files';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('retries an incomplete successful range once without decoding truncated output', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetch = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(0)))
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4])));
  vi.stubGlobal('fetch', fetch);
  expect(await readShellResult('session', 'case.sf', 146, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][0]).toBe(fetch.mock.calls[1][0]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('case.sf at byte 146: expected 4 bytes, received 0'));
});
it('reports a persistent short range with the file and byte offset and stops retrying', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(new Uint8Array(1)));
  vi.stubGlobal('fetch', fetch);
  await expect(readShellResult('session', 'case.sf', 146, 4)).rejects.toThrow('case.sf at byte 146: expected 4 bytes, received 1');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('does not retry server rejections such as changed files or expired sessions', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Result file changed' }), { status: 400 }));
  vi.stubGlobal('fetch', fetch);
  await expect(readShellResult('session', 'case.sf', 146, 4)).rejects.toThrow('Result file changed');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reports the HTTP status when a server returns HTML instead of a JSON error', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('<html>Not found</html>', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  await expect(readShellResult('session', 'case.sf', 146, 4)).rejects.toThrow('Could not read case.sf: HTTP 404');
  expect(fetch).toHaveBeenCalledTimes(1);
});
