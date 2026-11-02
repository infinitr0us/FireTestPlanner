/** Left-hand panels: object palette, outliner, and the checks list. */

import {
  createBurner,
  createCamera,
  createCeiling,
  createHeatFluxSensor,
  createHood,
  createObstruction,
  createThermocouple, createVelocityProbe, createGasSampling, createLoadCell,
  createWall,
  defaultCameraPosition,
} from '../core/factory';
import { deviceFromRecord, obstructionFromRecord } from '../core/fds';
import { fdsFrame } from '../core/fdsview';
import { NamelistError, readOneRecord } from '../core/namelist';
import { checkPlan, displayName, hasObjectColor, MODALITY_COLORS, nextId, objectColor } from '../core/plan';
import { isMounted } from '../core/types';
import { collapseBodies, lensesOf, lensName, listedLabel } from '../core/lenses';
import { cameraPresets, isCustomPreset, presetsArePersistent, type CameraPreset } from '../core/presets';
import { setPosition } from '../core/transform';
import type { Issue, PlanObject, Vec3 } from '../core/types';
import { describeErrors, validateStructure } from '../core/validate';
import type { Store } from '../state/store';
import { clear, h } from './dom';

const TYPE_ICON: Record<string, string> = {
  camera: '◈',
  burner: '▲',
  hood: '⌂',
  wall: '▬',
  ceiling: '▭',
  heatFluxSensor: '◉',
  thermocouple: '⋮',
  velocityProbe: '▬', gasSampling: '○', loadCell: '▱',
  obstruction: '▢',
  reconstructedFlame: '✶',
};

/** A camera row's tooltip. A body is listed once, so its row says which lens it
 *  places and where the others are. */
function paletteTitle(preset: CameraPreset): string {
  const lenses = lensesOf(preset.id);
  if (lenses.length === 0) return preset.note ?? '';
  const mm = lenses.map((l) => lensName(l.focalLength_mm).replace(/ mm$/, ''));
  return `Placed with the ${lensName(preset.focalLength_mm)} lens. Choose `
    + `${mm.slice(0, -1).join(', ')} or ${mm[mm.length - 1]} mm under Lens in the inspector.`
    + (preset.note ? `\n\n${preset.note}` : '');
}

export class Palette {
  /** Set while a palette item is armed for click-to-place in the viewport. */
  pending: (() => PlanObject) | null = null;

  /** Draft FDS text and the last thing wrong with it. Kept on the instance so a
   *  repaint -- which every object added causes -- does not wipe what was typed. */
  private fdsDraft = '';
  private fdsError: string | null = null;
  /** Set by the app: link a folder of reconstructed frames as a new flame object. */
  linkFlame: (() => void) | null = null;

  constructor(
    private root: HTMLElement,
    private store: Store,
    private onArm: (armed: boolean) => void,
  ) {}

  render(): void {
    // Read which folds are open from the DOM being replaced, synchronously. A
    // `toggle` listener would be a race: the event is queued as a task, so a repaint
    // in the same turn as the click that opened a fold would not see it yet.
    for (const d of this.root.querySelectorAll<HTMLDetailsElement>('details[data-fold]')) {
      this.open[d.dataset.fold as string] = d.open;
    }
    clear(this.root);

    this.root.append(h('h3', { class: 'panel__section' }, ['Add']));

    this.root.append(h('div', { class: 'palette__grid' }, [
      this.tile('▲', 'Fuel pan', () => createBurner(this.store.document, [0, 0, 0])),
      this.tile('⌂', 'Hood', () => createHood(this.store.document)),
      this.tile('▬', 'Wall', () => createWall(this.store.document)),
      this.tile('▭', 'Ceiling', () => createCeiling(this.store.document)),
      this.tile('▢', 'Obstruction', () => createObstruction(this.store.document),
        'A box: furniture, equipment, blockwork. What stands between an instrument and the fire.'),
      h('button', {
        class: 'palette__tile', type: 'button',
        title: 'A flame reconstructed from the test\'s cameras: pick the pipeline\'s voxels/ folder and play it back in the layout.',
        onclick: () => this.linkFlame?.(),
      }, [h('span', { class: 'palette__icon' }, ['✶']), h('span', {}, ['3D flame…'])]),
    ]));

    this.root.append(this.disclosure('instruments', 'Instruments', [h('div', { class: 'palette__grid' }, [
      this.tile('◉', 'Heat flux', () => createHeatFluxSensor(this.store.document),
        'Gauge, aimed at the fire on drop. Its inspector predicts what it will read.'),
      this.tile('⋮', 'Thermocouple', () => createThermocouple(this.store.document),
        'One bead on drop; add more in the inspector to make it a rake.'),
      this.tile('▬', 'Velocity probe', () => createVelocityProbe(this.store.document), 'Bi-directional tube. Align its axis with an opening in the inspector.'),
      this.tile('○', 'Gas sample', () => createGasSampling(this.store.document), 'Sampling point with recorded species.'),
      this.tile('▱', 'Load cell', () => createLoadCell(this.store.document), 'Mass measurement beneath the fuel.'),
    ])]));
    this.root.append(h('h3', { class: 'panel__section' }, ['Cameras']));
    this.root.append(
      h('div', { class: 'palette__list' }, collapseBodies(cameraPresets()).map((preset) =>
        h('button', {
          class: 'palette__row',
          type: 'button',
          title: paletteTitle(preset),
          onclick: () => this.arm(() =>
            createCamera(this.store.document, preset, defaultCameraPosition(this.store.document))),
        }, [
          h('span', { class: 'palette__swatch', style: { background: MODALITY_COLORS[preset.modality] ?? MODALITY_COLORS.other } }),
          h('span', { class: 'palette__row-label' }, [listedLabel(preset)]),
          isCustomPreset(preset.id)
            ? h('span', { class: 'palette__badge', title: 'Your own preset. Delete it from a camera that uses it.' }, ['mine'])
            : null,
          preset.intrinsicsSource === 'nominal'
            ? h('span', { class: 'palette__badge', title: 'Placeholder intrinsics — not reconstruction-grade' }, ['nom'])
            : null,
        ])),
      ),
    );

    // Where new presets come from. Stated here because the action lives in the
    // inspector, which is the only place the optics being saved are visible. Folded
    // behind one line: it is read once, and the rail's height belongs to Checks. The
    // failure case is not folded, because it is news about the user's own presets.
    const howTo = 'Place the nearest camera, correct its optics in the inspector, then '
      + 'Save as preset. It joins this list';
    if (presetsArePersistent()) {
      this.root.append(this.disclosure('presetHelp', 'Camera not listed?', [
        h('p', { class: 'panel__hint' }, [`${howTo} and survives a restart.`]),
      ], false, 'hint'));
    } else {
      this.root.append(h('p', { class: 'panel__hint' }, [
        `A camera this list does not have: ${howTo.charAt(0).toLowerCase()}${howTo.slice(1)} `
        + 'for this session only. The last attempt to store the library did not land, so '
        + 'it will not survive a restart.',
      ]));
    }

    this.root.append(h('p', { class: 'panel__hint' }, [
      'Click an item, then click in the viewport to place it. Press Esc to cancel.',
    ]));

    this.renderFdsPaste();
  }

  /** Which folded sections are open, carried across repaints (a Create repaints
   *  the palette, and a repaint must not close what the user opened). Instruments
   *  starts open: gauges and thermocouples are core tools, not ones to go looking for. */
  private open: Record<string, boolean> = { instruments: true };

  /** A folded palette section: a native disclosure, so keyboard and screen-reader
   *  behaviour is the browser's own (docs/visual-language.md). */
  private disclosure(key: string, label: string, body: HTMLElement[], forceOpen = false,
    variant: 'section' | 'hint' = 'section'): HTMLElement {
    return h('details', {
      class: `palette__fold palette__fold--${variant}`,
      dataset: { fold: key },
      open: forceOpen || this.open[key] === true,
    }, [
      h('summary', { class: 'palette__fold-summary' }, [label]),
      ...body,
    ]);
  }

  /**
   * Create one object from a pasted FDS record.
   *
   * Straight into the plan rather than armed for placement: an `&OBST` already says
   * where it goes, and asking someone to click a position for a line that carries
   * six coordinates would throw the coordinates away.
   *
   * It goes through the importer's own converter, so a wall pasted here and the same
   * wall imported from a file are classified by one rule rather than two.
   */
  private renderFdsPaste(): void {
    const input = h('textarea', {
      class: 'fdspaste__input',
      spellcheck: false,
      placeholder: "&OBST XB=0,2.4,0,0.1,0,2.5, SURF_ID='WALL' /",
      value: this.fdsDraft,
      oninput: (e: Event) => { this.fdsDraft = (e.target as HTMLTextAreaElement).value; },
    });

    // Folded by default: most plans never paste a record, and the rail's height is
    // what decides whether Checks is on screen. It stays open while it holds a draft
    // or an error, so a repaint never hides what the user is in the middle of.
    this.root.append(this.disclosure('fds', 'From FDS', [
      h('div', { class: 'fdspaste' }, [
        input,
        this.fdsError ? h('p', { class: 'fdspaste__error' }, [this.fdsError]) : null,
        h('div', { class: 'panel__actions' }, [
          h('button', {
            class: 'btn', type: 'button', onclick: () => this.createFromFds(),
          }, ['Create']),
        ]),
        h('p', { class: 'panel__hint' }, [
          'One record at a time. &OBST becomes a wall, ceiling or box by its shape; '
          + '&DEVC becomes an instrument by its quantity and species. A &VENT is a '
          + 'surface on a solid, not a solid: paste the &OBST it sits on.',
        ]),
      ].filter(Boolean) as HTMLElement[]),
    ], this.fdsDraft !== '' || this.fdsError !== null));
  }

  private createFromFds(): void {
    const doc = this.store.document;
    // The same frame the inspector's FDS view uses: a line copied out of the model
    // this plan came from lands where that model puts it, not offset by the origin
    // shift the import applied.
    const { offset } = fdsFrame(doc);

    let obj: PlanObject | null = null;
    try {
      const record = readOneRecord(this.fdsDraft);
      obj = obstructionFromRecord(record, offset)
        ?? deviceFromRecord(record, new Map(), offset);
      if (!obj) {
        this.fdsError = record.group === 'VENT'
          ? 'A &VENT is a boundary condition on the face of a solid, not a solid: it '
            + 'has no thickness, and this format has no planar object. Paste the &OBST '
            + 'it sits on instead.'
          : `&${record.group} has no counterpart in a test plan. `
            + 'Geometry comes from &OBST with an XB; instruments from &DEVC '
            + 'with an XYZ and a heat flux or temperature quantity.';
      }
    } catch (err) {
      this.fdsError = err instanceof NamelistError
        ? err.message
        : `Could not read that: ${(err as Error).message}`;
    }

    if (obj) {
      // The converter mints ids from its own counter, which knows nothing about the
      // plan already open; `nextId` is what keeps them unique in this document.
      obj.id = nextId(doc, obj.id.replace(/-\d+$/, ''));
      // The same boundary a file crosses on the way in. An object the load boundary
      // would refuse must not be added: it would save, and the plan would then
      // refuse to reopen, a long way from the paste that caused it.
      const errors = validateStructure({ ...doc, objects: [...doc.objects, obj] });
      if (errors.length > 0) {
        this.fdsError = 'That record converts into something this format cannot hold:\n'
          + describeErrors(errors);
        obj = null;
      }
    }

    if (obj) {
      this.store.addObject(obj);
      this.fdsDraft = '';
      this.fdsError = null;
    }
    this.render();
  }

  private tile(icon: string, label: string, make: () => PlanObject, title?: string): HTMLElement {
    return h('button', {
      class: 'palette__tile',
      type: 'button',
      title: title ?? '',
      onclick: () => this.arm(make),
    }, [h('span', { class: 'palette__icon' }, [icon]), h('span', {}, [label])]);
  }

  private arm(make: () => PlanObject): void {
    this.pending = make;
    this.onArm(true);
  }

  cancel(): void {
    this.pending = null;
    this.onArm(false);
  }

  /** Place the armed object at a world point picked in the viewport. */
  place(at: Vec3): void {
    if (!this.pending) return;
    const obj = this.pending();
    const t = obj.transform ?? (obj.transform = { position_m: [0, 0, 0] });
    // Instruments on stands keep the height they were created with; things that
    // sit on the floor drop to the pick point. setPosition re-derives the
    // orientation for the actual drop point, so a camera or a gauge lands aimed at
    // the fire rather than at wherever the factory's default position faced.
    setPosition(obj, [at[0], at[1], (isMounted(obj) || obj.type === 'velocityProbe' || obj.type === 'gasSampling') ? t.position_m[2] : at[2]]);
    this.store.addObject(obj);
    this.cancel();
  }
}

export class Outliner {
  constructor(
    private root: HTMLElement,
    private store: Store,
  ) {}

  render(): void {
    clear(this.root);
    const objects = this.store.document.objects;

    this.root.append(h('h3', { class: 'panel__section' }, [`Objects (${objects.length})`]));
    if (objects.length === 0) {
      this.root.append(h('p', { class: 'panel__hint' }, ['Empty plan.']));
      return;
    }

    this.root.append(h('ul', { class: 'outliner' }, objects.map((obj) => {
      const selected = this.store.selectedIds.includes(obj.id);
      return h('li', {}, [
        h('button', {
          class: `outliner__row${selected ? ' outliner__row--selected' : ''}`,
          type: 'button',
          onclick: (e: MouseEvent) => {
            if (e.shiftKey || e.ctrlKey || e.metaKey) this.store.toggleSelect(obj.id);
            else this.store.select([obj.id]);
          },
        }, [
          h('span', {
            class: 'outliner__icon',
            style: { color: hasObjectColor(obj) ? objectColor(obj) : undefined },
          }, [TYPE_ICON[obj.type] ?? '◇']),
          h('span', { class: 'outliner__name' }, [displayName(obj)]),
          obj.display?.visible === false ? h('span', { class: 'outliner__flag' }, ['hidden']) : null,
          obj.display?.locked ? h('span', { class: 'outliner__flag' }, ['locked']) : null,
        ]),
      ]);
    })));
  }
}

export class ChecksPanel {
  /** Set by the app: a finding about a test data source opens that source. */
  openTestData: ((sourceId: string) => void) | null = null;

  constructor(
    private root: HTMLElement,
    private store: Store,
  ) {}

  render(): void {
    clear(this.root);
    const issues = checkPlan(this.store.document);
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');

    this.root.append(h('h3', { class: 'panel__section' }, [
      'Checks',
      h('span', { class: 'panel__count' }, [
        errors.length > 0 ? `${errors.length} error${errors.length > 1 ? 's' : ''}` :
        warnings.length > 0 ? `${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : 'all clear',
      ]),
    ]));

    if (issues.length === 0) {
      this.root.append(h('p', { class: 'panel__hint' }, ['No issues found.']));
      return;
    }

    const order: Record<Issue['severity'], number> = { error: 0, warning: 1, info: 2 };
    const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);

    this.root.append(h('ul', { class: 'checks' }, sorted.map((issue) =>
      h('li', { class: `checks__item checks__item--${issue.severity}` }, [
        h('button', {
          class: 'checks__body',
          type: 'button',
          disabled: !issue.objectId && !(issue.sourceId && this.openTestData),
          title: issue.sourceId && this.openTestData ? 'Open this source in Test data' : '',
          onclick: () => {
            if (issue.sourceId && this.openTestData) this.openTestData(issue.sourceId);
            else if (issue.objectId) this.store.select([issue.objectId]);
          },
        }, [
          h('span', { class: 'checks__code' }, [issue.code]),
          h('span', { class: 'checks__message' }, [issue.message]),
        ]),
      ]))));
  }
}
