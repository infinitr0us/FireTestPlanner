import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlameAnalysisWorkspace } from './flame-analysis';
import { deferred, fakeDocument, fakeEncoder, settle } from './flame-analysis-test-support';
import { integrate, firstOrderResponse, joinPath, keyNumbers, localText, parseEventManifest, parseSeriesCsv } from '../core/flame-analysis';
import { saveMedia } from '../io/files';

vi.mock('../io/files', async (original) => ({ ...await original<typeof import('../io/files')>(), saveMedia: vi.fn(async () => 'saved') }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
function fixture() {
  const root = new URL('../../../fixtures/flame-analysis/', import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
  const event = parseEventManifest(read('E1/event.json'));
  const series = new Map(event.series.map((s) => [s.id, parseSeriesCsv(read(joinPath('E1', s.file)), s.time, s.value)]));
  return { event, series };
}
function workspace() {
  const dom = fakeDocument(), w: any = new FlameAnalysisWorkspace();
  const f = fixture();
  Object.assign(w, { loaded: { ...f, sequence: {}, plots: { dispose: vi.fn() }, tiles: { dispose: vi.fn() }, plotData: { specs: [] } }, index: 0 });
  w.dialog.open = true;
  const exportGroup = dom.element('div'); exportGroup.className = 'flame-analysis__export';
  const trigger = dom.element('button'); exportGroup.append(trigger); w.body.append(exportGroup);
  return { w, ...dom, trigger, ...f };
}

describe('plot and card semantics (B1-B4)', () => {
  it('the actual plot builder applies the response before integrating, labels it, and preserves raw keys', () => {
    const { w, event, series } = workspace();
    w.plotOptions = { heat: true, hoodResponse: true, heskestad: false };
    const built = w.makePlots(event, series);
    for (const s of event.series.filter((s) => s.quantity === 'hrr')) {
      const line = built.plotData.specs[0].lines.find((l: any) => l.label.startsWith(localText(s.label)));
      const filtered = s.role === 'estimated' ? firstOrderResponse(series.get(s.id)!, 2.3) : series.get(s.id)!;
      expect(line.v.at(-1)).toBeCloseTo(integrate(filtered, 99.5, 103), 8);
      expect(line.v[line.t.indexOf(99.5)]).toBe(0);
      if (s.role === 'estimated') expect(line.label).toContain('as the hood sees it');
    }
    expect(keyNumbers(event, series).estimates[0].heat_kJ).toBeCloseTo(204.3165, 6);
  });
  it('labels every HRR basis when mixed, carries notes into legends/cards, and explains no comparison', () => {
    const { w, event, series } = workspace();
    event.series.filter((s) => s.quantity === 'hrr').forEach((s) => { s.note = `delivered ${s.id}`; });
    event.series.find((s) => s.id === 'hrr-from-volume')!.basis = 'total';
    event.series.find((s) => s.id === 'hrr-from-area')!.basis = undefined;
    const built = w.makePlots(event, series), lines = built.plotData.specs[0].lines;
    expect(lines.map((l: any) => l.label)).toEqual(expect.arrayContaining([
      expect.stringContaining('(convective)'), expect.stringContaining('(total)'), expect.stringContaining('(basis not stated)'),
    ]));
    expect(built.plots.element.querySelectorAll('th').slice(0, 3).map((e: any) => e.title)).toEqual(lines.map((l: any) => l.note));
    const cards = w.numbersRow(keyNumbers(event, series), event);
    expect(cards.textContent).toContain('Bases differ; not compared.');
    expect(cards.textContent).toContain('A basis is not stated; not compared.');
    expect(cards.children[2].title).toContain('delivered hrr-from-volume');
    expect(cards.children[0].title).toContain('delivered');
  });
  it('shows missing heat as a dash and partial heat with its share', () => {
    const { w, event, series } = workspace();
    event.instants.t_s = [0, 1, 2, 3];
    event.series.filter((s) => s.quantity === 'hrr').forEach((s) => series.set(s.id,
      { t: Float64Array.from([0, 1, 2, 3]), v: Float64Array.from(s.role === 'measured' ? [10, NaN, 10, NaN] : [10, 10, NaN, 10]) }));
    const cards = w.numbersRow(keyNumbers(event, series), event);
    expect(cards.children[1].textContent).toBe('Heat released, hood–');
    expect(cards.children[2].textContent).toContain('0.01 MJ (partial, 33.3 % covered)');
    expect(cards.children[2].textContent).toContain('Incomplete coverage; not compared.');
  });
});

describe('board export ownership and focus (B5, B11, B12, B15, B16, B18)', () => {
  it('makes the background inert, keeps focus within the panel, disables the form and cannot start twice', async () => {
    const { w, all, doc, trigger } = workspace(), work = deferred<Blob>();
    w.exportVideo = vi.fn(() => w.runExport(() => work.promise));
    w.openExport();
    expect([...w.dialog.children].filter((e: any) => e !== w.exportPanel).every((e: any) => e.inert)).toBe(true);
    expect(w.exportPanel.contains(doc.activeElement)).toBe(true);
    const go = all.find((e) => e.textContent === 'Export'), close = all.find((e) => e.textContent === 'Close');
    const form = w.exportPanel.querySelectorAll('select');
    const first = go.onclick(); await settle();
    expect(form.every((e: any) => e.disabled)).toBe(true); expect(go.disabled).toBe(true); expect(close.disabled).toBe(false);
    form[0].onchange(); await go.onclick(); expect(w.exportVideo).toHaveBeenCalledOnce();
    close.focus(); const tab = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
    w.exportPanel.onkeydown(tab); expect(tab.preventDefault).toHaveBeenCalledOnce(); expect(doc.activeElement).toBe(close);
    w.escapeExport(); expect(w.exportPanel).toBeDefined();
    work.resolve(new Blob()); await first;
    expect(saveMedia).not.toHaveBeenCalled();
    await w.closeExport(); expect(w.body.inert).toBe(false); expect(doc.activeElement).toBe(trigger);
  });
  it.each(['close', 'selectEvent', 'stopExport'])('%s aborts and waits before continuing', async (action) => {
    const { w } = workspace(), work = deferred<Blob>();
    w.analysis = { events: [] }; w.source = {}; w.plan = {};
    const pending = w.runExport(() => work.promise), aborted = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await settle(); const controller = w.exportController;
    let finished = false;
    const transition = (action === 'selectEvent' ? w.selectEvent('unknown') : w[action]()).then(() => { finished = true; });
    await settle(); expect(controller.signal.aborted).toBe(true); expect(finished).toBe(false);
    if (action === 'close') expect(w.dialog.open).toBe(true);
    work.resolve(new Blob()); await aborted; await transition;
    if (action === 'close') expect(w.dialog.open).toBe(false);
  });
  it('does not publish a late result after panel removal even if the encoder ignores abort', async () => {
    const { w, all } = workspace(), late = deferred<Blob>();
    w.exportVideo = () => late.promise;
    w.openExport(); const running = all.find((e) => e.textContent === 'Export').onclick();
    await w.closeExport(); late.resolve(new Blob()); await running;
    expect(saveMedia).not.toHaveBeenCalled(); expect(w.lastVideo).toBeUndefined();
  });
  it.each([false, true])('PNG restores the live scene after delayed draw, failure=%s (reviewer R15)', async (failure) => {
    const { w } = workspace(), wait = deferred<void>();
    w.scene = { currentFrame: 0, setFrame(i: number) { this.currentFrame = i; } };
    w.composer = () => ({ async draw(i: number) { await wait.promise; w.scene.currentFrame = i; if (failure) throw new Error('draw'); },
      canvas: { toBlob(cb: (b: Blob) => void) { cb(new Blob()); } } });
    const pending = w.exportPng(), outcome = failure ? expect(pending).rejects.toThrow('draw') : expect(pending).resolves.toBeInstanceOf(Blob);
    await settle(); w.index = 1; w.scene.currentFrame = 1; wait.resolve(); await outcome;
    expect(w.scene.currentFrame).toBe(1);
  });
  it.each([false, true])('video restores the current instant after delayed drawing, cancelled=%s', async (cancelled) => {
    const { w } = workspace(), wait = deferred<void>(), controller = new AbortController();
    fakeEncoder();
    w.scene = { currentFrame: 0, setFrame(i: number) { this.currentFrame = i; } };
    w.composer = () => ({ async draw(i: number) { await wait.promise; w.scene.currentFrame = i; }, canvas: { width: 1280, height: 720 } });
    const pending = w.exportVideo({ layout: 'board', width: 1280, from: 99.5, to: 99.5, speed: 1 }, () => {}, controller.signal);
    const outcome = cancelled ? expect(pending).rejects.toMatchObject({ name: 'AbortError' }) : expect(pending).resolves.toBeInstanceOf(Blob);
    await settle(); w.index = 2; w.scene.currentFrame = 2;
    if (cancelled) controller.abort();
    wait.resolve(); await outcome; expect(w.scene.currentFrame).toBe(2);
  });
  it('does not save a PNG when the board closes during its draw', async () => {
    const { w } = workspace(), wait = deferred<void>();
    w.composer = () => ({ draw: () => wait.promise, canvas: { toBlob(cb: (b: Blob) => void) { cb(new Blob()); } } });
    const pending = w.savePng(); await settle(); const closing = w.close();
    wait.resolve(); await pending; await closing;
    expect(saveMedia).not.toHaveBeenCalled();
  });
  it('rejects concurrent direct exports through the shared owner', async () => {
    const { w } = workspace(), wait = deferred<Blob>();
    const first = w.runExport(() => wait.promise);
    const second = vi.fn();
    await expect(w.runExport(second)).rejects.toThrow('already running');
    expect(second).not.toHaveBeenCalled(); wait.resolve(new Blob()); await first;
  });
  it('disposes plots, tiles, scene and source exactly once', async () => {
    const { w } = workspace(), plots = w.loaded.plots, tiles = w.loaded.tiles;
    const scene = { dispose: vi.fn() }, source = { close: vi.fn() }; w.scene = scene; w.source = source;
    await Promise.all([w.dispose(), w.dispose()]); await w.dispose();
    for (const fn of [plots.dispose, tiles.dispose, scene.dispose, source.close]) expect(fn).toHaveBeenCalledOnce();
    expect(w.loaded).toBeUndefined();
  });
  it('separates view and look pressed states', () => {
    const { w, element } = workspace();
    const buttons = ['cubes', 'surface', 'site', 'flame'].map((id) => {
      const b = element('button'); b.dataset[id === 'cubes' || id === 'surface' ? 'look' : 'view'] = id;
      w.body.append(b); return b;
    });
    w.setLook('surface'); w.setSceneView('site');
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'true', 'false']);
    w.setLook('cubes'); expect(buttons[2].getAttribute('aria-pressed')).toBe('true');
  });
  it('returns full-size-picture focus to the tile that opened it', async () => {
    const { w, element, doc } = workspace();
    const buttons = ['camA', 'camB'].map((camera) => { const b = element('button'); b.className = 'flame-analysis__tile-open'; b.dataset.camera = camera; w.body.append(b); return b; });
    w.source = { blob: async () => new Blob() }; w.cameraLabel = (s: string) => s;
    vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close() {} }));
    await w.openZoom('camB'); w.closeZoom(); expect(doc.activeElement).toBe(buttons[1]);
  });
});
