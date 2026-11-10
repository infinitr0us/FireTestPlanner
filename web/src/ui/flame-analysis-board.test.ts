import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlameAnalysisWorkspace } from './flame-analysis';
import { deferred, fakeDocument, fakeEncoder, settle } from './flame-analysis-test-support';
import { integrate, firstOrderResponse, joinPath, keyNumbers, localText, parseEventManifest, parseSeriesCsv } from '../core/flame-analysis';
import { parseAndValidatePlan } from '../core/validate';
import { saveMedia } from '../io/files';
import { dashOf } from './flame-analysis-plots';

vi.mock('../io/files', async (original) => ({ ...await original<typeof import('../io/files')>(), saveMedia: vi.fn(async () => 'saved') }));
// Count the 3-D flame files that were read through to the end, so a test can wait for
// the readers to finish instead of sleeping.
const parsed = vi.hoisted(() => ({ count: 0 }));
vi.mock('../core/flame', async (original) => {
  const actual = await original<typeof import('../core/flame')>();
  return { ...actual, parseFrameData: async (...args: Parameters<typeof actual.parseFrameData>) => {
    const frame = await actual.parseFrameData(...args);
    parsed.count++;
    return frame;
  } };
});
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
    w.composer = () => ({ async draw(i: number) { await wait.promise; w.scene.currentFrame = i; }, canvas: { width: 1280, height: 720 },
      pixels: () => new Uint8ClampedArray(1280 * 720 * 4) });
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
    const scene = { dispose: vi.fn(), setActive: vi.fn() }, source = { close: vi.fn() }; w.scene = scene; w.source = source;
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
  it('keeps the board behind a full-size picture out of reach, and shows one picture at a time', async () => {
    const { w } = workspace();
    w.source = { blob: async () => new Blob() }; w.cameraLabel = (s: string) => s;
    vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close() {} }));
    const overlays = () => w.dialog.children.filter((e: any) => e.className.includes('flame-analysis__zoom'));
    const behind = () => w.dialog.children.filter((e: any) => !e.className.includes('flame-analysis__zoom'));
    await w.openZoom('camA');
    expect(overlays()).toHaveLength(1);
    expect(behind().every((e: any) => e.inert)).toBe(true);
    const tab = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
    w.zoom.onkeydown(tab); expect(tab.preventDefault).toHaveBeenCalledOnce(); // Tab stays on Close
    await w.openZoom('camB'); // a host or a stray activation asks again
    expect(overlays()).toHaveLength(1);
    expect(behind().every((e: any) => e.inert)).toBe(true);
    w.closeZoom();
    expect(overlays()).toHaveLength(0);
    expect(behind().some((e: any) => e.inert)).toBe(false);
  });
  it('closes a full-size picture with the board', async () => {
    const { w } = workspace();
    w.source = { blob: async () => new Blob() }; w.cameraLabel = (s: string) => s;
    vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close() {} }));
    await w.openZoom('camA'); await w.close();
    expect(w.zoom).toBeUndefined(); expect(w.body.inert).toBe(false);
  });
});

describe('reading the 3-D flame', () => {
  it('stops at the first unreadable file and says nothing over its message', async () => {
    const { w, event } = workspace();
    const hull = new Uint8Array(readFileSync(new URL('../../../fixtures/flame-analysis/E1/hull/t_0099.50.npz', import.meta.url)));
    const gates = event.instants.stem.map(() => deferred<Uint8Array>());
    const asked: string[] = [];
    const source = { read: (path: string) => { asked.push(path); return gates[asked.length - 1].promise; } };
    const status = vi.spyOn(w, 'setStatus');
    parsed.count = 0;
    const pending = w.readHull(source, event, 'E1', w.epoch);
    const refused = expect(pending).rejects.toThrow('unreadable');
    await settle();
    expect(asked).toHaveLength(8); // eight at a time
    gates[2].reject(new Error('unreadable')); await refused;
    status.mockClear();
    gates.forEach((gate, i) => { if (i !== 2) gate.resolve(hull); });
    // The seven other readers each finish the file they had, and get their turn to go on.
    await vi.waitFor(() => expect(parsed.count).toBe(7), { timeout: 10000 });
    await settle();
    expect(asked).toHaveLength(8); // none asked for another
    expect(status).not.toHaveBeenCalled();
  });
});

describe('panels over the board', () => {
  const pictures = (w: any): void => {
    w.source = { blob: async () => new Blob() }; w.cameraLabel = (s: string) => s;
    vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close() {} }));
  };
  const inert = (w: any): number => w.dialog.children.filter((e: any) => e.inert).length;
  it.each([[0, 1], [1, 0]])('gives the board back whatever order two holders let go in: %s then %s', (first, second) => {
    const { w, element } = workspace();
    const a = element('div'), b = element('div'); w.dialog.append(a, b);
    const release = [w.holdBoard(a), w.holdBoard(b)];
    expect([a.inert, b.inert, w.body.inert]).toEqual([true, false, true]); // the one opened last is on top
    release[first]();
    expect(inert(w)).toBe(w.dialog.children.length - 1); // one holder left: still held
    release[second]();
    expect(inert(w)).toBe(0);
  });
  it("opens no full-size picture behind the export panel, and the export takes a picture's place", async () => {
    const { w } = workspace(); pictures(w);
    w.openExport(); await w.openZoom('camA');
    expect(w.zoom).toBeUndefined();
    await w.closeExport(); expect(inert(w)).toBe(0);
    await w.openZoom('camA'); expect(w.zoom).toBeDefined();
    w.openExport();
    expect(w.zoom).toBeUndefined(); expect(w.exportPanel).toBeDefined();
    expect(w.exportPanel.inert).toBe(false); expect(w.body.inert).toBe(true);
    await w.close();
    expect(inert(w)).toBe(0); expect(w.exportPanel).toBeUndefined();
  });
});

describe('what the plots draw', () => {
  it('gives a second measured heat release rate its own dash', () => {
    const { w, event, series } = workspace();
    const hood = event.series.find((s) => s.id === 'hood')!;
    event.series.splice(1, 0, { ...hood, id: 'hood-total', basis: 'total', label: 'Hood, total' });
    series.set('hood-total', series.get('hood')!);
    const lines = w.makePlots(event, series).plotData.specs[0].lines;
    const measured = lines.filter((l: any) => l.role === 'measured');
    expect(measured.map((l: any) => l.nth)).toEqual([0, 1]);
    expect(dashOf(measured[0])).toBe(''); expect(dashOf(measured[1])).not.toBe('');
    expect(lines.filter((l: any) => l.role === 'estimated').map((l: any) => l.nth)).toEqual([0, 1]);
  });
  it('shows the Heskestad note only with its line', () => {
    const { w, event, series } = workspace();
    w.plan = parseAndValidatePlan(readFileSync(new URL('../../../fixtures/flame-analysis/site.ftp.json', import.meta.url), 'utf8'));
    w.plotOptions = { heat: false, hoodResponse: false, heskestad: true };
    const withHeight = w.makePlots(event, series);
    expect(withHeight.note).toContain('Heskestad');
    expect(withHeight.plotData.specs.find((s: any) => s.id === 'height').lines.some((l: any) => l.role === 'predicted')).toBe(true);
    event.series = event.series.filter((s) => s.quantity !== 'height');
    const without = w.makePlots(event, series);
    expect(without.note).toBeUndefined();
    expect(without.plotData.specs.some((s: any) => s.id === 'height')).toBe(false);
  });
  it('takes the response time from the hood the cards compare with, not from another measurement', () => {
    const { w, event } = workspace();
    const hood = event.series.find((s) => s.id === 'hood')!;
    expect(w.responseTime(event)).toBe(2.3);
    event.series.splice(1, 0, { ...hood, id: 'hood-total', basis: 'total' });
    delete hood.responseTime_s;
    expect(w.responseTime(event)).toBeUndefined();
  });
});

describe('reopening the board', () => {
  it('redraws the cards and plots when the editor changed unit system meanwhile, metric or imperial', () => {
    fakeDocument();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    let unit = 'm';
    const w: any = new FlameAnalysisWorkspace(() => {}, { lengthUnit: () => unit as never });
    Object.assign(w, { analysis: {}, loaded: { ...fixture(), plots: { dispose: vi.fn() }, tiles: { dispose: vi.fn() } }, builtImperial: false });
    const refresh = vi.spyOn(w, 'refreshUnits').mockImplementation(() => {});
    w.open(); expect(refresh).not.toHaveBeenCalled();
    w.dialog.open = false; unit = 'ft';
    w.open(); expect(refresh).toHaveBeenCalledOnce();
    // Metres to millimetres is the same system: the board shows metres either way.
    refresh.mockClear(); w.dialog.open = false; unit = 'mm';
    w.open(); expect(refresh).not.toHaveBeenCalled();
    expect(w.units().height).toEqual([1, 'm']);
  });
  it('wakes the 3-D view on opening and rests it on closing', async () => {
    const { w } = workspace();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    w.analysis = {}; w.scene = { setActive: vi.fn() }; w.builtImperial = false;
    await w.close(); expect(w.scene.setActive).toHaveBeenLastCalledWith(false);
    w.open(); expect(w.scene.setActive).toHaveBeenLastCalledWith(true);
  });
});

describe('what an estimate card claims', () => {
  const card = (cards: any, label: string) => cards.children.find((c: any) => c.textContent.startsWith(label));
  it('with a hood response time: raw peak and heat, percentages like for like and named so', () => {
    const { w, event, series } = workspace();
    const volume = card(w.numbersRow(keyNumbers(event, series), event), 'Estimate from flame volume');
    expect(volume.textContent).toBe('Estimate from flame volume111 kWheat 0.204 MJas the hood sees it: peak −50 %, heat −36 %');
    expect(volume.title).toContain('response time 2.3 s: peak 54.7 kW, heat 0.0943 MJ');
    expect(volume.title).toContain('at a peak it reads lower than the flame');
  });
  it('without one: the raw percentages, and why a higher peak is expected', () => {
    const { w, event, series } = workspace();
    delete event.series.find((s) => s.id === 'hood')!.responseTime_s;
    const volume = card(w.numbersRow(keyNumbers(event, series), event), 'Estimate from flame volume');
    expect(volume.textContent).toBe('Estimate from flame volume111 kW (+2 %)heat 0.204 MJ (+39 %)');
    expect(volume.title).toContain('a higher estimate there is expected');
  });
  it('says nothing like for like where the two may not be compared', () => {
    const { w, event, series } = workspace();
    event.series.find((s) => s.id === 'hrr-from-volume')!.basis = 'total';
    const volume = card(w.numbersRow(keyNumbers(event, series), event), 'Estimate from flame volume');
    expect(volume.textContent).toBe('Estimate from flame volume111 kWheat 0.204 MJ · Bases differ; not compared.');
    expect(volume.title).not.toContain('reads lower');
  });
});
