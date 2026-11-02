import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); vi.resetModules(); });

it('downloads the exact UTF-8 text through the shared browser download path', async () => {
  vi.useFakeTimers();
  const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:devices');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: vi.fn() } });
  const { saveFdsText } = await import('./files');
  const text = "! Café\n&DEVC ID='g', XYZ=1,2,3, QUANTITY='THERMOCOUPLE' /\n";
  expect(await saveFdsText(text, 'test-devices.fds')).toBe('test-devices.fds');
  const blob = (createObjectURL.mock.calls as unknown as [Blob][])[0][0];
  expect(await blob.text()).toBe(text);
  expect(anchor.download).toBe('test-devices.fds');
  expect(anchor.click).toHaveBeenCalledOnce();
  expect(revokeObjectURL).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:devices');
});

it('uses the desktop save route and distinguishes cancel from failure', async () => {
  const responses = [{ path: 'E:/out/devices.fds' }, null, { error: 'Disk full' }];
  const fetch = vi.fn(async () => ({ ok: true, json: async () => responses.shift() }));
  vi.stubGlobal('window', { location: { search: '?shell=test-token' } });
  vi.stubGlobal('fetch', fetch);
  const { connectShell, saveFdsText } = await import('./files');
  connectShell(() => {});
  expect(await saveFdsText('! exact\n', 'devices.fds')).toBe('E:/out/devices.fds');
  expect(await saveFdsText('! exact\n', 'devices.fds')).toBeNull();
  await expect(saveFdsText('! exact\n', 'devices.fds')).rejects.toThrow('Disk full');
  const [route, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(route).toBe('/api/save-fds');
  expect(JSON.parse(init.body as string)).toEqual({ text: '! exact\n', name: 'devices.fds' });
  expect(init.headers).toMatchObject({ 'X-Shell-Token': 'test-token' });
});
