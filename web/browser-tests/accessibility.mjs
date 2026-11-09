import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// No rule or element exclusions. Keep all impacts and affected nodes in the report.
export async function accessibility({ web, origin, send, evaluate, click, key, openTab, waitFor, phase, screenshot, eventListeners }) {
  const scans = [], toolbar = {}, checks = [];
  const check = (name, passed, detail) => { checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); };
  const axe = await readFile(resolve(web, 'node_modules/axe-core/axe.min.js'), 'utf8');
  const button = text => `[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)})`;
  const scan = async name => {
    phase('axe: ' + name);
    await evaluate(axe);
    const result = await evaluate(`axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}).then(r=>({violations:r.violations,incomplete:r.incomplete}))`);
    scans.push({ name, ...result });
    const blocking = result.violations.filter(v => ['serious', 'critical'].includes(v.impact));
    check('axe WCAG 2.1 A/AA: ' + name, blocking.length === 0,
      blocking.map(v => ({ rule: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })));
    // Persist every impact even if a later input check or navigation fails.
    if (process.env.BROWSER_TEST_OUTPUT) {
      const path = resolve(process.env.BROWSER_TEST_OUTPUT);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ incompleteRun: true, accessibility: { scans, toolbar, checks } }, null, 2) + '\n');
    }
  };
  const file = async (control, path) => {
    await send('Page.setInterceptFileChooserDialog', { enabled: true });
    const chooser = new Promise(resolve => {
      const listener = m => { if (m.method === 'Page.fileChooserOpened') { eventListeners.delete(listener); resolve(m.params); } };
      eventListeners.add(listener);
    });
    await click(control);
    const { backendNodeId } = await chooser;
    await send('DOM.setFileInputFiles', { files: [resolve(web, '..', path)], backendNodeId });
    await send('Page.setInterceptFileChooserDialog', { enabled: false });
  };
  const fds = async text => {
    if (await evaluate(`!!document.querySelector('#fds-menu-button')`)) await click(`document.querySelector('#fds-menu-button')`);
    await click(button(text));
  };
  await openTab();
  await send('Page.navigate', { url: origin + '/dist/index.html' });
  await waitFor(() => evaluate(`!!document.querySelector('[data-language=en]')`), 'accessibility editor');
  await click(`document.querySelector('[data-language=en]')`);
  await click(button('Example'));
  await waitFor(() => evaluate(`!!document.querySelector('.playback-bar input:not(:disabled)')`), 'accessibility Example');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  for (const lang of ['en', 'fr']) {
    await click(`document.querySelector('[data-language=${lang}]')`);
    toolbar[lang] = await evaluate(`document.querySelector('#toolbar').getBoundingClientRect().height`);
    check('toolbar at most two rows at 1280 x 720: ' + lang, toolbar[lang] <= 92, toolbar[lang]);
    await scan('Example ' + lang);
    await screenshot('axe-example-' + lang);
  }
  await click(`document.querySelector('[data-language=en]')`);
  phase('accessibility: menu keyboard and contrast themes');
  await evaluate(button('Next test…') + '.focus()'); await key('Tab', 'Tab', 9);
  check('Tab reaches the FDS menu in toolbar order', await evaluate(`document.activeElement.id==='fds-menu-button'`));
  const menuOpen = `document.querySelector('#fds-menu-button').getAttribute('aria-expanded')==='true'`;
  const activeText = () => evaluate(`document.activeElement.textContent`);
  await key('Enter', 'Enter', 13);
  check('Enter opens the menu at Import FDS', await evaluate(menuOpen) && await activeText() === 'Import FDS…');
  await scan('FDS menu');
  await key('ArrowDown', 'ArrowDown', 40);
  check('Down moves to Export', await activeText() === 'Export to FDS…');
  await key('End', 'End', 35);
  check('End reaches results', await activeText() === 'FDS results…');
  await key('Home', 'Home', 36);
  await key('ArrowUp', 'ArrowUp', 38);
  check('Home and Up wrap from first to last', await activeText() === 'FDS results…');
  await key('Escape', 'Escape', 27);
  check('Escape closes menu and restores its button', !await evaluate(menuOpen) && await evaluate(`document.activeElement.id==='fds-menu-button'`));
  await key('ArrowUp', 'ArrowUp', 38);
  check('Up on the button opens at the last item', await activeText() === 'FDS results…');
  await key('Tab', 'Tab', 9);
  check('Tab closes menu and continues to Test data', !await evaluate(menuOpen) && await activeText() === 'Test data…');
  await evaluate(`document.querySelector('#fds-menu-button').focus()`); await key('ArrowDown', 'ArrowDown', 40);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  check('Shift+Tab closes menu and continues to Next test', !await evaluate(menuOpen) && await activeText() === 'Next test…');
  await evaluate(`document.querySelector('#fds-menu-button').focus()`); await key(' ', 'Space', 32);
  check('Space opens menu at its first item', await activeText() === 'Import FDS…');
  await click(`document.querySelector('.toolbar__title')`);
  check('click outside closes menu', !await evaluate(menuOpen));
  await click(`document.querySelector('.outliner__row')`);
  await key('ArrowDown', 'ArrowDown', 40); await key(' ', 'Space', 32);
  check('outliner arrow then Space selects and preserves row focus', await evaluate(`document.activeElement.matches('.outliner__row[aria-pressed=true]') && document.activeElement.textContent.includes('Calorimeter hood')`));
  await key('ArrowUp', 'ArrowUp', 38); await key('Enter', 'Enter', 13);
  check('outliner Enter selects and preserves focus', await evaluate(`document.activeElement.matches('.outliner__row[aria-pressed=true]') && document.activeElement.textContent.includes('Heptane pan')`));
  await waitFor(() => evaluate(`!!document.querySelector('.plot-panel:not([hidden]) [data-plot-control=collapse]')`), 'burner plot');
  await evaluate(`document.querySelector('[data-plot-control=collapse]').focus()`); await key(' ', 'Space', 32);
  check('plot Collapse preserves focus and announces its state', await evaluate(`document.activeElement.matches('[data-plot-control=collapse][aria-expanded=false]')`));
  await key(' ', 'Space', 32);
  check('plot Expand preserves focus and restores content', await evaluate(`document.activeElement.matches('[data-plot-control=collapse][aria-expanded=true]') && !!document.querySelector('.plot-panel svg')`));
  check('frame and plot readouts do not announce every frame', await evaluate(`
    [...document.querySelectorAll('.playback-bar output,.plot-panel output')].every(e=>e.getAttribute('aria-live')==='off')`));
  await evaluate(`document.querySelector('#inspector .field__vec input').focus()`); await key('Tab', 'Tab', 9);
  check('inspector text inputs have the shared visible focus ring', await evaluate(`getComputedStyle(document.activeElement).outlineStyle==='solid' && getComputedStyle(document.activeElement).outlineWidth==='2px'`));
  const rootLayout = await evaluate(`({ y:scrollY, boxes:[document.documentElement,document.body,document.querySelector('#toolbar'),document.querySelector('.layout')].map(e=>({tag:e.tagName,top:e.getBoundingClientRect().top,height:e.getBoundingClientRect().height,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,overflow:getComputedStyle(e).overflow})) })`);
  check('keyboard focus keeps toolbar in view', rootLayout.boxes[2].top===0, rootLayout);
  const finding = `document.querySelector('.checks__body:not(:disabled)[data-object-id]')`;
  const issueObject = await evaluate(finding + '.dataset.objectId');
  await evaluate(finding + '.focus()'); await key('Enter', 'Enter', 13);
  check('Checks Enter selects its associated object', await evaluate(`document.querySelector('.outliner__row[aria-pressed=true]').dataset.objectId===${JSON.stringify(issueObject)}`));
  await click(`document.querySelector('.outliner__row')`);
  await evaluate(finding + '.focus()'); await key(' ', 'Space', 32);
  check('Checks Space selects its associated object', await evaluate(`document.querySelector('.outliner__row[aria-pressed=true]').dataset.objectId===${JSON.stringify(issueObject)}`));
  // The viewport's controls retain native Tab behavior and can be left for the inspector.
  await evaluate(`document.querySelector('.playback-bar button:last-of-type').focus()`);
  for (let n = 0; n < 20 && !await evaluate(`!!document.activeElement.closest('#inspector')`); n++) await key('Tab', 'Tab', 9);
  check('Tab leaves viewport controls for the inspector', await evaluate(`!!document.activeElement.closest('#inspector')`));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  const states = await evaluate(`(() => {
    const style=e=>{const s=getComputedStyle(e);return [s.outlineStyle,s.outlineWidth,s.textDecorationLine,s.borderLeftStyle]};
    return { pressed:style(document.querySelector('#toolbar [aria-pressed=true]')), plain:style(document.querySelector('#toolbar [aria-pressed=false]')),
      selected:style(document.querySelector('.outliner__row[aria-pressed=true]')), row:style(document.querySelector('.outliner__row[aria-pressed=false]')),
      language:style(document.querySelector('[data-language=en]')), otherLanguage:style(document.querySelector('[data-language=fr]')) };
  })()`);
  for (const [a, b] of [['pressed','plain'], ['selected','row'], ['language','otherLanguage']]) {
    check('forced colors distinguishes ' + a + ' without color', JSON.stringify(states[a]) !== JSON.stringify(states[b]), states);
  }
  await screenshot('forced-colors');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check('reduced motion suppresses CSS animation, transition and smooth scroll', await evaluate(`
    [...document.querySelectorAll('button,input,select,summary,.panel,.viewport')].every(e=>{
      const s=getComputedStyle(e);return s.animationName==='none' && s.transitionDuration==='0s' && s.scrollBehavior==='auto';})`));
  await send('Emulation.setEmulatedMedia', { features: [] });
  for (const name of ['FLIR A8303sc MWIR', 'East wall gauge', 'Plume rake', 'Heptane pan', 'East wall', 'Calorimeter hood', 'Synthetic flame']) {
    await click(`[...document.querySelectorAll('.outliner__row')].find(r=>r.querySelector('.outliner__name').textContent.startsWith(${JSON.stringify(name)}))`);
    await waitFor(() => evaluate(`document.querySelector('#inspector input')?.value.startsWith(${JSON.stringify(name)})`), 'selected inspector ' + name);
    await scan('inspector ' + name);
  }
  // The production curve editor is inline in the burner inspector.
  await click(`[...document.querySelectorAll('.outliner__row')].find(r=>r.textContent.includes('Heptane pan'))`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-focus-key=curve-mode]')`), 'burner curve selector');
  await evaluate(`document.querySelector('[data-focus-key=curve-mode]').focus()`);
  await key('Home', 'Home', 36); await key('ArrowDown', 'ArrowDown', 40); await key('ArrowDown', 'ArrowDown', 40);
  await waitFor(() => evaluate(`!!document.querySelector('.hrr-curve__table')`), 'curve table');
  await scan('HRR curve table');
  await fds('Export to FDS…'); await scan('Export to FDS'); await key('Escape', 'Escape', 27);
  check('export dialog Escape restores FDS button', await evaluate(`document.activeElement.id==='fds-menu-button'`));
  await click(button('Drawing…')); await scan('Drawing preview');
  check('Drawing takes focus inside a modal', await evaluate(`!!document.querySelector('dialog.report-overlay[open]')?.contains(document.activeElement)`));
  await screenshot('drawing-accessibility');
  await key('Escape', 'Escape', 27);
  check('Drawing Escape returns focus to opener', await activeText() === 'Drawing…');
  if (await evaluate(`!!document.querySelector('#fds-menu-button')`)) await click(`document.querySelector('#fds-menu-button')`);
  await file(button('Import FDS…'), 'fixtures/fds/room_corner.fds');
  await waitFor(() => evaluate(`!!document.querySelector('.import')`), 'import preview');
  await scan('Import FDS preview');
  check('Import takes focus inside a modal with keyboard scroll access', await evaluate(`!!document.querySelector('dialog.modal[open]')?.contains(document.activeElement) && !!document.querySelector('.import__scroll[tabindex="0"]')`));
  await key('Escape', 'Escape', 27);
  check('Import Escape restores FDS button', await evaluate(`document.activeElement.id==='fds-menu-button'`));
  await click(`document.querySelector('#fds-menu-button')`);
  await file(button('Import FDS…'), 'fixtures/fds/room_corner.fds');
  await waitFor(() => evaluate(`!!document.querySelector('.import')`), 'second import preview');
  await click(button('Import'));
  check('Import completion is announced', await evaluate(`document.querySelector('#file-status').textContent==='Imported room_corner.fds.'`));
  const downloads = resolve(web, '../review/accessibility-downloads');
  await mkdir(downloads, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }, null);
  // Exercise the supported download fallback; native save pickers are a separate boundary.
  await evaluate(`void Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })`);
  await click(button('Save'));
  await waitFor(() => evaluate(`document.querySelector('#file-status').textContent.startsWith('Saved ')`), 'save status');
  check('Save completion is announced', true);
  await fds('FDS results…'); await scan('FDS results empty'); await key('Escape', 'Escape', 27);
  // The results regression fixture opens the small recorded room_corner subset.
  await openTab();
  await send('Page.navigate', { url: origin + '/browser-tests/visual-consistency.html?interactive=1' });
  await waitFor(async () => {
    const text = await evaluate(`document.querySelector('#report')?.textContent ?? ''`);
    if (text.includes('FAILED:')) throw new Error(text);
    try { return JSON.parse(text).passed; } catch { return false; }
  }, 'results fixture for axe');
  await scan('FDS results loaded');
  // Reuse the imported room fixture: it contains both a real HRR curve and a wall opening.
  await openTab();
  await send('Page.navigate', { url: origin + '/dist/index.html' });
  await waitFor(() => evaluate('!!' + button('Open')), 'room plan editor');
  await file(button('Open'), 'fixtures/fds/room_corner.ftp.json');
  await waitFor(() => evaluate(`document.querySelector('.toolbar__file').textContent.startsWith('room_corner.ftp.json')`), 'room plan');
  check('Open completion is in a polite live region', await evaluate(`document.querySelector('#file-status[role=status][aria-live=polite]').textContent==='Opened room_corner.ftp.json.'`));
  for (const name of ['Wall', 'Ceiling', 'FIRE']) {
    await click(`[...document.querySelectorAll('.outliner__row')].find(r=>r.querySelector('.outliner__name').textContent===${JSON.stringify(name)})`);
    await waitFor(() => evaluate(`document.querySelector('#inspector input')?.value===${JSON.stringify(name)}`), 'inspector ' + name);
    await scan(name === 'Wall' ? 'wall with opening' : name === 'FIRE' ? 'burner with HRR curve' : 'ceiling');
  }
  await openTab();
  await send('Page.navigate', { url: origin + '/dist/index.html' });
  await waitFor(() => evaluate('!!' + button('Open')), 'optional measurements editor');
  await file(button('Open'), 'fixtures/instruments17.ftp.json');
  await waitFor(() => evaluate(`document.querySelector('.toolbar__file').textContent.startsWith('instruments17.ftp.json')`), 'instruments plan');
  for (const name of ['Door probe', 'Gas sample', 'Load cell']) {
    await click(`[...document.querySelectorAll('.outliner__row')].find(r=>r.querySelector('.outliner__name').textContent===${JSON.stringify(name)})`);
    await waitFor(() => evaluate(`document.querySelector('#inspector input')?.value===${JSON.stringify(name)}`), 'inspector ' + name);
    await scan('inspector ' + name);
    if (name === 'Gas sample') continue;
    const label = name === 'Load cell' ? 'Capacity (kg)' : 'Range (m/s)';
    const input = `document.querySelector('input[aria-label="${label}"]')`;
    await click(input); await evaluate(input + '.select()'); await key('Backspace', 'Backspace', 8); await key('Tab', 'Tab', 9);
    await waitFor(() => evaluate(input + '.value===""'), 'cleared optional field');
    await click(`[...document.querySelectorAll('.outliner__row')].find(r=>r.textContent.includes('Gas sample'))`);
    await click(`[...document.querySelectorAll('.outliner__row')].find(r=>r.querySelector('.outliner__name').textContent===${JSON.stringify(name)})`);
    await waitFor(() => evaluate('!!' + input), 'optional field rebuilt');
    check('cleared ' + label + ' stays empty after rebuilding, with placeholder', await evaluate(input + '.value==="" && ' + input + '.placeholder==="not set"'));
  }
  // Add the remaining geometry kind using the public palette placement path.
  await click(`[...document.querySelectorAll('.palette__tile')].find(b=>b.textContent.includes('Obstruction'))`);
  await click(`document.querySelector('#viewport canvas')`);
  await waitFor(() => evaluate(`!![...document.querySelectorAll('.outliner__name')].find(e=>e.textContent.startsWith('Obstruction'))`), 'placed obstruction');
  await scan('inspector obstruction');
  await openTab();
  await send('Page.navigate', { url: origin + '/dist/index.html' });
  await waitFor(() => evaluate('!!' + button('Open')), 'test data editor for axe');
  await file(button('Open'), 'fixtures/test-data/test-data.ftp.json');
  await waitFor(() => evaluate(`document.querySelector('.toolbar__file').textContent.startsWith('test-data.ftp.json')`), 'test data plan');
  await click(button('Test data…')); await scan('Test data sources');
  await evaluate(`window.__a11yMessage = document.querySelector('dialog.test-data [role=status]'); window.__a11yCount = document.querySelector('#checks [role=status]'); true`);
  const { result } = await send('Runtime.evaluate', { expression: `document.querySelector('dialog.test-data input[type=file][data-source-id=logger]')` });
  await send('DOM.setFileInputFiles', { files: [resolve(web, '../fixtures/test-data/logger-export.xlsx')], objectId: result.objectId });
  await waitFor(() => evaluate(`document.querySelector('[data-source-id=logger] .test-data__status').textContent.startsWith('Loaded')`), 'test data loaded');
  check('source load status updates the persistent dialog live region', await evaluate(`window.__a11yMessage===document.querySelector('dialog.test-data [role=status]') && window.__a11yMessage.textContent.includes('Loaded')`));
  await click(`[...document.querySelectorAll('[data-source-id=logger] button')].find(b=>b.textContent==='Edit…')`);
  await scan('Test data mapping');
  check('mapping editor keeps the same live region', await evaluate(`window.__a11yMessage===document.querySelector('dialog.test-data [role=status]')`));
  check('one persistent live region in Test data', await evaluate(`document.querySelectorAll('dialog.test-data [role=status]').length===1`));
  await key('Escape', 'Escape', 27);

  // The flame analysis board: its welcome in the built editor, then the synthetic
  // test loaded on its regression page with a step's text open.
  await click(button('Flame analysis…'));
  await waitFor(() => evaluate(`!!document.querySelector('dialog.flame-analysis[open] .flame-analysis__welcome button')`), 'flame analysis welcome');
  await scan('Flame analysis empty');
  await key('Escape', 'Escape', 27);
  check('Escape closes the empty flame analysis board', await evaluate(`!document.querySelector('dialog.flame-analysis[open]')`));
  await openTab();
  await send('Page.navigate', { url: origin + '/browser-tests/flame-analysis.html' });
  await waitFor(() => evaluate(`document.querySelectorAll('.flame-analysis__picture').length===3 && [...document.querySelectorAll('.flame-analysis__picture')].every(c=>c.width>1)`), 'flame analysis loaded', 60000);
  await click(`document.querySelector('.flame-analysis__step[data-step=hrr]')`);
  await scan('Flame analysis loaded');
  return { scans, toolbar, checks, exclusions: [], notes: ['Share uses a file download and native alert messages, with no HTML dialog.'] };
}
