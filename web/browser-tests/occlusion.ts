/** Inspector/report regressions for the coordinator's browser run. */
import shared from '../../fixtures/occlusion/check-cases.json';
import { lookAtQuat } from '../src/core/math';
import { newPlan } from '../src/core/plan';
import type { CameraObject, HeatFluxSensorObject, PlanObject, Vec3 } from '../src/core/types';
import { buildReportBody } from '../src/export/report';
import { Store } from '../src/state/store';
import { Inspector } from '../src/ui/inspector';

export async function checkOcclusionInspector(
  check: (name: string, ok: boolean) => void,
  waitFor: (predicate: () => boolean) => Promise<void>,
): Promise<void> {
  const root = document.createElement('div');
  root.style.width = '320px';
  document.body.append(root);
  const doc = newPlan('Line of sight browser fixture');
  const at: Vec3 = [-4, 0, 1];
  const gauge: HeatFluxSensorObject = { id: 'gauge', type: 'heatFluxSensor', name: 'Test gauge',
    transform: { position_m: at, rotation_quat: lookAtQuat(at, [0, 0, 1]) }, gauge: { range_kw_m2: 50 } };
  const camera: CameraObject = { id: 'camera', type: 'camera', name: 'Test camera',
    transform: structuredClone(gauge.transform),
    camera: { modality: 'RGB', resolution_px: [1000, 1000], sensor_mm: [36, 24], focalLength_mm: 10 } };
  const store = new Store(doc);
  const inspector = new Inspector(root, store);
  const unsubscribe = store.subscribe(() => inspector.render());
  const row = (label: string): HTMLElement | undefined =>
    [...root.querySelectorAll<HTMLElement>('.readout')].find(r => r.querySelector('.readout__label')?.textContent === label);
  const value = (label: string): string | null | undefined => row(label)?.querySelector('.readout__value')?.textContent;
  try {
    for (const [name, percentage, gaugeTone, cameraTone] of [
      ['doorway', '100%', 'good', 'good'],
      ['solid wall', '0%', 'bad', 'bad'],
      ['lower four samples hidden', '56%', 'warn', 'bad'],
    ]) {
      const c = shared.cases.find(c => c.name === name)!;
      store.replaceDocument({ ...doc, objects: structuredClone([shared.burner, gauge, camera, ...c.objects]) as PlanObject[] }, 'los.ftp.json');
      store.select(['gauge']);
      await waitFor(() => value('Line of sight') === percentage);
      check(`${name}: gauge line of sight uses the shared ${gaugeTone} row`, row('Line of sight')!.classList.contains(`readout--${gaugeTone}`));
      check(`${name}: report shows visibility`, buildReportBody(store.document, 'm').includes(`${percentage} line of sight`));
      store.select(['camera']);
      await waitFor(() => value('Flame unobstructed') === percentage);
      check(`${name}: camera row uses the shared ${cameraTone} status`, row('Flame unobstructed')!.classList.contains(`readout--${cameraTone}`));
      for (const width of [320, 260]) {
        root.style.width = `${width}px`;
        const bounds = row('Flame unobstructed')!.getBoundingClientRect();
        const text = row('Flame unobstructed')!.querySelector('.readout__value')!.getBoundingClientRect();
        check(`${name}: ${width}px camera readout fits`, text.right <= bounds.right + 1 && text.left >= bounds.left);
      }
    }
    store.edit('look away', d => {
      const c = d.objects.find(o => o.id === 'camera') as CameraObject;
      c.transform!.rotation_quat = lookAtQuat(at, [-8, 0, 1]);
    });
    store.commit();
    await waitFor(() => value('Flame unobstructed') === 'no centreline in frame');
    check('no in-frame centreline uses neutral status', row('Flame unobstructed')!.classList.contains('readout--muted'));
    store.undo();
    await waitFor(() => value('Flame unobstructed') === '56%');
    check('undo restores camera visibility', true);
  } finally {
    unsubscribe();
    root.remove();
  }
}
