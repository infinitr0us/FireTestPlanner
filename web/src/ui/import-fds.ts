/**
 * The import preview: what an FDS input would become, before it becomes it.
 *
 * An FDS model is bigger than a fire test plan and most of it has no counterpart
 * here. Importing silently would hand someone a plan and no way to know whether the
 * half they cared about survived -- so this shows what was made, what was skipped,
 * and every judgement the mapping had to make, with the two that are genuinely
 * ambiguous offered as choices: which heat-release surface is the burner, and
 * whether a vertical run of devices is one rake or twenty-two instruments.
 *
 * Re-running the conversion on every option change rather than patching the result
 * is deliberate: the preview and the plan that gets adopted come from the same call,
 * so they cannot disagree.
 */

import { fdsToPlan, type FdsImportOptions, type FdsImportResult } from '../core/fds';
import type { Issue, LengthUnit, PlanDocument } from '../core/types';
import { formatLengthWithUnit } from '../core/units';
import { clear, h } from './dom';
import { button } from './fields';

const TYPE_LABEL: Record<string, string> = {
  wall: 'walls',
  ceiling: 'ceilings',
  obstruction: 'obstructions',
  burner: 'burners',
  heatFluxSensor: 'heat flux gauges',
  thermocouple: 'thermocouples',
  camera: 'cameras',
  hood: 'hoods',
};

const plural = (type: string, n: number): string => {
  const label = TYPE_LABEL[type] ?? `${type}s`;
  return n === 1 && label.endsWith('s') ? label.slice(0, -1) : label;
};

export class FdsImportDialog {
  private root: HTMLElement | null = null;
  private text = '';
  private fileName = 'model.fds';
  private options: FdsImportOptions = {};
  private result: FdsImportResult | null = null;
  private onAdopt: ((doc: PlanDocument, name: string) => void) | null = null;
  private unit: LengthUnit = 'm';

  get isOpen(): boolean {
    return this.root !== null;
  }

  /**
   * Convert, and show what it would produce.
   *
   * Throws only when the text is not FDS input at all -- everything else is a
   * finding in the report rather than a refusal, because a model this tool can only
   * half-represent is still worth half-importing.
   */
  open(
    text: string,
    fileName: string,
    unit: LengthUnit,
    onAdopt: (doc: PlanDocument, name: string) => void,
  ): void {
    this.close();
    this.text = text;
    this.fileName = fileName;
    this.unit = unit;
    this.onAdopt = onAdopt;
    this.options = {};
    this.result = fdsToPlan(text, fileName, this.options);

    this.root = h('div', { class: 'modal' }, [h('div', { class: 'modal__panel' })]);
    document.body.appendChild(this.root);
    this.render();
  }

  close(): void {
    this.root?.remove();
    this.root = null;
    this.result = null;
    this.onAdopt = null;
  }

  private reconvert(patch: Partial<FdsImportOptions>): void {
    this.options = { ...this.options, ...patch };
    this.result = fdsToPlan(this.text, this.fileName, this.options);
    this.render();
  }

  private render(): void {
    const panel = this.root?.querySelector<HTMLElement>('.modal__panel');
    const result = this.result;
    if (!panel || !result) return;
    clear(panel);

    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);

    panel.append(
      h('h2', { class: 'modal__title' }, [`Import ${this.fileName}`]),
      h('p', { class: 'import__intro' }, [
        total === 0
          ? 'Nothing in this file maps onto a test plan.'
          : `${total} objects, re-origined onto the burner centre at floor level. `
            + `The plan origin sits at (${result.originM
              .map((v) => formatLengthWithUnit(v, this.unit)).join(', ')}) `
            + 'in this file’s coordinates.',
      ]),
    );

    const body = h('div', { class: 'import' }, [
      this.counts(),
      this.burnerChoice(),
      this.deviceTable(),
      this.issueList(result.issues),
    ].filter(Boolean) as HTMLElement[]);

    panel.append(body, h('div', { class: 'import__actions' }, [
      button('Cancel', () => this.close()),
      button('Import', () => this.adopt(), 'btn--primary'),
    ]));
  }

  private counts(): HTMLElement {
    const counts = this.result!.counts;
    return h('div', { class: 'import__counts' },
      Object.keys(counts).sort().map((type) =>
        h('span', { class: 'import__chip' }, [
          h('b', {}, [String(counts[type])]), ` ${plural(type, counts[type])}`,
        ])));
  }

  /**
   * Which heat-release surface is the burner.
   *
   * Only shown when the file has more than one, which is the case worth asking
   * about: a model with an ignition source and a burning lining has two, and the
   * plan's whole coordinate frame hangs off which one is chosen.
   */
  private burnerChoice(): HTMLElement | null {
    const result = this.result!;
    if (result.burnerCandidates.length < 2) return null;

    return h('div', { class: 'field' }, [
      h('span', { class: 'field__label' }, ['Burner surface']),
      h('select', {
        class: 'field__input',
        onchange: (e: Event) =>
          this.reconvert({ burnerSurf: (e.target as HTMLSelectElement).value }),
      }, result.burnerCandidates.map((surf) =>
        h('option', { value: surf, selected: surf === result.burnerSurf }, [
          `${surf}${surf === result.burnerSurf ? ' — most compact horizontal' : ''}`,
        ]))),
    ]);
  }

  private deviceTable(): HTMLElement | null {
    const devices = this.result!.devices;
    if (devices.length === 0) return null;

    const rows = devices.map((g) => h('tr', {}, [
      h('td', {}, [g.quantity ?? '(no quantity)']),
      h('td', { class: 'import__num' }, [String(g.count)]),
      g.mappedTo
        ? h('td', {}, [`${g.objects} ${plural(g.mappedTo, g.objects)}`])
        : h('td', { class: 'import__skip' }, [g.note || 'not imported']),
    ]));

    const grouped = devices.some((g) => g.mappedTo === 'thermocouple' && g.objects < g.count);

    return h('div', {}, [
      h('div', { class: 'import__scroll' }, [
        h('table', { class: 'import__table' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', {}, ['&DEVC quantity']),
            h('th', { class: 'import__num' }, ['Found']),
            h('th', {}, ['Becomes']),
          ])]),
          h('tbody', {}, rows),
        ]),
      ]),
      h('label', { class: 'field' }, [
        h('span', { class: 'field__label' }, ['Group rakes']),
        h('input', {
          class: 'field__checkbox',
          type: 'checkbox',
          checked: this.options.groupRakes !== false,
          onchange: (e: Event) =>
            this.reconvert({ groupRakes: (e.target as HTMLInputElement).checked }),
        }),
      ]),
      h('p', { class: 'import__intro' }, [
        grouped || this.options.groupRakes === false
          ? 'A vertical run of same-quantity devices at one XY is one rake with several '
            + 'beads, not several instruments. Turn this off to keep one object per &DEVC.'
          : 'No vertical runs to group in this file.',
      ]),
    ]);
  }

  private issueList(issues: Issue[]): HTMLElement | null {
    if (issues.length === 0) return null;
    const order: Record<Issue['severity'], number> = { error: 0, warning: 1, info: 2 };
    const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);

    return h('div', { class: 'import__scroll' }, [
      h('ul', { class: 'import__issues' }, sorted.map((i) =>
        h('li', { class: `import__issue import__issue--${i.severity}` }, [
          h('code', {}, [i.code]),
          h('span', {}, [i.message]),
        ]))),
    ]);
  }

  private adopt(): void {
    const result = this.result;
    const onAdopt = this.onAdopt;
    if (!result || !onAdopt) return;
    // The plan name follows the FDS job, not the .fds filename: CHID is what the
    // engineer calls the case, and it is already the plan's title.
    const stem = (result.doc.meta?.testId ?? this.fileName.replace(/\.fds$/i, '')) || 'plan';
    this.close();
    onAdopt(result.doc, `${stem}.ftp.json`);
  }
}
