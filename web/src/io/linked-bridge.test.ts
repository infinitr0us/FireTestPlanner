import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectShell, openShellAnalysis, shell, saveNextTestText } from './files';
import { readFileSync } from 'node:fs';
import { serializePlan } from '../core/serialize';

afterEach(() => vi.unstubAllGlobals());

function bridge(responses: unknown[]) {
  vi.stubGlobal('window', { location: { search: '?shell=test-token' } });
  const fetch = vi.fn(async () => ({ ok: true, json: async () => responses.shift() }));
  vi.stubGlobal('fetch', fetch);
  connectShell(() => {});
  return { api: shell()!, fetch };
}

describe('desktop link/save bridge', () => {
  it('next test chooses a new native destination, handles cancel and propagates failures', async () => {
    const { fetch } = bridge([{ path: 'E:/T-008.ftp.json', token: 'next' }, { path: 'E:/T-008.ftp.json', token: 'written' }]);
    const text = readFileSync(new URL('../../../fixtures/asbuilt-series.ftp.json', import.meta.url), 'utf8');
    expect(await saveNextTestText(text, 'T-008.ftp.json')).toEqual({ path: 'E:/T-008.ftp.json', token: 'written' });
    const calls = fetch.mock.calls as unknown as [string, { body: string }][];
    expect(JSON.parse(calls[0][1].body)).toEqual({ name: 'T-008.ftp.json', saveAs: true, token: null });
    const cancelled = bridge([null]);
    expect(await saveNextTestText(text, 'T-008.ftp.json')).toBeNull();
    expect(cancelled.fetch).toHaveBeenCalledTimes(1);
    bridge([{ path: 'E:/T-008.ftp.json', token: 'next' }, { error: 'disk full' }]);
    await expect(saveNextTestText(text, 'T-008.ftp.json')).rejects.toThrow('disk full');
  });
  it('rebases testData files through the desktop open and Save As path', async () => {
    const disk = readFileSync(new URL('../../../fixtures/test-data/test-data.ftp.json', import.meta.url), 'utf8');
    const { api, fetch } = bridge([
      { path: 'E:/original/plan.json', text: disk, token: 'original' },
      { path: 'E:/revisions/plan.json', token: 'chosen' },
      { path: 'E:/revisions/plan.json', token: 'saved' },
    ]);
    const opened = (await api.openPlan())!;
    expect(JSON.parse(opened.text).testData[0].file.path).toBe('E:/original/logger-export.xlsx');
    await api.savePlan(opened.text, 'plan.json', true, opened.token);
    const calls = fetch.mock.calls as unknown as [string, { body: string }][];
    const saved = JSON.parse(JSON.parse(calls[2][1].body).text);
    expect(saved.testData[0].file.path).toBe('../original/logger-export.xlsx');
    expect(saved.testData[1].file.path).toBe('../original/room-test_devc.csv');
    expect(JSON.parse(opened.text).testData[0].file.path).toBe('E:/original/logger-export.xlsx');
  });
  it('writes canonical geometry and measurements after Save and Save As', async () => {
    const disk = readFileSync(new URL('../../../fixtures/linked-files/linked-test.ftp.json', import.meta.url), 'utf8');
    const { api, fetch } = bridge([
      { path: 'E:/original/plan.json', text: disk, token: 'original' },
      { path: 'E:/original/plan.json', token: 'same' }, { path: 'E:/original/plan.json', token: 'saved' },
      { path: 'E:/revisions/plan.json', token: 'new' }, { path: 'E:/revisions/plan.json', token: 'saved-as' },
    ]);
    const opened = (await api.openPlan())!;
    const working = serializePlan(JSON.parse(opened.text));
    await api.savePlan(working, 'plan.json', false, opened.token);
    await api.savePlan(working, 'plan.json', true, opened.token);
    const calls = fetch.mock.calls as unknown as [string, { body: string }][];
    const writes = calls.filter(([url]) => url === '/api/save').map(([, init]) => JSON.parse(init.body).text as string);
    expect(writes).toHaveLength(2);
    for (const text of writes) {
      expect(text).toBe(serializePlan(JSON.parse(text)));
      expect(text).toContain('[2, 0.005168, 0.1798]');
    }
    expect(writes[0]).toBe(disk);
    expect(serializePlan(JSON.parse(opened.text))).toBe(working);
  });
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
  it("says why a shell call failed, not only its status", async () => {
    vi.stubGlobal('window', { location: { search: '?shell=test-token' } });
    const failing = (status: number, body: () => Promise<unknown>) =>
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json: body })));
    connectShell(() => {});
    failing(500, async () => ({ error: 'Flame analysis (analysis.json) is not a valid file filter' }));
    await expect(openShellAnalysis()).rejects.toThrow(
      'Shell call /api/flame-analysis/open failed: 500 (Flame analysis (analysis.json) is not a valid file filter)');
    failing(502, async () => { throw new SyntaxError('not JSON'); });
    await expect(openShellAnalysis()).rejects.toThrow(/^Shell call \/api\/flame-analysis\/open failed: 502$/);
  });
});
