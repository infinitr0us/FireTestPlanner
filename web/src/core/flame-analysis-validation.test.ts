import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEvent, fillTemplate, joinPath, parseAnalysisManifest, parseEventManifest, parseMesh,
  parseOutlines, parseSeriesCsv, pathProblem, seriesObjectProblems, type EventManifest, type Series } from './flame-analysis';
import { parseFrameData } from './flame';
import { checkedEventSource, readText, type AnalysisSource } from '../io/flame-analysis-source';
import { connectShell, saveMedia, shell, openShellAnalysis, readShellAnalysisFile } from '../io/files';
import { setLanguage } from '../ui/i18n';

afterEach(() => { vi.unstubAllGlobals(); setLanguage('en'); });

const ROOT = new URL('../../../fixtures/flame-analysis-validation/', import.meta.url);
const bytes = (path: string): Uint8Array => new Uint8Array(readFileSync(new URL(path, ROOT)));
const json = <T>(path: string): T => JSON.parse(new TextDecoder().decode(bytes(path))) as T;
const cases = json<{ name: string; accept: boolean; files: string[] }[]>('cases.json');
const meshes = json<{ name: string; accept: boolean }[]>('meshes.json');
const paths = json<{ path: string; accept: boolean }[]>('paths.json');
const baseEvent = (): EventManifest => json<EventManifest>('baseline/event.json');
const sourceFor = (name = 'baseline', files: string[] = []): AnalysisSource => {
  const read = async (path: string): Promise<Uint8Array> => bytes(files.includes(path) ? `cases/${name}/${path}` : `baseline/${path}`);
  return { name, read, blob: async path => new Blob([await read(path) as BlobPart]), close() {} };
};

async function load(source: AnalysisSource): Promise<void> {
  const analysis = parseAnalysisManifest(await readText(source, 'analysis.json'));
  const site = JSON.parse(await readText(source, analysis.sitePlan)) as { objects: { id: string; type: string }[] };
  for (const entry of analysis.events) {
    const event = parseEventManifest(await readText(source, entry.path));
    const problems = seriesObjectProblems(event, site.objects);
    if (problems.length) throw new Error(problems.join('\n'));
    const series = new Map<string, Series>();
    for (const s of event.series) series.set(s.id, parseSeriesCsv(await readText(source, s.file), s.time, s.value, s.file));
    const checked = checkedEventSource(source, event, entry, series, '');
    for (const cam of event.cameras) {
      expect(analysis.cameras.some(c => c.id === cam)).toBe(true);
      parseOutlines(await readText(checked, fillTemplate(event.files.outlines, cam)), cam, event.instants.t_s.length);
    }
    for (let i = 0; i < event.instants.stem.length; i++) {
      const file = fillTemplate(event.files.hull, undefined, event.instants.stem[i]);
      await parseFrameData(file, await checked.read(file), event.instants.t_s[i]);
    }
  }
}

describe('shared reviewer corpus', () => {
  it.each(cases)('$name: folder acceptance = $accept', async ({ name, files, accept }) => {
    if (accept) await expect(load(sourceFor(name, files))).resolves.toBeUndefined();
    else await expect(load(sourceFor(name, files))).rejects.toThrow();
  });
  it.each(meshes)('$name: PLY acceptance = $accept', ({ name, accept }) => {
    const parse = (): ReturnType<typeof parseMesh> => parseMesh(bytes(`meshes/${name}.ply`), name);
    if (accept) {
      const mesh = parse();
      expect([...mesh.positions.slice(0, 3)]).toEqual(name === 'writer_fractional_faces' ? [0, 0, 0] : [1, 2, 3]);
      expect([...mesh.indices]).toEqual([0, 1, 2]);
    } else expect(parse).toThrow();
  });
  it.each(paths)('path $path acceptance = $accept', ({ path, accept }) => {
    expect(pathProblem(path) === null).toBe(accept);
    const analysis = json<Record<string, unknown>>('baseline/analysis.json');
    analysis.sitePlan = path;
    const event = baseEvent(); event.series[0].file = path;
    for (const parse of [() => joinPath('', path), () => parseAnalysisManifest(JSON.stringify(analysis)),
      ...['1.0.0', '1.1.0', '1.2.0'].map(version => () => parseEventManifest(JSON.stringify({ ...event, version })))]) {
      if (accept) expect(parse).not.toThrow(); else expect(parse).toThrow();
    }
  });
});

describe('event 1.2 heat flux (mirror of fireplan)', () => {
  const heatFlux = (): EventManifest => json<EventManifest>('cases/v12_heat_flux/event.json');
  const parse = (event: EventManifest): EventManifest => parseEventManifest(JSON.stringify(event));
  it.each(['measured', 'estimated'] as const)('accepts %s heat flux with or without an object', role => {
    const event = heatFlux(), s = event.series.at(-1)!;
    s.role = role;
    expect(parse(event).series.at(-1)!.object).toBe('gauge');
    delete s.object;
    expect(parse(event).series.at(-1)!.object).toBeUndefined();
  });
  it.each(['1.0.0', '1.1.0'])('keeps %s closed to both 1.2 additions', version => {
    const event = heatFlux(); event.version = version;
    delete event.series.at(-1)!.object;
    expect(() => parse(event)).toThrow(/series\/2\/quantity/);
    event.series.pop(); event.series[0].object = 'gauge';
    expect(() => parse(event)).toThrow(/unexpected property 'object'/);
  });
  it.each([
    { unit: 'W/m2' }, { role: 'reconstructed' }, { basis: 'total' }, { responseTime_s: 2 },
    { quantity: 'hrr', unit: 'kW' }, { object: '' }, { object: '-gauge' }, { object: 'gauge\n' },
    { object: 'gauge space' }, { object: 'é' }, { object: 'g'.repeat(65) }, { object: null }, { object: 1 },
  ])('refuses invalid heat flux descriptor %j', change => {
    const event = heatFlux(); Object.assign(event.series.at(-1)!, change);
    expect(() => parse(event)).toThrow(/series\/2/);
  });
  it('accepts the same id grammar as other ids', () => {
    for (const object of ['0', 'Gauge_1.2-3', 'g'.repeat(64)]) {
      const event = heatFlux(); event.series.at(-1)!.object = object;
      expect(parse(event).series.at(-1)!.object).toBe(object);
    }
  });
  it('keeps the 1.1 fields valid at 1.1 and 1.2', () => {
    for (const version of ['1.1.0', '1.2.0']) {
      const event = baseEvent(); event.version = version;
      event.files.mesh = 'mesh/{stem}.ply'; event.series[0].responseTime_s = 2;
      expect(parse(event)).toEqual(event);
    }
  });
  it('checks references separately, once per series, without changing either input', () => {
    const event = heatFlux(), s = event.series.at(-1)!;
    event.series.push({ ...s, id: 'second' }, { ...s, id: 'unlinked', object: undefined });
    const objects = Object.freeze([Object.freeze({ id: 'gauge', type: 'heatFluxSensor' })]);
    const before = JSON.stringify(event);
    expect(seriesObjectProblems(event, objects)).toEqual([]);
    expect(JSON.stringify(event)).toBe(before);
    s.object = 'missing'; event.series.at(-2)!.object = 'camA';
    expect(parse(event)).toEqual(event); // the manifest alone cannot resolve the plan
    expect(seriesObjectProblems(event, [{ id: 'camA', type: 'camera' }])).toEqual([
      "Event E: series 'flux' names missing site plan object 'missing'",
      "Event E: series 'second' object 'camA' must be a heat flux sensor",
    ]);
  });
});

describe('event semantics', () => {
  it('names the event and duplicate series id before any indexing', () => {
    const event = baseEvent(); event.series[1].id = 'hood';
    expect(() => parseEventManifest(JSON.stringify(event))).toThrow(/Event E: series id 'hood' repeats/);
  });
  it.each([[0, 2, 1], [0, 0, 1]])('refuses unordered instants %j', (...times) => {
    const event = baseEvent(); event.instants.t_s = times;
    expect(() => parseEventManifest(JSON.stringify(event))).toThrow(/strictly increasing/);
  });
  it.each(['NaN', 'Infinity', '-Infinity', '1e999'])('refuses nonfinite JSON %s', number => {
    const text = JSON.stringify(baseEvent()).replace('"t_s":[0,1,2]', `"t_s":[0,${number},2]`);
    expect(() => parseEventManifest(text)).toThrow();
  });
  it('accepts BOMs in manifests and outlines', async () => {
    for (const file of ['analysis.json', 'event.json', 'outlines/camA.json']) {
      const source = sourceFor(), original = source.read;
      source.read = async path => path === file ? new Uint8Array([239, 187, 191, ...await original(path)]) : original(path);
      await expect(load(source)).resolves.toBeUndefined();
      source.read = async path => path === file ? new Uint8Array([239, 187, 191, 239, 187, 191, ...await original(path)]) : original(path);
      await expect(load(source)).rejects.toThrow();
    }
  });
  it.each(['event.json', 'series.csv', 'outlines/camA.json'])('names undecodable UTF-8 in %s', async file => {
    const source = sourceFor(); source.read = async () => new Uint8Array([255]);
    await expect(readText(source, file)).rejects.toThrow(`${file}: not readable as UTF-8`);
  });
  it('requires exactly the cameras, matching ids, and consistent close-ups', () => {
    const event = baseEvent();
    event.images.extra = { size_px: [100, 100], display_px: [100, 100] };
    event.images.camA.closeup = { rect_px: [240, 180, 10, 10], display_px: [10, 10] };
    expect(checkEvent(event, { id: 'different' }).map(p => p.code)).toEqual(['event-id', 'images-cameras', 'closeup', 'closeup']);
    delete event.images.extra;
    delete event.images.camA.closeup;
    event.files.closeup = 'frames/{cam}/{stem}.png';
    expect(checkEvent(event, { id: event.id }).map(p => p.code)).toEqual(['closeup']);
  });
  it('accepts close-ups touching the boundary and quality endpoints', () => {
    const event = baseEvent();
    event.files.closeup = 'frames/{cam}/{stem}.png';
    event.images.camA.closeup = { rect_px: [0, 0, 240, 180], display_px: [240, 180] };
    event.quality = { noHull: [0, 2], outsideFrame: { camA: [0, 2] } };
    expect(checkEvent(event, { id: event.id })).toEqual([]);
  });
  it('refuses quality cameras and indices outside the event', () => {
    const event = baseEvent(); event.quality = { noHull: [3], outsideFrame: { camZ: [999] } };
    expect(checkEvent(event, { id: event.id }).map(p => p.code)).toEqual(['quality-camera', 'quality-index']);
  });
  it.each(['volume', 'area'] as const)('refuses negative %s, keeps missing values and signed HRR', quantity => {
    const event = baseEvent(); event.series[1].quantity = quantity;
    const series = new Map([['hood', { t: new Float64Array([0]), v: new Float64Array([-1]) }],
      ['volume', { t: new Float64Array([0, 1]), v: new Float64Array([NaN, -1]) }]]);
    expect(checkEvent(event, { id: event.id }, series).map(p => p.code)).toEqual(['series-negative']);
    series.get('volume')!.v[1] = -0;
    expect(checkEvent(event, { id: event.id }, series)).toEqual([]);
  });
  it('rejects outline size and names the file at the source read', async () => {
    const event = baseEvent(); event.images.camA.size_px = [480, 360];
    const source = checkedEventSource(sourceFor(), event, { id: 'E', label: 'E', path: 'event.json' }, new Map(), '');
    await expect(source.read('outlines/camA.json')).rejects.toThrow(/outlines\/camA.json.*fails schema/);
  });
  it.each([false, true])('checks every hull voxel size, including empty = %s', async empty => {
    const event = baseEvent(), original = sourceFor();
    if (empty) original.read = async () => new Uint8Array(readFileSync(new URL('../../../fixtures/flame-analysis/E1/hull/t_0099.50.npz', import.meta.url)));
    for (const [relative, accept] of [[0, true], [0.5e-9, true], [-0.5e-9, true], [2e-9, false]] as const) {
      event.hull.voxelSize_m = 0.03 * (1 + relative);
      const source = checkedEventSource(original, event, { id: 'E', label: 'E', path: 'event.json' }, new Map(), '');
      for (const stem of event.instants.stem) {
        const promise = source.read(`hull/${stem}.npz`);
        if (accept) await expect(promise).resolves.toBeInstanceOf(Uint8Array);
        else await expect(promise).rejects.toThrow(/voxel_size.*hull.voxelSize_m/);
      }
    }
  });
});

describe('series CSV dialect', () => {
  it.each([
    ['t,v\n\n0,1\n\n1,bad\n', 5], ['t,v\r\n\r\n0,1\r\n,\r\n', 4],
    ['t,v\r0,1\r\r0,2', 4], ['t,v\n\n0,"12', 3], ['t,v\n0,"1"x', 2],
  ] as const)('reports physical lines in %j', (text, row) => {
    expect(() => parseSeriesCsv(text, 't', 'v', 'series.csv')).toThrow(new RegExp(`series.csv.*row ${row}`));
  });
  it.each(['', '\n\r\n', 't,v\n\n'])('refuses no samples in %j', text => {
    expect(() => parseSeriesCsv(text, 't', 'v')).toThrow(/no samples/);
  });
  it('accepts decimal forms and spaces around quoted values', () => {
    const series = parseSeriesCsv('t,v\r0, " +1.2e2 " \r1,.5\r2,1.\r3,-0\r', 't', 'v');
    expect([...series.v]).toEqual([120, 0.5, 1, -0]);
  });
  it.each([' ', ',', '"",""'])('does not skip a nonempty record %j', row => {
    expect(() => parseSeriesCsv(`t,v\n0,1\n${row}\n1,2`, 't', 'v')).toThrow(/row 3/);
  });
  it('tracks physical lines across quoted fields', () => {
    expect(() => parseSeriesCsv('"t\ntime",v\n0,1\n\n1,bad', 't\ntime', 'v')).toThrow(/row 5/);
  });
});

describe('translated desktop validation errors', () => {
  const connect = (error: string, ok = true): void => {
    vi.stubGlobal('window', { location: { search: '?shell=test-token' } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: 400, json: async () => ({ error }) })));
    connectShell(() => {}); setLanguage('fr');
  };
  it('translates extension conflicts for each save route', async () => {
    connect('The name with its extension already exists. Choose the name with its extension.');
    for (const save of [() => shell()!.saveFds('a', 'a'), () => shell()!.saveCsv('a', 'a'),
      () => saveMedia(new Blob(), 'a', 'png'), () => saveMedia(new Blob(), 'a', 'video')]) {
      await expect(save()).rejects.toThrow('Choisissez le nom avec son extension.');
    }
  });
  it.each(['Invalid JSON request body.', 'JSON request body exceeds the size limit.'])('translates %s', async message => {
    connect(message, false);
    await expect(openShellAnalysis()).rejects.toThrow(/corps JSON/);
  });
  it('translates an opened-file identity change and retains its name', async () => {
    connect('race.txt changed while opening the file.', false);
    await expect(readShellAnalysisFile('token', 'race.txt')).rejects.toThrow('race.txt a changé pendant l’ouverture du fichier.');
  });
});
