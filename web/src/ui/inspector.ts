import { curvePeak, hrrAt } from '../core/hrr';
/**
 * Property inspector for the selected object.
 *
 * For cameras it also carries a derived readout -- field of view, standoff, ground
 * sample distance, and whether the flame actually fits in frame. Those are the
 * numbers a test plan exists to settle, and they are worth more than the raw
 * intrinsics they come from.
 */

import { DEFAULT_RADIATIVE_FRACTION, POINT_SOURCE_MIN_DIAMETERS } from '../core/correlations';
import { defaultAimTarget } from '../core/factory';
import {
  applyXbToObject,
  fdsFrame,
  xbProblem,
  hasXbView,
  hasXyzView,
  iorLabel,
  normalForIor,
  xbOfObject,
  xyzOfObject,
} from '../core/fdsview';
import { setAimTarget, setPosition, type AimableObject } from '../core/transform';
import {
  beadOffsetsOf,
  beadVerdict,
  burnerDiameterM,
  burnerFlameHeightM,
  burners,
  ceilingAreaM2,
  ceilingCoversXY,
  ceilingSoffitZM,
  displayName,
  effectiveFocalLengthMm,
  fireBurners,
  flameTipZM,
  framingOf,
  fxOf,
  fyOf,
  gaugeRangeKwM2,
  gaugeVerdict,
  gaugeViewAngleDeg,
  groundSampleDistanceM,
  heatFluxEstimate,
  hfovDegOf,
  hoodIntakeHeightM,
  hoodOpeningOffset,
  isBurner,
  isCamera,
  isCeiling,
  isHeatFluxSensor,
  isHood,
  isObstruction,
  isReconstructedFlame,
  isThermocouple,
  isWall,
  LOW_SIGNAL_FRACTION,
  plumeRadiusAtZ,
  positionOf,
  principalPointOf,
  radiativeFractionOf,
  standoffHorizontalM,
  standoffM,
  TC_MAX_TEMPERATURE_C,
  tcMaxTemperatureC,
  tcTypeOf,
  thermocoupleBeads,
  verticalCoverageM,
  vfovDegOf,
  zoomOf,
  type InstrumentStatus,
} from '../core/plan';
import {
  applyLensToSpec,
  collapseBodies,
  compareLenses,
  currentLensOf,
  lensesOf,
  lensName,
  listedLabel,
  withLens,
} from '../core/lenses';
import {
  applyPresetToSpec,
  cameraPresets,
  deleteCustomPreset,
  focalLengthForHfov,
  isCustomPreset,
  presetFromCamera,
  presetsArePersistent,
  saveCustomPreset,
  type CameraPreset,
} from '../core/presets';
import { formatLength, formatLengthWithUnit } from '../core/units';
import type {
  BurnerObject,
  CameraObject,
  CeilingObject,
  GaugeKind,
  HeatFluxSensorObject,
  HoodObject,
  IntrinsicsSource,
  LengthUnit,
  Modality,
  ObstructionObject,
  PlanDocument,
  ReconstructedFlameObject,
  PlanObject,
  TcType,
  ThermocoupleObject,
  Vec3,
  WallObject,
} from '../core/types';
import type { Store } from '../state/store';
import { clear, h } from './dom';
import { FlamePanel } from './flame-panel';
import { LinkedFilesPanel } from './linked-files';
import type { FlameActions } from '../state/flame-actions';
import type { FlameStore } from '../state/flame-store';
import type { TestDataStore } from '../state/test-data-store';
import { CurveEditor } from './hrr-curve-editor';
import {
  button,
  checkboxField,
  lengthField,
  numberField,
  readout,
  type ReadoutTone,
  row,
  sectionTitle,
  selectField,
  textField,
  vecField,
} from './fields';

/** Object types whose `type` string does not read as a heading on its own. The
 *  panel title is uppercased by CSS, and "HEATFLUXSENSOR" is not a phrase. */
const TYPE_LABEL: Record<string, string> = {
  heatFluxSensor: 'heat flux gauge',
  reconstructedFlame: 'reconstructed flame',
};

/** Which coordinate vocabulary the Position section is showing.
 *
 *  Sticky across selections on purpose: someone working from an FDS input wants
 *  every object in FDS coordinates, not to re-choose per object. */
type CoordMode = 'fields' | 'fds';

/** One classifier, two vocabularies: `readout` has said `good` since 1.0, and the
 *  report says `ok` because that is its CSS class. This is the whole difference. */
const TONE: Record<InstrumentStatus, ReadoutTone> = {
  ok: 'good', warn: 'warn', bad: 'bad', muted: 'muted',
};

export class Inspector {
  private linkedFiles: LinkedFilesPanel;
  private flamePanel: FlamePanel | null = null;
  /**
   * Fired when the camera preset library changes.
   *
   * The library lives outside the document, so saving or deleting a preset emits
   * no store event and nothing would repaint -- including the palette, which is a
   * different panel listing the same presets. main.ts wires this to both.
   */
  onPresetLibraryChange: (() => void) | null = null;

  /**
   * The preset being named, or null when no save is in progress.
   *
   * An inline row rather than `window.prompt`, which would be the only blocking
   * dialog in the editing path and is not guaranteed to be there at all -- the
   * desktop shell is an embedded WebView, and every other field in this panel is
   * inline anyway.
   *
   * Scoped to a camera id so that selecting a different camera closes the form
   * rather than silently re-pointing it at another camera's optics.
   */
  private pendingPreset: { cameraId: string; name: string } | null = null;

  /** Why the last XB typed for an object was refused, shown under its XB fields
   *  until the next edit of that object goes through. */
  private xbProblem: { id: string; message: string } | null = null;

  /** Fields, or the FDS spelling of the same geometry. See `core/fdsview.ts`. */
  private coordMode: CoordMode = 'fields';

  /** The session's test data, for a burner's From test data curve; none in fixtures. */
  private testData: TestDataStore | null = null;

  /** A burner's Curve control, with its drafts. */
  private curveEditor = new CurveEditor({
    apply: (id, label, curve) => this.patch(id, label, (o) => {
      const burner = o as BurnerObject;
      if (curve) {
        // hrr_kw is the curve's peak; the writer enforces the same.
        burner.fire = { ...(burner.fire ?? {}), hrr_kw: curvePeak(curve), hrrCurve: curve };
      } else {
        // Remove curve keeps the peak as the steady rate; a zero peak is an unset rate.
        const peak = hrrAt(burner);
        burner.fire = { ...burner.fire, hrr_kw: peak === 0 ? null : peak, hrrCurve: null };
      }
    }),
    series: (id) => this.testData?.seriesFor(id).filter((s) => s.unit === 'kW') ?? [],
    rerender: () => this.render(),
    documentId: () => this.store.documentId,
  });

  constructor(
    private root: HTMLElement,
    private store: Store,
  ) { this.linkedFiles = new LinkedFilesPanel(store, () => this.render()); }

  /** A burner's From test data curve reads the session's loaded series. */
  attachTestData(testData: TestDataStore): void {
    this.testData = testData;
    testData.subscribe(() => {
      const sole = this.store.soleSelected;
      if (sole && isBurner(sole)) this.render();
    });
  }

  /** The flame sections need the session's loaded sequences and the link actions. */
  attachFlames(flames: FlameStore, actions: FlameActions): FlamePanel {
    this.flamePanel = new FlamePanel(this.store, flames, actions, () => this.render());
    // A burner's Linked files section offers the same run's frames as a new flame;
    // it runs the link through its own guard, so a folder that cannot be read is
    // reported under the burner like any other failed link.
    this.linkedFiles.linkFlame = (burnerId) => actions.link(null, burnerId);
    return this.flamePanel;
  }

  /**
   * A plan-level edit as one undoable step. These used to leave their run open, so
   * two separate title edits undid as one, and the plan's notes merged with the next
   * object's "Edit notes" (review 2026-09-22, UI-5).
   */
  private editPlan(label: string, fn: (doc: PlanDocument) => void): void {
    this.store.edit(label, fn);
    this.store.commit();
  }

  /** Mutate the selected object as one undoable step. */
  private patch(id: string, label: string, fn: (obj: PlanObject) => void): void {
    this.store.edit(label, (doc) => {
      const obj = doc.objects.find((o) => o.id === id);
      if (obj) fn(obj);
    });
    this.store.commit();
  }

  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Re-render on the next task, coalesced -- never inside the event that asked.
   *
   * A committed field fires `change` while the browser is moving focus: Tab out of
   * X, or a click on Z. Rebuilding synchronously there removed the control focus was
   * heading to, focus fell to the page, and the next key went to the editor instead
   * -- Backspace deleted the selected object, a digit switched the view, and what
   * was typed next was lost. A selection change made while a field held uncommitted
   * text did worse: removing the field fired its `change`, which rendered again from
   * inside the first render and threw, leaving a placement half done. One task later
   * the browser has finished moving focus, and there is only ever one render.
   */
  render(): void {
    if (this.renderTimer !== null) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderNow();
    }, 0);
  }

  /**
   * Re-render now, keeping keyboard focus where it was.
   *
   * Every field edit rebuilds this panel, which would otherwise drop focus on each
   * committed value and make tabbing through X/Y/Z impossible. Restoring by index
   * is crude but the control order is stable within one selection.
   */
  private renderNow(): void {
    // Buttons too: Tab from the last field lands on Duplicate, and the rebuild used
    // to drop that focus onto the page. A control is refocused only if the one at
    // its index is the same kind of control -- after Delete the panel is a different
    // panel, and the index would otherwise put focus in whatever field it now meets.
    const controls = () => Array.from(this.root.querySelectorAll('input, select, textarea, button'));
    const kind = (el: Element | undefined): string => (el === undefined ? ''
      : `${el.tagName}|${(el as HTMLInputElement).type ?? ''}|${el.tagName === 'BUTTON' ? el.textContent : ''}`);
    const before = controls();
    const focusedIndex = before.indexOf(document.activeElement as Element);
    const focusedKind = kind(before[focusedIndex]);
    // A control with a stable key (the Curve control's) is found again by that key,
    // with its caret, although controls before it come and go: Make t² curve turns
    // the HRR field above it into a readout.
    const active = before[focusedIndex] as (HTMLElement & Partial<HTMLInputElement>) | undefined;
    const focusKey = active?.dataset.focusKey;
    const caret = active && typeof active.selectionStart === 'number' && /^(TEXTAREA|INPUT)$/.test(active.tagName)
      ? [active.selectionStart, active.selectionEnd ?? active.selectionStart] as const : null;

    this.renderInner();

    if (focusKey) {
      const next = this.root.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`);
      if (next) {
        next.focus();
        if (caret && (next instanceof HTMLTextAreaElement || next instanceof HTMLInputElement)) next.setSelectionRange(caret[0], caret[1]);
        return;
      }
    }
    if (focusedIndex >= 0) {
      const next = controls()[focusedIndex] as HTMLElement | undefined;
      if (next === undefined || kind(next) !== focusedKind) return;
      next.focus();
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
    this.root.append(sectionTitle(TYPE_LABEL[obj.type] ?? obj.type));
    this.root.append(
      row('Name', textField(obj.name ?? '', (v) =>
        this.patch(obj.id, 'Rename', (o) => { o.name = v || null; }))),
      row('ID', h('code', { class: 'field__static' }, [obj.id]),
        'Stable across revisions so git diffs stay meaningful'),
    );

    // A flame's one link is a folder with a manifest, and has its own sections.
    const linkedFiles = isReconstructedFlame(obj) ? null : this.linkedFiles.render(obj);
    if (linkedFiles) this.root.append(linkedFiles);
    if (isReconstructedFlame(obj) && this.flamePanel) {
      this.root.append(...this.flamePanel.render(obj, (label, fn) => this.patch(obj.id, label, (o) => fn(o as ReconstructedFlameObject))));
    }
    this.renderTransform(obj, unit);

    if (isCamera(obj)) this.renderCamera(obj, unit);
    else if (isBurner(obj)) this.renderBurner(obj, unit);
    else if (isHood(obj)) this.renderHood(obj, unit);
    else if (isWall(obj)) this.renderWall(obj, unit);
    else if (isCeiling(obj)) this.renderCeiling(obj, unit);
    else if (isHeatFluxSensor(obj)) this.renderHeatFluxSensor(obj, unit);
    else if (isThermocouple(obj)) this.renderThermocouple(obj, unit);
    else if (isObstruction(obj)) this.renderObstruction(obj, unit);
    else if (isReconstructedFlame(obj)) { /* its sections are above the transform */ }
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
    const canFds = hasXbView(obj) || hasXyzView(obj);
    this.root.append(sectionTitle('Position', canFds ? this.coordToggle() : undefined));

    if (canFds && this.coordMode === 'fds') {
      this.renderFdsCoords(obj, unit);
      return;
    }

    const p = positionOf(obj);
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

  /** The Fields / FDS switch, in the section heading rather than as a row: it
   *  changes what the whole section means, not one value in it. */
  private coordToggle(): HTMLElement {
    const pick = (mode: CoordMode, label: string, title: string): HTMLElement =>
      h('button', {
        class: `seg__btn${this.coordMode === mode ? ' seg__btn--active' : ''}`,
        type: 'button',
        title,
        onclick: () => { this.coordMode = mode; this.render(); },
      }, [label]);

    return h('span', { class: 'seg' }, [
      pick('fields', 'Fields', 'Position, size and height as this format stores them'),
      pick('fds', 'FDS', 'The same geometry as FDS spells it: XB for a box, XYZ and IOR for a device'),
    ]);
  }

  /**
   * Geometry in FDS's own parameterisation.
   *
   * The numbers are in the SOURCE file's coordinates when the plan was imported
   * from one, so they can be compared against the `.fds` line by line. A plan that
   * was authored here has no offset to apply and the panel says so, rather than
   * implying the numbers would match a file somewhere.
   */
  private renderFdsCoords(obj: PlanObject, unit: LengthUnit): void {
    const frame = fdsFrame(this.store.document);

    if (hasXyzView(obj)) {
      this.renderFdsDevice(obj, unit, frame.offset);
    } else {
      this.renderFdsBox(obj, unit, frame.offset);
    }

    this.root.append(h('p', { class: 'panel__hint' }, [
      frame.fromImport
        ? `In ${frame.file ?? 'the source file'}'s coordinates — the plan origin sits at `
          + `(${frame.offset.map((v) => formatLength(v, unit)).join(', ')}) there, `
          + 'so these are the numbers that file contains.'
        : 'In plan coordinates. This plan was not imported from FDS, so there is no source '
          + 'file to match — the numbers are FDS-shaped, not FDS-sourced.',
    ]));
  }

  private renderFdsBox(obj: PlanObject, unit: LengthUnit, offset: Vec3): void {
    const view = xbOfObject(obj, offset);
    if (!view) {
      this.root.append(h('p', { class: 'panel__hint' }, ['This object has no XB.']));
      return;
    }

    const labels = ['X1', 'X2', 'Y1', 'Y2', 'Z1', 'Z2'];
    const rows: HTMLElement[] = [];
    for (let axis = 0; axis < 3; axis += 1) {
      const lo = axis * 2;
      rows.push(row(
        `XB ${labels[lo]} ${labels[lo + 1]} (${unit})`,
        view.editable
          ? vecField(
            [view.xb[lo], view.xb[lo + 1]], unit, [labels[lo], labels[lo + 1]],
            (index, metres) => {
              // Re-read rather than closing over the rendered box: two edits in a
              // row would otherwise write the second onto a stale first. `obj` is
              // the live document object, so this reads its current state.
              const current = xbOfObject(obj, offset);
              if (!current) return;
              const next = [...current.xb] as typeof current.xb;
              next[lo + index] = metres;
              // Refused BEFORE it becomes an edit: an XB that would make the object
              // one the load boundary rejects must not enter the document, or it
              // saves and the plan then refuses to reopen. Nothing goes onto the
              // undo stack for a value that was never applied.
              const problem = xbProblem(obj, next, offset, unit);
              if (problem !== null) {
                this.xbProblem = { id: obj.id, message: problem };
                this.render();
                return;
              }
              this.xbProblem = null;
              this.patch(obj.id, 'Set XB', (o) => { applyXbToObject(o, next, offset); });
            },
          )
          : h('span', { class: 'field__static' }, [
            `${formatLength(view.xb[lo], unit)}, ${formatLength(view.xb[lo + 1], unit)}`,
          ]),
      ));
    }
    this.root.append(...rows);

    if (this.xbProblem?.id === obj.id) {
      this.root.append(h('p', { class: 'panel__error' }, [
        `Not applied: ${this.xbProblem.message}.`,
      ]));
    }

    if (!view.editable) {
      this.root.append(h('p', { class: 'panel__hint' }, [
        `Read-only: ${view.why}. Edit it in the Fields view, or square it off there first.`,
      ]));
    }
  }

  private renderFdsDevice(obj: PlanObject, unit: LengthUnit, offset: Vec3): void {
    const view = xyzOfObject(obj, offset);
    if (!view) return;

    this.root.append(row(
      `XYZ (${unit})`,
      vecField(view.xyz, unit, ['X', 'Y', 'Z'], (index, metres) =>
        this.patch(obj.id, 'Set XYZ', (o) => {
          const next = [...positionOf(o)] as Vec3;
          next[index] = metres - offset[index];
          setPosition(o, next);
        })),
      "A device's position, as &DEVC writes it",
    ));

    if (!view.aimable) {
      // A thermocouple bead has no facing, and FDS does not give one an IOR either.
      this.root.append(h('p', { class: 'panel__hint' }, [
        'A thermocouple has no IOR: a bead has no facing. Its beads run up the rake '
        + 'from this point.',
      ]));
      return;
    }

    this.root.append(row(
      'IOR',
      selectField(String(view.ior ?? ''), [
        { value: '', label: view.ior === null ? 'off-axis (aimed)' : '— none —' },
        { value: '1', label: '1 — faces +X' },
        { value: '-1', label: '−1 — faces −X' },
        { value: '2', label: '2 — faces +Y' },
        { value: '-2', label: '−2 — faces −Y' },
        { value: '3', label: '3 — faces +Z (floor-mounted, looking up)' },
        { value: '-3', label: '−3 — faces −Z (ceiling-mounted, looking down)' },
      ], (raw) => {
        const ior = Number(raw);
        const normal = raw === '' ? null : normalForIor(ior);
        if (!normal) return; // '— none —' keeps whatever aim the gauge already has
        this.patch(obj.id, 'Set IOR', (o) => {
          const p = positionOf(o);
          // IOR is the direction the MOUNTING SURFACE faces, which is exactly this
          // format's outward normal for a gauge -- so setting one is an aim at a
          // point one metre out along that axis, and the two stay consistent.
          setAimTarget(o as AimableObject,
            [p[0] + normal[0], p[1] + normal[1], p[2] + normal[2]]);
        });
      }),
      'Index of orientation: the axis the gauge\'s mounting surface faces',
    ));

    this.root.append(h('div', { class: 'readouts' }, [
      readout('Facing', iorLabel(view.ior),
        view.ior === null ? 'muted' : 'good'),
    ]));
  }

  private renderPlanProperties(): void {
    const doc = this.store.document;
    const unit = this.store.displayUnit;

    this.root.append(sectionTitle('Plan'));
    this.root.append(
      row('Title', textField(doc.meta?.title ?? '', (v) =>
        this.editPlan('Edit title', (d) => { d.meta = { ...(d.meta ?? {}), title: v }; }))),
      row('Test ID', textField(doc.meta?.testId ?? '', (v) =>
        this.editPlan('Edit test ID', (d) => { d.meta = { ...(d.meta ?? {}), testId: v || null }; }))),
      row('Author', textField(doc.meta?.author ?? '', (v) =>
        this.editPlan('Edit author', (d) => { d.meta = { ...(d.meta ?? {}), author: v || null }; }))),
      row('Site', textField(doc.meta?.siteName ?? '', (v) =>
        this.editPlan('Edit site', (d) => { d.meta = { ...(d.meta ?? {}), siteName: v || null }; }))),
      row('Revision', textField(doc.meta?.revision ?? '', (v) =>
        this.editPlan('Edit revision', (d) => { d.meta = { ...(d.meta ?? {}), revision: v || null }; })),
        'Plans are revised by saving a new file; this plus git history is the audit trail'),
      row('Notes', textField(doc.meta?.notes ?? '', (v) =>
        this.editPlan('Edit plan notes', (d) => { d.meta = { ...(d.meta ?? {}), notes: v || null }; }))),
    );

    const env = doc.environment ?? {};
    this.root.append(sectionTitle('Environment'));
    this.root.append(
      row(`Floor size (${unit})`,
        vecField(env.floorSize_m ?? [20, 20], unit, ['W', 'D'], (index, metres) =>
          this.editPlan('Resize floor', (d) => {
            const size = [...(d.environment?.floorSize_m ?? [20, 20])] as [number, number];
            size[index] = metres;
            d.environment = { ...(d.environment ?? {}), floorSize_m: size };
          }))),
      row('Ambient (°C)',
        numberField(env.ambientTemperature_C ?? 20, (v) =>
          this.editPlan('Set ambient', (d) => {
            d.environment = { ...(d.environment ?? {}), ambientTemperature_C: v };
          }), { step: 1 })),
    );
  }

  // -- aim ---------------------------------------------------------------

  /**
   * The aim block, shared by cameras and heat flux gauges.
   *
   * Both store their orientation the same way and both mean the same thing by it
   * ("this is what I am pointed at"), so they get the same control rather than two
   * that could drift.
   */
  private renderAim(obj: AimableObject, unit: LengthUnit, handRotatedHint: string): void {
    const target = obj.transform?.aimTarget_m ?? null;

    // Since 1.1 a gauge can legitimately stand on the point the model puts the
    // fire at -- `gauge-in-fire` says so in as many words -- and there is no
    // direction from a point to itself. `setAimTarget` refuses that edit rather
    // than throwing halfway through it, so the button has to say why it is off
    // instead of looking like it does nothing.
    const fire = defaultAimTarget(this.store.document);
    const here = positionOf(obj);
    const onTheFire =
      Math.hypot(fire[0] - here[0], fire[1] - here[1], fire[2] - here[2]) < 1e-9;
    const aimAtFire = button('Aim at fire', () =>
      this.patch(obj.id, 'Aim at fire', (o) => {
        setAimTarget(o as AimableObject, defaultAimTarget(this.store.document));
      }));
    if (onTheFire) {
      aimAtFire.disabled = true;
      aimAtFire.title = 'This sits on the point the model puts the fire at, so there is no '
        + 'direction to aim along. Move it out of the flame first.';
    }

    this.root.append(sectionTitle('Aim'));
    this.root.append(
      row(`Aim target (${unit})`,
        vecField(target ?? [0, 0, 0], unit, ['X', 'Y', 'Z'], (index, metres) =>
          this.patch(obj.id, 'Re-aim', (o) => {
            const next = [...(o.transform?.aimTarget_m ?? [0, 0, 0])] as Vec3;
            next[index] = metres;
            setAimTarget(o as AimableObject, next);
          })),
        target ? 'Advisory; the stored quaternion is authoritative' : handRotatedHint),
      h('div', { class: 'panel__actions' }, [aimAtFire]),
    );
  }

  // -- camera ------------------------------------------------------------

  private renderCamera(cam: CameraObject, unit: LengthUnit): void {
    const spec = cam.camera;

    this.renderAim(cam, unit, 'No target set — this camera was rotated by hand');

    this.root.append(sectionTitle('Optics'));
    this.root.append(
      this.presetRow(cam),
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
          }), { step: 0.1, min: 0.1 }),
        'The lens itself. Zoom is separate, so this stays the number on the barrel'),
      row('Zoom (×)',
        numberField(zoomOf(cam), (v) =>
          this.patch(cam.id, 'Set zoom', (o) => {
            const c = (o as CameraObject).camera;
            // 1x is the absence of a zoom rather than a value. Omitting it keeps a
            // plan that does not use the feature declaring format 1.0, so it still
            // opens in a build that predates zoom.
            //
            // A typed 0 or a negative gets the same treatment, because that is what
            // `zoomOf` already says they mean. Clamping them to 0.01 instead wrote a
            // ~171 degree field of view into the file and bumped it to 1.1.0 -- the
            // `min` attribute does not stop a typed value.
            if (!(v > 0) || Math.abs(v - 1) < 1e-9) delete c.zoomFactor;
            else c.zoomFactor = v;
          }), { step: 0.5, min: 0.01 }),
        'Multiplies the effective focal length: 2× halves both fields of view'),
      row('Horizontal FOV (°)',
        numberField(hfovDegOf(cam), (deg) =>
          this.patch(cam.id, 'Set field of view', (o) => {
            const c = (o as CameraObject).camera;
            const clamped = Math.min(Math.max(deg, 1), 179);
            const effective = focalLengthForHfov(c.sensor_mm[0], (clamped * Math.PI) / 180);
            // Back out the zoom, so typing a field of view changes the LENS and
            // leaves the zoom setting where the operator put it.
            c.focalLength_mm = effective / zoomOf(o as CameraObject);
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
    this.renderLensComparison(cam, unit);
  }

  // -- camera presets ----------------------------------------------------

  /**
   * Preset picker, plus the actions that let the library grow.
   *
   * The library is not a file the user maintains (see core/presets.ts), so every
   * way of adding to it has to be here, next to the numbers being captured:
   * saving the optics in front of you, and adopting a preset named by a plan
   * someone else authored. That second one is how a preset crosses machines
   * without ever becoming an attachment.
   */
  private presetRow(cam: CameraObject): HTMLElement {
    const spec = cam.camera;
    const library = cameraPresets();
    const named = spec.presetId ?? '';
    const foreign = named !== '' && !library.some((p) => p.id === named);

    const lenses = lensesOf(named);
    const options = [
      { value: '', label: '— custom —' },
      ...(foreign ? [{ value: named, label: `${named} — not in your library` }] : []),
      // A body with several lenses is one entry, and the lens is chosen below it.
      // The entry stands for the camera's own lens when the camera is that body, so
      // it shows as selected; picked from another camera, it applies the lens the
      // palette places.
      ...collapseBodies(library).map((p) => ({
        value: lenses.some((l) => l.id === p.id) ? named : p.id,
        label: listedLabel(p),
      })),
    ];

    const naming = this.pendingPreset?.cameraId === cam.id;
    const actions: HTMLElement[] = [
      button(naming ? 'Cancel' : 'Save as preset…', () => {
        this.pendingPreset = naming
          ? null
          : { cameraId: cam.id, name: this.suggestedPresetName(cam) };
        this.renderInner();
        (this.root.querySelector('.preset-name input') as HTMLInputElement | null)?.select();
      }),
    ];
    if (foreign) {
      actions.push(button('Add to my presets', () => this.adoptPreset(cam, named)));
    } else if (named && isCustomPreset(named)) {
      actions.push(button('Delete preset', () => this.deletePreset(named), 'btn--danger'));
    }

    return h('div', {}, [
      row('Preset',
        selectField(named, options, (id) => {
          const preset = library.find((p) => p.id === id);
          if (!preset) return;
          this.patch(cam.id, 'Apply preset', (o) => {
            const c = o as CameraObject;
            c.camera = applyPresetToSpec(c.camera, preset);
          });
        }),
        'Intrinsics are copied inline, so the plan stays self-contained'),
      lenses.length > 0 ? this.lensRow(cam, lenses) : null,
      h('div', { class: 'panel__actions' }, actions),
      naming ? this.presetNameForm(cam) : null,
      foreign
        ? h('p', { class: 'panel__hint' }, [
          'This plan names a preset your library does not have. The camera is complete '
          + 'either way — every intrinsic is stored inline — but adding it lets you place '
          + 'more of the same camera.',
        ])
        : null,
    ].filter(Boolean) as HTMLElement[]);
  }

  /**
   * The lens, for a body whose datasheet lists several. Each option carries the
   * field of view it would give this camera, at its zoom, so the choice reads as
   * what it does rather than as a number on a barrel.
   */
  private lensRow(cam: CameraObject, lenses: CameraPreset[]): HTMLElement {
    const mine = currentLensOf(cam);
    const fov = (c: CameraObject): string => `${hfovDegOf(c).toFixed(1)}° × ${vfovDegOf(c).toFixed(1)}°`;
    const options = [
      ...(mine ? [] : [{ value: '', label: `${lensName(cam.camera.focalLength_mm)} (not a listed lens)` }]),
      ...lenses.map((lens) => ({
        value: lens.id,
        label: `${lensName(lens.focalLength_mm)} (${fov(lens === mine ? cam : withLens(cam, lens))})`,
      })),
    ];
    return row('Lens',
      selectField(mine?.id ?? '', options, (id) => {
        const lens = lenses.find((l) => l.id === id);
        if (!lens) return;
        this.patch(cam.id, 'Change lens', (o) => {
          const c = o as CameraObject;
          c.camera = applyLensToSpec(c.camera, lens);
        });
      }),
      'The lenses this body\'s datasheet lists. Changing it keeps the zoom and the body\'s '
      + 'settings, and drops a calibration made through the old lens');
  }

  private suggestedPresetName(cam: CameraObject): string {
    return cam.name
      || cameraPresets().find((p) => p.id === cam.camera.presetId)?.label
      || 'My camera';
  }

  /** The inline "name it" row. Rendered only while a save is in progress. */
  private presetNameForm(cam: CameraObject): HTMLElement {
    const input = textField(this.pendingPreset?.name ?? '', (v) => {
      if (this.pendingPreset) this.pendingPreset.name = v;
    });
    // `change` only fires on blur, and Enter is what anyone naming a thing presses.
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitPreset(cam, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.pendingPreset = null;
        this.renderInner();
      }
    });

    return h('div', { class: 'preset-name' }, [
      row('Preset name', input,
        'Saved to your preset library, not to a file beside the plan'),
      h('div', { class: 'panel__actions' }, [
        button('Save preset', () => this.commitPreset(cam, input.value)),
      ]),
      h('p', { class: 'panel__hint' }, [
        'Captures the optics above — resolution, sensor, focal length, band and frame '
        + 'rate — but not the zoom, which belongs to the shot rather than to the camera.',
        cam.camera.intrinsicsSource === 'calibrated'
          ? ' Nor the calibration: a principal point and distortion belong to this one '
            + 'physical unit, so the preset is saved as datasheet-grade.'
          : '',
        presetsArePersistent()
          ? ''
          : ' The library has nowhere to be stored that outlives this session, so the preset '
            + 'will last only until the app closes. The plan itself is unaffected: every '
            + 'intrinsic is written into the camera.',
      ]),
    ]);
  }

  private commitPreset(cam: CameraObject, typed: string): void {
    const label = typed.trim();
    if (!label) return;
    this.pendingPreset = null;

    const saved = saveCustomPreset(presetFromCamera(cam, label));
    // Point the camera at the preset it just became, so the picker shows it
    // selected rather than "custom" and the two cannot look unrelated.
    this.patch(cam.id, 'Save camera preset', (o) => {
      (o as CameraObject).camera.presetId = saved.id;
    });
    this.onPresetLibraryChange?.();
  }

  private adoptPreset(cam: CameraObject, id: string): void {
    saveCustomPreset(presetFromCamera(cam, cam.name || id, id));
    this.onPresetLibraryChange?.();
    this.render();
  }

  private deletePreset(id: string): void {
    if (!window.confirm(
      `Remove the preset "${id}" from your library?\n\n`
      + 'Cameras already placed keep their intrinsics — a preset is only a starting '
      + 'point, and nothing in any plan depends on it.',
    )) return;
    deleteCustomPreset(id);
    this.onPresetLibraryChange?.();
    this.render();
  }

  /** Derived numbers: what this camera will actually get. */
  private renderCameraCoverage(cam: CameraObject, unit: LengthUnit): void {
    const [cx, cy] = principalPointOf(cam);
    const zoom = zoomOf(cam);
    const items: HTMLElement[] = [
      readout('Field of view', `${hfovDegOf(cam).toFixed(1)}° × ${vfovDegOf(cam).toFixed(1)}°`),
      readout('Standoff (plan / slant)',
        `${formatLength(standoffHorizontalM(cam), unit)} / ${formatLengthWithUnit(standoffM(cam), unit)}`),
      readout('fx, fy', `${fxOf(cam).toFixed(1)}, ${fyOf(cam).toFixed(1)} px`),
      readout('Principal point', `${cx.toFixed(1)}, ${cy.toFixed(1)} px`),
      readout('Resolution at the fire', `${(groundSampleDistanceM(cam) * 1000).toFixed(2)} mm/px`),
    ];

    if (zoom !== 1) {
      items.splice(1, 0, readout('Effective focal length',
        `${effectiveFocalLengthMm(cam).toFixed(2)} mm — ${cam.camera.focalLength_mm} mm at ${zoom}×`));
    }

    const framing = framingOf(this.store.document, cam);
    if (framing) {
      items.push(
        readout('Flame base in frame', framing.base ? 'yes' : 'no', framing.base ? 'good' : 'bad'),
        readout('Flame tip in frame', framing.tip ? 'yes' : 'no', framing.tip ? 'good' : 'bad'),
        readout('Plume in frame', `${(framing.fraction * 100).toFixed(0)}%`,
          framing.fraction > 0.999 ? 'good' : 'bad'),
        readout('Flame unobstructed', framing.unobstructed === null ? 'no centreline in frame'
          : `${(framing.unobstructed * 100).toFixed(0)}%`,
          framing.unobstructed === null ? 'muted' : framing.unobstructed > 0.999 ? 'good' : 'bad'),
      );
      if (!framing.tip || !framing.base) {
        // Deliberately NOT compared against the flame height to decide whether the
        // miss is "marginal". This strip is measured across the optical axis, the
        // flame stands vertically, and a camera tilted down at the fire makes those
        // two quantities incomparable -- near enough that the arithmetic looks fine
        // and far enough that it is wrong. `Plume in frame` above is the honest
        // measure of how badly a camera misses, and it comes from the projection.
        const covers = verticalCoverageM(cam);
        items.push(h('p', { class: 'readout__note' }, [
          `A ${vfovDegOf(cam).toFixed(0)}° vertical field at ` +
          `${formatLengthWithUnit(standoffM(cam), unit)} covers about ` +
          `${formatLengthWithUnit(covers, unit)} across the frame. Move back, ` +
          `${zoom > 1 ? 'zoom out, ' : ''}or fit a wider lens` +
          `${lensesOf(cam.camera.presetId).length > 0 ? ' (Lens, under Optics)' : ''}.`,
        ]));
      }
    }

    // The framing is real at any zoom; the resolution is only real at optical
    // zoom. Saying so here is the difference between a planning number and a
    // number someone sizes a reconstruction on.
    if (zoom > 1) {
      items.push(h('p', { class: 'readout__note' }, [
        `Fields of view above are at ${zoom}× and are correct either way. If this is a `
        + 'DIGITAL zoom, though, it crops and interpolates: the mm/px figure is what the '
        + 'output pixels imply, not detail the detector actually resolved.',
      ]));
    }

    this.root.append(sectionTitle('Coverage'));
    this.root.append(h('div', { class: 'readouts' }, items));
  }

  /**
   * Every lens of this camera's body, fitted where the camera stands: the trade
   * between field and detail, in the numbers Coverage uses. Read-only; the Lens
   * field is where one is chosen, and the frustum and preview follow it.
   */
  private renderLensComparison(cam: CameraObject, unit: LengthUnit): void {
    const rows = compareLenses(this.store.document, cam);
    if (rows.length === 0) return;
    const framed = rows.some((r) => r.framing !== null);
    const zoom = zoomOf(cam);
    const head = (text: string, title: string): HTMLElement => h('th', { scope: 'col', title }, [text]);

    this.root.append(sectionTitle('Lens comparison'));
    this.root.append(h('div', { class: 'readouts' }, [h('table', { class: 'lens-table' }, [
      h('thead', {}, [h('tr', {}, [
        head('Lens', 'Focal length. ▶ marks the lens on this camera'),
        head('FOV', `Horizontal × vertical field of view${zoom === 1 ? '' : ` at ${zoom}×`}`),
        head('mm/px', 'Resolution at the fire: millimetres per pixel at the slant standoff'),
        framed ? head('Plume', 'Share of the mean flame envelope in frame; ✓ when all of it is') : null,
      ])]),
      h('tbody', {}, rows.map((r) => {
        const whole = r.framing !== null && r.framing.fraction > 0.999;
        return h('tr', {
          class: `lens-table__row${r.current ? ' lens-table__row--current' : ''}`,
          'aria-current': r.current ? 'true' : undefined,
        }, [
          h('th', { scope: 'row' }, [r.current ? '▶ ' : '', lensName(r.focalLength_mm)]),
          h('td', {}, [`${r.hfovDeg.toFixed(1)}° × ${r.vfovDeg.toFixed(1)}°`]),
          h('td', {}, [r.mmPerPx.toFixed(2)]),
          framed
            ? h('td', { class: r.framing ? (whole ? 'lens-table__good' : 'lens-table__bad') : undefined }, [
              r.framing ? `${(r.framing.fraction * 100).toFixed(0)}% ${whole ? '✓' : '✗'}` : '—',
            ])
            : null,
        ]);
      })),
    ]),
    h('p', { class: 'readout__note' }, [
      `This camera as placed and aimed, ${formatLengthWithUnit(standoffM(cam), unit)} slant `
      + `standoff${zoom === 1 ? '' : `, at ${zoom}× zoom`}. mm/px is the detail at the fire; `
      + (framed
        ? 'Plume is how much of the mean flame envelope is in frame.'
        : 'framing needs a burner with a heat release rate.'),
    ])]));
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
      b.fire?.hrrCurve ? readout('Peak HRR (kW)', String(Number(hrrAt(b)!.toFixed(6)))) : row('HRR (kW)',
        numberField(b.fire?.hrr_kw ?? 0, (v) =>
          this.patch(b.id, 'Set HRR', (o) => {
            const burner = o as BurnerObject;
            burner.fire = { ...(burner.fire ?? {}), hrr_kw: v > 0 ? v : null };
          }), { step: 10, min: 0 })),
      row('Radiative fraction',
        numberField(radiativeFractionOf(b), (v) =>
          this.patch(b.id, 'Set radiative fraction', (o) => {
            const burner = o as BurnerObject;
            const f = Math.min(Math.max(v, 0.01), 1);
            const fire: NonNullable<BurnerObject['fire']> = { ...(burner.fire ?? {}) };
            // Same rule as camera zoom: the default is the absence of the field,
            // so a plan that leaves it alone still declares format 1.0.
            if (Math.abs(f - DEFAULT_RADIATIVE_FRACTION) < 1e-9) delete fire.radiativeFraction;
            else fire.radiativeFraction = f;
            burner.fire = fire;
          }), { step: 0.05, min: 0.01, max: 1 }),
        'Fraction radiated rather than convected — drives what a heat flux gauge reads. '
        + '≈0.35 heptane, 0.2 methanol. 0.3 is the default and is not written to the file'),
    );

    // The Curve control: Steady, t² growth, a pasted table or a test data series,
    // the readout with a sparkline, and Remove curve (ui/hrr-curve-editor.ts).
    this.root.append(...this.curveEditor.render(b));
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
        'Height of the opening plane above the hood\'s origin — the floor, unless the '
        + 'hood has been moved in Z. The readouts below are above the floor'),
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

    const sources = burners(this.store.document);
    // World space: the hood's own height plus wherever its transform puts it, which
    // is the plane the 3D view draws and the checks judge.
    const intake = hoodIntakeHeightM(hood);
    const items: HTMLElement[] = [readout('Intake plane above floor', formatLengthWithUnit(intake, unit))];

    for (const burner of sources) {
      if (sources.length > 1) items.push(readout('Burner', displayName(burner), 'muted'));
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
        items.push(readout('Flame tip clearance', off.inside ? formatLengthWithUnit(intake - tip, unit) : 'outside opening',
          off.inside ? (intake - tip > 0.2 * intake ? 'good' : 'bad') : 'muted'));
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

  // -- obstruction -------------------------------------------------------

  /**
   * A box. Format 1.2.
   *
   * The size fields are the extents, and the transform's Z is the height the base
   * stands at -- there is no separate base height, because unlike a wall's polyline
   * a box has an origin to put it in. The readout says where the top ends up, since
   * that is the number you are checking when you ask whether a camera sees over it.
   */
  private renderObstruction(box: ObstructionObject, unit: LengthUnit): void {
    this.root.append(sectionTitle('Obstruction'));

    const set = (index: number, metres: number): void =>
      this.patch(box.id, 'Resize obstruction', (o) => {
        const size = [...(o as ObstructionObject).size_m] as Vec3;
        size[index] = Math.max(0.01, metres);
        (o as ObstructionObject).size_m = size;
      });

    this.root.append(
      row(`Size (${unit})`,
        vecField(box.size_m, unit, ['X', 'Y', 'Z'], set),
        'Extents along the object\'s own axes. The origin is the centre of the base'),
    );

    const z = positionOf(box)[2];
    this.root.append(h('div', { class: 'readouts' }, [
      readout('Top of box', formatLengthWithUnit(z + box.size_m[2], unit)),
      readout('Footprint', `${(box.size_m[0] * box.size_m[1]).toFixed(2)} m²`),
    ]));
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
        'Underside above the slab\'s origin — the floor, unless the slab has been moved '
        + 'in Z. This is the surface a flame impinges on'),
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

    const sources = burners(this.store.document);
    // World space, as the checks and the drawing judge it.
    const soffit = ceilingSoffitZM(slab);
    const items: HTMLElement[] = [
      readout('Slab area', `${ceilingAreaM2(slab).toFixed(2)} m²`),
      readout('Soffit above floor', formatLengthWithUnit(soffit, unit)),
    ];
    for (const burner of sources) {
      if (sources.length > 1) items.push(readout('Burner', displayName(burner), 'muted'));
      const covered = ceilingCoversXY(slab, positionOf(burner)[0], positionOf(burner)[1]);
      items.push(readout('Covers the fire', covered ? 'yes' : 'no', 'muted'));
      const tip = flameTipZM(burner);
      if (tip !== null && covered) {
        const clearance = soffit - tip;
        items.push(readout('Flame tip clearance', formatLengthWithUnit(clearance, unit),
          clearance > 0.2 * soffit ? 'good' : 'bad'));
        items.push(h('p', { class: 'readout__note' }, [
          'Flame on a ceiling spreads as a ceiling jet, and the free-plume correlations ' +
          'used elsewhere here stop applying.',
        ]));
      }
    }
    this.root.append(sectionTitle('Clearance'));
    this.root.append(h('div', { class: 'readouts' }, items));
  }

  // -- heat flux sensor --------------------------------------------------

  private renderHeatFluxSensor(s: HeatFluxSensorObject, unit: LengthUnit): void {
    const gauge = s.gauge ?? {};
    const patchGauge = (label: string, fn: (g: NonNullable<HeatFluxSensorObject['gauge']>) => void) =>
      this.patch(s.id, label, (o) => {
        const sensor = o as HeatFluxSensorObject;
        sensor.gauge = { ...(sensor.gauge ?? {}) };
        fn(sensor.gauge);
      });

    this.renderAim(s, unit, 'No target set — this gauge was rotated by hand');

    this.root.append(sectionTitle('Gauge'));
    this.root.append(
      row('Kind',
        selectField(gauge.kind ?? 'schmidt-boelter', [
          { value: 'schmidt-boelter' as GaugeKind, label: 'Schmidt-Boelter' },
          { value: 'gardon' as GaugeKind, label: 'Gardon (foil)' },
          { value: 'thermopile' as GaugeKind, label: 'Thermopile' },
          { value: 'other' as GaugeKind, label: 'Other' },
        ], (v) => patchGauge('Set gauge kind', (g) => { g.kind = v; })),
        'Recorded for the equipment list; it does not change the predicted flux'),
      row('Range (kW/m²)',
        numberField(gaugeRangeKwM2(s) ?? 0, (v) =>
          patchGauge('Set gauge range', (g) => { g.range_kw_m2 = v > 0 ? v : null; }),
          { step: 5, min: 0 }),
        'Full scale. Zero means unrecorded, and the over-range check goes quiet'),
      row('View angle (°)',
        numberField(gaugeViewAngleDeg(s), (v) =>
          patchGauge('Set view angle', (g) => {
            g.viewAngle_deg = Math.min(Math.max(v, 1), 180);
          }), { step: 5, min: 1, max: 180 }),
        'Full acceptance angle. 180° is an open hemisphere; less means a view tube'),
      row('Water-cooled',
        checkboxField(gauge.waterCooled === true, (v) =>
          patchGauge('Toggle cooling', (g) => { g.waterCooled = v; }))),
      row('Serial',
        textField(gauge.serial ?? '', (v) =>
          patchGauge('Set serial', (g) => { g.serial = v || null; })),
        'Which physical gauge this is, for the calibration record'),
    );

    this.renderHeatFluxExposure(s, unit);
  }

  /** What this gauge will read, and whether that is a usable measurement. */
  private renderHeatFluxExposure(s: HeatFluxSensorObject, unit: LengthUnit): void {
    const doc = this.store.document;
    const estimate = heatFluxEstimate(doc, s);
    const items: HTMLElement[] = [];

    if (!estimate) {
      items.push(
        readout('Predicted incident flux', 'needs a burner with an HRR', 'muted'),
        h('p', { class: 'readout__note' }, [
          'The point-source model needs a heat release rate to radiate. Set one on the '
          + 'fuel pan and this fills in.',
        ]),
      );
    } else {
      const sources = fireBurners(doc);
      const burner = sources.find((b) => b.id === estimate.sourceId);
      const range = gaugeRangeKwM2(s);

      const verdict = gaugeVerdict(doc, s);
      if (burner) items.push(readout('Geometry relative to', displayName(burner), 'muted'));
      items.push(
        // The same call the report's exposure table and the Checks list use, so a
        // green readout here can no longer contradict a warning printed there.
        readout('Verdict', verdict ? verdict.label : '—',
          verdict ? TONE[verdict.status] : undefined),
        readout('Distance to mid-flame', formatLengthWithUnit(estimate.distanceM, unit)),
        // A gauge turned away from the fire is an error; a view tube that misses it
        // is a warning. `instrumentChecks` has always said so, and one tone for both
        // was the same disagreement the Verdict line above exists to end.
        readout('Off the gauge axis', `${estimate.offAxisDeg.toFixed(0)}°`,
          !estimate.facesFire ? 'bad' : estimate.withinViewAngle ? 'good' : 'warn'),
        readout(sources.length > 1 ? 'Total incident flux' : 'Predicted incident flux',
          Number.isFinite(estimate.incidentKwM2)
            ? `${estimate.incidentKwM2.toFixed(2)} kW/m²`
            : 'inside the fire',
          estimate.facesFire ? undefined : 'bad'),
        readout('Line of sight', `${(estimate.visibleFraction * 100).toFixed(0)}%`,
          estimate.visibleFraction === 1 ? 'good' : estimate.visibleFraction === 0 ? 'bad' : 'warn'),
      );

      if (range !== null && estimate.fractionOfRange !== null) {
        const frac = estimate.fractionOfRange;
        // Over range is an error -- the reading is lost. Low signal is a warning:
        // the gauge still reads, just badly. Same split as the checks list.
        items.push(readout('Fraction of range',
          Number.isFinite(frac) ? `${(frac * 100).toFixed(1)}% of ${range} kW/m²` : 'over range',
          frac > 1 ? 'bad' : frac < LOW_SIGNAL_FRACTION ? 'warn' : 'good'));
      }

      for (const source of sources) {
        items.push(readout(sources.length > 1 ? `Radiative fraction: ${displayName(source)}` : 'Radiative fraction used',
          radiativeFractionOf(source).toFixed(2), 'muted'));
      }

      items.push(h('p', { class: 'readout__note' }, [
        'Point source at mid-flame height: q″ = χ_r·Q̇·cos θ / (4πr²). A first-order '
        + 'estimate for sizing and placement, scaled by line of sight to nine flame '
        + 'centreline samples. Flux sums all fires; distance '
        + 'and angle refer to the source contributing most.'
        + (sources.length > 1 ? ' Line of sight is weighted by each fire’s unshadowed flux.' : ''),
      ]));

      if (estimate.nearField && burner) {
        items.push(h('p', { class: 'readout__note' }, [
          `At ${formatLengthWithUnit(estimate.distanceM, unit)} from a `
          + `${formatLengthWithUnit(burnerDiameterM(burner), unit)} fire this is inside `
          + `${POINT_SOURCE_MIN_DIAMETERS} diameters, where the fire is plainly not a point. `
          + 'Treat the figure above as an order of magnitude.',
        ]));
      }
    }

    this.root.append(sectionTitle('Exposure'));
    this.root.append(h('div', { class: 'readouts' }, items));
  }

  // -- thermocouple ------------------------------------------------------

  private renderThermocouple(t: ThermocoupleObject, unit: LengthUnit): void {
    const tc = t.thermocouple ?? {};
    const patchTc = (label: string, fn: (x: NonNullable<ThermocoupleObject['thermocouple']>) => void) =>
      this.patch(t.id, label, (o) => {
        const obj = o as ThermocoupleObject;
        obj.thermocouple = { ...(obj.thermocouple ?? {}) };
        fn(obj.thermocouple);
      });

    const type = tcTypeOf(t);
    // Not "Thermocouple": that is already the panel heading, and a section that
    // repeats its parent tells the reader nothing about what is in it.
    this.root.append(sectionTitle('Wire and limits'));
    this.root.append(
      row('Type',
        selectField(type,
          (Object.keys(TC_MAX_TEMPERATURE_C) as TcType[]).map((k) => ({
            value: k, label: `Type ${k} — to ${TC_MAX_TEMPERATURE_C[k]} °C`,
          })),
          (v) => patchTc('Set thermocouple type', (x) => { x.tcType = v; })),
        'Sets the default upper limit, which is what the over-temperature check uses'),
      row('Bead ⌀ (mm)',
        numberField(tc.beadDiameter_mm ?? 1.5, (v) =>
          patchTc('Set bead diameter', (x) => { x.beadDiameter_mm = v > 0 ? v : null; }),
          { step: 0.5, min: 0 }),
        'Recorded, not corrected for: a bigger bead lags more and radiates more'),
      row('Sheathed',
        checkboxField(tc.sheathed === true, (v) =>
          patchTc('Toggle sheath', (x) => { x.sheathed = v; }))),
      row('Max temperature (°C)',
        numberField(tcMaxTemperatureC(t), (v) =>
          patchTc('Set max temperature', (x) => { x.maxTemperature_C = v; }),
          { step: 50, min: 0 }),
        `Blank in the file means the type ${type} standard limit, ${TC_MAX_TEMPERATURE_C[type]} °C`),
      h('div', { class: 'panel__actions' }, [
        button(`Use type ${type} default`, () =>
          patchTc('Clear max temperature', (x) => { x.maxTemperature_C = null; })),
      ]),
    );

    this.renderBeads(t, unit);
  }

  /** The rake itself. One bead or twelve is the same list, so it is the same UI as
   *  a wall's point list rather than a second way of editing a series of numbers. */
  private renderBeads(t: ThermocoupleObject, unit: LengthUnit): void {
    const offsets = beadOffsetsOf(t);

    this.root.append(sectionTitle(offsets.length === 1 ? 'Bead' : `Beads (${offsets.length})`));
    offsets.forEach((offset, i) => {
      this.root.append(row(`Bead ${i + 1} (${unit})`,
        lengthField(offset, unit, (m) =>
          this.patch(t.id, 'Move bead', (o) => {
            const next = [...beadOffsetsOf(o as ThermocoupleObject)];
            next[i] = m;
            (o as ThermocoupleObject).beadOffsets_m = next;
          })),
        i === 0 ? 'Height above the object origin, along the rake' : undefined));
    });

    const actions: HTMLElement[] = [
      button('Add bead', () => this.patch(t.id, 'Add bead', (o) => {
        const next = [...beadOffsetsOf(o as ThermocoupleObject)];
        (o as ThermocoupleObject).beadOffsets_m = [...next, next[next.length - 1] + 0.3];
      })),
    ];
    if (offsets.length > 1) {
      actions.push(button('Remove last', () => this.patch(t.id, 'Remove bead', (o) => {
        (o as ThermocoupleObject).beadOffsets_m = beadOffsetsOf(o as ThermocoupleObject).slice(0, -1);
      })));
    }
    this.root.append(h('div', { class: 'panel__actions' }, actions));

    this.renderBeadPredictions(t, unit);
  }

  private renderBeadPredictions(t: ThermocoupleObject, unit: LengthUnit): void {
    const doc = this.store.document;
    const sources = fireBurners(doc);
    const beads = thermocoupleBeads(doc, t);
    const limit = tcMaxTemperatureC(t);
    const items: HTMLElement[] = [];

    if (sources.length === 0) {
      items.push(readout('Fire region', 'needs a burner with an HRR', 'muted'));
    } else {
      for (const bead of beads) {
        // `beadVerdict`, not "is there a plume temperature": a bead inside the
        // flame envelope has no plume temperature by design, so the old test fell
        // through to green for exactly the placement Checks calls an error.
        const verdict = beadVerdict(bead, limit);
        const temp = bead.gasTemperatureC === null
          ? ''
          : `, ${bead.gasTemperatureC.toFixed(0)} °C`;
        items.push(readout(
          `Bead ${bead.index + 1} at ${formatLengthWithUnit(bead.world[2], unit)}`,
          `${verdict.label}${temp}`,
          TONE[verdict.status],
        ));
      }

      for (const burner of sources) {
        const label = burners(doc).length > 1 ? `Mean flame tip: ${displayName(burner)}` : 'Mean flame tip';
        items.push(readout(label, formatLengthWithUnit(flameTipZM(burner)!, unit), 'muted'));
      }

      items.push(h('p', { class: 'readout__note' }, [
        'Temperatures are the Heskestad PLUME CENTRELINE, quoted only for beads above the '
        + 'mean flame tip and inside the envelope — the correlation says nothing about the '
        + 'flame itself, and a bead off the axis reads lower than the figure shown.',
      ]));
    }

    this.root.append(sectionTitle('Predicted'));
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
