/** Reusable inspector/lens/report checks for the lead's browser run. */
import fixture from '../../fixtures/thermocouple-view.ftp.json';
import { lensesOf } from '../src/core/lenses';
import { cameras, parsePlan } from '../src/core/plan';
import type { CameraObject } from '../src/core/types';
import { buildReportBody } from '../src/export/report';
import { Store } from '../src/state/store';
import * as i18n from '../src/ui/i18n';
import { Inspector } from '../src/ui/inspector';

export async function checkThermocoupleView(
  check: (name: string, ok: boolean) => void,
  waitFor: (predicate: () => boolean) => Promise<void>,
): Promise<void> {
  const previousLanguage = i18n.language();
  const root = document.createElement('div');
  root.className = 'panel--right';
  root.style.width = '320px';
  document.body.append(root);
  const doc = parsePlan(JSON.stringify(fixture));
  cameras(doc)[0].camera.presetId = 'flir-a8303sc-50mm';
  doc.units.display!.length = 'mm';
  const store = new Store(doc);
  const inspector = new Inspector(root, store);
  const offStore = store.subscribe(() => inspector.render());
  const offLanguage = i18n.subscribeLanguage(() => inspector.render());
  const row = (label: string) => [...root.querySelectorAll<HTMLElement>('.readout')]
    .find(r => r.querySelector('.readout__label')?.textContent === label);
  const value = (label: string) => row(label)?.querySelector('.readout__value')?.textContent;
  const currentTc = () => root.querySelector<HTMLElement>('.lens-table__row--current td:last-child');
  // A field by its visible label, as run.mjs finds them: the inspector labels a
  // control by wrapping it, not with an aria-label attribute.
  const control = <T extends HTMLElement>(label: string): T => [...root.querySelectorAll<HTMLElement>('label.field')]
    .find(l => l.querySelector('.field__label')?.textContent === label)!.querySelector<T>('select,input')!;
  try {
    store.select(['camera']);
    for (const language of ['en', 'fr'] as const) {
      i18n.setLanguage(language);
      await waitFor(() => value(i18n.t('Thermocouple beads seen')) === (language === 'en' ? '3 of 5' : '3 sur 5'));
      check(`${language}: closest pair names and decimal separator`, value(i18n.t('Closest pair'))
        === (language === 'en' ? '5.0 px (TC-01 / TC-02)' : '5,0\u202fpx (TC-01 / TC-02)'));
      check(`${language}: mean 3 by 3 spot uses display units`, value(i18n.t('3 × 3 px spot at the beads'))
        === (language === 'en' ? '12 mm' : '12\u202fmm'));
      check(`${language}: exclusions name the pack`, [...root.querySelectorAll('.readout__note')]
        .some(n => n.textContent?.includes(language === 'en'
          ? 'Outside frame: 1; hidden: 1 (behind Synthetic pack).'
          : 'Hors cadre : 1; masquées : 1 (derrière Synthetic pack).')));
      check(`${language}: closest pair and TC cell warn without hiding the numbers`,
        row(i18n.t('Closest pair'))!.classList.contains('readout--warn')
        && currentTc()!.classList.contains('lens-table__warn')
        && currentTc()!.textContent === (language === 'en' ? '3/5 · 5.0 px' : '3/5 · 5,0\u202fpx'));
      const table = root.querySelector<HTMLTableElement>('.lens-table')!;
      const header = table.querySelector('thead th:last-child')!;
      check(`${language}: TC header explains the counts and separation`, header.textContent === 'TC'
        && header.getAttribute('title') === i18n.t('Thermocouple beads seen/total and closest pair separation in pixels'));
      check(`${language}: table has every body lens`, table.tBodies[0].rows.length === lensesOf(cameras(doc)[0].camera.presetId).length);
      // The inspector column is fixed at 320 px (styles.css, the editor grid); a
      // narrower case would test a layout the editor never has.
      for (const width of [320]) {
        root.style.width = `${width}px`;
        const bounds = root.getBoundingClientRect();
        check(`${language}: ${width}px TC table fits`, table.getBoundingClientRect().right <= bounds.right + 1);
        for (const label of [i18n.t('Thermocouple beads seen'), i18n.t('Closest pair'), i18n.t('3 × 3 px spot at the beads')]) {
          const text = row(label)!.querySelector('.readout__value')!.getBoundingClientRect();
          check(`${language}: ${width}px ${label} fits`, text.left >= bounds.left && text.right <= bounds.right + 1);
        }
      }
      const printed = document.createElement('div');
      printed.innerHTML = buildReportBody(store.document, 'mm');
      const tcHeader = [...printed.querySelectorAll('th')].find(th => th.textContent === i18n.t('TC beads'))!;
      check(`${language}: report agrees with the inspector`, tcHeader.closest('table')!.querySelector('tbody td:last-child')!.textContent
        === currentTc()!.textContent);
    }

    i18n.setLanguage('en');
    // The inspector repaints on the language change after this tick; until it does,
    // its labels are still French.
    await waitFor(() => value('Thermocouple beads seen') === '3 of 5');
    // Commit through the real field handler, then exercise the store's undo path.
    for (const [focal, px, tone] of [[20, '2.0', 'bad'], [100, '10.0', 'good']] as const) {
      const field = control<HTMLInputElement>('Focal length (mm)');
      field.focus();
      field.value = String(focal);
      field.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => value('Closest pair') === `${px} px (TC-01 / TC-02)`);
      check(`focal edit updates the ${tone} TC status`, currentTc()!.classList.contains(`lens-table__${tone}`));
      store.undo();
      await waitFor(() => value('Closest pair') === '5.0 px (TC-01 / TC-02)');
    }
    const lensSelect = control<HTMLSelectElement>('Lens');
    const shortest = lensesOf(cameras(store.document)[0].camera.presetId)[0];
    lensSelect.value = shortest.id;
    lensSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => value('Closest pair') === `${(shortest.focalLength_mm / 10).toFixed(1)} px (TC-01 / TC-02)`);
    check('lens control changes bead separation', true);
    store.undo();
    await waitFor(() => value('Closest pair') === '5.0 px (TC-01 / TC-02)');
    store.setDisplayUnit('in');
    await waitFor(() => value('3 × 3 px spot at the beads') === '0.47 in');
    check('spot readout follows display unit changes', true);
    store.edit('Keep one bead without fire', d => { d.objects = d.objects.filter(o => o.type === 'camera' || o.id === 'tc-01'); });
    store.commit();
    await waitFor(() => value('Thermocouple beads seen') === '1 of 1');
    check('one seen bead keeps counts and mutes the absent pair', value('Closest pair') === '—'
      && row('Closest pair')!.classList.contains('readout--muted') && currentTc()!.textContent === '1/1');
    store.edit('Look away', d => { (d.objects[0] as CameraObject).transform!.rotation_quat = [0, 0, 0, 1]; });
    store.commit();
    await waitFor(() => value('Thermocouple beads seen') === '0 of 1');
    check('zero seen beads have muted counts, pair and spot size',
      ['Thermocouple beads seen', 'Closest pair', '3 × 3 px spot at the beads'].every(label => row(label)!.classList.contains('readout--muted'))
      && value('3 × 3 px spot at the beads') === '—' && currentTc()!.textContent === '0/1');
    store.edit('Remove thermocouples', d => { d.objects = d.objects.filter(o => o.type === 'camera'); });
    store.commit();
    await waitFor(() => !row('Thermocouple beads seen'));
    check('no thermocouples removes the TC column', !root.querySelector('.lens-table--tc'));
  } finally {
    offStore();
    offLanguage();
    root.remove();
    i18n.setLanguage(previousLanguage);
  }
}
