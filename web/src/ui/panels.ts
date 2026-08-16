/** Left-hand panels: object palette, outliner, and the checks list. */

import {
  createBurner,
  createCamera,
  createHood,
  createWall,
  defaultCameraPosition,
} from '../core/factory';
import { checkPlan, displayName, cameraColor, isCamera } from '../core/plan';
import { CAMERA_PRESETS } from '../core/presets';
import type { Issue, PlanObject, Vec3 } from '../core/types';
import type { Store } from '../state/store';
import { clear, h } from './dom';

const TYPE_ICON: Record<string, string> = {
  camera: '◈',
  burner: '▲',
  hood: '⌂',
  wall: '▬',
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

    const geometry = h('div', { class: 'palette__grid' }, [
      this.tile('▲', 'Fuel pan', () => createBurner(this.store.document, [0, 0, 0])),
      this.tile('⌂', 'Hood', () => createHood(this.store.document)),
      this.tile('▬', 'Wall', () => createWall(this.store.document)),
    ]);
    this.root.append(geometry);

    this.root.append(h('h3', { class: 'panel__section' }, ['Cameras']));
    this.root.append(
      h('div', { class: 'palette__list' }, CAMERA_PRESETS.map((preset) =>
        h('button', {
          class: 'palette__row',
          type: 'button',
          title: preset.note ?? '',
          onclick: () => this.arm(() =>
            createCamera(this.store.document, preset, defaultCameraPosition(this.store.document))),
        }, [
          h('span', { class: 'palette__swatch', style: { background: modalityColor(preset.modality) } }),
          h('span', { class: 'palette__row-label' }, [preset.label]),
          preset.intrinsicsSource === 'nominal'
            ? h('span', { class: 'palette__badge', title: 'Placeholder intrinsics — not reconstruction-grade' }, ['nom'])
            : null,
        ])),
      ),
    );

    this.root.append(h('p', { class: 'panel__hint' }, [
      'Click an item, then click in the viewport to place it. Press Esc to cancel.',
    ]));
  }

  private tile(icon: string, label: string, make: () => PlanObject): HTMLElement {
    return h('button', {
      class: 'palette__tile',
      type: 'button',
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
    // Cameras keep the tripod height they were created with; ground objects drop
    // to the floor.
    t.position_m = [at[0], at[1], isCamera(obj) ? t.position_m[2] : at[2]];
    if (isCamera(obj) && t.aimTarget_m) {
      // Re-derive the orientation for the actual drop point.
      obj.transform = { ...t };
    }
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
            style: { color: isCamera(obj) ? cameraColor(obj) : undefined },
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
