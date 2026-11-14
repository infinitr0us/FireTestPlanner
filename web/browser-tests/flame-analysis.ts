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
  check('key numbers: an estimate is compared with the hood like for like, as the hood sees it',
    numbers.includes('Estimate from flame volume111 kWheat 0.204 MJas the hood sees it: peak −50 %, heat −36 %'), numbers);
  check('a loaded board offers another folder', !!$<HTMLElement>('.flame-analysis__another') && !$<HTMLElement>('.flame-analysis__another')!.hidden);
  check('plot lines are clipped to their plot area', $$('.flame-analysis__plot-svg').every((svg) => {
    const clip = svg.querySelector('clipPath'), paths = [...svg.querySelectorAll('path')];
    return !!clip && paths.length > 0 && paths.every((p) => p.getAttribute('clip-path') === `url(#${clip.id})`);
  }));
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
  // The share is measured once the clock rests on an instant, a moment after the picture.
  const measured = (count: number) => (): boolean => caption().length === count && caption().every((c) => /\d %/.test(c));
  await wait(measured(3), 'hull check captions');
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
  const behindZoom = (): HTMLElement[] => [...$('.flame-analysis__zoom')!.parentElement!.children]
    .filter((e) => !e.classList.contains('flame-analysis__zoom')) as HTMLElement[];
  check('the full-size picture takes focus and the board behind it is out of reach',
    $('.flame-analysis__zoom')!.contains(document.activeElement) && behindZoom().every((e) => e.inert));
  // A host, or an activation that slips through, asks for the picture again.
  await (workspace as unknown as { openZoom(camera: string): Promise<void> }).openZoom(zoomTile.dataset.camera!);
  check('one full-size picture at a time', $$('.flame-analysis__zoom').length === 1 && behindZoom().every((e) => e.inert));
  $('.flame-analysis__zoom')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('full-size picture returns focus to the camera that opened it', document.activeElement === zoomTile);
  check('closing the full-size picture gives the board back', !$('.flame-analysis__zoom') && !$<HTMLElement>('.flame-analysis__body')!.inert);
  // One panel over the board at a time, whatever a host asks for.
  exportButton.click();
  await (workspace as unknown as { openZoom(camera: string): Promise<void> }).openZoom(zoomTile.dataset.camera!);
  check('no full-size picture opens behind the export panel', !$('.flame-analysis__zoom-picture') && !!$('.flame-analysis__export-panel'));
  $('.flame-analysis__export-panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await wait(() => !$('.flame-analysis__export-panel'), 'export panel closes again');
  check('the board is given back after the export panel', !$<HTMLElement>('.flame-analysis__body')!.inert
    && !$<HTMLElement>('.flame-analysis__header')!.inert);

  // Feedback of 2026-11-13: volume in m³, the fire's label under its rim, plots drawn as
  // the event plays (on by default, in the export too), and the board without plots.
  const feedback = workspace as unknown as {
    scene: any; index: number; plotsShown: boolean; seekIndex(i: number): void;
    composer(layout: string, width: number): { canvas: HTMLCanvasElement; draw(i: number): Promise<void>; pixels(): Uint8ClampedArray };
  };
  const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const cards = (): string[] => $$('.flame-analysis__number').map((n) => n.textContent!.replace(/ | /g, ' '));
  check('flame volume is in m³ on its plot and its card', plotCaptions().includes('Flame volume (m³)')
    && cards().some((n) => /^Largest flame0\.\d+ m³/.test(n)), [plotCaptions(), cards()]);
  check('a volume reading keeps four significant digits at the plot’s largest value',
    /^\d\.\d{4}$/.test($('[data-plot=volume] .flame-analysis__value')!.textContent!), $('[data-plot=volume] .flame-analysis__value')!.textContent);

  const reveal = $<HTMLButtonElement>('.flame-analysis__reveal')!;
  const plotEnds = (): { clip: number; cursor: number; full: number; bands: boolean }[] => $$('.flame-analysis__plot-svg').map((svg) => {
    const rect = svg.querySelector('clipPath rect')!;
    const cursor = [...svg.querySelectorAll('line')].find((l) => l.getAttribute('stroke') === 'var(--plot-cursor)')!;
    return {
      clip: Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')), cursor: Number(cursor.getAttribute('x1')),
      full: Number(svg.getAttribute('width')) - 10,
      bands: [...svg.querySelectorAll('.flame-analysis__band')].every((b) => b.getAttribute('clip-path') === `url(#${rect.parentElement!.id})`),
    };
  });
  await wait(() => $$('.flame-analysis__plot-svg').length === 4, 'plots before Draw as it plays');
  check('Draw as it plays is on by default: every plot ends its lines and bands at the cursor',
    reveal.getAttribute('aria-pressed') === 'true' && plotEnds().every((p) => Math.abs(p.clip - p.cursor) < 0.5 && p.bands), plotEnds());
  feedback.seekIndex(0);
  await frame();
  const atFirst = plotEnds();
  feedback.seekIndex(1e9);
  await frame();
  const atLast = plotEnds();
  check('at the first instant nothing is drawn yet; at the last, everything',
    atFirst.every((p) => Math.abs(p.clip - 44) < 0.5) && atLast.every((p) => Math.abs(p.clip - p.full) < 0.5), [atFirst, atLast]);
  feedback.seekIndex(0);
  await frame();
  const primary = getComputedStyle(document.documentElement).getPropertyValue('--plot-primary').trim();
  const [pr, pg, pb] = [1, 3, 5].map((i) => parseInt(primary.slice(i, i + 2), 16));
  /** Pixels of the measured colour in the right part of the exported plots, at the first instant. */
  const exportedRight = async (): Promise<number> => {
    const composer = feedback.composer('board', 1280);
    await composer.draw(0);
    const { width, height } = composer.canvas, data = composer.pixels();
    let n = 0;
    for (let y = Math.round(height * 0.2); y < height * 0.95; y++) {
      for (let x = Math.round(width * 0.8); x < width * 0.97; x++) {
        const i = (y * width + x) * 4;
        if (Math.abs(data[i] - pr) < 40 && Math.abs(data[i + 1] - pg) < 40 && Math.abs(data[i + 2] - pb) < 40) n++;
      }
    }
    feedback.scene.setFrame(feedback.index);
    return n;
  };
  const revealedExport = await exportedRight();
  reveal.click();
  await wait(() => $$('.flame-analysis__plot-svg').length === 4 && plotEnds().every((p) => Math.abs(p.clip - p.full) < 0.5), 'whole plots');
  check('Draw as it plays off: every plot is whole again, and the choice is remembered',
    reveal.getAttribute('aria-pressed') === 'false' && JSON.parse(localStorage.getItem('fire-test-plan.flame-analysis.view')!).reveal === false);
  const wholeExport = await exportedRight();
  check('the exported plots draw as it plays too', wholeExport > 200 && revealedExport * 4 < wholeExport, [revealedExport, wholeExport]);
  $<HTMLButtonElement>('.flame-analysis__reveal')!.click();
  await wait(() => $$('.flame-analysis__plot-svg').length === 4, 'plots drawn as it plays again');

  // The fire's label hangs under its rim, below the flame rising from it, here and in the export.
  const fireLabel = (() => {
    let found: any;
    feedback.scene.scene.traverse((o: any) => { if (o.isCSS2DObject && o.visible && o.element.textContent === 'Steel pan, 0.4 m square') found = o; });
    return found;
  })();
  if (fireLabel) {
    feedback.scene.render();
    const anchor = fireLabel.getWorldPosition(fireLabel.position.clone()).project(feedback.scene.camera);
    const host = feedback.scene.renderer.domElement.getBoundingClientRect();
    const anchorY = host.top + ((1 - anchor.y) / 2) * host.height, top = fireLabel.element.getBoundingClientRect().top;
    check('the fire’s label hangs just below its rim', fireLabel.center.y < 0 && top > anchorY && top < anchorY + 12, [top, anchorY]);
    check('the export draws the fire’s label below its point too', feedback.scene.labelsAt(640, 360).some((l: any) => l.text === 'Steel pan, 0.4 m square' && l.below));
  } else check('the fire is labelled in the 3-D view', false, 'no visible label for the fire');

  // The board without its plots: the pictures beside the 3-D view, both larger.
  const plotsToggle = $<HTMLButtonElement>('.flame-analysis__plots-toggle')!;
  const area = (r: DOMRect): number => r.width * r.height;
  const sceneBefore = $('.flame-analysis__scene-host')!.getBoundingClientRect();
  const framesBefore = $$('.flame-analysis__tile-open').map((t) => t.getBoundingClientRect().height);
  check('the header offers the plots, shown', !plotsToggle.hidden && plotsToggle.getAttribute('aria-pressed') === 'true');
  plotsToggle.click();
  await wait(() => !!$('.flame-analysis__tiles--packed'), 'pictures packed');
  await frame();
  const left = $('.flame-analysis__left')!.getBoundingClientRect(), cams = $('.flame-analysis__cameras')!.getBoundingClientRect();
  const sceneAfter = $('.flame-analysis__scene-host')!.getBoundingClientRect();
  const framesAfter = $$('.flame-analysis__tile-open').map((t) => t.getBoundingClientRect().height);
  check('Plots off: the plots are hidden and the pictures stand beside the 3-D view, in a column no wider than they need',
    plotsToggle.getAttribute('aria-pressed') === 'false' && getComputedStyle($('.flame-analysis__charts')!).display === 'none'
    && cams.right < sceneAfter.left && Math.abs(cams.top - left.top) < 2 && cams.width < 0.56 * left.width,
    { cams: [cams.left, cams.width], scene: [sceneAfter.left, sceneAfter.width], left: left.width });
  check('Plots off: the pictures are one height and larger, and the 3-D view is larger',
    Math.max(...framesAfter) - Math.min(...framesAfter) < 1.5 && framesAfter[0] > Math.max(...framesBefore)
    && area(sceneAfter) > 1.5 * area(sceneBefore), { framesBefore, framesAfter, sceneBefore: area(sceneBefore), sceneAfter: area(sceneAfter) });
  check('Plots off: the choice is remembered', JSON.parse(localStorage.getItem('fire-test-plan.flame-analysis.view')!).plots === false);
  $<HTMLButtonElement>('.flame-analysis__export button')!.click();
  check('Plots off: the export starts from the cameras and the 3-D view, as on screen',
    ($('.flame-analysis__export-panel select') as HTMLSelectElement).value === 'cameras');
  $('.flame-analysis__export-panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await wait(() => !$('.flame-analysis__export-panel'), 'export panel closes after the layout check');
  $<HTMLButtonElement>('.flame-analysis__step[data-step=hrr]')!.click();
  await wait(() => !$('.flame-analysis__tiles--packed') && $$('.flame-analysis__plot-svg').length === 4, 'the HRR step brings the plots back');
  check('the heat release rate step brings the plots back to explain them',
    plotsToggle.getAttribute('aria-pressed') === 'true' && getComputedStyle($('.flame-analysis__charts')!).display !== 'none'
    && !!$('[data-plot=hrr].flame-analysis--pointed'));
  $<HTMLButtonElement>('.flame-analysis__step[data-step=hrr]')!.click();
  localStorage.removeItem('fire-test-plan.flame-analysis.view');

  // Heat flux (event format 1.2): E1's two gauges, the near one with two records.
  const fluxToggles = (): HTMLButtonElement[] => $$<HTMLButtonElement>('.flame-analysis__flux-toggle');
  const gaugeLabel = (id: string): any => {
    let found: any;
    feedback.scene.scene.traverse((o: any) => { if (o.isCSS2DObject && o.userData.planId === id) found = o; });
    return found;
  };
  const fluxPlot = (): Element | null => $('[data-plot=heatFlux]');
  check('heat flux: one toggle per gauge under the plots, none plotted at first',
    fluxToggles().map((b) => b.textContent).join('|') === 'Near gauge (synthetic)|Far gauge (synthetic)'
    && fluxToggles().every((b) => b.getAttribute('aria-pressed') === 'false') && !fluxPlot(), fluxToggles().map((b) => b.textContent));
  feedback.seekIndex(1e9);
  await frame();
  const near = gaugeLabel('gauge-near');
  check('heat flux: a gauge with records is labelled in 3-D with its reading, as a toggle out of the tab order',
    !!near && near.visible && /^Near gauge \(synthetic\): -?\d+\.\d kW\/m²$/.test(near.element.textContent)
    && near.element.getAttribute('role') === 'button' && near.element.tabIndex === -1 && near.element.getAttribute('aria-pressed') === 'false',
    near && [near.visible, near.element.textContent]);
  near.element.click();
  await wait(() => $$('[data-plot=heatFlux] .flame-analysis__plot-svg').length === 1, 'the heat flux plot');
  check('heat flux: a click on the gauge’s label plots both its records, and presses it here and below the plots',
    $$('[data-plot=heatFlux] tbody tr').length === 2 && near.element.getAttribute('aria-pressed') === 'true'
    && fluxToggles()[0].getAttribute('aria-pressed') === 'true' && $('[data-plot=heatFlux] caption')!.textContent === 'Heat flux (kW/m²)');
  check('heat flux: the gauge’s second record takes the measured family’s next dash',
    (() => { const keys = $$('[data-plot=heatFlux] tbody tr line'); return keys.length === 2 && !keys[0].getAttribute('stroke-dasharray') && !!keys[1].getAttribute('stroke-dasharray'); })());
  fluxToggles()[1].click();
  await wait(() => $$('[data-plot=heatFlux] tbody tr').length === 3, 'the far gauge added');
  check('heat flux: the far gauge’s toggle adds its record to the same plot', gaugeLabel('gauge-far').element.getAttribute('aria-pressed') === 'true');
  // A click near a gauge in the view: the near one, where the view draws it.
  {
    const scene = feedback.scene, box = scene.renderer.domElement.getBoundingClientRect();
    const p = gaugeLabel('gauge-near').parent.getWorldPosition(gaugeLabel('gauge-near').position.clone()).project(scene.camera);
    const x = box.left + ((p.x + 1) / 2) * box.width, y = box.top + ((1 - p.y) / 2) * box.height;
    check('heat flux: a click within a few pixels of a gauge in the view picks it', scene.gaugeAt(x + 3, y - 3) === 'gauge-near', [x, y]);
  }
  const exportedFlux = feedback.composer('board', 1280) as unknown as { source: { plots: { specs: { id: string }[] }; labelText(id: string, i: number): string } };
  check('heat flux: the export draws the plot, and each gauge’s reading at its own frame',
    exportedFlux.source.plots.specs.some((s) => s.id === 'heatFlux')
    && exportedFlux.source.labelText('gauge-near', 0) !== exportedFlux.source.labelText('gauge-near', feedback.index)
    && /^Near gauge \(synthetic\)/.test(exportedFlux.source.labelText('gauge-near', 0)));
  // Plotting a gauge while the plots are hidden shows them.
  fluxToggles().forEach((b) => b.click());
  await wait(() => !fluxPlot(), 'heat flux plot gone');
  $<HTMLButtonElement>('.flame-analysis__plots-toggle')!.click();
  await wait(() => !!$('.flame-analysis__tiles--packed'), 'plots hidden again');
  gaugeLabel('gauge-near').element.click();
  await wait(() => !$('.flame-analysis__tiles--packed') && !!fluxPlot(), 'the gauge brings the plots back');
  check('heat flux: plotting a gauge while the plots are hidden shows them',
    $<HTMLButtonElement>('.flame-analysis__plots-toggle')!.getAttribute('aria-pressed') === 'true');
  gaugeLabel('gauge-near').element.click();
  await wait(() => !fluxPlot(), 'heat flux plot gone again');
  localStorage.removeItem('fire-test-plan.flame-analysis.view');

  // The second event: two cameras, its own clock.
  const select = $('.flame-analysis__event select') as HTMLSelectElement;
  select.value = 'E2';
  select.dispatchEvent(new Event('change'));
  await wait(() => $$('.flame-analysis__tile').length === 2 && painted(), 'E2 board');
  check('E2 shows two cameras', true);
  check('E2 (format 1.0) has no heat flux: no gauge toggles, no gauge labelled in 3-D',
    !$('.flame-analysis__flux') && (() => { let shown = 0; (workspace as any).scene.scene.traverse((o: any) => {
      if (o.isCSS2DObject && o.visible && /gauge/.test(o.userData.planId ?? '')) shown++; }); return shown === 0; })());
  check('the drawer closes with the event change', $<HTMLElement>('.flame-analysis__drawer')!.hidden === true);
  check('the outline choice carries over', ($('.flame-analysis__outline-toggle') as HTMLButtonElement).getAttribute('aria-pressed') === 'true');
  check('E2 times are its own', /\(t_clock 16\d/.test(text('.flame-analysis__readout')), text('.flame-analysis__readout'));
  const e2Numbers = $$('.flame-analysis__number').map((n) => n.textContent!.replace(/ | /g, ' '));
  check('a format 1.0 event has no hood response time, so its estimates keep the raw percentages',
    e2Numbers.some((n) => /^Estimate from flame volume[\d.]+ kW \([+−]?\d+ %\)heat [\d.]+ MJ \([+−]?\d+ %\)$/.test(n)), e2Numbers);
  check('the 3-D view draws cubes', (workspace as unknown as { scene: { cubeCount: number } }).scene.cubeCount > 0);
  check('a format 1.0 event offers no surfaces and no hood response, and falls back to cubes',
    !$('.flame-analysis__look') && !toggles().some((b) => b.textContent === 'As the hood sees it') && scene.flameLook === 'cubes');
  // The captions come with the pictures of the instant the board seeks to, which a
  // slow machine draws after the first instant's (no flame, so no caption).
  await wait(measured(2), 'E2 hull check captions').catch(() => undefined);
  check('the hull check carries over to E2', measured(2)(), caption());
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
  // The composition's panel colour, at a point clear of every text and frame.
  const pixel = (source: CanvasImageSource): number[] => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(source, 0, 0, 1280, 720);
    return [...g.getImageData(8, 8, 1, 1).data.slice(0, 3)];
  };
  const pngPanel = pixel(picture);
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
  // A player reads a stream that says nothing about its range as limited range. The
  // frames are encoded that way, so what plays is what the PNG shows. This suite runs
  // without a graphics processor, where a frame taken from the canvas was encoded full
  // range and came out darker (19, 28, 49 against 3, 15, 36 before the conversion).
  const videoPanel = pixel(player);
  check('video export: the played video has the colours of the PNG, neither darker nor harsher',
    pngPanel.every((v, i) => Math.abs(v - videoPanel[i]) <= 6), [pngPanel, videoPanel]);
  // The same instant as a PNG (the frame at 1.5 s shows the source time onset + 0.75 s),
  // compared over the whole frame: all of it, its dark part and its bright part.
  const frameOf = (source: CanvasImageSource): Uint8ClampedArray => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(source, 0, 0, 1280, 720);
    return g.getImageData(0, 0, 1280, 720).data;
  };
  const board = workspace as unknown as { loaded: { event: EventManifest }; seekIndex(index: number): void };
  const shownAt = onset + 1.5 * 0.5;
  board.seekIndex(board.loaded.event.instants.t_s.filter((t) => t <= shownAt + 1e-6).length - 1);
  const still = await createImageBitmap(await workspace.exportPng(1280));
  const a = frameOf(still), b = frameOf(player);
  still.close();
  const luma = (d: Uint8ClampedArray, i: number): number => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const sums = { all: [0, 0, 0], dark: [0, 0, 0], bright: [0, 0, 0] };
  for (let i = 0; i < a.length; i += 4) {
    const la = luma(a, i), lb = luma(b, i);
    for (const part of ['all', la < 40 ? 'dark' : '', la > 200 ? 'bright' : ''] as (keyof typeof sums | '')[]) {
      if (part) { sums[part][0] += la; sums[part][1] += lb; sums[part][2] += 1; }
    }
  }
  const means = Object.fromEntries(Object.entries(sums).map(([part, [pa, pb, n]]) => [part, [pa / n, pb / n, n]]));
  check('video export: mean luma of the played frame matches the PNG of its instant, overall and in the dark and bright parts',
    means.dark[2] > 10000 && means.bright[2] > 1000 && Math.abs(means.all[0] - means.all[1]) < 3
    && Math.abs(means.dark[0] - means.dark[1]) < 3 && Math.abs(means.bright[0] - means.bright[1]) < 8, means);
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

  // One 3-D flame file among many cannot be read: the message naming it stays, whatever
  // the readers still at work finish afterwards.
  const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const hullFile = `E1/${event.files.hull.replace('{stem}', event.instants.stem[5])}`;
  let reading = 0, finished = 0;
  const brokenHull: AnalysisSource = { ...source, close() {}, read: async path => {
    if (path === hullFile) throw new Error(`Missing file: ${path}`);
    if (!path.includes('/hull/')) return source.read(path);
    reading += 1;
    try { return await source.read(path); } finally { reading -= 1; finished += 1; }
  } };
  await workspace.load(brokenHull);
  // The readers at work finish the file they had; give them their turn to ask for more.
  await wait(() => reading === 0, 'the other 3-D flame readers');
  await pause(400);
  check('an unreadable 3-D flame file stays named on screen after the other files are read',
    text('.flame-analysis__status--error').includes(hullFile) && !$('.flame-analysis__tile'), text('.flame-analysis__status'));
  check('the other readers stop after the first unreadable file', reading === 0 && finished <= 12, [finished, event.instants.stem.length]);
  check('a failed event keeps its folder open: its other events and another folder are still offered',
    !$<HTMLElement>('.flame-analysis__event')!.hidden && !$<HTMLElement>('.flame-analysis__another')!.hidden);
  select.value = 'E2';
  select.dispatchEvent(new Event('change'));
  await wait(() => $$('.flame-analysis__tile').length === 2 && painted(), 'E2 after a failed E1');
  check('the other event of that folder opens from the selector', true);

  // Another folder in the same workspace: its own site and camera names in the 3-D view.
  const json = (bytes: Uint8Array): any => JSON.parse(new TextDecoder().decode(bytes));
  const bytesOf = (data: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(data));
  const site = (workspace as unknown as { scene: { site: { children: unknown[]; traverse(f: (o: any) => void): void } } }).scene.site;
  const siteLabels = (): string[] => {
    const labels: string[] = [];
    site.traverse((o) => { if (o.isCSS2DObject && o.visible) labels.push(o.element.textContent); });
    return labels;
  };
  const objectsBefore = site.children.length;
  const second: AnalysisSource = { ...source, close() {}, read: async path => {
    const bytes = await source.read(path);
    if (path === 'analysis.json') {
      const data = json(bytes);
      data.cameras.forEach((c: { label?: string }, i: number) => { c.label = `Second ${i + 1}`; });
      return bytesOf(data);
    }
    if (path === 'site.ftp.json') {
      const plan = json(bytes);
      plan.objects = plan.objects.filter((o: { type: string }) => o.type !== 'hood');
      return bytesOf(plan);
    }
    return bytes;
  } };
  await workspace.load(second);
  await wait(() => $$('.flame-analysis__tile').length === 3 && painted(), 'second folder');
  check('another folder brings its own site and camera names into the 3-D view',
    siteLabels().filter((l) => l.startsWith('Second ')).length === 3 && site.children.length === objectsBefore - 1,
    [siteLabels(), site.children.length, objectsBefore]);

  // Eight cameras, the most the format allows: the tiles keep the clock's instant.
  const ids = Array.from({ length: 8 }, (_, i) => `cam${i + 1}`);
  const asCamA = (path: string): string => path.replace(/^E1\/frames\/cam\d+\//, 'E1/frames/camA/').replace(/^E1\/outlines\/cam\d+\.json$/, 'E1/outlines/camA.json');
  const eight: AnalysisSource = { ...source, close() {}, blob: path => source.blob(asCamA(path)), read: async path => {
    const data = await source.read(asCamA(path));
    if (path === 'analysis.json') {
      const manifest = json(data);
      manifest.cameras = ids.map((id) => ({ id, planCameraId: 'camA' }));
      manifest.events = manifest.events.filter((e: { id: string }) => e.id === 'E1');
      return bytesOf(manifest);
    }
    if (path === 'E1/event.json') {
      const manifest = json(data);
      manifest.cameras = ids;
      manifest.images = Object.fromEntries(ids.map((id) => [id, manifest.images.camA]));
      return bytesOf(manifest);
    }
    const outline = /^E1\/outlines\/(cam\d+)\.json$/.exec(path);
    return outline ? bytesOf({ ...json(data), camera: outline[1] }) : data;
  } };
  await workspace.load(eight);
  await wait(() => $$('.flame-analysis__tile').length === 8 && painted(), 'eight cameras');
  const inner = workspace as unknown as {
    index: number; playhead: { play(): void; pause(): void; setLoop(loop: boolean): void };
    loaded: { tiles: { tiles: Map<string, { drawn: number; caption: HTMLElement }> } };
  };
  inner.playhead.setLoop(true);
  ($('.flame-analysis__transport button[aria-label="First frame (Home)"]') as HTMLButtonElement).click();
  inner.playhead.play();
  await wait(() => inner.index >= 8, 'the clock advancing with eight cameras', 60000).catch(() => undefined);
  const reached = inner.index;
  inner.playhead.pause();
  inner.playhead.setLoop(false);
  const settled = (): boolean => [...inner.loaded.tiles.tiles.values()].every((t) => t.drawn === inner.index);
  await wait(settled, 'eight tiles on the clock').catch(() => undefined);
  const eightTiles = [...inner.loaded.tiles.tiles.values()];
  check('eight cameras: after playback every tile shows the instant on the clock, with no error in a caption',
    reached >= 8 && settled() && eightTiles.every((t) => !t.caption.textContent!.includes('·')),
    [reached, inner.index, eightTiles.map((t) => t.drawn), eightTiles.map((t) => t.caption.textContent)]);
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
