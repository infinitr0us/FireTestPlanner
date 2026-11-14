// Browser regressions without an additional automation dependency.
// Uses Chromium's DevTools protocol for real keyboard/mouse default actions.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { accessibility } from './accessibility.mjs';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Slow machines (CI runners render WebGL in software) can raise the limit for
// every wait and DevTools call with BROWSER_TEST_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.BROWSER_TEST_TIMEOUT_MS) || 15000;
const waitFor = async (predicate, label, timeout = TIMEOUT_MS) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await predicate();
    if (result) return result;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Timed out: ' + label);
};
const candidates = [
  process.env.BROWSER_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
let executable;
for (const candidate of candidates) {
  try { await access(candidate); executable = candidate; break; } catch {}
}
if (!executable) throw new Error('Set BROWSER_BIN to a Chromium, Chrome or Edge executable.');
const profileBase = resolve(web, '../review');
await mkdir(profileBase, { recursive: true });
const profile = await mkdtemp(join(profileBase, 'fireplan-browser-'));
const server = await createServer({ root: web, server: { host: '127.0.0.1', port: 0, open: false } });
let browser, socket, send;
const checks = [], errors = [];
// Progress on stderr, so a timeout on a slow machine says which phase it was in;
// stdout stays the JSON report.
const started = Date.now();
const phase = label => console.error('[browser-tests] ' + ((Date.now() - started) / 1000).toFixed(1) + ' s  ' + label);
const check = (name, ok) => {
  if (!ok) throw new Error(name);
  checks.push({ name, passed: true });
};
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = 'http://127.0.0.1:' + address.port;
  browser = spawn(executable, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let browserLog = '';
  browser.stderr.on('data', chunk => { browserLog += chunk; });
  browser.on('error', error => errors.push(error.message));
  const portFile = await waitFor(async () => {
    try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return false; }
  }, 'Chromium DevTools endpoint');
  const [port, path] = portFile.trim().split(/\r?\n/);
  socket = new WebSocket('ws://127.0.0.1:' + port + path);
  await waitFor(() => socket.readyState === WebSocket.OPEN, 'Chromium DevTools WebSocket connection');
  let id = 0, sessionId;
  const pending = new Map();
  // Protocol events other than exceptions, for waits such as a file chooser opening.
  const eventListeners = new Set();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails;
      errors.push(detail.exception?.description ?? detail.text);
    } else {
      for (const listener of eventListeners) listener(message);
    }
  });
  send = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error('CDP timeout: ' + method + '\n' + browserLog)); }, TIMEOUT_MS);
    pending.set(next, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: next, method, params, ...(session ? { sessionId: session } : {}) }));
  });
  let targetId;
  // A fresh tab per page under test: navigating away from a page still busy with
  // software WebGL can stall for minutes on a slow runner.
  const openTab = async () => {
    const previous = targetId;
    ({ targetId } = await send('Target.createTarget', { url: 'about:blank' }, null));
    ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    if (previous) await send('Target.closeTarget', { targetId: previous }, null);
  };
  phase('browser ready');
  await openTab();
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  const screenshot = async name => {
    if (!process.env.BROWSER_TEST_OUTPUT) return;
    const folder = dirname(resolve(process.env.BROWSER_TEST_OUTPUT));
    await mkdir(folder, { recursive: true });
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(folder, name + '.png'), Buffer.from(data, 'base64'));
  };
  const key = async (key, code, keyCode) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode,
      ...(key === ' ' ? { text: ' ' } : key === 'Enter' ? { text: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  };
  const click = async expression => {
    const point = await evaluate('(() => { const e = ' + expression + '; e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  if (process.env.BROWSER_TEST_PHASE !== 'a11y') {
  phase('opening alignment and gas units');
  await send('Page.navigate', { url: origin + '/browser-tests/instruments17.html' });
  const align = "[...document.querySelectorAll('#inspector button')].find(b=>b.textContent==='Align with opening')";
  await waitFor(() => evaluate('!!(' + align + ')'), 'alignment inspector');
  check('nearby opening enables alignment', await evaluate('!(' + align + ').disabled'));
  await click(align);
  await waitFor(() => evaluate("Math.abs(JSON.parse(document.querySelector('#state').textContent).axis[1]+1)<1e-8"), 'aligned opening normal');
  check('real alignment click sets the opening normal', true);
  await click("[...document.querySelectorAll('#actions button')].find(b=>b.textContent==='Undo')");
  await waitFor(() => evaluate("Math.abs(JSON.parse(document.querySelector('#state').textContent).axis[0]-1)<1e-8"), 'undo opening alignment');
  const xField = "[...document.querySelectorAll('#inspector label.field')].find(l=>l.querySelector('.field__label')?.textContent==='Position (m)').querySelector('input')";
  await click(xField); await evaluate(xField + '.select()');
  await send('Input.insertText', { text: '20' }); await key('Tab', 'Tab', 9);
  await waitFor(() => evaluate('(' + align + ').disabled'), 'distant opening disables alignment');
  check('alignment beyond 1 m is disabled with a reason', await evaluate('(' + align + ').title.includes("1 m")'));
  await screenshot('instruments17-alignment-disabled');
  await click("[...document.querySelectorAll('#actions button')].find(b=>b.textContent==='Select gas')");
  await waitFor(() => evaluate("document.querySelector('#inspector').textContent.includes('Gas logger: oxygen')"), 'mapped gas unit');
  check('gas inspector shows the recorded column unit', await evaluate("[...document.querySelectorAll('#inspector .readout')].some(r=>r.textContent==='Gas logger: oxygen%')"));
  await screenshot('instruments17-gas-unit');
  await openTab();
  phase('HRR curve inspector and drawing');
  await send('Page.navigate', { url: origin + '/browser-tests/hrr.html' });
  const hrrReport = await waitFor(async () => {
    const text = await evaluate('document.querySelector("#report")?.textContent');
    try { const r = JSON.parse(text); if (r.error) throw new Error(r.error); return r.passed ? r : false; } catch (e) { if (text?.includes('"error"')) throw e; return false; }
  }, 'HRR fixture checks');
  for (const item of hrrReport.results) check(item.name, item.passed);
  await evaluate(`Array.from(document.querySelectorAll('#inspector button')).find(b => b.textContent === 'Remove curve').focus()`);
  check('Remove curve is keyboard focusable', await evaluate(`document.activeElement.textContent === 'Remove curve'`));
  await screenshot('hrr');
  await key(' ', 'Space', 32);
  await waitFor(() => evaluate(`!document.querySelector('.hrr-curve') && Array.from(document.querySelectorAll('#inspector label')).some(l => l.textContent.includes('HRR (kW)'))`), 'remove curve');
  check('Space removes the curve and restores the steady HRR field', true);
  await click('document.querySelector("#undo")');
  await waitFor(() => evaluate(`!!document.querySelector('.hrr-curve')`), 'undo curve removal');
  check('undo restores the curve', true);
  await click('document.querySelector("#redo")');
  await waitFor(() => evaluate(`!document.querySelector('.hrr-curve')`), 'redo curve removal');
  check('redo removes the curve', true);
  await click('document.querySelector("#undo")');
  await waitFor(() => evaluate(`!!document.querySelector('.hrr-curve')`), 'restore before saving');
  await click('document.querySelector("#save")');
  await waitFor(() => evaluate(`document.querySelector('.hrr-curve')?.textContent.includes('peak 300 kW at 26 s')`), 'saved curve reload');
  check('save and reopen retain the HRR readout', true);
  await evaluate(`document.querySelector('#inspector').style.width = '260px'`);
  await screenshot('hrr-narrow');
  await evaluate(`Array.from(document.querySelectorAll('#drawing tr')).find(r => r.textContent.includes('Curve: 5 points')).scrollIntoView({block:'center'})`);
  await screenshot('hrr-equipment');
  await click('document.querySelector("#preview")');
  await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.import__issue')).some(e => e.textContent.includes('Curve: 5 points, peak 300 kW at 26 s, source fds-ramp:burner_steps'))`), 'curve import preview');
  check('FDS import preview reports the curve', true);
  await screenshot('hrr-import');
  await openTab();
  phase('DOM/WebGL regression page');
  await send('Page.navigate', { url: origin + '/browser-tests/visual-consistency.html?interactive=1' });
  const report = await waitFor(async () => {
    const text = await evaluate('document.querySelector("#report")?.textContent ?? ""');
    if (text.includes('FAILED:')) throw new Error(text);
    try { const result = JSON.parse(text); return result.passed ? result : false; } catch { return false; }
  }, 'DOM/WebGL regression page');
  checks.push(...report.checks);
  phase('results transport keys');
  await evaluate('document.querySelector("dialog details").open=false; document.querySelector("dialog summary").focus()');
  await key(' ', 'Space', 32);
  check('native Space opens coverage without playing', await evaluate('document.querySelector("dialog details").open && !!document.querySelector("button[aria-label=\\"Play (Space)\\"]")'));
  await key(' ', 'Space', 32);
  check('native Space closes coverage without playing', await evaluate('!document.querySelector("dialog details").open && !!document.querySelector("button[aria-label=\\"Play (Space)\\"]")'));
  const first = 'document.querySelector("dialog button[aria-label=\\"First frame (Home)\\"]")';
  await click(first);
  await key('.', 'Period', 190);
  await waitFor(() => evaluate('document.querySelector("[aria-label=\\"Simulation frame\\"]").value==="1"'), 'results step after mouse click');
  check('results period works after mouse click on transport', true);
  await evaluate('document.querySelector("[aria-label=\\"Simulation frame\\"]").focus()');
  await key('End', 'End', 35);
  await waitFor(() => evaluate('document.querySelector("[aria-label=\\"Simulation frame\\"]").value==="2"'), 'native slider End');
  await key('Home', 'Home', 36);
  await waitFor(() => evaluate('document.querySelector("[aria-label=\\"Simulation frame\\"]").value==="0"'), 'native slider Home');
  check('native results slider Home/End seek frames', true);
  const resultsSpeeds = await evaluate('[...document.querySelector("dialog [aria-label=\\"Playback speed\\"]").options].map(o=>[o.value,o.textContent])');
  await screenshot('results');
  const resultsStyle = await evaluate('(() => { const s=getComputedStyle(document.querySelector("dialog .playback-bar__btn")); return [s.fontFamily,s.fontSize,s.lineHeight,s.padding,s.borderRadius]; })()');

  phase('flame analysis board');
  // The synthetic test (fixtures/flame-analysis): the page's own DOM checks, then
  // real keys and clicks on the board.
  await openTab();
  await send('Page.navigate', { url: origin + '/browser-tests/flame-analysis.html?check=1' });
  const board = await waitFor(async () => {
    const text = await evaluate('document.querySelector("#report")?.textContent ?? ""');
    if (text.includes('FAILED:')) throw new Error(text);
    try { const result = JSON.parse(text); return result.checks ? result : false; } catch { return false; }
  }, 'flame analysis board checks', Math.max(TIMEOUT_MS, 60000));
  for (const c of board.checks) check('flame analysis: ' + c.name + (c.passed ? '' : ' ' + c.detail), c.passed);
  const boardStamp = 'document.querySelector(".flame-analysis__transport .playback-bar__readout").textContent';
  const boardIndex = async () => Number((await evaluate(boardStamp)).match(/instant (\d+)\//)[1]);
  await evaluate('document.querySelector(".flame-analysis__scene-host canvas").focus()');
  const startIndex = await boardIndex();
  await key('.', 'Period', 190);
  await waitFor(async () => (await boardIndex()) === startIndex + 1, 'board period step');
  check('board: a real period key steps one instant', true);
  await key(' ', 'Space', 32);
  await waitFor(async () => (await boardIndex()) >= startIndex + 3, 'board playback');
  await key(' ', 'Space', 32);
  await waitFor(() => evaluate('document.querySelector(".flame-analysis__transport button[aria-label=\\"Play (Space)\\"]") !== null'), 'board pause');
  const paused = await boardIndex();
  await new Promise(r => setTimeout(r, 400));
  check('board: Space plays at real time and Space pauses', (await boardIndex()) === paused);
  await click('document.querySelector(".flame-analysis__step[data-step=hrr]")');
  await waitFor(() => evaluate('!document.querySelector(".flame-analysis__drawer").hidden'), 'board drawer');
  check('board: the heat release rate step points at its plot, its text beside the pictures', await evaluate(
    '!!document.querySelector(".flame-analysis__plot[data-plot=hrr].flame-analysis--pointed") && document.querySelector(".flame-analysis__drawer").classList.contains("flame-analysis__drawer--left")'));
  await key('Escape', 'Escape', 27);
  check('board: Escape closes the step text and returns focus to its step', await evaluate(
    'document.querySelector(".flame-analysis__drawer").hidden && document.activeElement?.dataset.step === "hrr" && document.querySelector("dialog.flame-analysis").open'));
  await click('document.querySelector(".flame-analysis__tile-open")');
  await waitFor(() => evaluate('(document.querySelector(".flame-analysis__zoom-picture")?.width ?? 0) > 1'), 'board full-resolution view');
  await key('Escape', 'Escape', 27);
  check('board: a tile opens its picture full size and Escape closes it, not the board', await evaluate(
    '!document.querySelector(".flame-analysis__zoom") && document.querySelector("dialog.flame-analysis").open'));
  await screenshot('flame-analysis');
  // Export video through its panel with real clicks; the browser download goes to
  // the run's temporary profile, not the user's Downloads folder.
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: profile }, null);
  await click('[...document.querySelectorAll(".flame-analysis__export button")].find(b=>b.textContent==="Export video…")');
  await waitFor(() => evaluate('!!document.querySelector(".flame-analysis__export-panel")'), 'export panel');
  check('board: the export panel takes focus and says what it will make', await evaluate(
    'document.activeElement === document.querySelector(".flame-analysis__export-panel select") && document.querySelector(".flame-analysis__export-panel").textContent.includes("frames at 30 per second, H.264 MP4")'));
  await evaluate(`(() => {
    const [layout, size, from, to] = document.querySelectorAll('.flame-analysis__export-panel select');
    from.value = from.options[from.options.length - 2].value; to.value = to.options[0].value; from.dispatchEvent(new Event('change'));
    return true; })()`);
  check('board: an empty range turns Export off and says why', await evaluate(
    'document.querySelector(".flame-analysis__export-panel .btn--primary").disabled && document.querySelector(".flame-analysis__export-panel").textContent.includes("The end must come after the start.")'));
  await evaluate(`(() => {
    const [layout, size, from, to] = document.querySelectorAll('.flame-analysis__export-panel select');
    size.value = '1280'; from.value = from.options[1].value; to.value = to.options[1].value;
    for (const s of [size, from, to]) s.dispatchEvent(new Event('change'));
    window.workspace.lastVideo = undefined; return true; })()`);
  await click('document.querySelector(".flame-analysis__export-panel .btn--primary")');
  await waitFor(() => evaluate('/^Saved .*\\.mp4\\.$/.test(document.querySelector(".flame-analysis__export-panel [role=status]").textContent)'), 'video export through the panel', Math.max(TIMEOUT_MS, 120000));
  check('board: Export makes and saves an MP4 through the panel', await evaluate('window.workspace.lastVideo?.type === "video/mp4" && window.workspace.lastVideo.size > 10000'));
  await key('Escape', 'Escape', 27);
  check('board: Escape closes the export panel, not the board', await evaluate(
    '!document.querySelector(".flame-analysis__export-panel") && !!document.querySelector("dialog.flame-analysis[open]")'));
  await key('Escape', 'Escape', 27);
  check('board: Escape then leaves the board', await evaluate('!document.querySelector("dialog.flame-analysis[open]")'));
  phase('flame analysis board in French at 1280 x 720');
  await openTab();
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin + '/browser-tests/flame-analysis.html?lang=fr' });
  await waitFor(() => evaluate('document.querySelectorAll(".flame-analysis__picture").length===3 && [...document.querySelectorAll(".flame-analysis__picture")].every(c=>c.width>1)'), 'French board', Math.max(TIMEOUT_MS, 60000));
  const frenchBoard = await evaluate(`({
    steps: [...document.querySelectorAll('.flame-analysis__step')].map(b => b.textContent),
    plots: [...document.querySelectorAll('.flame-analysis__plot caption')].map(c => c.textContent),
    overflow: [...document.querySelectorAll('.flame-analysis__header, .flame-analysis__steps, .flame-analysis__panel-bar, .flame-analysis__transport, .flame-analysis__number')]
      .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className),
    plotsFit: [...document.querySelectorAll('.flame-analysis__plot-svg')].every(s => s.getBoundingClientRect().height > 50),
    // A laptop screen shows every plot without scrolling and the playback bar on one row,
    // with four key moments (as a real delivery has), and each moment's label inside its plot.
    chartsScroll: (c => c.scrollHeight - c.clientHeight)(document.querySelector('.flame-analysis__plots')),
    // The plot bar's toggles take a second row at this size (Draw as it plays did not
    // fit beside the others); the plots list may lose that row, and nothing else.
    barExtra: (b => { const s = getComputedStyle(b);
      return b.offsetHeight - Math.max(...[...b.children].map(c => c.offsetHeight)) - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom); })(
      document.querySelector('.flame-analysis__charts > .flame-analysis__panel-bar')),
    // And the heat flux gauges' toggles under the plots (event format 1.2).
    fluxRow: (r => r ? r.offsetHeight : 0)(document.querySelector('.flame-analysis__flux')),
    transportHeight: Math.round(document.querySelector('.flame-analysis__transport').getBoundingClientRect().height),
    moments: document.querySelectorAll('.flame-analysis__moments button').length,
    labelsInside: [...document.querySelectorAll('.flame-analysis__moment-label')].every(t => {
      const b = t.getBBox(); return b.x >= 0 && b.x + b.width <= t.ownerSVGElement.getBoundingClientRect().width + 1;
    }),
  })`);
  check('French board: steps and plots in French, nothing overflows at 1280 x 720: ' + JSON.stringify(frenchBoard),
    frenchBoard.steps.some(s => s.includes('Flamme 3D')) && frenchBoard.plots[0].startsWith('Taux de dégagement de chaleur, convectif')
    && frenchBoard.overflow.length === 0 && frenchBoard.plotsFit);
  check('French board at 1280 x 720: every plot without scrolling but for a second row of the plot bar and the gauge toggles, the playback bar on one row, moment labels inside: '
    + JSON.stringify(frenchBoard), frenchBoard.chartsScroll <= frenchBoard.barExtra + frenchBoard.fluxRow + 1 && frenchBoard.fluxRow < 40 && frenchBoard.barExtra < 45 && frenchBoard.transportHeight < 50
    && frenchBoard.moments === 4 && frenchBoard.labelsInside);
  await screenshot('flame-analysis-fr');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // Exercise the built single-file editor, including its window-level key routing.
  phase('built editor');
  await openTab();
  await send('Page.navigate', { url: origin + '/dist/index.html' });
  await waitFor(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="Example")'), 'built editor');
  phase('Example flame playback');
  await click('[...document.querySelectorAll("button")].find(b=>b.textContent==="Example")');
  await waitFor(() => evaluate('!!document.querySelector(".playback-bar:not([hidden]) input[aria-label=\\"Frame\\"]:not(:disabled)")'), 'example flame');
  const editorFirst = 'document.querySelector(".playback-bar button[aria-label=\\"First frame (Home)\\"]")';
  phase('Example FDS device export');
  const exportButton = '[...document.querySelectorAll("button")].find(b=>b.textContent==="Export to FDS…")';
  await click('document.querySelector("#fds-menu-button")');
  await click(exportButton);
  await waitFor(() => evaluate('!!document.querySelector("dialog.fds-export[open]")'), 'FDS export dialog');
  check('Example export reports quantities and omissions', await evaluate(
    'document.querySelector(".fds-export__summary").textContent === "9 devices: 2 gauge heat flux, 3 thermocouple beads, 4 surface thermocouple beads. Cameras and geometry are not exported."'));
  const firstExportedDevice = await evaluate('document.querySelector(".fds-export__text").value.split("\\n").find(line=>line.startsWith("&DEVC"))');
  check('Example export first DEVC retains its position and normal', firstExportedDevice ===
    "&DEVC ID='East wall gauge', XYZ=1.45,0,0.9, QUANTITY='GAUGE HEAT FLUX', IOR=-1, ORIENTATION=-0.9946,0.0000,-0.1043 /");
  check('FDS preview is read only, focused and uses shared monospace', await evaluate(
    '(() => { const t=document.querySelector(".fds-export__text"); return t.readOnly && document.activeElement===t && getComputedStyle(t).fontFamily.includes("Cascadia Mono"); })()'));
  await screenshot('fds-export');
  await key('Escape', 'Escape', 27);
  check('Escape closes FDS preview and restores toolbar focus', await evaluate(
    '!document.querySelector("dialog.fds-export") && document.activeElement.id === "fds-menu-button"'));
  await click(editorFirst);
  await key('.', 'Period', 190);
  await waitFor(() => evaluate('document.querySelector(".playback-bar input[aria-label=\\"Frame\\"]").value==="1"'), 'editor step after mouse click');
  check('built editor period works after mouse click on transport', true);
  await key('End', 'End', 35);
  await waitFor(() => evaluate('(() => {const e=document.querySelector(".playback-bar input[aria-label=\\"Frame\\"]");return e.value===e.max;})()'), 'editor last frame');
  await key('Home', 'Home', 36);
  await waitFor(() => evaluate('document.querySelector(".playback-bar input[aria-label=\\"Frame\\"]").value==="0"'), 'editor first frame');
  check('built editor Home/End work with transport button focused', true);
  const editorStyle = await evaluate('(() => { const s=getComputedStyle(document.querySelector(".playback-bar__btn")); return [s.fontFamily,s.fontSize,s.lineHeight,s.padding,s.borderRadius]; })()');
  check('editor and results transport typography and dimensions match', JSON.stringify(resultsStyle)===JSON.stringify(editorStyle));
  const editorSpeeds = await evaluate('[...document.querySelector(".playback-bar [aria-label=\\"Playback speed\\"]").options].map(o=>[o.value,o.textContent])');
  check('editor and results expose identical playback speeds', JSON.stringify(resultsSpeeds)===JSON.stringify(editorSpeeds));
  // The bundled Example must render the synthetic payload, including a nonempty
  // frame and its matching CSV cursor; a loaded manifest alone is insufficient.
  for (let i = 0; i < 11; i += 1) await key('.', 'Period', 190);
  const frameValue = 'document.querySelector(".playback-bar input[aria-label=\\"Frame\\"]").value';
  await waitFor(() => evaluate(frameValue + '==="11"'), 'synthetic frame at 55 s');
  check('synthetic Example draws the pinned surface count at 55 s',
    /frame 12\/80.*4[,\s]?758 cubes/.test(await evaluate('document.querySelector(".playback-bar__readout").textContent')));
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("Heptane pan"))');
  await waitFor(() => evaluate('document.querySelector(".plot-panel input[aria-label=\\"Measurement sample\\"]")?.value==="11"'), 'synthetic CSV cursor at 55 s');
  check('synthetic Example CSV follows the flame frame', true);
  await click('document.querySelector(".playback-bar button[aria-label=\\"Play (Space)\\"]")');
  await waitFor(() => evaluate('Number(' + frameValue + ')>11'), 'synthetic Example playback advances');
  await click('document.querySelector(".playback-bar button[aria-label=\\"Pause (Space)\\"]")');
  check('synthetic Example plays and pauses', true);
  // Return to the pinned nonempty frame for visual review and later input checks.
  await click(editorFirst);
  for (let i = 0; i < 11; i += 1) await key('.', 'Period', 190);
  await screenshot('editor');

  phase('inspector editing');
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("East wall gauge"))');
  const losReadout = label => '[...document.querySelectorAll("#inspector .readout")].find(r=>r.querySelector(".readout__label").textContent==="' + label + '")';
  await waitFor(() => evaluate(losReadout('Line of sight') + '?.querySelector(".readout__value").textContent==="100%"'), 'Example gauge line of sight');
  check('Example wall-mounted gauge has an unobstructed view', await evaluate(losReadout('Line of sight') + '.classList.contains("readout--good")'));
  // Inspector editing (review 2026-09-22): Tab after a committed edit keeps focus in
  // the panel instead of dropping it to the page, where the next Backspace deleted
  // the object (UI-1); a decimal comma is read as one (UI-4); Escape cancels what was
  // typed (UI-7); and undo back to the loaded plan leaves it unmodified (UI-11).
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("Heptane pan"))');
  const axis = i => 'document.querySelectorAll("#inspector .field__vec input")[' + i + ']';
  await waitFor(() => evaluate('!!' + axis(0) + ' && ' + axis(0) + '.value==="0"'), 'burner inspector');
  const rows = await evaluate('document.querySelectorAll(".outliner__row").length');
  await evaluate('(() => { const e=' + axis(0) + '; e.focus(); e.select(); })()');
  await send('Input.insertText', { text: '2,5' });
  await key('Tab', 'Tab', 9);
  await waitFor(() => evaluate(axis(0) + '.value==="2.5" && document.activeElement===' + axis(1)), 'focus after Tab from an edited field');
  check('inspector keeps focus on Tab after an edit and reads a decimal comma', true);
  await send('Input.insertText', { text: '9' });
  await key('Escape', 'Escape', 27);
  await new Promise(r => setTimeout(r, 150));
  check('Escape in an inspector field cancels the typed value',
    await evaluate(axis(1) + '.value==="0" && document.activeElement!==' + axis(1)));
  await key('Backspace', 'Backspace', 8);
  await new Promise(r => setTimeout(r, 150));
  check('a key after leaving a field reaches the editor, not a lost focus', await evaluate('document.querySelectorAll(".outliner__row").length') === rows - 1);
  for (let i = 0; i < 2; i += 1) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  }
  await waitFor(() => evaluate('document.querySelectorAll(".outliner__row").length===' + rows), 'undo of the delete and the edit');
  check('undo back to the loaded plan leaves it unmodified',
    await evaluate('!document.querySelector(".toolbar__file").textContent.includes("•")'));

  phase('lens choice');
  // Lens choice (2026-10-16): the A8303sc is one palette row and one picker entry; its
  // inspector offers the datasheet's five lenses, a real key on the Lens select swaps
  // the lens and moves the comparison's current row, and undo puts the 25 mm back.
  const ctrlZ = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  };
  check('the palette lists the A8303sc body once',
    await evaluate('[...document.querySelectorAll(".palette__row-label")].map(e=>e.textContent).filter(t=>t.includes("A8303")).join("|")') === 'FLIR A8303sc');
  // The A700 (2026-11-02) is the other body with a lens choice: one row, which places
  // its 24° lens, printed as 18 mm.
  const a700Row = '[...document.querySelectorAll(".palette__row")].find(r=>r.querySelector(".palette__row-label").textContent==="FLIR A700")';
  check('the palette lists the A700 body once, placed with its 24° (18 mm) lens',
    await evaluate('[...document.querySelectorAll(".palette__row-label")].map(e=>e.textContent).filter(t=>t.includes("A700")).join("|")') === 'FLIR A700'
    && await evaluate(a700Row + '.title.startsWith("Placed with the 18 mm lens. Choose 5, 10, 17, 18, 29 or 70 mm under Lens")'));
  const field =label => '[...document.querySelectorAll("#inspector label.field")].find(l=>l.querySelector(".field__label")?.textContent==="' + label + '")?.querySelector("select,input")';
  const lensSelect = field('Lens');
  const currentLens = 'document.querySelector("#inspector .lens-table__row--current th")?.textContent';
  const fovReadout = '[...document.querySelectorAll("#inspector .readout")].find(r=>r.querySelector(".readout__label").textContent==="Field of view")?.querySelector(".readout__value").textContent';
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("FLIR A8303sc MWIR"))');
  await waitFor(() => evaluate('!!' + lensSelect + ' && !!document.querySelector("#inspector .lens-table")'), 'A8303sc lens select and comparison');
  check('selected camera exposes flame line of sight', await evaluate('!!' + losReadout('Flame unobstructed')));
  const lensOptions = await evaluate('[...(' + lensSelect + ').options].map(o=>o.textContent).join("|")');
  check('the Lens select lists the datasheet lenses with their fields of view (' + lensOptions + ')',
    lensOptions === '17 mm (55.6° × 33.0°)|25 mm (39.4° × 22.8°)|50 mm (20.3° × 11.5°)|100 mm (10.2° × 5.8°)|200 mm (5.1° × 2.9°)'
    && await evaluate('(' + lensSelect + ').value') === 'flir-a8303sc-25mm');
  check('the preset picker names the body, not one lens',
    await evaluate('(' + field('Preset') + ').selectedOptions[0].textContent') === 'FLIR A8303sc');
  const before = await evaluate('[...document.querySelectorAll("#inspector .lens-table tbody tr")].map(r=>r.textContent).join("|")');
  check('the comparison has a row per lens, the 25 mm current, with plume verdicts (' + before + ')',
    await evaluate(currentLens) === '▶ 25 mm'
    && await evaluate('document.querySelectorAll("#inspector .lens-table tbody tr").length') === 5
    && await evaluate('document.querySelectorAll("#inspector .lens-table td.lens-table__good:nth-child(4), #inspector .lens-table td.lens-table__bad:nth-child(4)").length') === 5);
  await evaluate('(' + lensSelect + ').focus()');
  await key('End', 'End', 35);
  await waitFor(() => evaluate(currentLens + '==="▶ 200 mm"'), 'comparison follows the lens key');
  check('a key on the Lens select fits the 200 mm lens everywhere',
    await evaluate(fovReadout) === '5.1° × 2.9°'
    && await evaluate('(' + field('Focal length (mm)') + ').value') === '200'
    && await evaluate('(' + lensSelect + ').value') === 'flir-a8303sc-200mm');
  await evaluate('document.querySelector("#inspector .lens-table").scrollIntoView({block:"center"})');
  await screenshot('lens');
  await evaluate('document.activeElement?.blur()');
  await ctrlZ();
  await waitFor(() => evaluate(currentLens + '==="▶ 25 mm"'), 'undo of the lens change');
  check('undo of a lens change restores the 25 mm lens and an unmodified plan',
    await evaluate(fovReadout) === '39.4° × 22.8°'
    && await evaluate('!document.querySelector(".toolbar__file").textContent.includes("•")'));
  // The Example has no A700, so the same camera is switched to one by a real key on
  // the Preset select (the A700 is the entry above the A8303sc). Picking the body
  // applies the lens the palette places; undo puts the A8303sc back.
  const presetName = '(' + field('Preset') + ')?.selectedOptions[0]?.textContent';
  await evaluate('(' + field('Preset') + ').focus()');
  await key('ArrowUp', 'ArrowUp', 38);
  await waitFor(() => evaluate(presetName + '==="FLIR A700" && ' + currentLens + '==="▶ 18 mm"'), 'A700 chosen by a key on the Preset select');
  const a700Options = await evaluate('[...(' + lensSelect + ').options].map(o=>o.textContent).join("|")');
  check('the A700 Lens select lists its six lenses with their fields of view, the 24° (18 mm) fitted (' + a700Options + ')',
    a700Options === '5 mm (75.0° × 59.9°)|10 mm (42.0° × 32.1°)|17 mm (25.5° × 19.2°)|18 mm (24.1° × 18.2°)|29 mm (15.1° × 11.3°)|70 mm (6.3° × 4.7°)'
    && await evaluate('(' + lensSelect + ').value') === 'flir-a700-24deg'
    && await evaluate(fovReadout) === '24.1° × 18.2°'
    && await evaluate('document.querySelectorAll("#inspector .lens-table tbody tr").length') === 6);
  await evaluate('document.activeElement?.blur()');
  await ctrlZ();
  await waitFor(() => evaluate(presetName + '==="FLIR A8303sc" && ' + currentLens + '==="▶ 25 mm"'), 'undo of the switch to the A700');
  check('undo of the switch to the A700 restores the A8303sc and an unmodified plan',
    await evaluate(fovReadout) === '39.4° × 22.8°'
    && await evaluate('!document.querySelector(".toolbar__file").textContent.includes("•")'));

  phase('camera roll and flame height');
  // Roll (2026-11-02): a typed 90 on the A8303sc's Roll field mounts it on its side,
  // which puts its long sensor axis vertical and brings the flame base into frame
  // without changing the lens; undo levels it again. Metres first, so the flame
  // height field below reads in metres.
  const rollUnits = '[...document.querySelectorAll("select")].find(s=>s.title.startsWith("Display units"))';
  await evaluate('(' + rollUnits + ').focus()'); await key('Home', 'Home', 36);
  await waitFor(() => evaluate('(' + rollUnits + ').value==="m"'), 'metre display for roll and flame height');
  const readoutValue = label => '[...document.querySelectorAll("#inspector .readout")].find(r=>r.querySelector(".readout__label").textContent===' + JSON.stringify(label) + ')?.querySelector(".readout__value").textContent';
  const rollField = field('Roll (°)');
  await waitFor(() => evaluate('!!' + rollField), 'Roll field');
  check('the level A8303sc misses the flame base',
    await evaluate(readoutValue('Flame base in frame')) === 'no' && await evaluate('(' + rollField + ').value') === '0');
  await click(rollField); await evaluate('(' + rollField + ').select()');
  await send('Input.insertText', { text: '90' }); await key('Tab', 'Tab', 9);
  await waitFor(() => evaluate(readoutValue('Flame base in frame') + '==="yes"'), 'the rolled camera frames the base');
  check('a typed 90° roll mounts the A8303sc on its side and keeps its lens',
    await evaluate('(' + rollField + ').value') === '90' && await evaluate(readoutValue('Flame tip in frame')) === 'yes'
    && await evaluate(fovReadout) === '39.4° × 22.8°');
  await screenshot('camera-roll');
  await evaluate('document.activeElement?.blur()');
  await ctrlZ();
  await waitFor(() => evaluate('(' + rollField + ').value==="0"'), 'undo of the roll');
  check('undo of the roll levels the camera again', await evaluate(readoutValue('Flame base in frame')) === 'no');
  // Flame height (2026-11-02): typing a height back-solves the HRR, which is what is
  // stored; the readout shows the typed height and undo restores the HRR.
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("Heptane pan"))');
  const flameField = field('Flame height (m)');
  await waitFor(() => evaluate('!!' + flameField), 'Flame height field');
  const hrrBefore = await evaluate('(' + field('HRR (kW)') + ').value');
  await click(flameField); await evaluate('(' + flameField + ').select()');
  await send('Input.insertText', { text: '2' }); await key('Tab', 'Tab', 9);
  await waitFor(() => evaluate(readoutValue('Mean flame height') + '==="2 m"'), 'typed flame height');
  const hrrAfter = await evaluate('(' + field('HRR (kW)') + ').value');
  check('a typed flame height back-solves the HRR (' + hrrBefore + ' to ' + hrrAfter + ' kW)',
    Number(hrrAfter) > Number(hrrBefore) && await evaluate('(' + flameField + ').value') === '2');
  await evaluate('document.activeElement?.blur()');
  await ctrlZ();
  await waitFor(() => evaluate('(' + field('HRR (kW)') + ').value===' + JSON.stringify(hrrBefore)), 'undo of the flame height');
  check('undo of a flame height restores the HRR', true);
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("FLIR A8303sc MWIR"))');
  await waitFor(() => evaluate('!!document.querySelector("#inspector .lens-table")'), 'A8303sc selected again');

  phase('as-built camera survey');
  const surveyUnits ='[...document.querySelectorAll("select")].find(s=>s.title.startsWith("Display units"))';
  await evaluate('(' + surveyUnits + ').focus()'); await key('Home', 'Home', 36);
  await waitFor(() => evaluate('(' + surveyUnits + ').value==="m"'), 'survey units');
  const recordSurvey = '[...document.querySelectorAll("#inspector .as-built button")].find(b=>b.textContent==="Record as built")';
  await click(recordSurvey);
  const measuredAxis = i => 'document.querySelectorAll("#inspector .as-built .field__vec input")[' + i + ']';
  await waitFor(() => evaluate('!!' + measuredAxis(0)), 'recorded camera survey');
  const plannedX = await evaluate(axis(0) + '.value');
  const measuredX = String(Number(plannedX) + 0.21);
  await click(measuredAxis(0)); await evaluate(measuredAxis(0) + '.select()');
  await send('Input.insertText', { text: measuredX }); await key('Tab', 'Tab', 9);
  await waitFor(() => evaluate('document.querySelector(".as-built__offset").textContent.includes("0.21 m")'), 'survey offset after typing X');
  const measuredZ = String(Number(await evaluate(measuredAxis(2) + '.value')) - 0.04);
  await click(measuredAxis(2)); await evaluate(measuredAxis(2) + '.select()');
  await send('Input.insertText', { text: measuredZ }); await key('Tab', 'Tab', 9);
  await waitFor(() => evaluate('document.querySelector(".as-built__offset").textContent.includes("0.04 m low")'), 'survey height offset');
  check('typed survey shows plan and height offsets while planned X is unchanged', await evaluate(axis(0) + '.value') === plannedX);
  const surveyToggle = '[...document.querySelectorAll("#toolbar button")].find(b=>b.textContent==="As built")';
  await screenshot('as-built-visible');
  await click(surveyToggle);
  check('As built view toggle hides ghosts', await evaluate('!(' + surveyToggle + ').classList.contains("toolbar__btn--active")'));
  await screenshot('as-built-hidden');
  await click(surveyToggle);
  check('As built view toggle restores ghosts', await evaluate('(' + surveyToggle + ').classList.contains("toolbar__btn--active")'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector(".as-built").scrollIntoView({block:"center"})');
  check('survey fields fit the laptop inspector', await evaluate('document.querySelector("#inspector").scrollWidth <= document.querySelector("#inspector").clientWidth + 1'));
  await screenshot('as-built-laptop');
  await click('[...document.querySelectorAll("button")].find(b=>b.textContent.startsWith("Drawing"))');
  await waitFor(() => evaluate('!!document.querySelector(".set-out-check")'), 'survey drawing table');
  check('drawing reads the measured camera row and signed survey differences', await evaluate(`(() => {
    const cells=[...document.querySelector('.set-out-check [data-object-id="cam-mwir"]').cells].map(c=>c.textContent);
    return cells[2].includes(Number(${JSON.stringify(measuredX)}).toFixed(3)) && cells[3]==='0.210' && cells[4]==='-0.040'
      && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(cells[6]);
  })()`));
  await evaluate('document.querySelector(".set-out-check").scrollIntoView({block:"center"})');
  await screenshot('as-built-drawing');
  // Print / Save as PDF prints the whole drawing: the editor pins html and body to
  // the window, which once cut the printout to its first page.
  {
    const { data } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    const pdf = Buffer.from(data, 'base64').toString('latin1');
    const pages = Math.max(0, ...[...pdf.matchAll(/\/Count (\d+)/g)].map(m => Number(m[1])));
    check('printing the drawing preview prints every page (' + pages + ' pages)', pages >= 3);
  }
  await click('[...document.querySelectorAll(".report-overlay__bar button")].find(b=>b.textContent==="Close")');
  await click('[...document.querySelectorAll("#inspector .as-built button")].find(b=>b.textContent==="Clear")');
  await waitFor(() => evaluate('!!(' + recordSurvey + ')'), 'Clear survey');
  await evaluate('document.activeElement?.blur()'); await ctrlZ();
  await waitFor(() => evaluate('document.querySelector(".as-built__offset")?.textContent.includes("0.04 m low")'), 'undo Clear survey');
  check('Clear and its undo preserve the recorded survey values', true);
  for (let i = 0; i < 3; i++) { await evaluate('document.activeElement?.blur()'); await ctrlZ(); }
  await waitFor(() => evaluate('!!(' + recordSurvey + ')'), 'undo survey fields and recording');
  check('record survey is one undoable edit and undo removes its fields', await evaluate('!document.querySelector(".as-built__offset")'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  phase('feet-and-inches editing and drawing');
  const unitsSelect = 'document.querySelector("select[title^=\\"Display units\\"]")';
  check('unit selector offers ft-in immediately after ft',
    await evaluate('[...(' + unitsSelect + ').options].map(o=>o.value).join("|")') === 'm|cm|mm|ft|ft-in|in');
  await evaluate('(' + unitsSelect + ').focus()');
  await key('End', 'End', 35);
  // A unit change repaints the toolbar and replaces the select, so focus the new
  // one before the next key.
  await waitFor(() => evaluate('(' + unitsSelect + ').value==="in"'), 'unit select End');
  await evaluate('(' + unitsSelect + ').focus()');
  await key('ArrowUp', 'ArrowUp', 38);
  const originalX = `-9' 0"`, editedX = `-8' 6 1/2"`;
  await waitFor(() => evaluate(axis(0) + '.value===' + JSON.stringify(originalX)), 'feet-and-inches camera position');
  const standoffReadout = '[...document.querySelectorAll("#inspector .readout")].find(r=>r.querySelector(".readout__label").textContent.startsWith("Standoff"))?.querySelector(".readout__value").textContent';
  const originalStandoff = await evaluate(standoffReadout);
  await evaluate('(() => { const e=' + axis(0) + '; e.focus(); e.select(); })()');
  await send('Input.insertText', { text: editedX });
  check('typing fractional input does not commit before blur', await evaluate(standoffReadout) === originalStandoff);
  await key('Tab', 'Tab', 9);
  await waitFor(async () => (await evaluate(standoffReadout)) !== originalStandoff, 'fractional input commits on blur');
  check('fractional edit retains the text and Tab focus',
    await evaluate(axis(0) + '.value===' + JSON.stringify(editedX) + ' && document.activeElement===' + axis(1)));
  const originalY = await evaluate(axis(1) + '.value');
  await evaluate('(' + axis(1) + ').select()');
  await send('Input.insertText', { text: '1/0"' });
  await key('Tab', 'Tab', 9);
  check('invalid fractional input restores the previous length', await evaluate(axis(1) + '.value') === originalY);
  await evaluate('document.activeElement?.blur()');
  await ctrlZ();
  await waitFor(() => evaluate(axis(0) + '.value===' + JSON.stringify(originalX)), 'undo of fractional edit');
  check('fractional edit takes one undo and preserves display units', await evaluate('(' + unitsSelect + ').value') === 'ft-in');
  await click('[...document.querySelectorAll("button")].find(b=>b.textContent.startsWith("Drawing"))');
  await waitFor(() => evaluate('document.querySelectorAll(".report .set-out tbody tr").length===12'), 'Example set-out table');
  check('drawing carries fractional set-out coordinates and dimensions', await evaluate(`(() => {
    const report=document.querySelector('.report');
    return report.querySelector('[data-object-id="cam-mwir"]').textContent.includes(${JSON.stringify(originalX)})
      && [...report.querySelectorAll('.drawing .dim-text')].some(t=>t.textContent.includes("'"));
  })()`));
  check('set-out print rows stay together and headings repeat', await evaluate(`(() => {
    const table=document.querySelector('.set-out');
    return getComputedStyle(table.querySelector('tbody tr')).breakInside==='avoid'
      && getComputedStyle(table.tHead).display==='table-header-group'
      && table.scrollWidth<=table.clientWidth+1;
  })()`));
  // Capture the actual download Blob while the Example drawing is open.
  await evaluate(`(() => {
    window.__scheduleCreateUrl = URL.createObjectURL;
    window.__scheduleBlob = null;
    URL.createObjectURL = function(blob) {
      if (blob.type.startsWith('text/csv')) window.__scheduleBlob = blob;
      return window.__scheduleCreateUrl.call(URL, blob);
    };
  })()`);
  try {
    await click('[...document.querySelectorAll(".report-overlay__bar button")].find(b=>b.textContent==="Download schedule (CSV)")');
    await waitFor(() => evaluate('Boolean(window.__scheduleBlob)'), 'instrument schedule download');
    const schedule = await evaluate(`(async () => {
      const blob = window.__scheduleBlob;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { text: await blob.text(), bom: Array.from(bytes.slice(0, 3)), type: blob.type };
    })()`);
    check('Example schedule downloads a UTF-8 BOM CSV with all instruments and fractional coordinates',
      JSON.stringify(schedule.bom) === '[239,187,191]' && schedule.type.startsWith('text/csv')
      && schedule.text.includes('Height (ft-in)') && schedule.text.includes('FLIR A8303sc MWIR')
      && schedule.text.includes('East wall rake_4') && schedule.text.includes('Plume rake_3')
      && schedule.text.includes('toward') && schedule.text.includes('""')
      && schedule.text.split('\r\n').length === 15);
  } finally {
    await evaluate('URL.createObjectURL = window.__scheduleCreateUrl; delete window.__scheduleCreateUrl; delete window.__scheduleBlob;');
  }
  await evaluate('document.querySelector(".set-out").scrollIntoView({block:"center"})');
  await screenshot('set-out-ft-in');
  await click('[...document.querySelectorAll(".report-overlay__bar button")].find(b=>b.textContent==="Close")');

  phase('left rail on a laptop');
  // The left rail (2026-11-02): on a 1280x720 laptop the Checks used to start below
  // the fold under the Palette and the object list. All three sections must be on
  // screen, each scrolling its own contents. From FDS is folded by default, opens
  // with a real Space on its summary, and stays open through a create.
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await new Promise(r => setTimeout(r, 200));
  const rail = await evaluate('(() => { const rail=document.querySelector(".panel--left").getBoundingClientRect();'
    + ' const top=s=>document.querySelector(s).getBoundingClientRect().top - rail.top;'
    + ' const el=document.querySelector(".panel--left");'
    + ' return { height: rail.height, checks: top("#checks"), firstCard: top("#checks .checks__item"),'
    + ' overflow: el.scrollHeight-el.clientHeight }; })()');
  check('on a 1280x720 screen Checks and its first card are on screen without scrolling the rail ('
    + JSON.stringify(rail) + ')', rail.overflow <= 1 && rail.firstCard + 40 < rail.height);
  phase('new instrument palette, fields and undo');
  const instrumentFold = 'document.querySelector("#palette details[data-fold=instruments]")';
  check('the Instruments group starts open, so Heat flux and Thermocouple are one click away',
    await evaluate(instrumentFold + '.open && [...document.querySelectorAll("#palette .palette__tile")].some(b=>b.textContent.includes("Heat flux") && b.offsetParent!==null)'));
  const instrumentCount = await evaluate('document.querySelectorAll(".outliner__row").length');
  for (const [name, field, value] of [['Velocity probe', 'Range (m/s)', '12'], ['Gas sample', 'In duct', null], ['Load cell', 'Capacity (kg)', '250']]) {
    await click('[...document.querySelectorAll("#palette .palette__tile")].find(b=>b.textContent.includes(' + JSON.stringify(name) + '))');
    await click('document.querySelector("#viewport canvas")');
    const control = '[...document.querySelectorAll("#inspector label.field")].find(l=>l.querySelector(".field__label")?.textContent===' + JSON.stringify(field) + ').querySelector("input")';
    await waitFor(() => evaluate('[...document.querySelectorAll("#inspector .panel__section")].some(s=>s.textContent===' + JSON.stringify(name) + ')'), name + ' inspector');
    const before = await evaluate(control + (value === null ? '.checked' : '.value'));
    if (value === null) await click(control);
    else {
      await click(control);
      await evaluate(control + '.select()');
      await send('Input.insertText', { text: value });
      await key('Tab', 'Tab', 9);
    }
    await waitFor(() => evaluate(control + (value === null ? '.checked===true' : '.value===' + JSON.stringify(value))), name + ' field edit');
    await evaluate('document.activeElement?.blur()'); await ctrlZ();
    await waitFor(() => evaluate(control + (value === null ? '.checked===' : '.value===') + JSON.stringify(before)), name + ' field undo');
    check(name + ' places from a real palette click, edits and undoes its field', true);
    if (name === 'Velocity probe') check('probe offers opening alignment instead of fire aiming', await evaluate(`
      [...document.querySelectorAll('#inspector button')].some(b=>b.textContent==='Align with opening') &&
      ![...document.querySelectorAll('#inspector button')].some(b=>b.textContent==='Aim at fire')`));
  }
  check('all three instrument placements remain after undoing their edits',
    await evaluate('document.querySelectorAll(".outliner__row").length') === instrumentCount + 3);
  check('expanded instrument group still leaves Checks visible at 1280x720', await evaluate(`(() => {
    const rail=document.querySelector('.panel--left'), card=document.querySelector('#checks .checks__item').getBoundingClientRect();
    return rail.scrollHeight<=rail.clientHeight+1 && card.top+40<rail.getBoundingClientRect().bottom;
  })()`));
  await screenshot('instruments17-laptop');
  await click('[...document.querySelectorAll("button")].find(b=>b.textContent.startsWith("Drawing"))');
  await waitFor(() => evaluate('!!document.querySelector(".report")'), 'instrument drawing');
  check('plan and both elevations carry each new marker and set-out row', await evaluate(`
    ['velocityProbe','gasSampling','loadCell'].every(type=>document.querySelectorAll('.report [data-instrument="'+type+'"]').length===3)
    && document.querySelectorAll('.report .set-out tbody tr').length===15`));
  await screenshot('instruments17-drawing');
  await click('[...document.querySelectorAll(".report-overlay__bar button")].find(b=>b.textContent==="Close")');
  for (let i=0; i<3; i++) { await evaluate('document.activeElement?.blur()'); await ctrlZ(); }
  await waitFor(() => evaluate('document.querySelectorAll(".outliner__row").length===' + instrumentCount), 'instrument placements undo');
  const fdsFold = '[...document.querySelectorAll("#palette details")].find(d=>d.querySelector("summary").textContent==="From FDS")';
  check('From FDS is folded by default', await evaluate(fdsFold + '.open') === false);
  await evaluate(fdsFold + '.querySelector("summary").focus()');
  await key(' ', 'Space', 32);
  await waitFor(() => evaluate(fdsFold + '.open'), 'From FDS opens on Space');
  const objectCount = await evaluate('document.querySelectorAll(".outliner__row").length');
  await evaluate('document.querySelector(".fdspaste__input").focus()');
  await send('Input.insertText', { text: "&OBST XB=3,3.2,-1,1,0,2.4, SURF_ID='WALL' /" });
  await click('[...document.querySelectorAll(".fdspaste button")].find(b=>b.textContent==="Create")');
  await waitFor(() => evaluate('document.querySelectorAll(".outliner__row").length===' + (objectCount + 1)), 'object from a pasted record');
  check('From FDS stays open after Create repaints the palette', await evaluate(fdsFold + '.open'));
  await screenshot('rail-laptop');
  await evaluate('document.activeElement?.blur()');
  await ctrlZ();
  await waitFor(() => evaluate('document.querySelectorAll(".outliner__row").length===' + objectCount), 'undo of the pasted object');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  phase('focus after rebuild');
  // Tab from the last field onto a button keeps focus there through the rebuild,
  // and a rebuild into a different panel does not push focus into a field (Codex
  // review of 5f8333d).
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("Heptane pan"))');
  // The object's Notes: the last text field, just before Duplicate and Delete.
  const notes = '[...document.querySelectorAll("#inspector input[type=text]")].pop()';
  // Wait for the burner's own panel: the previous selection's panel also has a last
  // text field and actions, and typing into it is lost when the burner's replaces it.
  await waitFor(() => evaluate('!!' + notes + ' && !!document.querySelector("#inspector .panel__actions")'
    + ' && [...document.querySelectorAll("#inspector .panel__section")].some(s=>s.textContent==="Fuel pan")'), 'burner notes field');
  await evaluate('(() => { const e=' + notes + '; e.focus(); e.select(); })()');
  await send('Input.insertText', { text: 'checked' });
  await key('Tab', 'Tab', 9);
  await new Promise(r => setTimeout(r, 300));
  const landed = await evaluate('(() => { const a=document.activeElement; return [a?.tagName, a?.textContent?.slice(0,30), ' + notes + '.value].join("|"); })()');
  check('Tab from the last field keeps focus on the button it reached (' + landed + ')', landed === 'BUTTON|Duplicate|checked');
  await click('[...document.querySelectorAll("#inspector button")].find(b=>b.textContent==="Delete")');
  await new Promise(r => setTimeout(r, 150));
  check('a rebuild into another panel does not move focus into a field',
    await evaluate('!["INPUT","SELECT","TEXTAREA"].includes(document.activeElement?.tagName)'));
  phase('test data: sources, mapping and instrument plots');
  // Test data (M16 part 3b). A browser tab cannot read the plan's linked files, so
  // the plan is opened and its two files attached through real file inputs:
  // Open answers its file chooser, each source's Choose file… input takes its file.
  await openTab();
  await send('Page.navigate', { url: origin + '/dist/index.html' });
  const button = text => '[...document.querySelectorAll("button")].find(b=>b.textContent===' + JSON.stringify(text) + ')';
  await waitFor(() => evaluate('!!' + button('Test data…')), 'built editor for test data');
  const fixture = name => resolve(web, '../fixtures/test-data', name);
  const setFiles = async (expression, files) => {
    const { result } = await send('Runtime.evaluate', { expression, returnByValue: false });
    await send('DOM.setFileInputFiles', { files, objectId: result.objectId });
  };
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  const chooser = new Promise(resolve => {
    const listener = message => {
      if (message.method !== 'Page.fileChooserOpened') return;
      eventListeners.delete(listener);
      resolve(message.params);
    };
    eventListeners.add(listener);
  });
  await click(button('Open'));
  const { backendNodeId } = await chooser;
  await send('DOM.setFileInputFiles', { files: [fixture('test-data.ftp.json')], backendNodeId });
  await send('Page.setInterceptFileChooserDialog', { enabled: false });
  await waitFor(() => evaluate('document.querySelector(".toolbar__file").textContent.startsWith("test-data.ftp.json")'), 'test data plan opened');
  await click(button('Test data…'));
  await waitFor(() => evaluate('!!document.querySelector("dialog.test-data[open]")'), 'Test data dialog');
  const sourceStatus = id => 'document.querySelector("[data-source-id=\\"' + id + '\\"] .test-data__status")?.textContent ?? ""';
  check('a browser tab lists both sources as needing their files, each with Choose file…', await evaluate(
    '[...document.querySelectorAll(".test-data__source")].map(s=>s.querySelector("strong").textContent+"|"+s.querySelector(".test-data__status").textContent.split(" · ")[0]+"|"+[...s.querySelectorAll("button")].some(b=>b.textContent==="Choose file…")).join(";")')
    === 'Synthetic logger|Needs the file in this browser tab|true;Synthetic FDS|Needs the file in this browser tab|true');
  await setFiles('document.querySelector("dialog.test-data input[type=file][data-source-id=\\"logger\\"]")', [fixture('logger-export.xlsx')]);
  await waitFor(async () => (await evaluate(sourceStatus('logger'))).startsWith('Loaded'), 'logger workbook attached');
  await setFiles('document.querySelector("dialog.test-data input[type=file][data-source-id=\\"fds\\"]")', [fixture('room-test_devc.csv')]);
  await waitFor(async () => (await evaluate(sourceStatus('fds'))).startsWith('Loaded'), 'FDS CSV attached');
  // A browser File carries its own modification time; with the same size and the same
  // mapped channels that is not a changed file, and no mismatch may be shown.
  check('attached files load every mapping, and an unchanged file shows no mismatch',
    await evaluate(sourceStatus('logger')) === 'Loaded · 7 of 7 mappings plotting'
    && await evaluate(sourceStatus('fds')) === 'Loaded · 2 of 2 mappings plotting'
    && await evaluate('!document.querySelector(".test-data__mismatch")'));
  await screenshot('test-data-sources');

  await click('[...document.querySelectorAll("[data-source-id=\\"logger\\"] button")].find(b=>b.textContent==="Edit…")');
  await waitFor(() => evaluate('!!document.querySelector(".test-data__map")'), 'source editor');
  check('the preview marks the names and first data rows and every paired time column', await evaluate(
    '[...document.querySelectorAll(".test-data__grid tbody .test-data__mark th")].map(t=>t.textContent).join("|")') === '1names|2data'
    && await evaluate('document.querySelectorAll(".test-data__grid thead .test-data__time").length') === 13);
  const instrument = channel => 'document.querySelector("select[aria-label=\\"Instrument for ' + channel + '\\"]")';
  const rowText = channel => instrument(channel) + '.closest("tr").textContent';
  check('a gauge channel in volts carries its constant and says where it came from', await evaluate(
    rowText('HF east_23.17kW/m2permV') + '.includes("23.17 kW/m² per mV, from the channel name")')
    && await evaluate('document.querySelector("input[aria-label=\\"Scale for HF east_23.17kW/m2permV\\"]").value') === '23170');
  const targetLabels = await evaluate('[...' + instrument('TC duct lower') + '.options].map(o=>o.textContent).join("|")');
  check('the Instrument select lists gauges, every bead with its height, and burners (' + targetLabels + ')', targetLabels
    === 'Not mapped|HF east|HF west|TC low · bead 1 at 1 m|TC low · bead 2 at 1.5 m|TC low · bead 3 at 2 m|TC low · bead 4 at 2.5 m|TC low · bead 5 at 3 m|Synthetic burner (HRR)');
  await screenshot('test-data-editor');
  await evaluate('(' + instrument('TC duct lower') + ').focus()');
  await key('End', 'End', 35);
  await waitFor(() => evaluate('(' + instrument('TC duct lower') + ').value===\'["burner",null]\''), 'channel mapped by a key');
  check('a key on a channel\'s Instrument select maps it as one edit, with its unit caveat', await evaluate(
    rowText('TC duct lower') + '.includes("Recorded in °C; enter the scale that gives kW")')
    && await evaluate('document.querySelector(".toolbar__file").textContent.includes("•")')
    && await evaluate('document.querySelector("#test-data-channels").textContent.endsWith("8 mapped")'));
  await ctrlZ();
  await waitFor(() => evaluate('(' + instrument('TC duct lower') + ').value===""'), 'undo of the mapping');
  check('Ctrl+Z in the dialog undoes the mapping and leaves the plan unmodified', await evaluate(
    '!document.querySelector(".toolbar__file").textContent.includes("•") && document.querySelector("#test-data-channels").textContent.endsWith("7 mapped")'));
  await evaluate('document.querySelector(".test-data__filter").focus()');
  await send('Input.insertText', { text: 'tc tree' });
  await waitFor(() => evaluate('[...document.querySelectorAll(".test-data__map tbody tr")].filter(r=>!r.hidden).length===5'), 'channel filter');
  check('the channel filter narrows the table to matching channels', true);
  await evaluate('document.querySelector("select[aria-label=Role]").focus()');
  await key('Escape', 'Escape', 27);
  await waitFor(() => evaluate('!document.querySelector("dialog.test-data")'), 'Escape closes the Test data dialog');
  check('Escape closes the dialog and returns focus to the toolbar', await evaluate('document.activeElement.textContent') === 'Test data…');

  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("HF east"))');
  await waitFor(() => evaluate('!!document.querySelector(".plot-panel:not([hidden]) .plot-panel__legend")'), 'gauge plot');
  const legend = await evaluate('[...document.querySelectorAll(".plot-panel__legend tbody th")].map(t=>t.textContent).join("|")');
  check('the gauge plot\'s legend names both sources, Planned and Range (' + legend + ')',
    legend === 'Synthetic logger · measured|Synthetic FDS · simulated|Planned|Range');
  check('the planned value is a labelled dashed line, measured solid and simulated dashed', await evaluate(`(() => {
    const svg=document.querySelector('.plot-panel svg[role=img]');
    const planned=svg.querySelector('.plot-panel__planned');
    return planned.getAttribute('stroke-dasharray')!==null
      && [...svg.querySelectorAll('.plot-panel__line-label')].some(t=>t.textContent==='Planned')
      && !svg.querySelector('path[data-source=logger]').hasAttribute('stroke-dasharray')
      && svg.querySelector('path[data-source=fds]').hasAttribute('stroke-dasharray');
  })()`));
  check('unchanged source files raise no warning above the plot', await evaluate(
    'document.querySelectorAll(".plot-panel__warning").length===0'));
  await evaluate('document.querySelector("input[aria-label=\\"Test data time\\"]").focus()');
  await key('End', 'End', 35);
  await waitFor(() => evaluate('document.querySelector(".plot-panel__values").textContent==="t = 600 s from ignition"'), 'plot slider End');
  check('the slider reads every series at one time, and none outside its own span', await evaluate(
    '[...document.querySelectorAll(".plot-panel__legend tbody td.plot-panel__num")].map(t=>t.textContent).slice(0,2).join("|")') === '–|0 kW/m²');
  await screenshot('test-data-plot');
  await click('document.querySelector(".plot-panel__header button")');
  await waitFor(() => evaluate('document.querySelector(".plot-panel__header button").getAttribute("aria-expanded")==="false"'), 'plot collapsed');
  check('Collapse hides the plot and keeps its header', await evaluate('!document.querySelector(".plot-panel svg") && document.querySelector(".plot-panel__header button").textContent==="Expand"'));
  await click('document.querySelector(".plot-panel__header button")');
  await waitFor(() => evaluate('!!document.querySelector(".plot-panel__legend")'), 'plot expanded');
  check('Expand brings the plot back', await evaluate('document.querySelector(".plot-panel__header button").getAttribute("aria-expanded")==="true"'));

  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("TC low"))');
  await waitFor(() => evaluate('document.querySelector(".plot-panel__source")?.textContent.includes("rake")'), 'rake plot');
  check('a rake plots one line per bead and source, coloured by height, with a bead table legend', await evaluate(`(() => {
    const paths=[...document.querySelectorAll('.plot-panel svg[role=img] path[data-bead]')];
    const logger=paths.filter(p=>p.dataset.source==='logger').map(p=>p.getAttribute('stroke'));
    return paths.length===6 && new Set(logger).size===5
      && document.querySelectorAll('.plot-panel__legend tbody tr').length===5
      && document.querySelectorAll('.plot-panel__planned').length===5;
  })()`));
  await screenshot('test-data-rake');

  // A check about a source opens the dialog at it: deleting a mapped gauge leaves
  // a dangling mapping, and its card in Checks leads to the source's editor.
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("HF west"))');
  await new Promise(r => setTimeout(r, 150));
  await key('Delete', 'Delete', 46);
  const dangling = '[...document.querySelectorAll(".checks__body")].find(c=>c.querySelector(".checks__code").textContent==="test-data-dangling")';
  await waitFor(() => evaluate('!!' + dangling), 'dangling mapping check');
  await click(dangling);
  await waitFor(() => evaluate('!!document.querySelector("dialog.test-data[open] .test-data__map")'), 'dialog opened from Checks');
  check('clicking a test data check opens that source with the dangling mapping marked', await evaluate(
    'document.querySelector("#test-data-title").textContent==="Test data · Synthetic logger"')
    && await evaluate(instrument('HF west_22.10kW/m2permV') + '.selectedOptions[0].textContent==="Missing: hf-west"')
    && await evaluate('document.activeElement===' + instrument('HF west_22.10kW/m2permV')));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await new Promise(r => setTimeout(r, 200));
  check('at 1280 x 720 the dialog fits the window with its actions on screen', await evaluate(`(() => {
    const d=document.querySelector('dialog.test-data').getBoundingClientRect();
    const close=[...document.querySelectorAll('dialog.test-data button')].find(b=>b.textContent==='Close').getBoundingClientRect();
    return d.top>=0 && d.bottom<=innerHeight && close.bottom<=innerHeight && d.right<=innerWidth;
  })()`));
  await screenshot('test-data-laptop');
  await click(button('Close'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await ctrlZ();
  await waitFor(() => evaluate('!document.querySelector(".toolbar__file").textContent.includes("•")'), 'undo of the gauge deletion');
  check('undo restores the gauge and clears the dangling check', await evaluate('!' + dangling));

  phase('planned curves and a curve from test data');
  // A burner curve made in the inspector (M17): the plan has no flame, so it gets
  // the fire clock on the shared bar; the gauge's planned value becomes a curve the
  // plot's cursor and the clock read together; and a mapped series becomes a curve.
  const curveField = field('Curve');
  const curveSummaryText = 'document.querySelector("#inspector .hrr-curve")?.textContent ?? ""';
  const barReadout = 'document.querySelector(".playback-bar__readout")?.textContent ?? ""';
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("Synthetic burner"))');
  await waitFor(() => evaluate('!!' + curveField), 'burner Curve select');
  check('a steady burner offers the ways to make a curve, and no fire clock yet', await evaluate(
    '[...(' + curveField + ').options].map(o=>o.textContent).join("|")') === 'Steady|t² growth|Table|From test data'
    && await evaluate('(' + curveField + ').value') === 'steady'
    && await evaluate('!document.querySelector(".playback-bar:not([hidden])")'));
  await evaluate('(' + curveField + ').focus()');
  await key('ArrowDown', 'ArrowDown', 40);
  const makeT2 = '[...document.querySelectorAll("#inspector button")].find(b=>b.textContent==="Make t² curve")';
  await waitFor(() => evaluate('!!' + makeT2), 't² form on the synthetic burner');
  await click(makeT2);
  await waitFor(async () => (await evaluate(curveSummaryText)).endsWith('source t2-medium'), 't² medium curve on the synthetic burner');
  await waitFor(() => evaluate('document.querySelector(".playback-bar:not([hidden])")?.getAttribute("aria-label")==="Fire clock"'), 'fire clock for the curve');
  check('a curve without a flame gets the fire clock, at rest with the cone at the peak (' + await evaluate(barReadout) + ')',
    /^Cone at peak, Q = 80 kW · flame [\d.]+ m · t = 0\.0 s$/.test(await evaluate(barReadout)));

  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("HF east"))');
  const plannedLine = 'document.querySelector(".plot-panel svg[role=img] .plot-panel__planned")';
  await waitFor(() => evaluate(plannedLine + '?.tagName==="path"'), 'planned curve on the gauge plot');
  check('the gauge plot draws the planned value as a labelled dashed curve, not a line', await evaluate(`(() => {
    const p=${plannedLine};
    const ys=new Set(p.getAttribute('d').split(/[ML]/).filter(Boolean).map(s=>s.split(',')[1]));
    return p.getAttribute('stroke-dasharray')!==null && ys.size>20
      && [...document.querySelectorAll('.plot-panel svg .plot-panel__line-label')].some(t=>t.textContent==='Planned');
  })()`));
  const plannedCell = '[...document.querySelectorAll(".plot-panel__legend tbody tr")].find(r=>r.querySelector("th").textContent==="Planned").querySelector("td.plot-panel__num").textContent';
  const plotTime = 'Number(document.querySelector(".plot-panel__values").textContent.match(/t = ([\\d.]+) s/)[1])';
  const clockTime = 'Number(document.querySelector(".playback-bar__readout").textContent.match(/t = ([\\d.]+) s/)[1])';
  check('at ignition the legend reads the planned curve at 0 kW/m² (' + await evaluate(plannedCell) + ')',
    await evaluate(plannedCell) === '0 kW/m²');
  // A click on the plot's slider seeks the fire clock; the clock and the cursor agree,
  // the cone follows, and the legend reads the planned curve at that time.
  await click('document.querySelector("input[aria-label=\\"Test data time\\"]")');
  await waitFor(async () => (await evaluate(barReadout)).startsWith('Q = '), 'plot slider seeks the fire clock');
  const midPlanned = await evaluate(plannedCell);
  check('the plot\'s cursor and the fire clock read one time, and Planned reads the curve there ('
    + await evaluate(barReadout) + ' | ' + midPlanned + ')',
    Math.abs(await evaluate(plotTime) - await evaluate(clockTime)) < 0.06 && await evaluate(plotTime) > 100
    && /^[\d.]+ kW\/m²$/.test(midPlanned) && midPlanned !== '0 kW/m²'
    && (await evaluate('[...document.querySelectorAll(".plot-panel__note")].map(n=>n.textContent).join("|")'))
      .includes('The cursor follows the fire clock; dragging it seeks the clock.'));
  await screenshot('planned-curve');

  await click(button('Test data…'));
  await waitFor(() => evaluate('!!document.querySelector("dialog.test-data[open]")'), 'Test data dialog for an HRR series');
  await click('[...document.querySelectorAll("[data-source-id=\\"logger\\"] button")].find(b=>b.textContent==="Edit…")');
  await waitFor(() => evaluate('!!document.querySelector(".test-data__map")'), 'source editor for an HRR series');
  await evaluate('(' + instrument('TC duct lower') + ').focus()');
  await key('End', 'End', 35);
  await waitFor(() => evaluate('(' + instrument('TC duct lower') + ').value===\'["burner",null]\''), 'channel mapped to the burner');
  await key('Escape', 'Escape', 27);
  await waitFor(() => evaluate('!document.querySelector("dialog.test-data")'), 'Test data dialog closed');
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("Synthetic burner"))');
  await waitFor(() => evaluate('(' + curveField + ')?.value==="t2"'), 'burner with its t² curve');
  await evaluate('(' + curveField + ').focus()');
  await key('End', 'End', 35);
  const useSeries = '[...document.querySelectorAll("#inspector button")].find(b=>b.textContent==="Use series")';
  await waitFor(() => evaluate('!!' + useSeries), 'From test data form');
  const seriesPreview = await evaluate('document.querySelector("#inspector .hrr-curve__preview").textContent.replace(/\\u00a0/g, " ")');
  check('From test data names the mapped series and its thinning (' + seriesPreview + ')',
    /^Synthetic logger · measured: [\d,]+ samples from -?[\d.]+ s to [\d.]+ s(?:; the [\d,]+ before ignition are left out)?, thinned to at most 200 points keeping the extremes\.$/.test(seriesPreview));
  await click(useSeries);
  await waitFor(async () => (await evaluate(curveSummaryText)).endsWith('source measured:logger'), 'curve from test data');
  const kept = await evaluate('document.querySelector("#inspector .hrr-curve__message")?.textContent ?? ""');
  check('Use series makes a measured curve and says how many points it kept (' + kept + ')',
    /^Kept (\d+) of [\d,]+ samples, with the extremes\./.test(kept) && Number(kept.match(/^Kept (\d+)/)[1]) <= 200
    && (await evaluate(curveSummaryText)).startsWith('Curve: ' + kept.match(/^Kept (\d+)/)[1] + ' points'));
  await screenshot('curve-from-test-data');
  await evaluate('document.activeElement?.blur()');
  for (let i = 0; i < 3; i += 1) await ctrlZ();
  // The inspector repaints a task after the store; wait for all three together.
  await waitFor(() => evaluate('!document.querySelector(".toolbar__file").textContent.includes("•") && (' + curveField + ')?.value==="steady"'
    + ' && !document.querySelector(".playback-bar:not([hidden])")'), 'undo of the curves and the mapping');
  check('undo of the curves and the mapping leaves the plan unmodified, without a fire clock', true);

  phase('HRR curve editor and the fire clock');
  // Making a curve (M17) on the Example's burner: a t² fast growth by real keys on
  // the Curve and Growth rate selects, typed hold and decay with their readout, the
  // cone following the flame clock, and undo; a pasted table; then, with the flame
  // deleted, the fire clock on the same bar stepping the cone.
  await openTab();
  await send('Page.navigate', { url: origin + '/dist/index.html' });
  await waitFor(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="Example")'), 'built editor for the curve');
  await click('[...document.querySelectorAll("button")].find(b=>b.textContent==="Example")');
  await waitFor(() => evaluate('!!document.querySelector(".playback-bar:not([hidden]) input[aria-label=\\"Frame\\"]:not(:disabled)")'), 'Example flame for the curve');
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("Heptane pan"))');
  const exampleCurve = field('Curve');
  const exampleSummary = 'document.querySelector("#inspector .hrr-curve")?.textContent ?? ""';
  const exampleBar = 'document.querySelector(".playback-bar__readout")?.textContent ?? ""';
  // Previews keep a number and its unit together with a no-break space.
  const curvePreview = '(document.querySelector("#inspector .hrr-curve__preview")?.textContent ?? "").replace(/\\u00a0/g, " ")';
  const unmodified = '!document.querySelector(".toolbar__file").textContent.includes("•")';
  await waitFor(() => evaluate('!!' + exampleCurve), 'Example Curve select');
  await evaluate('(' + exampleCurve + ').focus()');
  await key('ArrowDown', 'ArrowDown', 40);
  await waitFor(() => evaluate('!!' + field('Growth rate') + ' && document.activeElement===' + exampleCurve), 't² form, focus kept on Curve');
  await evaluate('(' + field('Growth rate') + ').focus()');
  await key('ArrowDown', 'ArrowDown', 40);
  await waitFor(async () => await evaluate('(' + field('Growth rate') + ').value==="fast"') && (await evaluate(curvePreview)).startsWith('Time to peak 41.3 s'), 'fast growth by a key');
  check('the t² form reads out the time to peak of a fast growth to the burner\'s 80 kW (' + await evaluate(curvePreview) + ')',
    await evaluate(curvePreview) === 'Time to peak 41.3 s · holds to 341.3 s · ends at 641.3 s'
    && await evaluate('(' + field('Peak (kW)') + ').value') === '80'
    && await evaluate('[...document.querySelectorAll("#inspector label.field")].find(l=>l.querySelector(".field__label")?.textContent==="α (kW/s²)")?.querySelector(".hrr-curve__alpha")?.textContent') === '0.0469');
  const typeInto = async (expression, text) => {
    await evaluate('(() => { const e=' + expression + '; e.focus(); e.select(); })()');
    await send('Input.insertText', { text });
  };
  await typeInto(field('Hold (s)'), '60');
  await waitFor(async () => (await evaluate(curvePreview)) === 'Time to peak 41.3 s · holds to 101.3 s · ends at 401.3 s', 'typed hold');
  const makeExampleT2 = '[...document.querySelectorAll("#inspector button")].find(b=>b.textContent==="Make t² curve")';
  await typeInto(field('Decay (s)'), '0');
  await waitFor(() => evaluate('(' + field('Decay (s)') + ').getAttribute("aria-invalid")==="true"'), 'invalid decay');
  check('an invalid decay is named, keeps its text and turns Make t² curve off', await evaluate(curvePreview) === 'The decay must be longer than 0 s.'
    && await evaluate('(' + field('Decay (s)') + ').value') === '0' && await evaluate(makeExampleT2 + '.disabled'));
  await typeInto(field('Decay (s)'), '300');
  await waitFor(() => evaluate('!' + makeExampleT2 + '.disabled'), 'valid decay');
  await screenshot('hrr-t2-form');
  await click(makeExampleT2);
  await waitFor(async () => (await evaluate(exampleSummary)).endsWith('source t2-fast'), 't² fast curve made');
  const peakReadout = '[...document.querySelectorAll("#inspector .readout")].find(r=>r.querySelector(".readout__label").textContent==="Peak HRR (kW)")?.querySelector(".readout__value").textContent';
  check('Make t² curve sets the curve as one edit: readout, sparkline, the peak in place of the HRR field, focus kept ('
    + await evaluate(exampleSummary) + ')',
    /^Curve: \d+ points, peak 80 kW at 41\.3\d* s, source t2-fast$/.test(await evaluate(exampleSummary))
    && await evaluate(peakReadout) === '80' && !(await evaluate('!!' + field('HRR (kW)')))
    && await evaluate('(' + exampleCurve + ').value') === 't2'
    && await evaluate('document.querySelector("#inspector .hrr-curve__spark")?.getAttribute("aria-label")') === 'Heat release rate curve, peak 80 kW at 41.3 s'
    && await evaluate('!!document.querySelector("#inspector .hrr-curve__spark circle.hrr-curve__peak")')
    && await evaluate('document.activeElement.textContent') === 'Make t² curve'
    && !(await evaluate(unmodified)));
  // The Example's flame is loaded, so its frames stay the clock and the cone follows it.
  check('the flame clock at rest says the cone shows the peak (' + await evaluate(exampleBar) + ')',
    /^t = 0\.0 s · frame 1\/80 · [\d,]+ cubes · cone at peak, Q = 80 kW · flame [\d.]+ ft$/.test(await evaluate(exampleBar)));
  for (let i = 0; i < 4; i += 1) await key('.', 'Period', 190);
  await waitFor(async () => /^t = 20\.0 s · frame 5\/80 · [\d,]+ cubes · Q = 18\.8 kW · flame [\d.]+ ft$/.test(await evaluate(exampleBar)), 'cone follows the flame clock');
  check('stepped, the cone follows the flame clock at Q(t)', true);
  await key('Home', 'Home', 36);
  await waitFor(async () => (await evaluate(exampleBar)).includes('cone at peak'), 'Home returns the cone to the peak');
  check('Home returns the clock to rest and the cone to the peak', true);
  await evaluate('document.activeElement?.blur()');
  await ctrlZ();
  await waitFor(() => evaluate('!document.querySelector("#inspector .hrr-curve") && !!' + field('HRR (kW)')), 'undo of the t² curve');
  check('undo removes the curve, restores the steady HRR field and an unmodified plan',
    await evaluate('(' + exampleCurve + ').value') === 'steady' && await evaluate(unmodified)
    && !(await evaluate(exampleBar)).includes('Q = '));

  // A table pasted from a spreadsheet: refused by row while out of order, then used.
  await evaluate('(' + exampleCurve + ').focus()');
  await key('End', 'End', 35);
  await waitFor(async () => (await evaluate('document.querySelector("#inspector .hrr-curve__form")?.textContent ?? ""'))
    .startsWith('No heat release rate series is loaded for this burner.'), 'From test data by End');
  check('From test data without a mapped series says what it needs, with nothing to apply',
    await evaluate('(' + exampleCurve + ').value') === 'measured' && !(await evaluate('[...document.querySelectorAll("#inspector button")].some(b=>b.textContent==="Use series")')));
  await evaluate('(' + exampleCurve + ').focus()');
  await key('ArrowUp', 'ArrowUp', 38);
  const tableArea = 'document.querySelector("#inspector textarea.hrr-curve__table")';
  const useTable = '[...document.querySelectorAll("#inspector button")].find(b=>b.textContent==="Use table")';
  await waitFor(() => evaluate('!!' + tableArea), 'table form');
  check('a steady burner\'s table starts empty, with a hint and Use table off', await evaluate(tableArea + '.value') === ''
    && (await evaluate(tableArea + '.placeholder')).startsWith('Paste two columns') && await evaluate(useTable + '.disabled'));
  await evaluate(tableArea + '.focus()');
  await send('Input.insertText', { text: 'Time (s)\tHRR (kW)\n0\t60\n30\t120\n20\t120' });
  await waitFor(() => evaluate(tableArea + '.getAttribute("aria-invalid")==="true"'), 'table refused');
  check('a pasted table out of order is refused by row, its text kept (' + await evaluate(curvePreview) + ')',
    await evaluate(curvePreview) === 'Row 4: time 20 s does not follow 30 s; times must increase strictly.'
    && await evaluate(useTable + '.disabled') && (await evaluate(tableArea + '.value')).endsWith('20\t120'));
  await evaluate(tableArea + '.select()');
  await send('Input.insertText', { text: 'Time (s)\tHRR (kW)\n0\t60\n30\t120\n90\t120\n150\t0' });
  await waitFor(async () => (await evaluate(curvePreview)) === '4 points from 0 s to 150 s, peak 120 kW at 30 s', 'table preview');
  await click(useTable);
  await waitFor(async () => (await evaluate(exampleSummary)) === 'Curve: 4 points, peak 120 kW at 30 s, source table', 'curve from a table');
  check('Use table sets the pasted curve as one edit, with its peak', await evaluate(peakReadout) === '120'
    && await evaluate('(' + exampleCurve + ').value') === 'table');

  // Without the flame there is no frame clock: the same bar becomes the fire clock.
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("Synthetic flame"))');
  await new Promise(r => setTimeout(r, 150));
  await key('Delete', 'Delete', 46);
  await waitFor(() => evaluate('document.querySelector(".playback-bar:not([hidden])")?.getAttribute("aria-label")==="Fire clock"'), 'fire clock without the flame');
  const atRest = await evaluate(exampleBar);
  check('the fire clock uses the shared transport and speeds, and at rest draws the peak (' + atRest + ')',
    /^Cone at peak, Q = 120 kW · flame ([\d.]+) ft · t = 0\.0 s$/.test(atRest)
    && await evaluate('document.querySelector(".playback-bar input[aria-label=\\"Fire clock time\\"]").max') === '150'
    && await evaluate('[...document.querySelectorAll(".playback-bar__controls .playback-bar__btn")].slice(0, 5).map(b=>b.getAttribute("aria-label")).join("|")')
      === 'First frame (Home)|Previous frame (,)|Play (Space)|Next frame (.)|Last frame (End)'
    && JSON.stringify(await evaluate('[...document.querySelector(".playback-bar [aria-label=\\"Playback speed\\"]").options].map(o=>[o.value,o.textContent])')) === JSON.stringify(editorSpeeds)
    && await evaluate('!document.querySelector(".playback-bar__legend")'));
  await click('document.querySelector(".playback-bar button[aria-label=\\"First frame (Home)\\"]")');
  await key('.', 'Period', 190);
  await waitFor(async () => (await evaluate(exampleBar)).startsWith('Q = 62 kW at t = 1.0 s'), 'fire clock step');
  const stepped = await evaluate(exampleBar);
  check('a step of the fire clock moves the cone to Q(t), lower than the peak (' + stepped + ')',
    /^Q = 62 kW at t = 1\.0 s · flame ([\d.]+) ft$/.test(stepped)
    && Number(stepped.match(/flame ([\d.]+) ft/)[1]) < Number(atRest.match(/flame ([\d.]+) ft/)[1]));
  await evaluate('document.activeElement?.blur()');
  await key(' ', 'Space', 32);
  await waitFor(async () => Number((await evaluate(exampleBar)).match(/t = ([\d.]+) s/)?.[1] ?? 0) > 2, 'Space plays the fire clock');
  await key(' ', 'Space', 32);
  check('Space plays and pauses the fire clock from the page', await evaluate('!!document.querySelector(".playback-bar button[aria-label=\\"Play (Space)\\"]")'));
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("Heptane pan"))');
  await waitFor(() => evaluate('!!document.querySelector("#inspector .hrr-curve__spark")'), 'burner with its table curve');
  await screenshot('fire-clock');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await new Promise(r => setTimeout(r, 300));
  check('at 1280 x 720 the fire clock bar and the curve readout fit their panels', await evaluate(`(() => {
    const bar=document.querySelector('.playback-bar').getBoundingClientRect();
    const note=document.querySelector('#inspector .hrr-curve');
    return bar.right<=innerWidth && bar.bottom<=innerHeight && note.scrollWidth<=note.clientWidth+1;
  })()`));
  await evaluate('document.querySelector("#inspector .hrr-curve__form").scrollIntoView({block:"center"})');
  await screenshot('fire-clock-laptop');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.activeElement?.blur()');
  await ctrlZ();
  await ctrlZ();
  await waitFor(() => evaluate(unmodified + ' && !!document.querySelector(".playback-bar input[aria-label=\\"Frame\\"]")'
    + ' && !document.querySelector("#inspector .hrr-curve") && (' + exampleCurve + ')?.value==="steady"'), 'undo of the flame deletion and the table');
  check('undo restores the flame clock and the steady burner', true);


  phase('next test browser download and adoption');
  await openTab();
  await send('Page.navigate', { url: origin + '/dist/index.html' });
  await waitFor(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="Example")'), 'next-test editor');
  await click('[...document.querySelectorAll("button")].find(b=>b.textContent==="Example")');
  await waitFor(() => evaluate('!!(' + field('Series') + ')'), 'series field');
  await click(field('Series')); await send('Input.insertText', { text: 'Room fire series' }); await key('Tab', 'Tab', 9);
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("FLIR A8303sc MWIR"))');
  await waitFor(() => evaluate('!!(' + recordSurvey + ')'), 'next-test survey camera');
  await click(recordSurvey);
  await waitFor(() => evaluate('!!document.querySelector(".as-built__offset")'), 'next-test measured pose');
  await evaluate(`(() => {
    window.__nextNotices=[]; window.confirm=()=>true; window.alert=message=>window.__nextNotices.push(message);
    const create=URL.createObjectURL;
    URL.createObjectURL=function(blob) { if(blob.type==='application/json') window.__nextBlob=blob; return create.call(URL,blob); };
  })()`);
  await click('[...document.querySelectorAll("#toolbar button")].find(b=>b.textContent==="Next test…")');
  await waitFor(() => evaluate('document.querySelector(".toolbar__file").textContent==="EX-002.ftp.json"'), 'next test adopted');
  const nextDownloaded = await evaluate('(async()=>JSON.parse(await window.__nextBlob.text()))()');
  check('next test downloads the new ID, preserves series and removes test-specific records',
    nextDownloaded.meta.testId === 'EX-002' && nextDownloaded.meta.series === 'Room fire series'
    && nextDownloaded.meta.revision === null && !('testData' in nextDownloaded)
    && nextDownloaded.objects.every(o => o.type !== 'reconstructedFlame' && !('asBuilt' in o) && !('linkedFiles' in o)));
  check('next test opens the new plan and explains what was left behind', await evaluate('(' + field('Test ID') + ').value==="EX-002" && window.__nextNotices.some(s=>s.includes("Left behind:"))'));
  await screenshot('next-test');
  phase('French interface at 1280 x 720');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await click('document.querySelector("[data-language=fr]")');
  await waitFor(() => evaluate('document.documentElement.lang === "fr"'), 'French language switch');
  await evaluate('document.querySelector(".outliner__row").scrollIntoView({block:"nearest"})');
  await click('document.querySelector(".outliner__row")');
  await waitFor(() => evaluate('[...document.querySelectorAll("#inspector .field__label")].some(e=>e.textContent==="Nom")'), 'French object inspector');
  const frenchState = await evaluate(`({
    toolbar: [...document.querySelectorAll('#toolbar button')].map(b => b.textContent),
    palette: [...document.querySelectorAll('.palette__tile')].map(b => b.textContent),
    inspector: [...document.querySelectorAll('#inspector .field__label')].map(b => b.textContent),
    checks: [...document.querySelectorAll('.checks__message')].map(e => e.textContent),
    lang: document.documentElement.lang, stored: localStorage.getItem('fire-test-plan.language')
  })`);
  check('French toolbar, palette, inspector, diagnostics and document language: ' + JSON.stringify(frenchState),
    frenchState.toolbar.includes('Enregistrer') && frenchState.palette.some(s => s.includes('Bac de combustible'))
    && frenchState.inspector.includes('Nom') && frenchState.checks.some(s => /intrinsèques|brûleur|flamme|panache|fluxmètre/.test(s))
    && frenchState.lang === 'fr' && frenchState.stored === 'fr');
  const frenchOverflow = await evaluate(`
    [...document.querySelectorAll('.toolbar__group, .panel--left > section, #inspector')]
      .filter(e => e.scrollWidth > e.clientWidth + 1)
      .map(e => ({ box: e.id || e.className, scroll: e.scrollWidth, client: e.clientWidth }))`);
  check('French toolbar, rail and inspector fit their widths: ' + JSON.stringify(frenchOverflow), frenchOverflow.length === 0);
  const SPLIT_PALETTE_WORDS = `(() => {
    const split=[];
    for (const label of document.querySelectorAll('.palette__tile > span:last-child')) {
      const tile=label.parentElement;
      const box=tile.getBoundingClientRect(), style=getComputedStyle(tile);
      const right=box.right-parseFloat(style.borderRightWidth)-parseFloat(style.paddingRight);
      if (tile.offsetParent && label.getBoundingClientRect().right > right + 0.5) split.push('overflows: ' + label.textContent);
      const text=label.firstChild;
      if (!text || text.nodeType!==Node.TEXT_NODE) continue;
      for (const match of text.textContent.matchAll(/\\S+/g)) {
        const range=document.createRange(); range.setStart(text,match.index); range.setEnd(text,match.index+match[0].length);
        if(range.getClientRects().length>1) split.push(match[0]);
      }
    }
    return split;
  })()`;
  const splitWords = await evaluate(SPLIT_PALETTE_WORDS);
  check('French palette words stay together: ' + JSON.stringify(splitWords), splitWords.length === 0);
  await screenshot('french-editor');
  await click('[...document.querySelectorAll("#toolbar button")].find(b=>b.textContent==="Dessin…")');
  check('French drawing has its set-out heading', await evaluate(`
    [...document.querySelectorAll('.report h2')].some(e => e.textContent === 'Tableau d’implantation')`));
  await screenshot('french-drawing');
  await click('[...document.querySelectorAll(".report-overlay button")].find(b=>b.textContent==="Fermer")');
  await openTab();
  await send('Page.navigate', { url: origin + '/dist/index.html' });
  await waitFor(() => evaluate('document.documentElement.lang === "fr" && !!document.querySelector("[data-language=en]")'), 'French preference restored after navigation');
  check('French preference survives a new browser tab', true);
  await click('document.querySelector("[data-language=en]")');
  check('English restored by a real click', await evaluate(`document.documentElement.lang === 'en'
    && [...document.querySelectorAll('#toolbar button')].some(b=>b.textContent==='Save')
    && [...document.querySelectorAll('.palette__tile')].some(b=>b.textContent.includes('Fuel pan'))`));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => evaluate('!!document.querySelector(".palette__tile")'), 'English palette');
  const englishSplit = await evaluate(SPLIT_PALETTE_WORDS);
  check('English palette words stay together at 1280 x 720: ' + JSON.stringify(englishSplit), englishSplit.length === 0);
  check('no uncaught browser exceptions', errors.length===0);
  }
  const a11y = await accessibility({ web, origin, send, evaluate, click, key, openTab, waitFor, phase, screenshot, eventListeners });
  const failures = a11y.scans.flatMap(s => s.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ scan: s.name, rule: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })));
  checks.push({ name: 'no uncaught exceptions during accessibility checks', passed: errors.length === 0 });
  const result = { browser: executable, passed: checks.length, checks, accessibility: a11y, failures, errors };
  checks.push(...a11y.checks);
  result.passed = checks.filter(c => c.passed).length;
  if (failures.length || checks.some(c => !c.passed)) process.exitCode = 1;
  if (process.env.BROWSER_TEST_OUTPUT) {
    const output = resolve(process.env.BROWSER_TEST_OUTPUT);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (send && socket?.readyState === WebSocket.OPEN) {
    try { await send('Browser.close', {}, null); } catch {}
  }
  socket?.close();
  if (browser && browser.exitCode === null) {
    await Promise.race([once(browser, 'exit'), new Promise(r => setTimeout(r, 3000))]);
    if (browser.exitCode === null) browser.kill();
  }
  await server.close();
  // Only remove the unique temporary profile created above.
  if (dirname(profile) !== profileBase || !profile.startsWith(join(profileBase, 'fireplan-browser-'))) {
    throw new Error('Unexpected browser profile path: ' + profile);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
