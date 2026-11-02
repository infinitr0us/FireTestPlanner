// Browser regressions without an additional automation dependency.
// Uses Chromium's DevTools protocol for real keyboard/mouse default actions.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

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
const profile = await mkdtemp(join(tmpdir(), 'fireplan-browser-'));
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
  await once(socket, 'open');
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
      ...(key === ' ' ? { text: ' ' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  };
  const click = async expression => {
    const point = await evaluate('(() => { const e = ' + expression + '; e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
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
  await click(exportButton);
  await waitFor(() => evaluate('!!document.querySelector("dialog.fds-export[open]")'), 'FDS export dialog');
  check('Example export reports quantities and omissions', await evaluate(
    'document.querySelector(".fds-export__summary").textContent === "9 devices: 1 gauge heat flux, 1 radiative heat flux gas, 3 thermocouple beads, 4 surface thermocouple beads. Cameras and geometry are not exported."'));
  const firstExportedDevice = await evaluate('document.querySelector(".fds-export__text").value.split("\\n").find(line=>line.startsWith("&DEVC"))');
  check('Example export first DEVC retains its position and normal', firstExportedDevice ===
    "&DEVC ID='East wall gauge', XYZ=1.45,0,0.9, QUANTITY='RADIATIVE HEAT FLUX GAS', ORIENTATION=-0.9946,0.0000,-0.1043 /");
  check('FDS preview is read only, focused and uses shared monospace', await evaluate(
    '(() => { const t=document.querySelector(".fds-export__text"); return t.readOnly && document.activeElement===t && getComputedStyle(t).fontFamily.includes("Cascadia Mono"); })()'));
  await screenshot('fds-export');
  await key('Escape', 'Escape', 27);
  check('Escape closes FDS preview and restores toolbar focus', await evaluate(
    '!document.querySelector("dialog.fds-export") && document.activeElement.textContent === "Export to FDS…"'));
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
  // inspector offers the datasheet's four lenses, a real key on the Lens select swaps
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
    && await evaluate(a700Row + '.title.startsWith("Placed with the 18 mm lens. Choose 5, 10, 18, 29 or 70 mm under Lens")'));
  const field =label => '[...document.querySelectorAll("#inspector label.field")].find(l=>l.querySelector(".field__label")?.textContent==="' + label + '")?.querySelector("select,input")';
  const lensSelect = field('Lens');
  const currentLens = 'document.querySelector("#inspector .lens-table__row--current th")?.textContent';
  const fovReadout = '[...document.querySelectorAll("#inspector .readout")].find(r=>r.querySelector(".readout__label").textContent==="Field of view")?.querySelector(".readout__value").textContent';
  await click('[...document.querySelectorAll(".outliner__row")].find(r=>r.textContent.includes("FLIR A8303sc MWIR"))');
  await waitFor(() => evaluate('!!' + lensSelect + ' && !!document.querySelector("#inspector .lens-table")'), 'A8303sc lens select and comparison');
  check('selected camera exposes flame line of sight', await evaluate('!!' + losReadout('Flame unobstructed')));
  const lensOptions = await evaluate('[...(' + lensSelect + ').options].map(o=>o.textContent).join("|")');
  check('the Lens select lists the datasheet lenses with their fields of view (' + lensOptions + ')',
    lensOptions === '17 mm (55.6° × 33.0°)|25 mm (39.4° × 22.8°)|50 mm (20.3° × 11.5°)|100 mm (10.2° × 5.8°)'
    && await evaluate('(' + lensSelect + ').value') === 'flir-a8303sc-25mm');
  check('the preset picker names the body, not one lens',
    await evaluate('(' + field('Preset') + ').selectedOptions[0].textContent') === 'FLIR A8303sc');
  const before = await evaluate('[...document.querySelectorAll("#inspector .lens-table tbody tr")].map(r=>r.textContent).join("|")');
  check('the comparison has a row per lens, the 25 mm current, with plume verdicts (' + before + ')',
    await evaluate(currentLens) === '▶ 25 mm'
    && await evaluate('document.querySelectorAll("#inspector .lens-table tbody tr").length') === 4
    && await evaluate('document.querySelectorAll("#inspector .lens-table td.lens-table__good, #inspector .lens-table td.lens-table__bad").length') === 4);
  await evaluate('(' + lensSelect + ').focus()');
  await key('End', 'End', 35);
  await waitFor(() => evaluate(currentLens + '==="▶ 100 mm"'), 'comparison follows the lens key');
  check('a key on the Lens select fits the 100 mm lens everywhere',
    await evaluate(fovReadout) === '10.2° × 5.8°'
    && await evaluate('(' + field('Focal length (mm)') + ').value') === '100'
    && await evaluate('(' + lensSelect + ').value') === 'flir-a8303sc-100mm');
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
  check('the A700 Lens select lists its five lenses with their fields of view, the 24° (18 mm) fitted (' + a700Options + ')',
    a700Options === '5 mm (75.0° × 59.9°)|10 mm (42.0° × 32.1°)|18 mm (24.1° × 18.2°)|29 mm (15.1° × 11.3°)|70 mm (6.3° × 4.7°)'
    && await evaluate('(' + lensSelect + ').value') === 'flir-a700-24deg'
    && await evaluate(fovReadout) === '24.1° × 18.2°'
    && await evaluate('document.querySelectorAll("#inspector .lens-table tbody tr").length') === 5);
  await evaluate('document.activeElement?.blur()');
  await ctrlZ();
  await waitFor(() => evaluate(presetName + '==="FLIR A8303sc" && ' + currentLens + '==="▶ 25 mm"'), 'undo of the switch to the A700');
  check('undo of the switch to the A700 restores the A8303sc and an unmodified plan',
    await evaluate(fovReadout) === '39.4° × 22.8°'
    && await evaluate('!document.querySelector(".toolbar__file").textContent.includes("•")'));

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

  check('no uncaught browser exceptions', errors.length===0);
  const result = { browser: executable, passed: checks.length, checks };
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
  if (dirname(profile) !== resolve(tmpdir()) || !profile.startsWith(join(resolve(tmpdir()), 'fireplan-browser-'))) {
    throw new Error('Unexpected browser profile path: ' + profile);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
