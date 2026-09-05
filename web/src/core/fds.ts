/**
 * Convert an FDS input file into a fire test plan. Mirror of python/fireplan/fds.py.
 *
 * An FDS input describes a simulation; a fire test plan describes what will be built
 * and where the instruments go. The overlap is real but partial, and this module is
 * deliberately about the overlap only: geometry, the fire, and the devices that
 * correspond to instruments someone has to physically mount. Materials, reaction
 * chemistry, meshes, slice files and output control have no counterpart here and are
 * reported as skipped rather than smuggled into the plan.
 *
 * Three things are worth knowing before reading further.
 *
 * **The origin moves.** This format's origin is the burner centre at floor level
 * (CONVENTIONS section 1); an FDS file's origin is wherever the author put it. So an
 * import always translates, and records the translation in
 * `meta.source.originOffset_m` -- the position of the plan origin in the source
 * file's coordinates -- so a reader can put a number back into the frame the `.fds`
 * file uses and compare. That offset is what the inspector's FDS view is built on.
 *
 * **Nothing is guessed that the file does not say.** `RADIATIVE_FRACTION` is
 * imported only when `&REAC` states it, never defaulted to FDS's own default,
 * because a wrong radiative fraction silently changes every predicted heat flux in
 * the plan. The same goes for a gauge's range, which FDS has no concept of: it is
 * left null, and the gauge checks say so, rather than inventing 50 kW/m².
 *
 * **Everything not imported is reported.** The result carries an issue list covering
 * the records the mapping dropped and the judgements it had to make: which
 * heat-release surface was taken to be the burner, which `&HOLE` cut nothing, which
 * `&DEVC` quantity has no counterpart. Per-object classification -- this box became
 * a wall, that one a ceiling -- is reported as counts in the import preview rather
 * than one issue per object, because a model with two hundred obstructions would
 * bury everything else. An import that quietly loses half a model is worse than one
 * that refuses, so this one neither loses nor refuses: it converts and then says
 * what it did.
 */

import { lookAtQuat } from './math';
import { newPlan } from './plan';
import { validateStructure } from './validate';
import {
  readNamelist,
  type NamelistRecord,
} from './namelist';
import { requiredFormatVersion } from './types';
import type {
  BurnerObject,
  CeilingObject,
  HeatFluxSensorObject,
  Issue,
  ObstructionObject,
  PlanDocument,
  PlanObject,
  ThermocoupleObject,
  Vec3,
  WallOpening,
  WallObject,
} from './types';

/** `[x0, x1, y0, y1, z0, z1]`, FDS's own bounding-box ordering. */
export type Xb = [number, number, number, number, number, number];

// -- tunables -------------------------------------------------------------

/**
 * A box is a horizontal slab when its height is at most this fraction of its
 * smaller plan dimension, and a wall when its thin plan dimension is at most this
 * fraction of both its length and its height. Anything else is a solid block.
 *
 * 0.5 is loose on purpose: a 0.1 m wall 2.6 m long and a 0.15 m slab 3 m across
 * both clear it by a wide margin, while a 2.0 × 0.9 × 0.8 m couch fails it as a
 * wall (0.9 is not ≤ 0.4) and becomes the obstruction it is.
 */
export const SLAB_ASPECT = 0.5;
export const WALL_ASPECT = 0.5;

/** Coordinates closer than this are the same coordinate. FDS input is written to a
 *  few decimals by hand or by a mesh generator; 0.1 mm is finer than either. */
export const TOL_M = 1e-4;

/**
 * What a zero-thickness `&OBST` is drawn as.
 *
 * FDS allows an obstruction with no thickness -- glazing, a thin partition, a shelf
 * -- and real models are full of them. This format has no planar object, and a box
 * with a zero extent is one the editor refuses to open, so the plate is given a
 * nominal thickness and the import says so. 10 mm reads as a plate and can still be
 * picked in the viewport.
 */
export const THIN_M = 0.01;

/** A burner standing more than this above the detected floor is worth mentioning. */
const BURNER_PLATFORM_TOL_M = 0.05;

/** Quantities that correspond to an instrument someone has to mount. A DEVC is not
 *  automatically an instrument -- an FDS model is full of numerical probes -- so the
 *  mapping is an allow-list, and anything outside it is reported, not imported. */
export const GAUGE_QUANTITIES = [
  'GAUGE HEAT FLUX', 'INCIDENT HEAT FLUX', 'RADIATIVE HEAT FLUX',
  'CONVECTIVE HEAT FLUX', 'NET HEAT FLUX', 'HEAT FLUX',
  'RADIOMETER', 'RADIATIVE HEAT FLUX GAS',
];
export const GAS_TC_QUANTITIES = ['THERMOCOUPLE', 'TEMPERATURE'];
export const SURFACE_TC_QUANTITIES = [
  'WALL TEMPERATURE', 'INSIDE WALL TEMPERATURE', 'BACK WALL TEMPERATURE',
  'ADIABATIC SURFACE TEMPERATURE',
];

export type DeviceKind = 'heatFluxSensor' | 'thermocouple';

export function defaultDeviceMap(): Map<string, DeviceKind | null> {
  const out = new Map<string, DeviceKind | null>();
  for (const q of GAUGE_QUANTITIES) out.set(q, 'heatFluxSensor');
  for (const q of [...GAS_TC_QUANTITIES, ...SURFACE_TC_QUANTITIES]) out.set(q, 'thermocouple');
  return out;
}

/** FDS's named colours, restricted to the ones that actually turn up in inputs. */
const FDS_COLORS: Record<string, string | null> = {
  RED: '#ff0000', GREEN: '#008000', BLUE: '#0000ff', YELLOW: '#ffff00',
  CYAN: '#00ffff', MAGENTA: '#ff00ff', WHITE: '#ffffff', BLACK: '#000000',
  GRAY: '#808080', GREY: '#808080', SILVER: '#c0c0c0', ORANGE: '#ffa500',
  PURPLE: '#800080', BROWN: '#a52a2a', PINK: '#ffc0cb', GOLD: '#ffd700',
  BEIGE: '#f5f5dc', TAN: '#d2b48c', NAVY: '#000080', TEAL: '#008080',
  OLIVE: '#808000', MAROON: '#800000', INVISIBLE: null,
};

/** The record groups a single pasted record can become. Both converters check the
 *  group before the fields: `&MESH`, `&INIT` and `&SLCF` all carry an `XB`, and
 *  `&SLCF` carries a `QUANTITY` and an `XYZ` as well. `&VENT` is deliberately not
 *  here: a vent is a boundary condition on the face of a solid, not a solid, and the
 *  full import never turns one into geometry either -- it only ever reads one as a
 *  fire. Pasting one used to produce a box with a zero extent that the editor then
 *  refused to reopen. */
const GEOMETRY_GROUPS = ['OBST'];
const DEVICE_GROUP = 'DEVC';

/** The six faces of an FDS box, in `SURF_ID6` order. */
const FACES = ['-x', '+x', '-y', '+y', '-z', '+z'] as const;

/** `IOR` is the direction the mounting surface faces, which is exactly the outward
 *  normal a heat flux gauge in this format stores. */
const IOR_NORMAL: Record<string, Vec3> = {
  '1': [1, 0, 0], '-1': [-1, 0, 0],
  '2': [0, 1, 0], '-2': [0, -1, 0],
  '3': [0, 0, 1], '-3': [0, 0, -1],
};

// -- results --------------------------------------------------------------

/** One `&DEVC` quantity found in the file, and what it was turned into. The import
 *  preview lists these so the choice is visible before anything is created. */
export interface DeviceGroup {
  quantity: string | null;
  count: number;
  mappedTo: DeviceKind | null;
  objects: number;
  note: string;
}

export interface FdsImportResult {
  doc: PlanDocument;
  issues: Issue[];
  devices: DeviceGroup[];
  /** Position of the plan origin in the source file's coordinates. */
  originM: Vec3;
  burnerSurf: string | null;
  burnerCandidates: string[];
  sourceFile: string | null;
  counts: Record<string, number>;
}

export interface FdsImportOptions {
  /** Plan origin in FDS coordinates. Undefined means detect it. */
  originM?: Vec3;
  /** Floor level in FDS coordinates. Undefined means detect it. */
  floorZM?: number;
  /** `SURF` id to treat as the burner. Undefined means the most compact horizontal
   *  heat-release surface, which is the ignition source in every input that also
   *  has a burning lining. */
  burnerSurf?: string;
  /** Collapse a vertical run of same-quantity devices into one rake object. */
  groupRakes?: boolean;
  /** Quantity → plan type, overriding the built-in allow-list. */
  deviceMap?: Map<string, DeviceKind | null>;
  geometry?: boolean;
  devices?: boolean;
  /** Fixed `meta.source.importedAt`, so two imports of one file compare equal. */
  importedAt?: string;
  /** Whether `&CATF` includes were already spliced into `text`. The desktop shell
   *  can read the files beside the input and does; a browser tab handed one file's
   *  bytes cannot, and the import says so rather than quietly importing a fraction
   *  of the model. */
  includesResolved?: boolean;
  /** What splicing the includes had to report -- a file that was not there, a
   *  child that ended in `&TAIL`, a file read twice. Prepended to the import's own
   *  issues, exactly as `fireplan.fds.load` prepends its reader's. */
  includeIssues?: Issue[];
}

export class FdsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FdsError';
  }
}

// -- small helpers --------------------------------------------------------

const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

const extent = (xb: Xb): Vec3 => [xb[1] - xb[0], xb[3] - xb[2], xb[5] - xb[4]];
const centre = (xb: Xb): Vec3 => [(xb[0] + xb[1]) / 2, (xb[2] + xb[3]) / 2, (xb[4] + xb[5]) / 2];

/** `XB` with each pair in ascending order. FDS accepts either order and normalises
 *  internally, and hand-edited files do write `XB=2.5,-0.1,...`; every extent would
 *  otherwise come out negative. */
function sortedXb(values: number[]): Xb {
  return [
    Math.min(values[0], values[1]), Math.max(values[0], values[1]),
    Math.min(values[2], values[3]), Math.max(values[2], values[3]),
    Math.min(values[4], values[5]), Math.max(values[4], values[5]),
  ];
}

const sameXb = (a: Xb, b: Xb): boolean => a.every((v, i) => v === b[i]);

/** This record's `XB`, sorted -- or null if it does not have six numbers. The count
 *  is checked before anything indexes the list, so a half-finished hand edit is a
 *  skipped record rather than an exception from inside the importer. */
function xbOfRecord(rec: NamelistRecord): Xb | null {
  const raw = rec.numbers('XB');
  return raw.length === 6 ? sortedXb(raw) : null;
}

function colorOf(rec: NamelistRecord): string | null {
  const name = rec.string('COLOR');
  if (name) return FDS_COLORS[name.trim().toUpperCase()] ?? null;
  const rgb = rec.numbers('RGB');
  if (rgb.length >= 3) {
    return `#${rgb.slice(0, 3)
      .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0'))
      .join('')}`;
  }
  return null;
}

/** The `SURF_ID` of each of the six faces, in `FACES` order. */
function faceSurfs(rec: NamelistRecord): Array<string | null> {
  const six = rec.strings('SURF_ID6');
  if (six.length > 0) return [...six, null, null, null, null, null, null].slice(0, 6);
  const one = rec.string('SURF_ID');
  return one ? [one, one, one, one, one, one] : [null, null, null, null, null, null];
}

const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Unique, readable object ids -- an FDS `ID` where there is one, else a counter. */
class Ids {
  private used = new Map<string, number>();

  make(prefix: string, name?: string | null): string {
    const base = name ? `${prefix}-${slug(name)}` : prefix;
    const n = this.used.get(base) ?? 0;
    this.used.set(base, n + 1);
    if (n === 0 && name) return base;
    return `${base}-${n + 1}`;
  }
}

const issue = (severity: Issue['severity'], code: string, message: string): Issue =>
  ({ severity, code, message });

// -- the model, one step above raw records --------------------------------

interface Box {
  xb: Xb;
  rec: NamelistRecord;
  surfs: Array<string | null>;
  name: string | null;
}

function multipliers(records: NamelistRecord[]): Map<string, NamelistRecord> {
  const out = new Map<string, NamelistRecord>();
  for (const rec of records) {
    if (rec.group !== 'MULT') continue;
    const id = rec.string('ID');
    if (id) out.set(id, rec);
  }
  return out;
}

/**
 * Whether this replicate falls in the block `&MULT` was told to leave out.
 *
 * `I_LOWER_SKIP`..`K_UPPER_SKIP` (and `N_LOWER_SKIP`/`N_UPPER_SKIP`) carve a hole
 * out of the array -- a courtyard in a block of flats, the gap a stair core
 * occupies. An expander that ignores them builds geometry the model does not have,
 * right where the model deliberately has none. An axis with no bounds stated
 * constrains nothing, and a `&MULT` with no skip fields at all skips nothing.
 */
function skippedByMult(mult: NamelistRecord, axes: Array<[string, number]>): boolean {
  let stated = false;
  for (const [name, index] of axes) {
    const lo = mult.number(`${name}_LOWER_SKIP`);
    const hi = mult.number(`${name}_UPPER_SKIP`);
    if (lo === null && hi === null) continue;
    stated = true;
    const low = Math.trunc(lo ?? hi!);
    const high = Math.trunc(hi ?? lo!);
    if (index < Math.min(low, high) || index > Math.max(low, high)) return false;
  }
  return stated;
}

/**
 * Every copy `&MULT` asks for, including the original.
 *
 * Supports the two forms that appear in real inputs: a `DX`/`DY`/`DZ` step over
 * `I`/`J`/`K` index ranges, and a `DXB` delta over `N_LOWER`..`N_UPPER`. An
 * unexpanded `MULT_ID` would drop most of a repetitive facade, so this is not
 * optional decoration.
 */
function expandMult(xb: Xb, mult: NamelistRecord | undefined): Xb[] {
  if (!mult) return [[...xb] as Xb];

  const range = (lo: string, hi: string): number[] => {
    const a = Math.trunc(mult.number(lo) ?? 0);
    const b = Math.trunc(mult.number(hi) ?? 0);
    const out: number[] = [];
    for (let v = Math.min(a, b); v <= Math.max(a, b); v += 1) out.push(v);
    return out;
  };

  const dx0 = mult.number('DX0') ?? 0;
  const dy0 = mult.number('DY0') ?? 0;
  const dz0 = mult.number('DZ0') ?? 0;

  const dxb = mult.numbers('DXB');
  if (dxb.length === 6 && (mult.has('N_LOWER') || mult.has('N_UPPER'))) {
    return range('N_LOWER', 'N_UPPER')
      .filter((n) => !skippedByMult(mult, [['N', n]]))
      .map((n) => xb.map((v, k) => v + n * dxb[k]) as Xb);
  }

  const dx = mult.number('DX') ?? 0;
  const dy = mult.number('DY') ?? 0;
  const dz = mult.number('DZ') ?? 0;
  const out: Xb[] = [];
  for (const i of range('I_LOWER', 'I_UPPER')) {
    for (const j of range('J_LOWER', 'J_UPPER')) {
      for (const k of range('K_LOWER', 'K_UPPER')) {
        if (skippedByMult(mult, [['I', i], ['J', j], ['K', k]])) continue;
        const sx = dx0 + i * dx;
        const sy = dy0 + j * dy;
        const sz = dz0 + k * dz;
        out.push([xb[0] + sx, xb[1] + sx, xb[2] + sy, xb[3] + sy, xb[4] + sz, xb[5] + sz]);
      }
    }
  }
  return out;
}

function boxesOf(
  records: NamelistRecord[], group: string, mults: Map<string, NamelistRecord>,
): Box[] {
  const out: Box[] = [];
  for (const rec of records) {
    if (rec.group !== group) continue;
    const xb = xbOfRecord(rec);
    if (xb === null) continue;
    const mult = mults.get(rec.string('MULT_ID') ?? '');
    for (const copy of expandMult(xb, mult)) {
      out.push({ xb: sortedXb(copy), rec, surfs: faceSurfs(rec), name: rec.string('ID') });
    }
  }
  return out;
}

/**
 * Every `&MESH` box, `&MULT` expanded.
 *
 * The domain is what the origin falls back to when nothing in the file burns, so a
 * `MULT_ID` on a mesh that this reader ignored would shift every coordinate in the
 * plan by whatever the multiplied domain does not cover.
 */
function meshBoxes(records: NamelistRecord[], mults: Map<string, NamelistRecord>): Xb[] {
  const out: Xb[] = [];
  for (const rec of records) {
    if (rec.group !== 'MESH') continue;
    const xb = xbOfRecord(rec);
    if (xb === null) continue;
    const mult = mults.get(rec.string('MULT_ID') ?? '');
    for (const copy of expandMult(xb, mult)) out.push(sortedXb(copy));
  }
  return out;
}

// -- the fire -------------------------------------------------------------

interface FireFace {
  surf: string;
  xb: Xb;
  areaM2: number;
  hrrKw: number | null;
  face: string;
  horizontal: boolean;
  fromVent: boolean;
}

/**
 * The largest `F` each `&RAMP` reaches.
 *
 * `HRRPUA` is the value at `F = 1`, so the peak heat release of a ramped fire is
 * `HRRPUA × area × max(F)`. A ramp that never reaches 1 -- a growth curve cut short,
 * which is the usual shape -- would otherwise be read as a fire larger than the
 * input ever produces.
 */
function peakRamps(records: NamelistRecord[]): Map<string, number> {
  const peaks = new Map<string, number>();
  for (const rec of records) {
    if (rec.group !== 'RAMP') continue;
    const id = rec.string('ID');
    const f = rec.number('F');
    if (id !== null && f !== null) peaks.set(id, Math.max(peaks.get(id) ?? 0, f));
  }
  return peaks;
}

/**
 * Whether this `&SURF` names a heat release rate at all.
 *
 * Deliberately blind to ramps: this answers "is this a fire surface", which is what
 * decides whether a vent is a boundary condition or a burner, not "how big is the
 * fire", which is `fireFaces`'s question.
 */
function statesHeat(rec: NamelistRecord | undefined): boolean {
  return rec !== undefined && Boolean(rec.number('HRRPUA') || rec.number('MLRPUA'));
}

/**
 * Which way a `&VENT` faces: `'+z'`, `'-z'`, `'+x'` and so on, or null when the
 * box is not a plane at all.
 *
 * A vent is a face on a solid, and FDS decides its orientation from which side the
 * solid is on -- or from an explicit `IOR`, whose sign is the direction of the
 * surface normal. This reader has no solver, so it does the same by inspection:
 * `IOR` when stated; otherwise the obstruction the vent lies on (a vent on a box's
 * top face burns upward, one on its underside burns downward); otherwise the mesh
 * boundary (the domain floor faces up, the domain ceiling faces down). Reading
 * every horizontal vent as upward turned a fire on the underside of a ceiling into
 * an upward-burning pan three metres high.
 */
function ventOrientation(xb: Xb, rec: NamelistRecord, obsts: Box[], domain: Xb | null): string | null {
  const [dx, dy, dz] = extent(xb);
  let axis: 'x' | 'y' | 'z';
  if (dz <= TOL_M) axis = 'z';
  else if (dy <= TOL_M) axis = 'y';
  else if (dx <= TOL_M) axis = 'x';
  else return null;

  const ior = rec.number('IOR');
  if (ior !== null && Math.trunc(ior) !== 0) return `${ior > 0 ? '+' : '-'}${axis}`;

  const lo = axis === 'x' ? 0 : axis === 'y' ? 2 : 4;
  const plane = xb[lo];
  // The vent has to lie within the face it sits on, in the two in-plane axes.
  const inPlane = [0, 2, 4].filter((i) => i !== lo);
  const within = (box: Xb): boolean => inPlane.every(
    (i) => xb[i] >= box[i] - TOL_M && xb[i + 1] <= box[i + 1] + TOL_M,
  );
  let onHighFace = false;
  let onLowFace = false;
  for (const box of obsts) {
    if (!within(box.xb)) continue;
    if (Math.abs(plane - box.xb[lo + 1]) <= TOL_M) onHighFace = true;
    if (Math.abs(plane - box.xb[lo]) <= TOL_M) onLowFace = true;
  }
  if (onHighFace && !onLowFace) return `+${axis}`;
  if (onLowFace && !onHighFace) return `-${axis}`;
  if (domain !== null) {
    if (Math.abs(plane - domain[lo]) <= TOL_M) return `+${axis}`;
    if (Math.abs(plane - domain[lo + 1]) <= TOL_M) return `-${axis}`;
  }
  // Nothing establishes it -- a vent floating in the domain, which FDS itself would
  // reject -- so the positive side stands, as it always has.
  return `+${axis}`;
}

function fireFaces(
  boxes: Box[], vents: Box[], surfs: Map<string, NamelistRecord>,
  peaks: Map<string, number>, heatOfCombustion: number | null, issues: Issue[],
  domain: Xb | null = null,
): FireFace[] {
  const off: string[] = [];
  const released = (surfId: string | null): number | null => {
    const rec = surfId === null ? undefined : surfs.get(surfId);
    if (!rec) return null;
    // Membership, not `peak || 1`: a ramp whose peak really is zero is a surface
    // the input switches off, and reading that as "no ramp, so full power" turns a
    // cold burner into the largest fire in the file.
    const ramp = rec.string('RAMP_Q') ?? '';
    const peak = peaks.has(ramp) ? peaks.get(ramp)! : 1;
    if (peak <= 0) {
      if (surfId !== null && !off.includes(surfId)) off.push(surfId);
      return null;
    }
    const hrrpua = rec.number('HRRPUA');
    if (hrrpua) return hrrpua * peak;
    const mlrpua = rec.number('MLRPUA');
    const hoc = rec.number('HEAT_OF_COMBUSTION') ?? heatOfCombustion;
    // kg/m²/s × kJ/kg = kW/m²
    if (mlrpua && hoc) return mlrpua * hoc * peak;
    return null;
  };

  const out: FireFace[] = [];
  const pairs: Array<[Box, boolean]> = [
    ...boxes.map((b) => [b, false] as [Box, boolean]),
    ...vents.map((v) => [v, true] as [Box, boolean]),
  ];
  for (const [box, fromVent] of pairs) {
    const [dx, dy, dz] = extent(box.xb);
    box.surfs.forEach((surfId, index) => {
      const perArea = released(surfId);
      if (perArea === null) return;
      let face: string = FACES[index];
      let area = face === '-x' || face === '+x' ? dy * dz
        : face === '-y' || face === '+y' ? dx * dz
          : dx * dy;
      // A vent is a plane: whichever extent is degenerate names its axis, the solid
      // it sits on (or its IOR) names the side, and the other two extents give its
      // area, whatever SURF_ID6 slot it arrived in.
      if (fromVent) {
        const oriented = ventOrientation(box.xb, box.rec, boxes, domain);
        if (oriented !== null) {
          face = oriented;
          const axis = oriented[1];
          area = axis === 'z' ? dx * dy : axis === 'y' ? dx * dz : dy * dz;
        }
      }
      out.push({
        surf: String(surfId), xb: box.xb, areaM2: area,
        hrrKw: area > 0 ? perArea * area : null,
        face, horizontal: face === '-z' || face === '+z', fromVent,
      });
    });
  }
  if (off.length > 0) {
    issues.push(issue('warning', 'fds-surface-off',
      `${off.map((x) => `'${x}'`).join(', ')} release${off.length === 1 ? 's' : ''} no heat `
      + 'in this input: the &RAMP on RAMP_Q never leaves zero, so the surface is switched '
      + 'off. It was not imported as a fire.'));
  }
  return out;
}

/**
 * Whether this heat-release face can be *the* burner of a plan.
 *
 * A burner here is a floor-standing source: a footprint in plan, a rim height
 * measured up from the floor, and a fuel surface on top. Three kinds of burning face
 * are not that, and each one produces nonsense if it is forced to be:
 *
 * - **A vertical face** -- a wall lining -- has no plan footprint at all. Its
 *   `size_m` comes out `[w, 0]`, which this editor's own load boundary rejects.
 * - **A downward-facing face** -- a ceiling soffit, which is where a lining fire in
 *   a compartment test usually is -- has a footprint, and that is what makes it
 *   dangerous: `rimHeight_m` becomes the height of the ceiling, so the burner is a
 *   solid box the size of the room reaching from the floor to the soffit. It fills
 *   the room, hides everything inside it, and z-fights with every wall it shares a
 *   face with.
 * - **A degenerate horizontal face** has an area but no thickness in plan.
 *
 * All three are reported as burning surfaces instead, which is what they are.
 */
function canBeBurner(face: FireFace): boolean {
  const [dx, dy] = extent(face.xb);
  return face.face === '+z' && dx > TOL_M && dy > TOL_M;
}

/**
 * The heat-release face to treat as the plan's burner.
 *
 * Horizontal only, then smallest: a burning wall lining is not a burner -- and
 * cannot be one here, having no plan footprint (`canBeBurner`) -- and when a model
 * has both an ignition source and a spreading fire the ignition source is the
 * compact one. The caller can name a `SURF` instead, and the import preview lists
 * every candidate so the choice is visible rather than implicit.
 */
function pickBurner(faces: FireFace[], wanted: string | undefined): FireFace | null {
  const usable = faces.filter(canBeBurner);
  if (usable.length === 0) return null;
  const smallest = (pool: FireFace[]): FireFace =>
    pool.reduce((best, f) => (f.areaM2 < best.areaM2 ? f : best));
  if (wanted) {
    const named = usable.filter((f) => f.surf === wanted);
    if (named.length > 0) return smallest(named);
  }
  return smallest(usable);
}

/**
 * Every face that becomes a burner object: the picked one, then its siblings.
 *
 * One `&SURF` is routinely applied to several `&VENT`s -- two burners in a room, a
 * row of sand-box fires -- and taking only the first would drop a fire source from
 * the plan while reporting the conversion as complete. Format 1.2 holds several
 * burners and calls the one at the origin the primary (CONVENTIONS section 1),
 * which is exactly this: the picked face defines the frame, and its siblings are
 * objects standing where the file puts them.
 *
 * Only the picked surface's own faces. A second heat-release *surface* is a
 * different judgement -- the sample input's burning wall lining is not a second
 * burner -- and that one stays a reported choice rather than a silent import.
 */
function burnerFaces(faces: FireFace[], picked: FireFace | null): FireFace[] {
  if (picked === null) return [];
  const out = [picked];
  for (const face of faces) {
    if (face.surf !== picked.surf || !canBeBurner(face)) continue;
    if (out.some((other) => sameXb(face.xb, other.xb))) continue;
    out.push(face);
  }
  return out;
}

// -- geometry classification ----------------------------------------------

export function isSlabBox(xb: Xb): boolean {
  const [dx, dy, dz] = extent(xb);
  return dz <= SLAB_ASPECT * Math.min(dx, dy) && Math.min(dx, dy) > TOL_M;
}

export function isWallBox(xb: Xb): boolean {
  const [dx, dy, dz] = extent(xb);
  const thin = Math.min(dx, dy);
  return thin <= WALL_ASPECT * Math.max(dx, dy) && thin <= WALL_ASPECT * dz;
}

/**
 * Floor level, and the rule that produced it.
 *
 * The lowest horizontal slab's TOP face -- the surface things stand on -- rather
 * than the bottom of the mesh. The distinction is not academic: the sample input's
 * meshes start at z = −0.2 while its floor slab's top is at z = 0, so taking the
 * mesh would put every height in the plan 200 mm out and leave the burner floating.
 */
function detectFloor(
  slabs: Box[], burner: FireFace | null, domain: Xb | null,
): [number, string] {
  // With a burner, only a slab UNDER it can be the floor. Falling back to every slab
  // when none qualifies took the one slab in the model -- an overhead ceiling -- as
  // the floor, put the origin at its top, dropped it from the plan as floor geometry
  // and left every device two metres below ground.
  const candidates = burner === null
    ? slabs
    : slabs.filter((s) => s.xb[5] <= burner.xb[4] + BURNER_PLATFORM_TOL_M);
  if (candidates.length > 0) {
    const lowest = candidates.reduce((best, s) => (s.xb[5] < best.xb[5] ? s : best));
    return [lowest.xb[5], 'the top of the lowest horizontal slab'];
  }
  if (burner !== null) return [burner.xb[4], 'the base of the burner'];
  if (domain !== null) return [domain[4], 'the bottom of the mesh'];
  return [0, 'z = 0'];
}

/** The rule `detectFloor` reports when it took the burner's own base as the floor. */
const FLOOR_FROM_BURNER = 'the base of the burner';

// -- single-record conversion, shared with the paste box ------------------

/**
 * One `&OBST` or `&VENT` as a plan object, with no model around it.
 *
 * This is what "create from FDS text" calls, so a pasted `&OBST` lands as the same
 * wall the full importer would have produced -- one classification rule, not two
 * that drift.
 *
 * The group is checked, not just the fields. `&MESH`, `&INIT`, `&SLCF` and a dozen
 * others carry an `XB` too, and turning a computational mesh into a wall because it
 * has six numbers is a worse answer than refusing it.
 */
export function obstructionFromRecord(
  rec: NamelistRecord,
  origin: Vec3 = [0, 0, 0],
  ids: Ids = new Ids(),
  surfs: Map<string, NamelistRecord> = new Map(),
): PlanObject | null {
  if (!GEOMETRY_GROUPS.includes(rec.group)) return null;
  const xb = xbOfRecord(rec);
  if (xb === null) return null;
  return geometryObject(xb, rec, origin, ids, surfs);
}

/** How many boxes the conversion had to thicken to draw at all. */
interface GeometryStats {
  thin: number;
}

/**
 * A box -- classified, re-origined and named -- as a wall, ceiling or obstruction.
 *
 * Takes the `XB` separately from the record so a `&MULT` copy converts through
 * exactly this path rather than a parallel one.
 *
 * An extent of zero -- FDS's thin obstruction -- becomes `THIN_M`, and is counted in
 * `stats` so the import can say so. It is the only dimension this conversion ever
 * invents, and it invents it because a zero one is not a box the editor can open.
 */
function geometryObject(
  xb: Xb, rec: NamelistRecord, origin: Vec3, ids: Ids,
  surfs: Map<string, NamelistRecord>, stats: GeometryStats = { thin: 0 },
): PlanObject {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = extent(xb);
  const [cx, cy] = centre(xb);
  const color = colorOf(rec);
  const name = rec.string('ID');
  const thickened = (v: number): number => {
    if (v > TOL_M) return v;
    stats.thin += 1;
    return THIN_M;
  };

  let obj: PlanObject;
  // A slab is a ceiling only if it is above the floor. One resting on it -- a
  // plinth, a hearth, a second floor tile beside the first -- has a soffit height of
  // zero or less, which is not a ceiling in this format and not a valid object in
  // any schema version. It falls through to the box it actually is.
  if (isSlabBox(xb) && xb[4] - oz > TOL_M) {
    obj = {
      id: ids.make('ceiling', name), type: 'ceiling', name: name ?? 'Ceiling',
      transform: { position_m: [0, 0, 0] },
      polygon_m: [
        [xb[0] - ox, xb[2] - oy], [xb[1] - ox, xb[2] - oy],
        [xb[1] - ox, xb[3] - oy], [xb[0] - ox, xb[3] - oy],
      ],
      height_m: xb[4] - oz,
      thickness_m: thickened(dz),
    } as CeilingObject;
  } else if (isWallBox(xb)) {
    const runsAlongY = dx <= dy;
    const a: [number, number] = runsAlongY ? [cx - ox, xb[2] - oy] : [xb[0] - ox, cy - oy];
    const b: [number, number] = runsAlongY ? [cx - ox, xb[3] - oy] : [xb[1] - ox, cy - oy];
    obj = {
      id: ids.make('wall', name), type: 'wall', name: name ?? 'Wall',
      transform: { position_m: [0, 0, 0] },
      polyline_m: [a, b],
      // Height is measured from the base the plan will actually draw. A wall that
      // starts below the floor -- every wall in the sample input starts 100 mm down,
      // because that is how you seal one to a slab -- keeps its top where the file
      // put it instead of gaining the buried part twice.
      height_m: Math.max(xb[5] - Math.max(xb[4], oz), TOL_M),
      thickness_m: thickened(runsAlongY ? dx : dy),
      baseHeight_m: Math.max(xb[4] - oz, 0),
      openings: [],
    } as WallObject;
  } else {
    obj = {
      id: ids.make('obst', name), type: 'obstruction', name: name ?? 'Obstruction',
      transform: { position_m: [cx - ox, cy - oy, xb[4] - oz] },
      size_m: [thickened(dx), thickened(dy), thickened(dz)],
    } as ObstructionObject;
  }

  if (color) obj.display = { color };
  const note = surfaceNote(rec, surfs);
  if (note) obj.notes = note;
  return obj;
}

/**
 * What the FDS surfaces on this box were, and whether any of them burns.
 *
 * A combustible lining is a planning fact, not simulation trivia: it decides where a
 * gauge can survive and what the room looks like ten minutes in. This format has
 * nowhere structured to put it, so it goes in the notes rather than nowhere.
 */
function surfaceNote(
  rec: NamelistRecord, surfs: Map<string, NamelistRecord>,
): string | null {
  const six = rec.strings('SURF_ID6');
  const source = six.length > 0 ? six : [rec.string('SURF_ID')];
  const named = [...new Set(source)].filter((s): s is string => Boolean(s));
  if (named.length === 0) return null;

  const burning = named.filter((s) => {
    const surf = surfs.get(s);
    return Boolean(surf && (surf.number('HRRPUA') || surf.number('MLRPUA')));
  });
  const quoted = (names: string[]): string => names.map((n) => `'${n}'`).join(', ');
  let note = `FDS SURF ${quoted(named)}`;
  if (burning.length > 0) {
    note += ` -- ${quoted(burning)} release${burning.length > 1 ? '' : 's'} heat, `
      + 'so this surface burns';
  }
  return note;
}

/**
 * A device's quantity and bead diameter, following `PROP_ID` when it has one.
 *
 * A thermocouple is written as `&DEVC PROP_ID='TC'` with the quantity on the
 * `&PROP`, so a reader that only looks at `QUANTITY` sees an unlabelled device and
 * imports nothing -- which is exactly what every thermocouple in the sample input
 * would do.
 */
function deviceQuantity(
  rec: NamelistRecord, props: Map<string, NamelistRecord>,
): [string | null, number | null] {
  let quantity = rec.string('QUANTITY');
  let diameter: number | null = null;
  const prop = props.get(rec.string('PROP_ID') ?? '');
  if (prop) {
    quantity = quantity ?? prop.string('QUANTITY');
    diameter = prop.number('DIAMETER');
  }
  return [quantity, diameter];
}

function deviceNormal(rec: NamelistRecord): Vec3 | null {
  const orientation = rec.numbers('ORIENTATION');
  if (orientation.length === 3 && orientation.some((v) => Math.abs(v) > TOL_M)) {
    const n = Math.hypot(orientation[0], orientation[1], orientation[2]);
    return [orientation[0] / n, orientation[1] / n, orientation[2] / n];
  }
  const ior = rec.number('IOR');
  return ior === null ? null : IOR_NORMAL[String(Math.trunc(ior))] ?? null;
}

function gaugeObject(
  ids: Ids, name: string | null, position: Vec3, normal: Vec3 | null,
  aimTarget: Vec3 | null, quantity: string | null,
): HeatFluxSensorObject {
  const target: Vec3 = normal
    ? [position[0] + normal[0], position[1] + normal[1], position[2] + normal[2]]
    : aimTarget ?? [position[0], position[1], position[2] + 1];

  return {
    id: ids.make('hf', name), type: 'heatFluxSensor', name: name ?? 'Heat flux gauge',
    transform: {
      position_m: [...position] as Vec3,
      rotation_quat: lookAtQuat(position, target),
      aimTarget_m: target,
    },
    gauge: {
      kind: 'other',
      // FDS has no gauge; it reports the flux at a point. Inventing a full scale
      // here would make every over-range and low-signal verdict in the plan a
      // fiction, so the range stays unstated and the checks say so.
      range_kw_m2: null,
      viewAngle_deg: 180,
      waterCooled: null,
      serial: null,
    },
    mount: { type: normal ? 'wall' : 'other', height_m: position[2] },
    notes: quantity ? `FDS &DEVC QUANTITY='${quantity}'` : null,
  };
}

function rakeObject(
  ids: Ids, name: string | null, position: Vec3, offsets: number[],
  diameterM: number | null, quantity: string | null,
): ThermocoupleObject {
  const surface = SURFACE_TC_QUANTITIES.includes((quantity ?? '').toUpperCase());
  return {
    id: ids.make('tc', name), type: 'thermocouple',
    name: name ?? (surface ? 'Surface temperature' : 'Thermocouple'),
    transform: { position_m: [...position] as Vec3 },
    beadOffsets_m: [...offsets],
    thermocouple: {
      tcType: 'K',
      beadDiameter_mm: diameterM ? diameterM * 1000 : null,
      sheathed: null,
      maxTemperature_C: null,
    },
    mount: { type: surface ? 'wall' : 'pole', height_m: position[2] },
    notes: quantity
      ? `FDS &DEVC QUANTITY='${quantity}'${
        surface ? ' -- a surface temperature, not a gas temperature' : ''}`
      : null,
  };
}

/**
 * One `&DEVC` as a plan instrument, or null if its quantity is not one.
 *
 * `&SLCF QUANTITY='TEMPERATURE', XYZ=...` has every field this reads and is a slice
 * file, not a thermocouple, so the group is checked first.
 */
export function deviceFromRecord(
  rec: NamelistRecord,
  props: Map<string, NamelistRecord> = new Map(),
  origin: Vec3 = [0, 0, 0],
  aimTarget: Vec3 | null = null,
  ids: Ids = new Ids(),
): PlanObject | null {
  if (rec.group !== DEVICE_GROUP) return null;
  const [quantity, diameter] = deviceQuantity(rec, props);
  const kind = defaultDeviceMap().get((quantity ?? '').toUpperCase()) ?? null;
  if (kind === null || !rec.has('XYZ')) return null;
  const xyz = rec.numbers('XYZ');
  if (xyz.length !== 3) return null;

  const position: Vec3 = [xyz[0] - origin[0], xyz[1] - origin[1], xyz[2] - origin[2]];
  const name = rec.string('ID');
  return kind === 'heatFluxSensor'
    ? gaugeObject(ids, name, position, deviceNormal(rec), aimTarget, quantity)
    : rakeObject(ids, name, position, [0], diameter, quantity);
}

// -- the main conversion --------------------------------------------------

/**
 * A vent that is just a boundary condition on the edge of the mesh.
 *
 * `SURF_ID='OPEN'` and `MB='XMAX'` are how an FDS model says "the world continues
 * past here". They are not geometry and they are not instruments.
 *
 * A vent that releases heat is never one of those, wherever it sits. A floor fire in
 * a domain that starts at the floor is written `XB=...,z0,z0` with `z0` the bottom
 * of the mesh -- flush with a domain face, and the most ordinary way there is to
 * write a burner. Dropping it left the plan with no fire, an origin fallen back to
 * the mesh centre, and a warning telling the user their input has no heat source.
 */
function isDomainVent(box: Box, domain: Xb | null, surfs: Map<string, NamelistRecord>): boolean {
  if (box.surfs.some((s) => statesHeat(s === null ? undefined : surfs.get(s)))) return false;
  if (box.surfs.some((s) => s === 'OPEN' || s === 'MIRROR' || s === 'PERIODIC')) return true;
  if (domain === null) return false;
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-bitwise
    if (Math.abs(box.xb[i] - domain[i]) <= TOL_M && Math.abs(box.xb[i ^ 1] - domain[i]) <= TOL_M) {
      return true;
    }
  }
  return false;
}

function burnerObject(
  ids: Ids, burner: FireFace, origin: Vec3, floorZ: number,
  reac: NamelistRecord | undefined, surfs: Map<string, NamelistRecord>,
): BurnerObject {
  const [ox, oy, oz] = origin;
  const [dx, dy] = extent(burner.xb);
  const [cx, cy] = centre(burner.xb);
  const surfRec = surfs.get(burner.surf);

  // The fuel surface is the face that burns: the top of a pan, the plane of a vent.
  const fuelZ = burner.face === '+z' ? burner.xb[5] : burner.xb[4];

  const rawFuel = reac ? reac.string('FUEL') ?? reac.string('ID') : null;
  const fire: BurnerObject['fire'] = {
    fuel: rawFuel ? rawFuel.toLowerCase() : null,
    hrr_kw: burner.hrrKw,
    hrrCurve: null,
  };
  // Only when the input states it. FDS has its own default; adopting that here would
  // put a number the file never contained into a model that predicts every gauge
  // reading from it.
  const chiR = reac ? reac.number('RADIATIVE_FRACTION') : null;
  if (chiR !== null) fire.radiativeFraction = chiR;

  const obj: BurnerObject = {
    id: ids.make('burner', burner.surf), type: 'burner', name: burner.surf || 'Burner',
    transform: { position_m: [cx - ox, cy - oy, floorZ - oz] },
    footprint: {
      shape: Math.abs(dx - dy) <= TOL_M ? 'square' : 'rectangle',
      size_m: [dx, dy],
    },
    rimHeight_m: Math.max(fuelZ - floorZ, 0),
    fire,
    notes: `FDS &SURF ID='${burner.surf}'`,
  };
  // Absent, not null: `display` is an object or it is not there.
  const color = surfRec ? colorOf(surfRec) : null;
  if (color) obj.display = { color };
  return obj;
}

/**
 * Turn each `&HOLE` into an opening in every wall it cuts.
 *
 * A hole in FDS is a subtraction from the solid, so a doorway is a hole through the
 * wall obstruction rather than a property of the wall. This format has openings on
 * the wall, positioned by arc length along its polyline, so the conversion is an
 * overlap test -- which is also why a hole that misses every wall is reported
 * instead of vanishing.
 */
function applyHoles(
  holes: Box[], walls: Array<[WallObject, Xb]>, origin: Vec3, issues: Issue[],
): void {
  let placed = 0;
  for (const hole of holes) {
    let cut = false;
    for (const [wall, xb] of walls) {
      const loX = Math.max(hole.xb[0], xb[0]);
      const hiX = Math.min(hole.xb[1], xb[1]);
      const loY = Math.max(hole.xb[2], xb[2]);
      const hiY = Math.min(hole.xb[3], xb[3]);
      const loZ = Math.max(hole.xb[4], xb[4]);
      const hiZ = Math.min(hole.xb[5], xb[5]);
      if (hiX - loX <= TOL_M || hiY - loY <= TOL_M || hiZ - loZ <= TOL_M) continue;

      const alongX = (xb[1] - xb[0]) >= (xb[3] - xb[2]);
      const start = alongX ? xb[0] : xb[2];
      const lo = alongX ? loX : loY;
      const hi = alongX ? hiX : hiY;
      const base = Math.max(xb[4], origin[2]);
      const opening: WallOpening = {
        offset_m: lo - start,
        width_m: hi - lo,
        height_m: hiZ - Math.max(loZ, base),
        sillHeight_m: Math.max(loZ - base, 0),
      };
      if (hole.name) opening.id = hole.name;
      wall.openings!.push(opening);
      cut = true;
      placed += 1;
    }
    if (!cut) {
      issues.push(issue('info', 'fds-hole-unmatched',
        `&HOLE at line ${hole.rec.line} cuts nothing this plan holds — it opens a slab `
        + 'or a solid block, and only walls carry openings here.'));
    }
  }
  if (placed > 0) {
    issues.push(issue('info', 'fds-holes', `${placed} wall opening(s) came from &HOLE.`));
  }
}

/**
 * Collapse vertical runs at a common XY into one rake each.
 *
 * Only vertical runs. A rake's beads lie along its local +Z, so a horizontal row
 * would have to be a rotated object, and a rotated rake reads correctly in the 3D
 * view but not in the elevations (CONVENTIONS section 5a). Twenty-two separate
 * objects is untidy; twenty-two objects drawn in the wrong place is wrong.
 */
function groupedRakes(
  members: Array<[NamelistRecord, number | null]>, origin: Vec3, ids: Ids, quantity: string,
): ThermocoupleObject[] {
  const byXy = new Map<string, Array<[NamelistRecord, number | null]>>();
  for (const pair of members) {
    const xyz = pair[0].numbers('XYZ');
    const key = `${xyz[0].toFixed(4)}|${xyz[1].toFixed(4)}|${pair[0].number('IOR') ?? ''}`;
    const slot = byXy.get(key);
    if (slot) slot.push(pair);
    else byXy.set(key, [pair]);
  }

  const out: ThermocoupleObject[] = [];
  for (const run of byXy.values()) {
    run.sort((a, b) => a[0].numbers('XYZ')[2] - b[0].numbers('XYZ')[2]);
    const first = run[0][0];
    const [x, y] = first.numbers('XYZ');
    const z0 = first.numbers('XYZ')[2];
    const position: Vec3 = [x - origin[0], y - origin[1], z0 - origin[2]];
    const offsets = run.map(([r]) => r.numbers('XYZ')[2] - z0);
    const diameter = run.find(([, d]) => d)?.[1] ?? null;

    let name: string | null;
    if (run.length === 1) {
      name = first.string('ID');
    } else {
      const firstId = first.string('ID');
      const lastId = run[run.length - 1][0].string('ID');
      name = firstId && lastId ? `${firstId}-${lastId}` : null;
    }
    out.push(rakeObject(ids, name, position, offsets, diameter, quantity));
  }
  return out;
}

function importDevices(
  records: NamelistRecord[], props: Map<string, NamelistRecord>, origin: Vec3,
  opts: FdsImportOptions, burner: FireFace | null, floorZ: number, ids: Ids,
  groups: DeviceGroup[], issues: Issue[],
): PlanObject[] {
  const mapping = defaultDeviceMap();
  if (opts.deviceMap) {
    for (const [k, v] of opts.deviceMap) mapping.set(k.toUpperCase(), v);
  }

  let aim: Vec3 | null = null;
  if (burner) {
    const [bx, by] = centre(burner.xb);
    aim = [bx - origin[0], by - origin[1], Math.max(burner.xb[5] - floorZ, 0) + 0.3];
  }

  // Bucket by quantity first: the preview reports per quantity, and rake grouping
  // must never merge a thermocouple with a wall temperature that shares its point.
  const buckets = new Map<string, Array<[NamelistRecord, number | null]>>();
  for (const rec of records) {
    const [quantity, diameter] = deviceQuantity(rec, props);
    const key = (quantity ?? '').toUpperCase();
    const slot = buckets.get(key);
    if (slot) slot.push([rec, diameter]);
    else buckets.set(key, [[rec, diameter]]);
  }

  const groupRakes = opts.groupRakes !== false;
  const objects: PlanObject[] = [];
  for (const [key, members] of buckets) {
    const kind = mapping.get(key) ?? null;
    const group: DeviceGroup = {
      quantity: key || null, count: members.length, mappedTo: kind, objects: 0, note: '',
    };
    groups.push(group);
    if (kind === null) {
      group.note = 'no counterpart in a test plan';
      continue;
    }

    const positioned = members.filter(([r]) => r.numbers('XYZ').length === 3);
    if (positioned.length < members.length) {
      group.note = `${members.length - positioned.length} of them have no XYZ `
        + '(a region or a global quantity)';
    }

    let made: PlanObject[];
    if (kind === 'thermocouple' && groupRakes) {
      made = groupedRakes(positioned, origin, ids, key);
    } else {
      made = positioned.map(([rec, diameter]) => {
        const xyz = rec.numbers('XYZ');
        const pos: Vec3 = [xyz[0] - origin[0], xyz[1] - origin[1], xyz[2] - origin[2]];
        const name = rec.string('ID');
        return kind === 'heatFluxSensor'
          ? gaugeObject(ids, name, pos, deviceNormal(rec), aim, key)
          : rakeObject(ids, name, pos, [0], diameter, key);
      });
    }
    group.objects = made.length;
    objects.push(...made);

    if (kind === 'thermocouple' && groupRakes && made.length < positioned.length) {
      issues.push(issue('info', 'fds-rake-grouped',
        `${positioned.length} '${key}' devices became ${made.length} rake(s): a vertical `
        + 'run at one XY is one instrument with several beads here, not several instruments.'));
    }
  }

  const gauges = groups
    .filter((g) => g.mappedTo === 'heatFluxSensor')
    .reduce((n, g) => n + g.objects, 0);
  if (gauges > 0) {
    issues.push(issue('warning', 'fds-gauge-range',
      `${gauges} heat flux gauge(s) arrived without a full-scale range — FDS reports a `
      + 'flux at a point and has no gauge to over-range. Set a range on each to get an '
      + 'over-range or low-signal verdict.'));
  }
  return objects;
}

/** Records this format has no counterpart for, named individually so the report says
 *  what was in the file rather than "some things were skipped". */
const SKIPPED: Record<string, string> = {
  MESH: 'the computational grid',
  MATL: 'material thermal properties',
  SPEC: 'gas species',
  SLCF: 'slice file output',
  BNDF: 'boundary file output',
  ISOF: 'isosurface output',
  PART: 'Lagrangian particles',
  DUMP: 'output control',
  TRNX: 'mesh stretching', TRNY: 'mesh stretching', TRNZ: 'mesh stretching',
  PRES: 'pressure solver settings',
  RADI: 'radiation solver settings',
  CTRL: 'control logic',
  ZONE: 'pressure zones',
  INIT: 'initial conditions',
  PROF: 'profile output',
  SM3D: 'smoke3d output',
  OBST: '', VENT: '', HOLE: '', DEVC: '', PROP: '', SURF: '',
  RAMP: '', REAC: '', HEAD: '', TIME: '', TAIL: '', MULT: '', MISC: '', CATF: '',
};

function reportSkipped(byGroup: Map<string, NamelistRecord[]>, issues: Issue[]): void {
  const parts: string[] = [];
  for (const group of [...byGroup.keys()].sort()) {
    const why = SKIPPED[group];
    const n = byGroup.get(group)!.length;
    if (why) parts.push(`&${group} ×${n} (${why})`);
    else if (why === undefined) parts.push(`&${group} ×${n}`);
  }
  if (parts.length > 0) {
    issues.push(issue('info', 'fds-not-imported',
      `Simulation-only records, left behind: ${parts.join(', ')}.`));
  }
}

/**
 * Say so when `&CATF` named files nobody read.
 *
 * The desktop shell can read the files beside the input and hands them over already
 * spliced. A browser tab is given one file's bytes and cannot go looking, and a
 * silent skip there is the worst kind: the plan looks complete and holds a fraction
 * of the model.
 */
function reportUnresolvedIncludes(
  byGroup: Map<string, NamelistRecord[]>, opts: FdsImportOptions, issues: Issue[],
): void {
  const catf = byGroup.get('CATF') ?? [];
  if (catf.length > 0 && !opts.includesResolved) {
    const named = catf.flatMap((rec) => rec.strings('OTHER_FILES')).filter(Boolean);
    issues.push(issue('warning', 'fds-catf-unresolved',
      `&CATF pulls ${named.length > 0 ? `${named.length} other file(s)` : 'other files'} into `
      + `this input (${named.length > 0 ? named.join(', ') : 'unnamed'}), and only the file `
      + 'itself was read. Everything those files define — geometry, devices, surfaces — is '
      + 'missing from this plan. Open it in the desktop app, from the folder that holds them.'));
  }
}

/**
 * Check the plan the conversion just built, and report rather than throw.
 *
 * Every other way a document reaches the editor goes through `parseAndValidatePlan`;
 * an import that skipped it could adopt a plan that saves and then cannot be opened
 * again -- a failure that surfaces a long way from the import that caused it. The
 * findings are issues, not an exception, because the import preview is the right
 * place to show them and the dialog refuses to adopt while any is present.
 */
function reportInvalid(doc: PlanDocument, issues: Issue[]): void {
  for (const bad of validateStructure(doc)) {
    issues.push(issue('error', 'fds-invalid',
      `The conversion produced something this format does not accept: ${bad.message}`));
  }
}

/** `[x0, x1, y0, y1]` covering every object's plan footprint, in plan coordinates. */
function planSpan(objects: PlanObject[]): [number, number, number, number] | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const obj of objects) {
    const pos = obj.transform?.position_m ?? [0, 0, 0];
    const raw = obj as unknown as Record<string, unknown>;
    for (const key of ['polyline_m', 'polygon_m']) {
      const list = raw[key];
      if (!Array.isArray(list)) continue;
      for (const point of list as Array<[number, number]>) {
        xs.push(pos[0] + point[0]);
        ys.push(pos[1] + point[1]);
      }
    }
    if (obj.type === 'obstruction') {
      const size = (obj as ObstructionObject).size_m;
      xs.push(pos[0] - size[0] / 2, pos[0] + size[0] / 2);
      ys.push(pos[1] - size[1] / 2, pos[1] + size[1] / 2);
    } else if (['burner', 'heatFluxSensor', 'thermocouple', 'camera'].includes(obj.type)) {
      xs.push(pos[0]);
      ys.push(pos[1]);
    }
  }
  if (xs.length === 0) return null;
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
}

/** Convert FDS input text into a plan, with a full account of the conversion. */
export function fdsToPlan(
  text: string, filename: string | null = null, opts: FdsImportOptions = {},
): FdsImportResult {
  const records = readNamelist(text);
  if (records.length === 0) {
    throw new FdsError('No FDS namelist records found — is this an .fds input file?');
  }

  const byGroup = new Map<string, NamelistRecord[]>();
  for (const rec of records) {
    const slot = byGroup.get(rec.group);
    if (slot) slot.push(rec);
    else byGroup.set(rec.group, [rec]);
  }
  const group = (name: string): NamelistRecord[] => byGroup.get(name) ?? [];

  // Whatever reading the includes had to say comes first, as it does from
  // `fireplan.fds.load`: a child that ended in &TAIL explains everything missing
  // below it, and belongs above the findings it caused.
  const issues: Issue[] = [...(opts.includeIssues ?? [])];
  const ids = new Ids();
  const surfs = new Map<string, NamelistRecord>();
  for (const rec of group('SURF')) {
    const id = rec.string('ID');
    if (id) surfs.set(id, rec);
  }
  const props = new Map<string, NamelistRecord>();
  for (const rec of group('PROP')) {
    const id = rec.string('ID');
    if (id) props.set(id, rec);
  }
  const peaks = peakRamps(records);
  const mults = multipliers(records);

  // -- domain ------------------------------------------------------------
  const meshes = meshBoxes(records, mults);
  const domain: Xb | null = meshes.length === 0 ? null : [
    Math.min(...meshes.map((m) => m[0])), Math.max(...meshes.map((m) => m[1])),
    Math.min(...meshes.map((m) => m[2])), Math.max(...meshes.map((m) => m[3])),
    Math.min(...meshes.map((m) => m[4])), Math.max(...meshes.map((m) => m[5])),
  ];

  // -- the fire ----------------------------------------------------------
  const wantGeometry = opts.geometry !== false;
  const reac = group('REAC')[0];
  const obstBoxes = boxesOf(records, 'OBST', mults);
  const ventBoxes = boxesOf(records, 'VENT', mults).filter((b) => !isDomainVent(b, domain, surfs));
  const heatOfCombustion = reac ? reac.number('HEAT_OF_COMBUSTION') : null;
  const faces = fireFaces(obstBoxes, ventBoxes, surfs, peaks, heatOfCombustion, issues, domain);
  const burner = pickBurner(faces, opts.burnerSurf);
  const burners = burnerFaces(faces, burner);
  const candidates = [...new Set(faces.filter(canBeBurner).map((f) => f.surf))].sort();
  // Heat-release surfaces no face of which could be a burner here: a lining on a
  // wall vent, a plane fire with no plan area. They are still in the file and still
  // change the fire, so they are named rather than passed over.
  const unusable = [...new Set(faces.map((f) => f.surf))]
    .filter((surf) => !candidates.includes(surf)).sort();

  if (burner === null && faces.length === 0) {
    issues.push(issue('warning', 'fds-no-fire',
      'No surface in this input releases heat, so the plan has no burner and its origin '
      + 'is the centre of the mesh. Add a burner, then move the geometry onto it — every '
      + 'standoff and flame-height figure is measured from the burner centre.'));
  } else if (burner === null) {
    const surfaces = [...new Set(faces.map((f) => f.surf))].sort();
    issues.push(issue('warning', 'fds-fire-not-a-burner',
      `${surfaces.length} surface(s) release heat (${surfaces.join(', ')}) but none of them `
      + 'is an upward-facing horizontal face — a wall lining burns on a plane with no plan '
      + 'footprint, and a ceiling soffit burns downwards. Neither is the floor-standing '
      + "source this format's burner describes, so the plan has no burner and its origin "
      + 'is the centre of the mesh.'));
  } else {
    if (opts.burnerSurf && burner.surf !== opts.burnerSurf) {
      // The chooser falls back to the default pick rather than refusing, which is the
      // useful behaviour -- but a caller who named a surface and got a different one
      // has to be told, or the plan silently describes a fire somewhere else.
      issues.push(issue('warning', 'fds-burner-unavailable',
        `'${opts.burnerSurf}' was asked for as the burner surface, but no face of it is `
        + `one this format can hold as a burner; '${burner.surf}' was used instead.`));
    }
    if (candidates.length > 1) {
      issues.push(issue('info', 'fds-fire-choice',
        `${candidates.length} surfaces release heat (${candidates.join(', ')}); `
        + `'${burner.surf}' was taken as the burner because it is the most compact `
        + 'horizontal one. The rest are burning surfaces the plan cannot represent.'));
    }
    if (unusable.length > 0) {
      issues.push(issue('info', 'fds-fire-not-a-burner',
        `${unusable.map((x) => `'${x}'`).join(', ')} release${unusable.length === 1 ? 's' : ''} `
        + 'heat on faces this format cannot hold as a burner — a wall lining has no plan '
        + `footprint and a ceiling soffit burns downwards. ${
          unusable.length === 1 ? 'It is not' : 'They are not'} in the plan as a burner; `
        + 'the notes on the geometry say which surfaces burn.'));
    }
    if (burners.length > 1) {
      issues.push(issue('info', 'fds-burner-instances',
        `'${burner.surf}' burns on ${burners.length} separate faces; each became a burner, `
        + 'and the one at the origin is the primary.'));
    }
  }

  // -- origin and floor --------------------------------------------------
  // A shallow burner pan passes the slab test, so without this it becomes "the
  // lowest horizontal slab" and puts the floor at the top of the burner.
  const burnerXbs = burners.filter((f) => !f.fromVent).map((f) => f.xb);
  const slabs = obstBoxes.filter(
    (b) => isSlabBox(b.xb) && !burnerXbs.some((xb) => sameXb(b.xb, xb)),
  );
  const [floorZ, floorRule] = opts.floorZM !== undefined
    ? [opts.floorZM, 'the level you gave']
    : detectFloor(slabs, burner, domain);

  let origin: Vec3;
  if (opts.originM) {
    origin = [...opts.originM] as Vec3;
  } else if (burner !== null) {
    const [bx, by] = centre(burner.xb);
    origin = [bx, by, floorZ];
  } else if (domain !== null) {
    origin = [(domain[0] + domain[1]) / 2, (domain[2] + domain[3]) / 2, floorZ];
  } else {
    origin = [0, 0, 0];
  }
  const [ox, oy, oz] = origin;

  if (burner !== null && burner.xb[4] > floorZ + BURNER_PLATFORM_TOL_M) {
    issues.push(issue('warning', 'fds-burner-raised',
      `The burner's base is ${(burner.xb[4] - floorZ).toFixed(2)} m above the floor, taken `
      + `from ${floorRule}. If it stands on a platform this is right; if the floor was `
      + 'detected wrongly every height in the plan is off by the same amount.'));
  }
  if (floorRule === FLOOR_FROM_BURNER && slabs.length > 0) {
    // The model has slabs, but every one of them is above the fire. That is the
    // shape of a floor-level fire under a ceiling with no floor slab drawn -- and
    // also the shape of a floor slab this reader failed to recognise, so it is
    // worth a line rather than a silent choice.
    issues.push(issue('info', 'fds-floor-inferred',
      `No horizontal slab lies below the burner, so the floor was taken as the burner's `
      + `base (z = ${String(floorZ)} in the file). The ${slabs.length} slab(s) above it `
      + `${slabs.length === 1 ? 'was' : 'were'} kept as ceilings.`));
  }

  // -- build the plan ----------------------------------------------------
  const head = group('HEAD')[0];
  const chid = head ? head.string('CHID') : null;
  const fdsTitle = head ? head.string('TITLE') : null;
  // CHID, not TITLE: CHID is the job name and fits a toolbar and a drawing sheet,
  // while TITLE is free prose -- the sample input's is a 200-character paragraph.
  const doc = newPlan(chid ?? (fdsTitle ?? 'Imported FDS model').slice(0, 60));

  const objects: PlanObject[] = [];
  const walls: Array<[WallObject, Xb]> = [];

  if (wantGeometry) {
    const stats: GeometryStats = { thin: 0 };
    // Every slab whose top is the floor, not merely the lowest one. A meshed model
    // tiles its floor -- one &OBST per mesh is the usual shape -- and skipping a
    // single instance leaves the rest to be converted as slabs sitting at floor
    // level, which is not a ceiling and not an object anyone drew.
    for (const box of obstBoxes) {
      if (burnerXbs.some((xb) => sameXb(box.xb, xb))) continue; // becomes the burner
      if (isSlabBox(box.xb) && box.xb[5] <= floorZ + TOL_M) continue; // it is the floor
      const obj = geometryObject(box.xb, box.rec, origin, ids, surfs, stats);
      if (obj.type === 'wall') walls.push([obj as WallObject, box.xb]);
      objects.push(obj);
    }

    applyHoles(boxesOf(records, 'HOLE', mults), walls, origin, issues);

    if (stats.thin > 0) {
      issues.push(issue('info', 'fds-thin-geometry',
        `${stats.thin} zero-thickness &OBST extent(s) were drawn ${THIN_M * 1000} mm thick: `
        + 'this format has no planar object, and a box with no thickness is one the '
        + 'editor cannot open.'));
    }
  }

  for (const face of burners) {
    objects.push(burnerObject(ids, face, origin, floorZ, reac, surfs));
  }

  const devices: DeviceGroup[] = [];
  if (opts.devices !== false) {
    objects.push(...importDevices(
      group('DEVC'), props, origin, opts, burner, floorZ, ids, devices, issues));
  }

  doc.objects = objects;

  // -- document-level fields --------------------------------------------
  const meta = doc.meta ?? (doc.meta = {});
  if (chid) meta.testId = chid;
  const notes = [`Imported from ${filename ?? 'an FDS input'}.`];
  if (fdsTitle && fdsTitle !== chid) notes.push(`&HEAD TITLE: ${fdsTitle}`);
  const time = group('TIME')[0];
  const tEnd = time ? time.number('T_END') : null;
  // `String`, which is JSON.stringify's number spelling -- the one Python's
  // `_js_number` reproduces. This string ends up in the plan file, so the two
  // importers have to spell it the same way.
  if (tEnd !== null) notes.push(`Simulation T_END ${String(tEnd)} s.`);
  if (burner !== null) {
    notes.push(`Origin is the '${burner.surf}' surface centre; floor from ${floorRule}.`);
  }
  meta.notes = notes.join(' ');
  meta.source = {
    tool: 'FDS',
    file: filename,
    chid,
    importedAt: opts.importedAt ?? nowIso(),
    originOffset_m: [ox, oy, oz],
  };

  const env = doc.environment ?? (doc.environment = {});
  const span = planSpan(objects) ?? (domain === null ? null : [
    domain[0] - ox, domain[1] - ox, domain[2] - oy, domain[3] - oy,
  ] as [number, number, number, number]);
  if (span) {
    // floorSize is centred on the origin, and the origin is the burner rather than
    // the middle of anything, so the plane has to reach the further side. Sized on
    // the objects rather than the mesh: an FDS domain is routinely far larger than
    // the compartment inside it -- three times larger, in the sample input -- and a
    // floor plane that size dwarfs the plan drawn on it.
    env.floorSize_m = [
      Math.max(2 * Math.max(Math.abs(span[0]), Math.abs(span[1])) + 2, 4),
      Math.max(2 * Math.max(Math.abs(span[2]), Math.abs(span[3])) + 2, 4),
    ];
  }
  const ceilingHeights = objects
    .filter((o) => o.type === 'ceiling')
    .map((o) => (o as CeilingObject).height_m);
  if (ceilingHeights.length > 0) env.ceilingHeight_m = Math.min(...ceilingHeights);
  const misc = group('MISC')[0];
  const tmpa = misc ? misc.number('TMPA') : null;
  if (tmpa !== null) env.ambientTemperature_C = tmpa;

  // A freshly built plan starts at the baseline version and would report
  // `version-understated` against its own contents until first saved. An import is
  // not an edit in progress, so it declares what it holds straight away -- exactly
  // as `fireplan.fds` does, and for the same reason.
  doc.version = requiredFormatVersion(doc);

  reportSkipped(byGroup, issues);
  reportUnresolvedIncludes(byGroup, opts, issues);
  reportInvalid(doc, issues);

  const counts: Record<string, number> = {};
  for (const obj of objects) counts[obj.type] = (counts[obj.type] ?? 0) + 1;

  return {
    doc,
    issues,
    devices,
    originM: origin,
    burnerSurf: burner ? burner.surf : null,
    burnerCandidates: candidates,
    sourceFile: filename,
    counts,
  };
}
