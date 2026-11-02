import { createVelocityProbe, createGasSampling } from '../src/core/factory';
import { newPlan, positionOf, quatOf } from '../src/core/plan';
import { forwardOf } from '../src/core/math';
import { Store } from '../src/state/store';
import { Inspector } from '../src/ui/inspector';
import { button } from '../src/ui/fields';

const doc = newPlan(), probe = createVelocityProbe(doc, [1, 0.2, 1]), gas = createGasSampling(doc);
doc.objects = [probe, gas, { id: 'wall', type: 'wall', polyline_m: [[0, 0], [3, 0]], height_m: 3,
  openings: [{ offset_m: 0.5, width_m: 1, height_m: 2 }] }];
doc.testData = [{ id: 'data', name: 'Gas logger', role: 'measured',
  file: { id: 'csv', path: 'gas.csv', kind: 'spreadsheet' },
  table: { sheet: null, shape: 'plain', headerRow: 1, unitsRow: 2, dataRow: 3, timeColumn: 0 },
  channels: [{ channel: 'oxygen', object: gas.id }],
  manifest: { size: 40, modified: null, rows: 4, channels: [{ name: 'oxygen', unit: '%', samples: 2, t0: 0, t1: 1 }] } }];
const store = new Store(doc), inspector = new Inspector(document.querySelector('#inspector')!, store);
const update = () => {
  inspector.render();
  const obj = store.document.objects.find(o => o.id === probe.id)!;
  document.querySelector('#state')!.textContent = JSON.stringify({ axis: forwardOf(quatOf(obj)), at: positionOf(obj) });
};
store.subscribe(update); store.select([probe.id]); update();
document.querySelector('#actions')!.append(button('Undo', () => store.undo()),
  button('Select gas', () => store.select([gas.id])));
