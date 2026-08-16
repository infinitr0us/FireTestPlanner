/**
 * Property inspector for the selected object.
 *
 * For cameras it also carries a derived readout -- field of view, standoff, ground
 * sample distance, and whether the flame actually fits in frame. Those are the
 * numbers a test plan exists to settle, and they are worth more than the raw
 * intrinsics they come from.
 */

import { defaultAimTarget } from '../core/factory';
import { setAimTarget, setPosition } from '../core/transform';
import {
  burnerDiameterM,
  burnerFlameHeightM,
  ceilingAreaM2,
  ceilingCoversXY,
  flameTipZM,
  framingOf,
  fxOf,
  fyOf,
  groundSampleDistanceM,
  hfovDegOf,
  hoodIntakeHeightM,
  hoodOpeningOffset,
  isBurner,
  isCamera,
  isCeiling,
  isHood,
  isWall,
  plumeRadiusAtZ,
  positionOf,
  primaryBurner,
  principalPointOf,
  standoffHorizontalM,
  standoffM,
  vfovDegOf,
} from '../core/plan';
import { CAMERA_PRESETS, focalLengthForHfov, specFromPreset } from '../core/presets';
import { formatLength, formatLengthWithUnit } from '../core/units';
import type {
  BurnerObject,
  CameraObject,
  CeilingObject,
  HoodObject,
  IntrinsicsSource,
  LengthUnit,
  Modality,
  PlanObject,
  Vec3,
  WallObject,
} from '../core/types';
import type { Store } from '../state/store';
import { clear, h } from './dom';
import {
  button,
  checkboxField,
  lengthField,
  numberField,
  readout,
  row,
  sectionTitle,
  selectField,
  textField,
  vecField,
} from './fields';

export class Inspector {
  constructor(
    private root: HTMLElement,
    private store: Store,
  ) {}

  /** Mutate the selected object as one undoable step. */
  private patch(id: string, label: string, fn: (obj: PlanObject) => void): void {
    this.store.edit(label, (doc) => {
      const obj = doc.objects.find((o) => o.id === id);
      if (obj) fn(obj);
    });
    this.store.commit();
  }

  /**
   * Re-render, keeping keyboard focus where it was.
   *
   * Every field edit rebuilds this panel, which would otherwise drop focus on each
   * committed value and make tabbing through X/Y/Z impossible. Restoring by index
   * is crude but the control order is stable within one selection.
   */
  render(): void {
    const controls = () => Array.from(this.root.querySelectorAll('input, select, textarea'));
    const focusedIndex = controls().indexOf(document.activeElement as Element);

    this.renderInner();

    if (focusedIndex >= 0) {
      const next = controls()[focusedIndex] as HTMLInputElement | undefined;
      next?.focus();
      if (next instanceof HTMLInputElement && next.type === 'text') next.select();
    }
  }

  private renderInner(): void {
    clear(this.root);
    const unit = this.store.displayUnit;
    const selected = this.store.selected;

    if (selected.length === 0) {
      this.root.append(
        h('p', { class: 'panel__empty' }, [
          'Nothing selected. Click an object, or add one from the palette.',
        ]),
      );
      this.renderPlanProperties();
      return;
    }

    if (selected.length > 1) {
      this.root.append(
        h('p', { class: 'panel__empty' }, [`${selected.length} objects selected.`]),
        button('Delete selection', () => this.store.removeSelected(), 'btn--danger'),
      );
      return;
    }

    const obj = selected[0];
    this.root.append(sectionTitle(obj.type));
    this.root.append(
      row('Name', textField(obj.name ?? '', (v) =>
        this.patch(obj.id, 'Rename', (o) => { o.name = v || null; }))),
      row('ID', h('code', { class: 'field__static' }, [obj.id]),
        'Stable across revisions so git diffs stay meaningful'),
    );

    this.renderTransform(obj, unit);

    if (isCamera(obj)) this.renderCamera(obj, unit);
    else if (isBurner(obj)) this.renderBurner(obj, unit);
    else if (isHood(obj)) this.renderHood(obj, unit);
    else if (isWall(obj)) this.renderWall(obj, unit);
    else if (isCeiling(obj)) this.renderCeiling(obj, unit);
    else this.renderUnknown(obj);

    this.root.append(sectionTitle('Display'));
    this.root.append(
      row('Visible', checkboxField(obj.display?.visible !== false, (v) =>
        this.patch(obj.id, 'Toggle visibility', (o) => {
          o.display = { ...(o.display ?? {}), visible: v };
        }))),
      row('Locked', checkboxField(obj.display?.locked === true, (v) =>
        this.patch(obj.id, 'Toggle lock', (o) => {
          o.display = { ...(o.display ?? {}), locked: v };
        })), 'Locked objects cannot be dragged with the gizmo'),
      row('Notes', textField(obj.notes ?? '', (v) =>
        this.patch(obj.id, 'Edit notes', (o) => { o.notes = v || null; }))),
    );

    this.root.append(
      h('div', { class: 'panel__actions' }, [
        button('Duplicate', () => this.store.duplicateSelected()),
        button('Delete', () => this.store.removeSelected(), 'btn--danger'),
      ]),
    );
  }

  // -- shared ------------------------------------------------------------

  private renderTransform(obj: PlanObject, unit: LengthUnit): void {
    const p = positionOf(obj);
    this.root.append(sectionTitle('Position'));
    this.root.append(
      row(
        `Position (${unit})`,
        vecField(p, unit, ['X', 'Y', 'Z'], (index, metres) =>
          this.patch(obj.id, 'Move', (o) => {
            const next = [...(o.transform?.position_m ?? [0, 0, 0])] as Vec3;
            next[index] = metres;
            // Shared with palette drop and both gizmo drags, so a camera ends up
            // aimed the same way however it was moved.
            setPosition(o, next);
          }),
        ),
        'Measured from the burner centre at floor level',
      ),
    );
  }

  private renderPlanProperties(): void {
    const doc = this.store.document;
    const unit = this.store.displayUnit;

    this.root.append(sectionTitle('Plan'));
    this.root.append(
      row('Title', textField(doc.meta?.title ?? '', (v) =>
        this.store.edit('Edit title', (d) => { d.meta = { ...(d.meta ?? {}), title: v }; }))),
      row('Test ID', textField(doc.meta?.testId ?? '', (v) =>
        this.store.edit('Edit test ID', (d) => { d.meta = { ...(d.meta ?? {}), testId: v || null }; }))),
      row('Author', textField(doc.meta?.author ?? '', (v) =>
        this.store.edit('Edit author', (d) => { d.meta = { ...(d.meta ?? {}), author: v || null }; }))),
      row('Site', textField(doc.meta?.siteName ?? '', (v) =>
        this.store.edit('Edit site', (d) => { d.meta = { ...(d.meta ?? {}), siteName: v || null }; }))),
      row('Revision', textField(doc.meta?.revision ?? '', (v) =>
        this.store.edit('Edit revision', (d) => { d.meta = { ...(d.meta ?? {}), revision: v || null }; })),
        'Plans are revised by saving a new file; this plus git history is the audit trail'),
      row('Notes', textField(doc.meta?.notes ?? '', (v) =>
        this.store.edit('Edit notes', (d) => { d.meta = { ...(d.meta ?? {}), notes: v || null }; }))),
    );

    const env = doc.environment ?? {};
    this.root.append(sectionTitle('Environment'));
    this.root.append(
      row(`Floor size (${unit})`,
        vecField(env.floorSize_m ?? [20, 20], unit, ['W', 'D'], (index, metres) =>
          this.store.edit('Resize floor', (d) => {
            const size = [...(d.environment?.floorSize_m ?? [20, 20])] as [number, number];
            size[index] = metres;
            d.environment = { ...(d.environment ?? {}), floorSize_m: size };
          }))),
      row('Ambient (°C)',
        numberField(env.ambientTemperature_C ?? 20, (v) =>
          this.store.edit('Set ambient', (d) => {
            d.environment = { ...(d.environment ?? {}), ambientTemperature_C: v };
          }), { step: 1 })),
    );
  }

  // -- camera ------------------------------------------------------------

  private renderCamera(cam: CameraObject, unit: LengthUnit): void {
    const spec = cam.camera;
    const target = cam.transform?.aimTarget_m ?? null;

    this.root.append(sectionTitle('Aim'));
    this.root.append(
      row(`Aim target (${unit})`,
        vecField(target ?? [0, 0, 0], unit, ['X', 'Y', 'Z'], (index, metres) =>
          this.patch(cam.id, 'Re-aim', (o) => {
            const next = [...(o.transform?.aimTarget_m ?? [0, 0, 0])] as Vec3;
            next[index] = metres;
            setAimTarget(o as CameraObject, next);
          })),
        target
          ? 'Advisory; the stored quaternion is authoritative'
          : 'No target set — this camera was rotated by hand'),
      h('div', { class: 'panel__actions' }, [
        button('Aim at fire', () =>
          this.patch(cam.id, 'Aim at fire', (o) => {
            setAimTarget(o as CameraObject, defaultAimTarget(this.store.document));
          })),
      ]),
    );

    this.root.append(sectionTitle('Optics'));
    this.root.append(
      row('Preset',
        selectField(spec.presetId ?? '', [
          { value: '', label: '— custom —' },
          ...CAMERA_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        ], (id) => {
          const preset = CAMERA_PRESETS.find((p) => p.id === id);
          if (!preset) return;
          this.patch(cam.id, 'Apply preset', (o) => {
            (o as CameraObject).camera = specFromPreset(preset);
          });
        }),
        'Intrinsics are copied inline, so the plan stays self-contained'),
      row('Modality',
        selectField(spec.modality,
          (['RGB', 'LWIR', 'MWIR', 'SWIR', 'NIR', 'other'] as Modality[]).map((m) => ({ value: m, label: m })),
          (m) => this.patch(cam.id, 'Set modality', (o) => { (o as CameraObject).camera.modality = m; })),
        'Drives frustum colour and grouping in the equipment table'),
      row('Resolution (px)',
        h('div', { class: 'field__vec' }, [0, 1].map((i) =>
          h('span', { class: 'field__vec-cell' }, [
            h('span', { class: 'field__vec-axis' }, [i === 0 ? 'W' : 'H']),
            numberField(spec.resolution_px[i], (v) =>
              this.patch(cam.id, 'Set resolution', (o) => {
                const res = [...(o as CameraObject).camera.resolution_px] as [number, number];
                res[i] = Math.max(1, Math.round(v));
                (o as CameraObject).camera.resolution_px = res;
              }), { step: 1, min: 1 }),
          ])))),
      row('Sensor (mm)',
        h('div', { class: 'field__vec' }, [0, 1].map((i) =>
          h('span', { class: 'field__vec-cell' }, [
            h('span', { class: 'field__vec-axis' }, [i === 0 ? 'W' : 'H']),
            numberField(spec.sensor_mm[i], (v) =>
              this.patch(cam.id, 'Set sensor', (o) => {
                const s = [...(o as CameraObject).camera.sensor_mm] as [number, number];
                s[i] = Math.max(0.01, v);
                (o as CameraObject).camera.sensor_mm = s;
              }), { step: 0.1, min: 0.01 }),
          ]))),
        'With focal length this is the authoritative pair; FOV is derived'),
      row('Focal length (mm)',
        numberField(spec.focalLength_mm, (v) =>
          this.patch(cam.id, 'Set focal length', (o) => {
            (o as CameraObject).camera.focalLength_mm = Math.max(0.1, v);
          }), { step: 0.1, min: 0.1 })),
      row('Horizontal FOV (°)',
        numberField(hfovDegOf(cam), (deg) =>
          this.patch(cam.id, 'Set field of view', (o) => {
            const c = (o as CameraObject).camera;
            const clamped = Math.min(Math.max(deg, 1), 179);
            c.focalLength_mm = focalLengthForHfov(c.sensor_mm[0], (clamped * Math.PI) / 180);
          }), { step: 1, min: 1, max: 179 }),
        'Typing a field of view back-solves the focal length, which is what gets stored'),
      row('Frame rate (Hz)',
        numberField(spec.framerate_hz ?? 30, (v) =>
          this.patch(cam.id, 'Set frame rate', (o) => {
            (o as CameraObject).camera.framerate_hz = v > 0 ? v : null;
          }), { step: 1, min: 0 })),
      row('Intrinsics source',
        selectField(spec.intrinsicsSource ?? 'nominal', [
          { value: 'nominal' as IntrinsicsSource, label: 'nominal — placeholder' },
          { value: 'datasheet' as IntrinsicsSource, label: 'datasheet — manufacturer' },
          { value: 'calibrated' as IntrinsicsSource, label: 'calibrated — measured' },
        ], (v) => this.patch(cam.id, 'Set intrinsics source', (o) => {
          (o as CameraObject).camera.intrinsicsSource = v;
        })),
        'Tells a data scientist whether these numbers can be reconstructed from'),
    );

    this.renderCameraCoverage(cam, unit);
  }

  /** Derived numbers: what this camera will actually get. */
  private renderCameraCoverage(cam: CameraObject, unit: LengthUnit): void {
    const [cx, cy] = principalPointOf(cam);
    const items: HTMLElement[] = [
      readout('Field of view', `${hfovDegOf(cam).toFixed(1)}° × ${vfovDegOf(cam).toFixed(1)}°`),
      readout('Standoff (plan / slant)',
        `${formatLength(standoffHorizontalM(cam), unit)} / ${formatLengthWithUnit(standoffM(cam), unit)}`),
      readout('fx, fy', `${fxOf(cam).toFixed(1)}, ${fyOf(cam).toFixed(1)} px`),
      readout('Principal point', `${cx.toFixed(1)}, ${cy.toFixed(1)} px`),
      readout('Resolution at the fire', `${(groundSampleDistanceM(cam) * 1000).toFixed(2)} mm/px`),
    ];

    const framing = framingOf(this.store.document, cam);
    if (framing) {
      items.push(
        readout('Flame base in frame', framing.base ? 'yes' : 'no', framing.base ? 'good' : 'bad'),
        readout('Flame tip in frame', framing.tip ? 'yes' : 'no', framing.tip ? 'good' : 'bad'),
        readout('Plume in frame', `${(framing.fraction * 100).toFixed(0)}%`,
          framing.fraction > 0.999 ? 'good' : 'bad'),
      );
      if (!framing.tip || !framing.base) {
        const covers = 2 * Math.tan((vfovDegOf(cam) * Math.PI) / 360) * standoffM(cam);
        items.push(h('p', { class: 'readout__note' }, [
          `A ${vfovDegOf(cam).toFixed(0)}° vertical field at ` +
          `${formatLengthWithUnit(standoffM(cam), unit)} covers about ` +
          `${formatLengthWithUnit(covers, unit)} of height. Move back, or fit a wider lens.`,
        ]));
      }
    }

    this.root.append(sectionTitle('Coverage'));
    this.root.append(h('div', { class: 'readouts' }, items));
  }

  // -- burner ------------------------------------------------------------

  private renderBurner(b: BurnerObject, unit: LengthUnit): void {
    this.root.append(sectionTitle('Fuel pan'));
    this.root.append(
      row('Shape',
        selectField(b.footprint.shape, [
          { value: 'circle' as const, label: 'Circle' },
          { value: 'square' as const, label: 'Square' },
          { value: 'rectangle' as const, label: 'Rectangle' },
        ], (shape) => this.patch(b.id, 'Set shape', (o) => {
          const burner = o as BurnerObject;
          // Carry the effective diameter across, so changing shape does not
          // silently change the fire size.
          const d = burnerDiameterM(burner) || 0.3;
          burner.footprint = shape === 'circle'
            ? { shape, diameter_m: d }
            : { shape, size_m: [d, d] };
        }))),
    );

    if (b.footprint.shape === 'circle') {
      this.root.append(row(`Diameter (${unit})`,
        lengthField(b.footprint.diameter_m ?? 0.3, unit, (m) =>
          this.patch(b.id, 'Resize pan', (o) => {
            (o as BurnerObject).footprint.diameter_m = Math.max(0.01, m);
          }))));
    } else {
      this.root.append(row(`Size (${unit})`,
        vecField(b.footprint.size_m ?? [0.3, 0.3], unit, ['W', 'D'], (i, m) =>
          this.patch(b.id, 'Resize pan', (o) => {
            const size = [...((o as BurnerObject).footprint.size_m ?? [0.3, 0.3])] as [number, number];
            size[i] = Math.max(0.01, m);
            (o as BurnerObject).footprint.size_m = size;
          }))));
    }

    this.root.append(
      row(`Rim height (${unit})`,
        lengthField(b.rimHeight_m ?? 0, unit, (m) =>
          this.patch(b.id, 'Set rim height', (o) => {
            (o as BurnerObject).rimHeight_m = Math.max(0, m);
          })),
        'Fuel surface above the pan base — correlations measure from here'),
      row('Fuel', textField(b.fire?.fuel ?? '', (v) =>
        this.patch(b.id, 'Set fuel', (o) => {
          const burner = o as BurnerObject;
          burner.fire = { ...(burner.fire ?? {}), fuel: v || null };
        }))),
      row('HRR (kW)',
        numberField(b.fire?.hrr_kw ?? 0, (v) =>
          this.patch(b.id, 'Set HRR', (o) => {
            const burner = o as BurnerObject;
            burner.fire = { ...(burner.fire ?? {}), hrr_kw: v > 0 ? v : null };
          }), { step: 10, min: 0 })),
    );

    const flame = burnerFlameHeightM(b);
    const tip = flameTipZM(b);
    this.root.append(sectionTitle('Predicted fire'));
    this.root.append(h('div', { class: 'readouts' }, [
      readout('Effective diameter', formatLengthWithUnit(burnerDiameterM(b), unit),
        b.footprint.shape === 'circle' ? 'muted' : undefined),
      flame === null
        ? readout('Mean flame height', 'needs an HRR', 'muted')
        : readout('Mean flame height', formatLengthWithUnit(flame, unit)),
      tip === null
        ? readout('Flame tip above floor', '—', 'muted')
        : readout('Flame tip above floor', formatLengthWithUnit(tip, unit)),
      h('p', { class: 'readout__note' }, [
        'Heskestad correlation. Mean height — the intermittent tip reaches higher.',
      ]),
    ]));
  }

  // -- hood --------------------------------------------------------------

  private renderHood(hood: HoodObject, unit: LengthUnit): void {
    this.root.append(sectionTitle('Hood'));
    this.root.append(
      row(`Opening (${unit})`,
        vecField(hood.opening_m, unit, ['W', 'D'], (i, m) =>
          this.patch(hood.id, 'Resize hood', (o) => {
            const size = [...(o as HoodObject).opening_m] as [number, number];
            size[i] = Math.max(0.1, m);
            (o as HoodObject).opening_m = size;
          }))),
      row(`Height (${unit})`,
        lengthField(hood.height_m, unit, (m) =>
          this.patch(hood.id, 'Set hood height', (o) => {
            (o as HoodObject).height_m = Math.max(0.1, m);
          })),
        'Height of the opening plane above the floor'),
      row(`Skirt depth (${unit})`,
        lengthField(hood.skirtDepth_m ?? 0, unit, (m) =>
          this.patch(hood.id, 'Set skirt', (o) => {
            (o as HoodObject).skirtDepth_m = Math.max(0, m);
          })),
        'Hangs below the opening, lowering the plane the plume must reach'),
      row(`Duct diameter (${unit})`,
        lengthField(hood.duct?.diameter_m ?? 0.6, unit, (m) =>
          this.patch(hood.id, 'Set duct', (o) => {
            const hd = o as HoodObject;
            hd.duct = { diameter_m: Math.max(0.05, m), length_m: hd.duct?.length_m ?? 2 };
          }))),
    );

    const burner = primaryBurner(this.store.document);
    const intake = hoodIntakeHeightM(hood);
    const items: HTMLElement[] = [readout('Intake plane', formatLengthWithUnit(intake, unit))];

    if (burner) {
      const bp = positionOf(burner);
      const off = hoodOpeningOffset(hood, [bp[0], bp[1]]);
      const eccentricity = Math.hypot(off.u, off.v);

      // Over the fire or not comes first: everything below assumes it is.
      items.push(readout('Fire under the opening', off.inside ? 'yes' : 'no',
        off.inside ? 'good' : 'bad'));
      items.push(readout('Offset from opening centre', formatLengthWithUnit(eccentricity, unit),
        eccentricity < 0.1 ? 'muted' : undefined));

      const tip = flameTipZM(burner);
      if (tip !== null) {
        items.push(readout('Flame tip clearance', formatLengthWithUnit(intake - tip, unit),
          intake - tip > 0.2 * intake ? 'good' : 'bad'));
      }
      const radius = plumeRadiusAtZ(burner, intake);
      if (radius !== null) {
        const plumeD = 2 * radius;
        // The span the plume actually demands: a disk centred on the burner, not on
        // the opening, so an off-centre fire needs more than its own width.
        const axes: Array<[number, number]> = [
          [2 * (Math.abs(off.u) + radius), hood.opening_m[0]],
          [2 * (Math.abs(off.v) + radius), hood.opening_m[1]],
        ];
        const [need, avail] = axes.reduce((a, b) => (a[1] - a[0] <= b[1] - b[0] ? a : b));
        items.push(
          readout('Plume width at intake', formatLengthWithUnit(plumeD, unit)),
          readout('Opening needed / available',
            `${formatLength(need, unit)} / ${formatLengthWithUnit(avail, unit)}`,
            off.inside && need < 0.8 * avail ? 'good' : 'bad'),
          h('p', { class: 'readout__note' }, [
            'A hood that spills plume under-reads HRR by oxygen consumption. What has ' +
            'to fit is the plume disk where it sits, not just its width.',
          ]),
        );
      }
    }

    this.root.append(sectionTitle('Capture'));
    this.root.append(h('div', { class: 'readouts' }, items));
  }

  // -- wall --------------------------------------------------------------

  private renderWall(wall: WallObject, unit: LengthUnit): void {
    this.root.append(sectionTitle('Wall'));
    this.root.append(
      row(`Height (${unit})`,
        lengthField(wall.height_m, unit, (m) =>
          this.patch(wall.id, 'Set wall height', (o) => {
            (o as WallObject).height_m = Math.max(0.05, m);
          }))),
      row(`Thickness (${unit})`,
        lengthField(wall.thickness_m ?? 0.1, unit, (m) =>
          this.patch(wall.id, 'Set thickness', (o) => {
            (o as WallObject).thickness_m = Math.max(0.01, m);
          }))),
      row(`Base height (${unit})`,
        lengthField(wall.baseHeight_m ?? 0, unit, (m) =>
          this.patch(wall.id, 'Set base height', (o) => {
            (o as WallObject).baseHeight_m = Math.max(0, m);
          }))),
    );

    this.root.append(sectionTitle('Footprint'));
    wall.polyline_m.forEach((pt, i) => {
      this.root.append(row(`Point ${i + 1} (${unit})`,
        vecField(pt, unit, ['X', 'Y'], (axis, m) =>
          this.patch(wall.id, 'Move wall point', (o) => {
            const line = (o as WallObject).polyline_m.map((q) => [...q] as [number, number]);
            line[i][axis] = m;
            (o as WallObject).polyline_m = line;
          }))));
    });

    const actions: HTMLElement[] = [
      button('Add point', () => this.patch(wall.id, 'Add wall point', (o) => {
        const w = o as WallObject;
        const last = w.polyline_m[w.polyline_m.length - 1];
        w.polyline_m = [...w.polyline_m, [last[0] + 1, last[1]]];
      })),
    ];
    if (wall.polyline_m.length > 2) {
      actions.push(button('Remove last', () => this.patch(wall.id, 'Remove wall point', (o) => {
        const w = o as WallObject;
        w.polyline_m = w.polyline_m.slice(0, -1);
      })));
    }
    this.root.append(h('div', { class: 'panel__actions' }, actions));
  }

  // -- ceiling -----------------------------------------------------------

  private renderCeiling(slab: CeilingObject, unit: LengthUnit): void {
    this.root.append(sectionTitle('Ceiling'));
    this.root.append(
      row(`Soffit height (${unit})`,
        lengthField(slab.height_m, unit, (m) =>
          this.patch(slab.id, 'Set ceiling height', (o) => {
            (o as CeilingObject).height_m = Math.max(0.1, m);
          })),
        'Underside above the floor — the surface a flame impinges on'),
      row(`Thickness (${unit})`,
        lengthField(slab.thickness_m ?? 0.1, unit, (m) =>
          this.patch(slab.id, 'Set ceiling thickness', (o) => {
            (o as CeilingObject).thickness_m = Math.max(0.01, m);
          }))),
    );

    this.root.append(sectionTitle('Footprint'));
    slab.polygon_m.forEach((pt, i) => {
      this.root.append(row(`Point ${i + 1} (${unit})`,
        vecField(pt, unit, ['X', 'Y'], (axis, m) =>
          this.patch(slab.id, 'Move ceiling point', (o) => {
            const poly = (o as CeilingObject).polygon_m.map((q) => [...q] as [number, number]);
            poly[i][axis] = m;
            (o as CeilingObject).polygon_m = poly;
          }))));
    });

    const actions: HTMLElement[] = [
      button('Add point', () => this.patch(slab.id, 'Add ceiling point', (o) => {
        const c = o as CeilingObject;
        const last = c.polygon_m[c.polygon_m.length - 1];
        c.polygon_m = [...c.polygon_m, [last[0] + 1, last[1]]];
      })),
    ];
    if (slab.polygon_m.length > 3) {
      actions.push(button('Remove last', () => this.patch(slab.id, 'Remove ceiling point', (o) => {
        const c = o as CeilingObject;
        c.polygon_m = c.polygon_m.slice(0, -1);
      })));
    }
    this.root.append(h('div', { class: 'panel__actions' }, actions));

    const burner = primaryBurner(this.store.document);
    const items: HTMLElement[] = [
      readout('Slab area', `${ceilingAreaM2(slab).toFixed(2)} m²`),
      readout('Covers the fire',
        burner && ceilingCoversXY(slab, positionOf(burner)[0], positionOf(burner)[1]) ? 'yes' : 'no',
        'muted'),
    ];
    if (burner) {
      const tip = flameTipZM(burner);
      if (tip !== null) {
        const clearance = slab.height_m - tip;
        items.push(readout('Flame tip clearance', formatLengthWithUnit(clearance, unit),
          clearance > 0.2 * slab.height_m ? 'good' : 'bad'));
        items.push(h('p', { class: 'readout__note' }, [
          'Flame on a ceiling spreads as a ceiling jet, and the free-plume correlations ' +
          'used elsewhere here stop applying.',
        ]));
      }
    }
    this.root.append(sectionTitle('Clearance'));
    this.root.append(h('div', { class: 'readouts' }, items));
  }

  private renderUnknown(obj: PlanObject): void {
    this.root.append(sectionTitle('Unrecognised object'));
    this.root.append(
      h('p', { class: 'panel__empty' }, [
        `This build does not know the type "${obj.type}". Its data is preserved exactly ` +
        'and will be written back unchanged on save.',
      ]),
      h('pre', { class: 'panel__code' }, [JSON.stringify(obj, null, 2)]),
    );
  }
}
