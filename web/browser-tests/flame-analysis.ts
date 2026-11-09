/**
 * DOM checks of the flame analysis board on the synthetic test
 * (fixtures/flame-analysis). Run by run.mjs through flame-analysis.html?check=1;
 * real keys and pointer input are sent by the runner itself.
 */

import type { FlameAnalysisWorkspace } from '../src/ui/flame-analysis';

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
  check('hull check: every E1 camera says how much of its outline the 3-D flame covers (all of it: the hull contains the flame)',
    caption().every((c) => c === '3-D flame covers 100 % of the outline'), caption());
  const scene = (workspace as unknown as { scene: { flameLook: string } }).scene;
  press('.flame-analysis__look[data-look="surface"]');
  check('the 3-D flame switches to its smoothed surface', scene.flameLook === 'surface');
  const plotCaptions = (): string[] => $$('.flame-analysis__plot caption').map((c) => c.textContent!);
  press('.flame-analysis__heat[data-mode="heat"]');
  check('Heat released turns the first plot into MJ', plotCaptions()[0] === 'Heat released, convective (MJ)', plotCaptions());
  press('.flame-analysis__heat[data-mode="rate"]');
  const toggles = (): HTMLButtonElement[] => $$<HTMLButtonElement>('.flame-analysis__charts .flame-analysis__toggle');
  toggles().find((b) => b.textContent === 'As the hood sees it')!.click();
  const legend = (): string[] => $$('.flame-analysis__legend th').map((t) => t.textContent!);
  check('As the hood sees it relabels the estimates', legend().filter((l) => l.endsWith(', as the hood sees it')).length === 2, legend());
  toggles().find((b) => b.textContent === 'Heskestad height')!.click();
  check('Heskestad height adds a predicted line and says what it assumed',
    legend().includes('Heskestad mean height (pool fire), from the hood') && text('.flame-analysis__plot-note').includes('1 - 0.3'),
    [legend(), text('.flame-analysis__plot-note')]);
  const predicted = (): boolean => $$('.flame-analysis__plot[data-plot="height"] path')
    .some((p) => p.getAttribute('stroke') === 'var(--plot-planned)' && p.getAttribute('stroke-dasharray') === '10 4');
  await wait(predicted, 'the predicted line drawn').catch(() => undefined);
  check('the predicted line takes the planned-value long dash', predicted());

  // The second event: two cameras, its own clock.
  const select = $('.flame-analysis__event select') as HTMLSelectElement;
  select.value = 'E2';
  select.dispatchEvent(new Event('change'));
  await wait(() => $$('.flame-analysis__tile').length === 2 && painted(), 'E2 board');
  check('E2 shows two cameras', true);
  check('the drawer closes with the event change', $<HTMLElement>('.flame-analysis__drawer')!.hidden);
  check('the outline choice carries over', ($('.flame-analysis__outline-toggle') as HTMLButtonElement).getAttribute('aria-pressed') === 'true');
  check('E2 times are its own', /\(t_clock 16\d/.test(text('.flame-analysis__readout')), text('.flame-analysis__readout'));
  check('the 3-D view draws cubes', (workspace as unknown as { scene: { cubeCount: number } }).scene.cubeCount > 0);
  check('a format 1.0 event offers no surfaces and no hood response, and falls back to cubes',
    !$('.flame-analysis__look') && !toggles().some((b) => b.textContent === 'As the hood sees it') && scene.flameLook === 'cubes');
  // The captions come with the pictures of the instant the board seeks to, which a
  // slow machine draws after the first instant's (no flame, so no caption).
  await wait(() => caption().filter(Boolean).length === 2, 'E2 hull check captions').catch(() => undefined);
  check('the hull check carries over to E2', caption().filter(Boolean).length === 2, caption());

  // Export: a PNG of the composition, and a short H.264 MP4 Chromium itself plays.
  const png = await workspace.exportPng(1280);
  const picture = await createImageBitmap(png);
  check('PNG export is a 1280 x 720 picture', png.type === 'image/png' && picture.width === 1280 && picture.height === 720,
    [png.type, picture.width, picture.height]);
  const onset = 160;
  const video = await workspace.exportVideo({ layout: 'board', width: 1280, from: onset, to: onset + 1, speed: 0.5 });
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
  return { passed: checks.every((c) => c.passed), checks };
}
