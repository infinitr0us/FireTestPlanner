/** Left-hand panels: object palette, outliner, and the checks list. */

import {
  createBurner,
  createCamera,
  createCeiling,
  createHeatFluxSensor,
  createHood,
  createThermocouple,
  createWall,
  defaultCameraPosition,
} from '../core/factory';
import { checkPlan, displayName, hasObjectColor, objectColor } from '../core/plan';
import { isMounted } from '../core/types';
import { cameraPresets, isCustomPreset, presetsArePersistent } from '../core/presets';
import { setPosition } from '../core/transform';
import type { Issue, PlanObject, Vec3 } from '../core/types';
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
};

export class Palette {
  /** Set while a palette item is armed for click-to-place in the viewport. */
  pending: (() => PlanObject) | null = null;

  constructor(
    private root: HTMLElement,
    private store: Store,
    private onArm: (armed: boolean) => void,
  ) {}

  render(): void {
    clear(this.root);

    this.root.append(h('h3', { class: 'panel__section' }, ['Add']));

    this.root.append(h('div', { class: 'palette__grid' }, [
      this.tile('▲', 'Fuel pan', () => createBurner(this.store.document, [0, 0, 0])),
      this.tile('⌂', 'Hood', () => createHood(this.store.document)),
      this.tile('▬', 'Wall', () => createWall(this.store.document)),
      this.tile('▭', 'Ceiling', () => createCeiling(this.store.document)),
      this.tile('◉', 'Heat flux', () => createHeatFluxSensor(this.store.document),
        'Gauge, aimed at the fire on drop. Its inspector predicts what it will read.'),
      this.tile('⋮', 'Thermocouple', () => createThermocouple(this.store.document),
        'One bead on drop; add more in the inspector to make it a rake.'),
    ]));

    this.root.append(h('h3', { class: 'panel__section' }, ['Cameras']));
    this.root.append(
      h('div', { class: 'palette__list' }, cameraPresets().map((preset) =>
        h('button', {
          class: 'palette__row',
          type: 'button',
          title: preset.note ?? '',
          onclick: () => this.arm(() =>
            createCamera(this.store.document, preset, defaultCameraPosition(this.store.document))),
        }, [
          h('span', { class: 'palette__swatch', style: { background: modalityColor(preset.modality) } }),
          h('span', { class: 'palette__row-label' }, [preset.label]),
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
    // inspector, which is the only place the optics being saved are visible.
    this.root.append(h('p', { class: 'panel__hint' }, [
      'A camera this list does not have: place the nearest one, correct its optics in the '
      + 'inspector, then Save as preset. It joins this list',
      presetsArePersistent() ? ' and survives a restart.' : ' for this session only — this '
        + 'browser is not storing site data, so it will not survive a restart.',
    ]));

    this.root.append(h('p', { class: 'panel__hint' }, [
      'Click an item, then click in the viewport to place it. Press Esc to cancel.',
    ]));
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
    setPosition(obj, [at[0], at[1], isMounted(obj) ? t.position_m[2] : at[2]]);
    this.store.addObject(obj);
    this.cancel();
  }
}

const modalityColor = (m: string): string =>
  ({ RGB: '#3b82f6', LWIR: '#f97316', MWIR: '#a855f7', SWIR: '#14b8a6', NIR: '#eab308' })[m] ?? '#94a3b8';

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
          disabled: !issue.objectId,
          onclick: () => { if (issue.objectId) this.store.select([issue.objectId]); },
        }, [
          h('span', { class: 'checks__code' }, [issue.code]),
          h('span', { class: 'checks__message' }, [issue.message]),
        ]),
      ]))));
  }
}
