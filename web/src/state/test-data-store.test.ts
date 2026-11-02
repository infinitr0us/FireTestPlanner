import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { newPlan } from '../core/plan';
import { parseAndValidatePlan } from '../core/validate';
import type { TestDataSource } from '../core/types';
import { TestDataStore } from './test-data-store';
import { Store } from './store';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../fixtures/test-data/${name}`, import.meta.url)));
const doc = () => parseAndValidatePlan(new TextDecoder().decode(fixture('test-data.ftp.json')));
const read = (path: string) => Promise.resolve({ bytes: fixture(path.split(/[\\/]/).at(-1)!), modified: null });

describe('test data session', () => {
  it('auto-loads local files, keeps grids and metadata, and serves both sources in order', async () => {
    const store = new Store(doc()), reader = vi.fn(read), data = new TestDataStore(store, reader);
    const listener = vi.fn(), unsubscribe = data.subscribe(listener);
    expect(data.get('logger')?.status).toBe('loading');
    await Promise.all([data.load('logger'), data.load('fds')]);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(data.get('logger')?.units?.get('HF east_23.17kW/m2permV')).toBe('V');
    expect(data.get('logger')?.grid?.length).toBe(601);
    expect(data.get('logger')?.mismatches).toEqual([]);
    expect(data.seriesFor('hf-east').map(s => [s.sourceName, s.role])).toEqual([
      ['Synthetic logger', 'measured'], ['Synthetic FDS', 'simulated']]);
    expect(data.seriesFor('tc-tree')).toEqual([]);
    expect(data.seriesFor('tc-tree', 0)).toHaveLength(2);
    expect(listener).toHaveBeenCalled();
    unsubscribe(); data.dispose();
  });

  it('reports manifest drift without rewriting it', async () => {
    const d = doc(); d.testData = [d.testData![1]];
    d.testData[0].manifest.size = 0;
    d.testData[0].manifest.channels[0].unit = 'V';
    const before = JSON.stringify(d.testData[0].manifest);
    const data = new TestDataStore(new Store(d), read);
    await data.load('fds');
    expect(data.get('fds')?.mismatches).toEqual(['File size changed.', 'Unit of mapped channel "HF east" changed.']);
    expect(JSON.stringify(d.testData[0].manifest)).toBe(before);
    data.dispose();
  });

  it('rederives on undo, calibration and target deletion without rereading', async () => {
    const d = doc(); d.testData = [d.testData![1]];
    const mappings = d.testData[0].channels; d.testData[0].channels = [];
    const store = new Store(d), reader = vi.fn(read), data = new TestDataStore(store, reader);
    await data.load('fds');
    store.edit('Map', d => { d.testData![0].channels = mappings; });
    expect(data.seriesFor('hf-east')).toHaveLength(1);
    store.undo();
    expect(data.seriesFor('hf-east')).toEqual([]);
    store.redo();
    const old = data.seriesFor('hf-east')[0].values[1];
    store.edit('Calibrate', d => { d.testData![0].channels[0].scale = 2; d.testData![0].timeOffset_s = 10; });
    expect(data.seriesFor('hf-east')[0].values[1]).toBe(old * 2);
    expect(data.seriesFor('hf-east')[0].t[0]).toBe(-10);
    store.edit('Delete', d => { d.objects = d.objects.filter(o => o.id !== 'tc-tree'); });
    expect(data.seriesFor('tc-tree', 0)).toEqual([]);
    expect(data.seriesFor('hf-east')).toHaveLength(1);
    expect(reader).toHaveBeenCalledTimes(1);
    data.dispose();
  });

  it('clears on plan switches and a late read cannot restore old data', async () => {
    const d = doc(); d.testData = [d.testData![1]];
    let resolve!: (value: Awaited<ReturnType<typeof read>>) => void;
    const reader = vi.fn(() => new Promise<Awaited<ReturnType<typeof read>>>(r => { resolve = r; }));
    const store = new Store(d), data = new TestDataStore(store, reader);
    const pending = data.load('fds');
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1));
    store.replaceDocument(newPlan(), 'new.ftp.json');
    resolve(await read('room-test_devc.csv'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(data.get('fds')).toBeUndefined();
    expect(data.seriesFor('hf-east')).toEqual([]);
    store.replaceDocument(d, 'old.ftp.json');
    expect(data.get('fds')?.status).toBe('loading');
    data.dispose();
  });

  it('waits on network paths and allows an explicit load', async () => {
    for (const path of ['//server/share/room-test_devc.csv', '\\\\?\\UNC\\server\\share\\room-test_devc.csv']) {
      const d = doc(); d.testData = [d.testData![1]]; d.testData[0].file.path = path;
      const reader = vi.fn(read), data = new TestDataStore(new Store(d), reader);
      expect(data.get('fds')?.status).toBe('needs-load');
      expect(reader).not.toHaveBeenCalled();
      await data.load('fds');
      expect(data.get('fds')?.status).toBe('loaded');
      data.dispose();
    }
  });

  it('needs a browser file and loads it; a different modification time alone is not a mismatch', async () => {
    const store = new Store(doc()), data = new TestDataStore(store);
    expect(data.get('fds')?.status).toBe('needs-file');
    const file = new File([fixture('room-test_devc.csv') as Uint8Array<ArrayBuffer>], 'room-test_devc.csv', { lastModified: 0 });
    await data.attachFile('fds', file);
    expect(data.get('fds')?.status).toBe('loaded');
    expect(data.get('fds')?.mismatches).toEqual([]);
    expect(store.document.testData![1].manifest.modified).toBeNull();
    const initialTime = data.seriesFor('hf-east')[0].t[0];
    store.edit('Skip a row', d => { d.testData![1].table.dataRow = 4; });
    await data.load('fds');
    expect(data.get('fds')?.status).toBe('loaded');
    expect(data.seriesFor('hf-east')[0].t[0]).toBeGreaterThan(initialTime);
    store.edit('Remove source', d => { d.testData = d.testData!.filter(s => s.id !== 'fds'); });
    expect(data.get('fds')).toBeUndefined();
    expect(data.seriesFor('hf-east')).toEqual([]);
    store.undo();
    expect(data.get('fds')?.status).toBe('loaded');
    expect(data.seriesFor('hf-east')).toHaveLength(1);
    data.dispose();
  });

  it('rereads file/table changes, retains parsed data after mapping errors, and recovers on undo', async () => {
    const store = new Store(doc()), reader = vi.fn(read), data = new TestDataStore(store, reader);
    await Promise.all([data.load('logger'), data.load('fds')]);
    store.edit('Missing channel', d => { d.testData![1].channels[0].channel = 'missing'; });
    expect(data.get('fds')?.status).toBe('error');
    expect(data.get('fds')?.grid).toBeDefined();
    store.undo();
    expect(data.get('fds')?.status).toBe('loaded');
    expect(reader).toHaveBeenCalledTimes(2);
    store.edit('Table', d => { d.testData![1].table.dataRow = 4; });
    await data.load('fds');
    expect(reader).toHaveBeenCalledTimes(3);
    store.edit('File', d => { d.testData![1].file.path = 'E:/data/room-test_devc.csv'; });
    await data.load('fds');
    expect(reader).toHaveBeenCalledTimes(4);
    data.dispose();
  });

  it('loads a selected units sheet and never calls the reader during draft creation', async () => {
    const d = doc(); d.testData = [d.testData![0]];
    const source: TestDataSource = d.testData[0]; source.table.unitsSheet = 'Metadata';
    const data = new TestDataStore(new Store(d));
    // Use the fixture's first metadata sheet by its actual recorded name.
    const draft = await data.draftFromFile('logger-export.xlsx', fixture('logger-export.xlsx'));
    source.table.unitsSheet = draft.sheets[0].name!;
    await data.attachBytes('logger', 'logger-export.xlsx', { bytes: fixture('logger-export.xlsx'), modified: null });
    expect(data.get('logger')?.unitsGrid).toBeDefined();
    expect(data.get('logger')?.units?.size).toBeGreaterThan(0);
    data.dispose();
  });
});
