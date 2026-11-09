/**
 * DOM checks of the flame analysis board on the synthetic test
 * (fixtures/flame-analysis). Run by run.mjs through flame-analysis.html?check=1;
 * real keys and pointer input are sent by the runner itself.
 */

import type { FlameAnalysisWorkspace } from '../src/ui/flame-analysis';
import type { EventManifest } from '../src/core/flame-analysis';
import type { AnalysisSource } from '../src/io/flame-analysis-source';
import { setLanguage } from '../src/ui/i18n';
import { projectHull } from '../src/core/flame-analysis';
import type { CameraObject } from '../src/core/types';
import { coverage } from '../src/ui/flame-analysis-cameras';

type Check = { name: string; passed: boolean; detail?: string };

const wait = async (test: () => boolean, label: string, timeout = 20000): Promise<void> => {
  const start = performance.now();
  while (!test()) {
    if (performance.now() - start > timeout) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const $ = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector);
const $$ = <T extends Element>(selector: string): T[] => [...document.querySelectorAll<T>(selector)];
const text = (selector: string): string => ($(selector)?.textContent ?? '').replace(/ | /g, ' ');

export async function checkFlameAnalysis(workspace: FlameAnalysisWorkspace): Promise<{ passed: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const check = (name: string, passed: boolean, detail?: unknown): void => {
    checks.push({ name, passed, ...(passed ? {} : { detail: JSON.stringify(detail) }) });
  };
  await wait(() => $$('.flame-analysis__tile').length > 0, 'board for E1');
  const painted = (): boolean => $$<HTMLCanvasElement>('.flame-analysis__picture').every((c) => c.width > 1);
  await wait(painted, 'pictures of E1');
  // Plots draw at their laid-out size, once their resize observer has reported it.
  await wait(() => $$('.flame-analysis__plot-svg').length === 4, 'plots of E1');

  check('the title comes from analysis.json', text('.flame-analysis__title') === 'Synthetic flame analysis test', text('.flame-analysis__title'));
  check('two events in the selector', $$('.flame-analysis__event option').length === 2);
  check('E1 shows its three cameras, the portrait one narrower', (() => {
    const tiles = $$<HTMLElement>('.flame-analysis__tile');
    const widths = tiles.map((t) => t.getBoundingClientRect().width);
    return tiles.length === 3 && widths[2] < widths[0];
  })(), $$('.flame-analysis__tile').length);
  check('six steps and the limitations', $$('.flame-analysis__step').length === 7);
  check('four plots: heat release rate, volume, area, height', $$('.flame-analysis__plot').length === 4);
  check('the heat release rate plot names its basis', text('.flame-analysis__plot caption') === 'Heat release rate, convective (kW)', text('.flame-analysis__plot caption'));
  const numbers = $$('.flame-analysis__number').map((n) => n.textContent!.replace(/ | /g, ' '));
  check('key numbers: hood peak 109 kW at +3 s', numbers.some((n) => n.startsWith('Hood peak109 kWat +3 s')), numbers);
  check('key numbers: hood heat 0.147 MJ', numbers.some((n) => n.includes('Heat released, hood0.147 MJ')), numbers);
  check('key numbers: an estimate against the hood in percent', numbers.some((n) => /^Estimate from flame volume\d+ kW \([+−]\d+ %\)heat [\d.]+ MJ \([+−]\d+ %\)$/.test(n)), numbers);
  check('the board opens on the largest flame', /^\+\d/.test(text('.flame-analysis__readout').replace('t = ', '')), text('.flame-analysis__readout'));

  // The clock: every follower reads one time.
  const stamp = (): string => text('.flame-analysis__transport .playback-bar__readout');
  ($('.flame-analysis__transport button[aria-label="First frame (Home)"]') as HTMLButtonElement).click();
  await wait(() => stamp().startsWith('-0.5 s · instant 1/36'), 'first instant');
  check('First goes to the first instant, before the onset', true);
  ($('.flame-analysis__transport button[aria-label="Next frame (.)"]') as HTMLButtonElement).click();
  await wait(() => stamp().startsWith('-0.4 s · instant 2/36'), 'next instant');
  check('Next steps one instant', true);
  check('the slider follows', ($('.flame-analysis__transport input[type=range]') as HTMLInputElement).value === '1');
  const cursorX = (): string => ($('.flame-analysis__plot-svg line[stroke="var(--plot-cursor)"]') as SVGLineElement).getAttribute('x1')!;
  const before = cursorX();
  ($('.flame-analysis__transport button[aria-label="Last frame (End)"]') as HTMLButtonElement).click();
  await wait(() => stamp().startsWith('+3 s · instant 36/36') || stamp().startsWith('+3.0 s · instant 36/36'), 'last instant');
  check('the plot cursor moves with the clock', cursorX() !== before);
  check('the legend reads the hood at the cursor', $$('.flame-analysis__value')[0].textContent !== '–');

  // Pictures: outline on and off, close-up unavailable without close-ups.
  const outline = $('.flame-analysis__outline-toggle') as HTMLButtonElement;
  outline.click();
  check('Flame outline toggles', outline.getAttribute('aria-pressed') === 'true');
  const closeup = $$<HTMLButtonElement>('.flame-analysis__cameras .flame-analysis__group button')[0];
  check('Close-up is off for a folder without close-ups', closeup.disabled);

  // A step opens its text from analysis.json and points at its panel.
  ($('.flame-analysis__step[data-step="reconstruction"]') as HTMLButtonElement).click();
  await wait(() => !$<HTMLElement>('.flame-analysis__drawer')!.hidden, 'drawer');
  check('the step text comes from analysis.json', text('.flame-analysis__drawer').includes('inside the flame outline of every camera'), text('.flame-analysis__drawer'));
  check("the event's own note follows", text('.flame-analysis__drawer').includes('built from 3 camera(s)'));
  check('the step points at the 3-D view', !!$('.flame-analysis__scene.flame-analysis--pointed'));
  check('the drawer takes focus', document.activeElement === $('.flame-analysis__drawer'));

  // Phase 3 on E1 (format 1.1): hull check, surfaces, heat released, the hood's
  // response time and the Heskestad height.
  const press = (selector: string): void => ($(selector) as HTMLButtonElement).click();
  const caption = (): string[] => $$('.flame-analysis__tile-agreement').map((e) => e.textContent!.replace(/ | /g, ' '));
  $$<HTMLButtonElement>('.flame-analysis__moments button').find((b) => b.textContent === 'Largest flame')!.click();
  press('.flame-analysis__hull-toggle');
  await wait(() => caption().filter(Boolean).length === 3, 'hull check captions');
  // Independent scanline masks in flame-analysis-coverage.test.ts predict these
  // rounded E1 values. They remain 100/100/100 at this key moment under the new
  // physical rectangles; the R14 pinhole below exposes the former inflation.
  const expectedCoverage = [100, 100, 100];
  check('E1 quantitative cube-rectangle coverage at Largest flame: camA 100 %, camB 100 %, camC 100 %',
    caption().every((c, i) => c === `3-D flame covers ${expectedCoverage[i]} % of the outline`), caption());
  const r14 = { transform: { position_m: [0, 0, 0] }, camera: { resolution_px: [200, 200], sensor_mm: [2, 4], focalLength_mm: 10 } } as CameraObject;
  const r14Coverage = coverage([Float32Array.from([93.5, 93.5, 105.5, 93.5, 105.5, 105.5, 93.5, 105.5])], projectHull(r14, [0, 0, -10], 0.1));
  check('R14 coverage is about 35.07 %, independent of the enlarged display square',
    r14Coverage !== null && Math.abs(r14Coverage - 0.35072066) < 0.01, r14Coverage);
  const scene = (workspace as unknown as { scene: { flameLook: string } }).scene;
  press('.flame-analysis__look[data-look="surface"]');
  check('the 3-D flame switches to its smoothed surface', scene.flameLook === 'surface');
  press('[data-view="site"]');
  check('view selection preserves the independently pressed Surface button',
    $('[data-look="surface"]')!.getAttribute('aria-pressed') === 'true' && $('[data-view="site"]')!.getAttribute('aria-pressed') === 'true');
  press('[data-view="flame"]');
  const plotCaptions = (): string[] => $$('.flame-analysis__plot caption').map((c) => c.textContent!);
  press('.flame-analysis__heat[data-mode="heat"]');
  check('Heat released turns the first plot into MJ', plotCaptions()[0] === 'Heat released, convective (MJ)', plotCaptions());
  press('.flame-analysis__transport button[aria-label="Last frame (End)"]');
  const heatValues = (): number[] => $$<HTMLElement>('.flame-analysis__plot[data-plot="hrr"] .flame-analysis__value').map((e) => Number(e.textContent));
  check('E1 final plotted heat equals raw key-number heat per series',
    heatValues().every((v, i) => Math.abs(v - [0.146585, 0.2043165, 0.214543][i]) < 0.0001), heatValues());
  press('.flame-analysis__heat[data-mode="rate"]');
  const toggles = (): HTMLButtonElement[] => $$<HTMLButtonElement>('.flame-analysis__charts .flame-analysis__toggle');
  toggles().find((b) => b.textContent === 'As the hood sees it')!.click();
  const legend = (): string[] => $$('.flame-analysis__legend th').map((t) => t.textContent!);
  check('As the hood sees it relabels the estimates', legend().filter((l) => l.endsWith(', as the hood sees it')).length === 2, legend());
  press('.flame-analysis__heat[data-mode="heat"]');
  check('Heat released retains the hood-response label and integrates the filtered estimates',
    legend().filter((l) => l.endsWith(', as the hood sees it')).length === 2 && Math.abs(heatValues()[1] - 0.0942522732) < 0.0001,
    [legend(), heatValues()]);
  press('.flame-analysis__heat[data-mode="rate"]');
  toggles().find((b) => b.textContent === 'Heskestad height')!.click();
  check('Heskestad height adds a predicted line and says what it assumed',
    legend().includes('Heskestad mean height (pool fire), from the hood') && text('.flame-analysis__plot-note').includes('1 - 0.3'),
    [legend(), text('.flame-analysis__plot-note')]);
  const predicted = (): boolean => $$('.flame-analysis__plot[data-plot="height"] path')
    .some((p) => p.getAttribute('stroke') === 'var(--plot-planned)' && p.getAttribute('stroke-dasharray') === '10 4');
  await wait(predicted, 'the predicted line drawn').catch(() => undefined);
  check('the predicted line takes the planned-value long dash', predicted());

  // The export panel owns focus and makes all board controls inert.
  const exportButton = $<HTMLButtonElement>('.flame-analysis__export button')!;
  exportButton.click();
  const panel = $<HTMLElement>('.flame-analysis__export-panel')!;
  check('the export panel takes focus and its board siblings are inert', panel.contains(document.activeElement)
    && [...panel.parentElement!.children].filter((e) => e !== panel).every((e) => (e as HTMLElement).inert));
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await wait(() => !$('.flame-analysis__export-panel'), 'export panel closes');
  check('closing export restores focus to Export', document.activeElement === exportButton);
  check('closing export restores the board interaction', !$<HTMLElement>('.flame-analysis__body')!.inert);

  const zoomTile = $$<HTMLButtonElement>('.flame-analysis__tile-open')[1];
  zoomTile.click();
  await wait(() => !!$('.flame-analysis__zoom'), 'full-size second camera');
  $('.flame-analysis__zoom')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('full-size picture returns focus to the camera that opened it', document.activeElement === zoomTile);

  // The second event: two cameras, its own clock.
  const select = $('.flame-analysis__event select') as HTMLSelectElement;
  select.value = 'E2';
  select.dispatchEvent(new Event('change'));
  await wait(() => $$('.flame-analysis__tile').length === 2 && painted(), 'E2 board');
  check('E2 shows two cameras', true);
  check('the drawer closes with the event change', $<HTMLElement>('.flame-analysis__drawer')!.hidden === true);
  check('the outline choice carries over', ($('.flame-analysis__outline-toggle') as HTMLButtonElement).getAttribute('aria-pressed') === 'true');
  check('E2 times are its own', /\(t_clock 16\d/.test(text('.flame-analysis__readout')), text('.flame-analysis__readout'));
  check('the 3-D view draws cubes', (workspace as unknown as { scene: { cubeCount: number } }).scene.cubeCount > 0);
  check('a format 1.0 event offers no surfaces and no hood response, and falls back to cubes',
    !$('.flame-analysis__look') && !toggles().some((b) => b.textContent === 'As the hood sees it') && scene.flameLook === 'cubes');
  // The captions come with the pictures of the instant the board seeks to, which a
  // slow machine draws after the first instant's (no flame, so no caption).
  await wait(() => caption().filter(Boolean).length === 2, 'E2 hull check captions').catch(() => undefined);
  check('the hull check carries over to E2', caption().filter(Boolean).length === 2, caption());
  press('.flame-analysis__transport button[aria-label="Last frame (End)"]');
  press('.flame-analysis__heat[data-mode="heat"]');
  check('E2 final plotted heat equals raw key-number heat per series',
    heatValues().every((v, i) => Math.abs(v - [0.08033, 0.081956, 0.095067][i]) < 0.0001), heatValues());
  press('.flame-analysis__heat[data-mode="rate"]');

  // Export: a PNG of the composition, and a short H.264 MP4 Chromium itself plays.
  const png = await workspace.exportPng(1280);
  const picture = await createImageBitmap(png);
  check('PNG export is a 1280 x 720 picture', png.type === 'image/png' && picture.width === 1280 && picture.height === 720,
    [png.type, picture.width, picture.height]);
  picture.close();
  const live = workspace as unknown as { scene: { currentFrame: number }; index: number };
  check('PNG restores the live scene to the board instant', live.scene.currentFrame === live.index);
  const onset = 160;
  const video = await workspace.exportVideo({ layout: 'board', width: 1280, from: onset, to: onset + 1, speed: 0.5 });
  check('video restores the live scene to the board instant', live.scene.currentFrame === live.index);
  const player = document.createElement('video');
  player.muted = true;
  player.src = URL.createObjectURL(video);
  await new Promise<void>((resolve, reject) => {
    player.onloadeddata = () => resolve();
    player.onerror = () => reject(new Error('the video does not load: ' + player.error?.message));
  });
  check('video export: an MP4 Chromium decodes, 1280 x 720, 2 s for 1 s at x0.5',
    video.type === 'video/mp4' && player.videoWidth === 1280 && player.videoHeight === 720 && Math.abs(player.duration - 61 / 30) < 0.05,
    [video.type, player.videoWidth, player.videoHeight, player.duration]);
  player.currentTime = 1.5;
  await new Promise<void>((resolve) => { player.onseeked = () => resolve(); });
  check('video export: seeking into it decodes a frame', player.readyState >= 2);
  URL.revokeObjectURL(player.src);
  // Exercise the actual selection/load error surface, then restore the fixture
  // for the runner's pointer, keyboard and screenshot checks.
  const source = (workspace as unknown as { source: AnalysisSource }).source;
  const eventErrors: [string, (event: EventManifest) => void, RegExp][] = [
    ['duplicate series', event => { event.series[1].id = event.series[0].id; }, /series id.*repeats/],
    ['unordered instants', event => { event.instants.t_s.reverse(); }, /strictly increasing/],
    ['event identity', event => { event.id = 'different'; }, /analysis.json lists 'E1'/],
    ['extra image camera', event => { event.images.extra = event.images.camA; }, /exactly the event's cameras/],
    ['quality outside event', event => { event.quality = { noHull: [999], outsideFrame: { camZ: [0] } }; }, /quality indices/],
    ['close-up outside picture', event => { event.images.camA.closeup = { rect_px: [999, 0, 10, 10], display_px: [10, 10] }; }, /close-up/],
    ['stored hull size mismatch', event => { event.hull.voxelSize_m *= 2; }, /voxel_size.*hull.voxelSize_m/],
  ];
  for (const [name, mutate, expected] of eventErrors) {
    const faulty: AnalysisSource = { ...source, close() {}, read: async path => {
      const bytes = await source.read(path);
      if (path !== 'E1/event.json') return bytes;
      const event = JSON.parse(new TextDecoder().decode(bytes)) as EventManifest;
      mutate(event);
      return new TextEncoder().encode(JSON.stringify(event));
    } };
    await workspace.load(faulty);
    const message = text('.flame-analysis__status--error');
    check(`${name} is a visible load error before board construction`, expected.test(message) && !$('.flame-analysis__tile'), message);
  }
  const event = JSON.parse(new TextDecoder().decode(await source.read('E1/event.json'))) as EventManifest;
  const volume = event.series.find(s => s.quantity === 'volume')!;
  const fileErrors: [string, string, (text: string) => string, RegExp][] = [
    ['outline size mismatch', 'E1/outlines/camA.json', value => {
      const data = JSON.parse(value); data.size_px = [120, 90]; return JSON.stringify(data);
    }, /size_px/],
    ['negative volume', `E1/${volume.file}`, value => {
      const rows = value.trimEnd().split('\n').map(line => line.split(','));
      rows[1][rows[0].indexOf(volume.value)] = '-1';
      return rows.map(row => row.join(',')).join('\n');
    }, /negative/],
  ];
  for (const [name, target, mutate, expected] of fileErrors) {
    const faulty: AnalysisSource = { ...source, close() {}, read: async path => {
      const bytes = await source.read(path);
      if (path !== target) return bytes;
      return new TextEncoder().encode(mutate(new TextDecoder().decode(bytes)));
    } };
    await workspace.load(faulty);
    const message = text('.flame-analysis__status--error');
    check(`${name} prevents the board from showing`, expected.test(message) && !$('.flame-analysis__tile'), message);
  }
  setLanguage('fr');
  const french: AnalysisSource = { ...source, close() {}, read: async path => {
    const bytes = await source.read(path);
    if (path !== 'E1/event.json') return bytes;
    const event = JSON.parse(new TextDecoder().decode(bytes)); event.id = 'different';
    return new TextEncoder().encode(JSON.stringify(event));
  } };
  await workspace.load(french);
  check('event errors are translated into French', text('.flame-analysis__status--error').includes('analysis.json indique « E1 »'));
  setLanguage('en');
  await workspace.load(source);
  await workspace.selectEvent('E2');
  await wait(() => $$('.flame-analysis__tile').length === 2 && painted(), 'valid board after refused folders');
  return { passed: checks.every((c) => c.passed), checks };
}
