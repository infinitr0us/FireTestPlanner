import room from '../../fixtures/fds/room_corner.ftp.json';
import fdsText from '../../fixtures/fds/room_corner.fds?raw';
import { curveSummary } from '../src/core/hrr';
import { burnerFlameHeightM } from '../src/core/plan';
import { serializePlan } from '../src/core/serialize';
import { parseAndValidatePlan } from '../src/core/validate';
import { isBurner } from '../src/core/types';
import { buildReportBody, REPORT_CSS } from '../src/export/report';
import { buildBurner } from '../src/scene/builders';
import { Store } from '../src/state/store';
import { Inspector } from '../src/ui/inspector';
import { FdsImportDialog } from '../src/ui/import-fds';
import { button } from '../src/ui/fields';

const report = document.querySelector('#report')!;
const results: { name: string; passed: boolean }[] = [];
const check = (name: string, ok: boolean) => {
  results.push({ name, passed: ok });
  if (!ok) throw new Error(name);
};
try {
  const root = document.querySelector<HTMLElement>('#inspector')!;
  const doc = parseAndValidatePlan(JSON.stringify(room));
  const store = new Store(doc), inspector = new Inspector(root, store), dialog = new FdsImportDialog();
  const burner = doc.objects.find(isBurner)!;
  store.subscribe(() => inspector.render());
  store.select([burner.id]);
  inspector.render();
  await new Promise(resolve => setTimeout(resolve, 20));
  const summary = curveSummary(burner.fire!.hrrCurve!);
  check('loaded 1.7 readout names points, peak, first peak time and source', root.querySelector('.hrr-curve')?.textContent === summary);
  check('curve peak is read-only', [...root.querySelectorAll('label')].every(l => l.querySelector('.field__label')?.textContent !== 'HRR (kW)'));
  const group = buildBurner(burner, true);
  const cone = group.children.find(o => o.userData.selectionOnly);
  check('3D cone still uses the peak', !!cone && Math.abs(cone.position.z - (burner.rimHeight_m! + burnerFlameHeightM(burner)! / 2)) < 1e-8);
  const style = document.createElement('style'); style.textContent = REPORT_CSS; document.head.append(style);
  const drawing = document.querySelector('#drawing')!;
  drawing.innerHTML = buildReportBody(store.document, 'm');
  check('drawing equipment row has the same curve summary', drawing.textContent!.includes(summary));
  check('saving and reopening retains the curve', serializePlan(parseAndValidatePlan(serializePlan(doc))) === serializePlan(doc));
  for (const width of [320, 260]) {
    root.style.width = `${width}px`;
    const note = root.querySelector<HTMLElement>('.hrr-curve')!;
    check(`curve readout fits at ${width}px`, note.scrollWidth <= note.clientWidth + 1);
  }
  root.style.width = '320px';
  const actions = document.querySelector('#actions')!;
  const undo = button('Undo curve removal', () => store.undo()); undo.id = 'undo';
  const redo = button('Redo curve removal', () => store.redo()); redo.id = 'redo';
  const open = button('Import preview', () => dialog.open(fdsText, 'room_corner.fds', 'm', () => {})); open.id = 'preview';
  const save = button('Save and reopen', () => {
    store.replaceDocument(parseAndValidatePlan(serializePlan(store.document)), 'hrr.ftp.json');
    store.select([burner.id]);
  }); save.id = 'save';
  actions.append(undo, redo, open, save);
  report.textContent = JSON.stringify({ passed: results.length, results });
} catch (error) {
  report.textContent = JSON.stringify({ error: String(error), results });
  throw error;
}
