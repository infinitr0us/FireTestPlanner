import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectShell, shell } from './files';

afterEach(() => vi.unstubAllGlobals());

function bridge(responses: unknown[]) {
  vi.stubGlobal('window', { location: { search: '?shell=test-token' } });
  const fetch = vi.fn(async () => ({ ok: true, json: async () => responses.shift() }));
  vi.stubGlobal('fetch', fetch);
  connectShell(() => {});
  return { api: shell()!, fetch };
}

describe('desktop link/save bridge', () => {
  it('hydrates relative links on open and rebases only the saved copy after choosing a destination', async () => {
    const disk = JSON.stringify({ objects: [{ type: 'burner', linkedFiles: [{ path: 'data.csv' }] }] });
    const { api, fetch } = bridge([
      { path: 'E:/original/plan.json', text: disk, token: 'original' },
      { path: 'E:/revisions/plan.json', token: 'chosen' },
      { path: 'E:/revisions/plan.json', token: 'saved' },
    ]);
    const opened = (await api.openPlan())!;
    expect(JSON.parse(opened.text).objects[0].linkedFiles[0].path).toBe('E:/original/data.csv');
    expect(await api.savePlan(opened.text, 'plan.json', true, opened.token)).toEqual({ path: 'E:/revisions/plan.json', token: 'saved' });
    const calls = fetch.mock.calls as unknown as [string, { body: string; headers: Record<string, string> }][];
    expect(calls.map((c) => c[0])).toEqual(['/api/open', '/api/save-target', '/api/save']);
    expect(JSON.parse(calls[1][1].body)).toEqual({ name: 'plan.json', saveAs: true, token: 'original' });
    const write = JSON.parse(calls[2][1].body);
    expect(write.token).toBe('chosen');
    expect(JSON.parse(write.text).objects[0].linkedFiles[0].path).toBe('../original/data.csv');
    expect(JSON.parse(opened.text).objects[0].linkedFiles[0].path).toBe('E:/original/data.csv');
    expect(calls[2][1].headers['X-Shell-Token']).toBe('test-token');
  });
  it('never writes when the destination chooser is cancelled', async () => {
    const { api, fetch } = bridge([null]);
    expect(await api.savePlan('{}', 'p.json', true, null)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports save failures and file errors rather than claiming success', async () => {
    const { api } = bridge([{ path: 'E:/p.json', token: 'chosen' }, { error: 'disk full' }, { error: 'File missing. Relink.' }]);
    await expect(api.savePlan('{}', 'p.json', true, null)).rejects.toThrow('disk full');
    await expect(api.linkedFileAction('E:/missing.csv', 'spreadsheet', 'open')).rejects.toThrow('Relink');
  });
});
