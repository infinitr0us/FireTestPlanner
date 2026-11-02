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
  await waitFor(() => evaluate('document.querySelector(".reconstruction-plot input[aria-label=\\"Measurement sample\\"]")?.value==="11"'), 'synthetic CSV cursor at 55 s');
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
  const field = label => '[...document.querySelectorAll("#inspector label.field")].find(l=>l.querySelector(".field__label")?.textContent==="' + label + '")?.querySelector("select,input")';
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
