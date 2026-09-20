/**
 * Tests for the plan core.
 *
 * The load-bearing one is `serializePlan` parity with Python: a plan saved from the
 * editor and the same plan saved from `fireplan` must be byte-identical, or every
 * FSE <-> data-scientist handoff shows up as a spurious diff.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  effectiveDiameterM,
  flameHeightM,
  plumeRadiusM,
  virtualOriginM,
} from './correlations';
import { angleBetweenDeg, columnsToQuat, forwardOf, lookAtQuat, quatToColumns, sub } from './math';
import {
  boundsPoints,
  burnerDiameterM,
  cameraColor,
  ceilingAreaM2,
  ceilingChecks,
  ceilingCoversXY,
  ceilingSoffitZM,
  ceilings,
  checkPlan,
  flameTipZM,
  footprintXY,
  fxOf,
  hfovDegOf,
  hoodChecks,
  hoodIntakeHeightM,
  hoodOpeningZM,
  newPlan,
  objectColor,
  parsePlan,
  primaryBurner,
  principalPointOf,
  standoffHorizontalM,
  standoffM,
  toLocal,
  toWorld,
  vfovDegOf,
} from './plan';
import { serializePlan } from './serialize';
import { setPosition, setRotation } from './transform';
import type { BurnerObject, CameraObject, CeilingObject, PlanDocument, Quat, Vec3 } from './types';
import { formatLength, parseLength } from './units';
import { describeErrors, parseAndValidatePlan, validateStructure } from './validate';

const FIXTURE_PATH = fileURLToPath(new URL('../../../fixtures/pool-fire-camera-row.ftp.json', import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const fixture = (): PlanDocument => parsePlan(FIXTURE_TEXT);

const FWD_COMPAT_PATH = fileURLToPath(new URL('../../../fixtures/forward-compat.ftp.json', import.meta.url));
const FWD_COMPAT_TEXT = readFileSync(FWD_COMPAT_PATH, 'utf8');
const FWD_COMPAT = (): PlanDocument => parsePlan(FWD_COMPAT_TEXT);

// -- serialisation parity -------------------------------------------------

describe('canonical serialisation', () => {
  it('preserves own __proto__ fields at every dictionary-copy boundary', () => {
    const extra = JSON.parse('{"__proto__":{"retained":1.25}}');
    // Use JSON text to create an own property rather than an object-literal prototype.
    const raw = JSON.parse(JSON.stringify(fixture()).replace(/^{/, '{"__proto__":{"retained":1.25},'));
    raw.meta = { ...raw.meta, ...extra };
    raw.objects[0] = { ...raw.objects[0], ...extra };
    raw.objects[0].transform = { ...raw.objects[0].transform, ...extra };
    raw.objects.push({ id: 'future-proto', type: '__proto__', ...extra });
    const back = JSON.parse(serializePlan(raw));
    for (const block of [back, back.meta, back.objects[0], back.objects[0].transform,
      back.objects.at(-1)]) {
      expect(Object.hasOwn(block, '__proto__')).toBe(true);
      expect(block.__proto__).toEqual({ retained: 1.25 });
    }
  });
  it('reproduces the Python-written fixture byte for byte', () => {
    // If this fails, the TypeScript and Python writers have drifted and plans will
    // diff spuriously depending on which tool last saved them.
    expect(serializePlan(fixture())).toBe(FIXTURE_TEXT);
  });

  it('is idempotent', () => {
    const once = serializePlan(fixture());
    expect(serializePlan(parsePlan(once))).toBe(once);
  });

  it('preserves unknown object types verbatim', () => {
    const doc = newPlan('fwd compat');
    doc.objects.push({
      id: 'tc-tree-1',
      type: 'thermocoupleTree',
      heights_m: [0.5, 1, 1.5],
      junctionType: 'K',
    } as never);
    const back = parsePlan(serializePlan(doc));
    const raw = back.objects[0] as Record<string, unknown>;
    expect(raw.type).toBe('thermocoupleTree');
    expect(raw.heights_m).toEqual([0.5, 1, 1.5]);
    expect(raw.junctionType).toBe('K');
  });

  it('reproduces the forward-compatibility fixture byte for byte', () => {
    // The unknown-object half of the Python parity contract. If this fails, one
    // writer has started tidying data the format does not define.
    expect(serializePlan(FWD_COMPAT())).toBe(FWD_COMPAT_TEXT);
  });

  it('keeps unknown objects out of the canonical rounding and reordering', () => {
    // CONVENTIONS.md section 6 promises byte-identical re-emission. Rounding a
    // coefficient whose units we do not know, or sorting fields against a schema we
    // have never seen, silently corrupts a plan from a newer tool.
    const doc = newPlan('fwd compat');
    doc.objects.push({
      zzz_trailingKey: 'must stay last',
      id: 'spec-1',
      type: 'spectrometer',
      calibration: { coefficient: 1.23456789 },
    } as never);

    const raw = parsePlan(serializePlan(doc)).objects[0] as Record<string, unknown>;
    expect((raw.calibration as Record<string, number>).coefficient).toBe(1.23456789);
    expect(Object.keys(raw)).toEqual(['zzz_trailingKey', 'id', 'type', 'calibration']);
  });

  it('still rounds the transform of an unknown object', () => {
    // The editor can drag an unrecognised object, and gizmo output is raw float
    // noise -- transform is a format 1.0 block this version does own.
    const doc = newPlan('fwd compat');
    doc.objects.push({
      id: 'spec-1',
      type: 'spectrometer',
      transform: { position_m: [0.123456789, 0, 0] },
    } as never);

    const raw = parsePlan(serializePlan(doc)).objects[0] as Record<string, unknown>;
    expect((raw.transform as { position_m: number[] }).position_m[0]).toBe(0.123457);
  });

  it('emits keys in canonical order regardless of input order', () => {
    const doc = newPlan('ordering');
    doc.objects.push({
      notes: 'last',
      type: 'burner',
      footprint: { size_m: [0.3, 0.3], shape: 'square' },
      id: 'burner-1',
    } as never);
    const obj = JSON.parse(serializePlan(doc)).objects[0];
    expect(Object.keys(obj)).toEqual(['id', 'type', 'footprint', 'notes']);
    expect(Object.keys(obj.footprint)).toEqual(['shape', 'size_m']);
  });

  it('rounds floats and collapses negative zero', () => {
    const doc = newPlan('rounding');
    doc.objects.push({
      id: 'b',
      type: 'burner',
      transform: { position_m: [2.74320000000001, 0.1234567891, -0] },
      footprint: { shape: 'circle', diameter_m: 0.3 },
    } as never);
    const text = serializePlan(doc);
    expect(text).toContain('"position_m": [2.7432, 0.123457, 0]');
    expect(text).not.toContain('-0.0');
  });

  it('spells exotic numbers exactly as the Python writer does', () => {
    // Mirror of test_roundtrip.py's parity table. JSON.stringify is the reference
    // spelling and serialize.py reproduces it, so these strings are what BOTH writers
    // must emit -- inside an unknown object, where nothing rounds them first.
    const doc = newPlan('exotic numbers');
    doc.objects.push({
      id: 'spec-1',
      type: 'spectrometer',
      calibration: { dark: 1.23e-8, floor: 1e-6, scale: 1e16, big: 2 ** 60, huge: 1e21 },
    } as never);

    const text = serializePlan(doc);
    expect(text).toContain('"dark": 1.23e-8');
    expect(text).toContain('"floor": 0.000001');
    expect(text).toContain('"scale": 10000000000000000');
    expect(text).toContain('"big": 1152921504606847000');
    expect(text).toContain('"huge": 1e+21');
  });

  it('does not rewrite numeric-looking text inside strings', () => {
    const doc = newPlan('regex safety');
    doc.meta = { ...doc.meta, notes: 'measured at [1,2] and [3, 4]' };
    expect(parsePlan(serializePlan(doc)).meta?.notes).toBe('measured at [1,2] and [3, 4]');
  });

  it('rejects a file that is not a fire test plan', () => {
    expect(() => parsePlan('{"format":"something-else"}')).toThrow(/Not a fire test plan/);
    expect(() => parsePlan('{not json')).toThrow(/Invalid JSON/);
  });

  it('keeps data whose keys happen to be prototype names', () => {
    // `'constructor' in {}` is true, so a `meta.constructor` key read as already
    // emitted and vanished, and an unknown object typed `constructor` was routed
    // to the known-type path and handed Object.prototype.constructor as its key
    // order -- which threw out of the save.
    const doc = newPlan('prototype names');
    doc.meta = { ...doc.meta, constructor: 'keep this', toString: 'and this' } as never;
    doc.objects.push({ id: 'odd', type: 'constructor', hasOwnProperty: 1 } as never);
    doc.objects.push({ id: 'odd2', type: 'toString' } as never);

    const back = parsePlan(serializePlan(doc));
    expect((back.meta as Record<string, unknown>).constructor).toBe('keep this');
    expect((back.meta as Record<string, unknown>).toString).toBe('and this');
    expect(back.objects.map((o) => o.type)).toEqual(['constructor', 'toString']);
    expect((back.objects[0] as Record<string, unknown>).hasOwnProperty).toBe(1);
    // Nor does a prototype name masquerade as a colour.
    expect(objectColor(back.objects[0])).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

// -- frames ---------------------------------------------------------------

describe('frame math', () => {
  it('builds the OpenGL frame a camera at +X looking at the origin should have', () => {
    // Hand-derived: forward = (-1,0,0), so local +Z ('back') = (1,0,0);
    // up = (0,0,1); right = up x back = (0,1,0). Columns are [right, up, back].
    const q = lookAtQuat([2, 0, 0], [0, 0, 0]);
    const [right, up, back] = quatToColumns(q);
    expect(right[0]).toBeCloseTo(0, 12);
    expect(right[1]).toBeCloseTo(1, 12);
    expect(up[2]).toBeCloseTo(1, 12);
    expect(back[0]).toBeCloseTo(1, 12);
    expect(forwardOf(q)[0]).toBeCloseTo(-1, 12);
  });

  it('round-trips quaternion and columns', () => {
    for (const target of [[0, 0, 0], [1, 2, 0.5], [-3, 0.2, 2]] as const) {
      const q = lookAtQuat([2, 1, 1.5], [...target]);
      const back = columnsToQuat(quatToColumns(q));
      for (let i = 0; i < 4; i += 1) expect(back[i]).toBeCloseTo(q[i], 12);
    }
  });

  it('pins the quaternion sign so re-saves stay diff-free', () => {
    for (const target of [[0, 0, 0], [1, 2, 0.5], [-3, 0.2, 2], [0.1, -5, -2]] as const) {
      expect(lookAtQuat([2, 1, 1.5], [...target])[3]).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles looking straight down, where the up hint collapses', () => {
    const q = lookAtQuat([0, 0, 5], [0, 0, 0]);
    expect(forwardOf(q)[2]).toBeCloseTo(-1, 12);
    // Still orthonormal.
    const [r, u, b] = quatToColumns(q);
    expect(r[0] * u[0] + r[1] * u[1] + r[2] * u[2]).toBeCloseTo(0, 12);
    expect(u[0] * b[0] + u[1] * b[1] + u[2] * b[2]).toBeCloseTo(0, 12);
  });

  it('handles looking straight up', () => {
    expect(forwardOf(lookAtQuat([0, 0, 0.5], [0, 0, 5]))[2]).toBeCloseTo(1, 12);
  });
});

// -- camera ---------------------------------------------------------------

describe('camera intrinsics', () => {
  const cam = (): CameraObject => ({
    id: 'c',
    type: 'camera',
    transform: { position_m: [3, 0, 4] },
    camera: {
      modality: 'RGB',
      resolution_px: [1000, 500],
      sensor_mm: [10, 5],
      focalLength_mm: 20,
    },
  });

  it('derives fx from sensor and focal length', () => {
    expect(fxOf(cam())).toBeCloseTo(2000, 9); // 20 * 1000 / 10
  });

  it('defaults the principal point to the OpenCV image centre', () => {
    expect(principalPointOf(cam())).toEqual([499.5, 249.5]);
  });

  it('derives field of view rather than storing it', () => {
    expect(hfovDegOf(cam())).toBeCloseTo(28.07248694, 6);
    expect(vfovDegOf(cam())).toBeCloseTo(2 * (Math.atan(0.125) * 180) / Math.PI, 9);
    expect('fov_deg' in cam().camera).toBe(false);
  });

  it('reports slant and plan standoff separately', () => {
    expect(standoffM(cam())).toBeCloseTo(5, 9);
    expect(standoffHorizontalM(cam())).toBeCloseTo(3, 9);
  });
});

// -- correlations ---------------------------------------------------------

describe('Heskestad correlations', () => {
  it('matches the hand-computed 1 MW, 1 m case', () => {
    expect(flameHeightM(1000, 1)).toBeCloseTo(2.704499, 6);
    expect(virtualOriginM(1000, 1)).toBeCloseTo(0.295461, 6);
  });

  it('clamps a negative flame height to zero', () => {
    expect(flameHeightM(1, 5)).toBe(0);
  });

  it('does not clamp a virtual origin below the fuel surface', () => {
    expect(virtualOriginM(500, 3)).toBeLessThan(0);
  });

  it('converts non-circular pans by equal area', () => {
    expect(effectiveDiameterM(1)).toBeCloseTo(1.1283792, 6);
    const d = effectiveDiameterM(2.5);
    expect(Math.PI * (d / 2) ** 2).toBeCloseTo(2.5, 9);
  });

  it('opens the plume cone from the virtual origin', () => {
    const z0 = virtualOriginM(1000, 1);
    expect(plumeRadiusM(z0, 1000, 1)).toBeCloseTo(0, 12);
    expect(plumeRadiusM(z0 + 2, 1000, 1)).toBeCloseTo(2 * Math.tan(Math.PI / 12), 9);
  });

  it('agrees with the Python reader on the fixture burner', () => {
    // Reference values printed by python/fireplan on the same fixture.
    const b = primaryBurner(fixture())!;
    expect(burnerDiameterM(b)).toBeCloseTo(0.343929970, 9);
    expect(flameTipZM(b)).toBeCloseTo(1.396007906, 9);
  });
});

// -- checks ---------------------------------------------------------------

describe('plan checks', () => {
  const codes = (doc: PlanDocument): Set<string> => new Set(checkPlan(doc).map((i) => i.code));

  it('finds nothing wrong with the reference layout', () => {
    expect(hoodChecks(fixture())).toEqual([]);
  });

  it('flags flame reaching the canopy', () => {
    const doc = fixture();
    doc.objects.find((o) => o.type === 'hood')!['height_m' as never] = 1 as never;
    expect(new Set(hoodChecks(doc).map((i) => i.code))).toContain('flame-impingement');
  });

  it('flags a hood too small to capture the plume', () => {
    const doc = fixture();
    const hood = doc.objects.find((o) => o.type === 'hood')!;
    hood['opening_m' as never] = [0.5, 0.5] as never;
    expect(new Set(hoodChecks(doc).map((i) => i.code))).toContain('plume-spillage');
  });

  // -- hood placement ----------------------------------------------------
  //
  // A hood only captures the plume it is actually over. Judging capture from the
  // opening size alone lets a hood parked in the next bay report clean, which is a
  // false negative on a measurement-validity check.

  const hoodAt = (position: Vec3, quat?: Quat): PlanDocument => {
    const doc = fixture();
    const hood = doc.objects.find((o) => o.type === 'hood')!;
    hood.transform = { position_m: position, ...(quat ? { rotation_quat: quat } : {}) };
    return doc;
  };

  it('flags a hood that is nowhere near the burner', () => {
    const found = hoodChecks(hoodAt([100, 100, 0]));
    expect(found.map((i) => i.code)).toContain('hood-offset');
    // And it does not also claim the plume merely lacks margin.
    expect(found.map((i) => i.code)).not.toContain('plume-margin');
  });

  it('flags a hood nudged just past the burner', () => {
    // The reference opening is 8 ft; half of that plus a hair puts the burner out.
    const halfOpening = (8 * 0.3048) / 2;
    expect(hoodChecks(hoodAt([halfOpening + 0.01, 0, 0])).map((i) => i.code))
      .toContain('hood-offset');
    expect(hoodChecks(hoodAt([halfOpening - 0.01, 0, 0])).map((i) => i.code))
      .not.toContain('hood-offset');
  });

  it('spills when an off-centre fire pushes the plume past the rim', () => {
    // Centred, this hood is fine; the same hood shifted is not, because what has to
    // fit is a disk centred on the BURNER, not on the opening.
    expect(hoodChecks(fixture())).toEqual([]);
    expect(hoodChecks(hoodAt([0.9, 0, 0])).map((i) => i.code))
      .toEqual(expect.arrayContaining(['plume-spillage']));
  });

  it('reads an offset in the hood’s own frame, so yaw counts', () => {
    // A long narrow opening rotated 90 degrees presents its short side to an
    // offset the unrotated hood would have swallowed.
    const narrow = (doc: PlanDocument): PlanDocument => {
      const hood = doc.objects.find((o) => o.type === 'hood')!;
      hood['opening_m' as never] = [4, 0.8] as never;
      return doc;
    };
    const yaw90: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

    // Burner 1.2 m along the hood's local +X: inside a 4 m axis unrotated...
    expect(hoodChecks(narrow(hoodAt([-1.2, 0, 0]))).map((i) => i.code))
      .not.toContain('hood-offset');
    // ...and outside once that axis points along world Y instead.
    expect(hoodChecks(narrow(hoodAt([-1.2, 0, 0], yaw90))).map((i) => i.code))
      .toContain('hood-offset');
  });

  it('flags a quaternion that disagrees with its aim target', () => {
    const doc = fixture();
    const cam = doc.objects.find((o) => o.id === 'cam-gopro')!;
    cam.transform!.aimTarget_m = [5, 5, 0];
    expect(codes(doc)).toContain('aim-mismatch');
  });

  it('flags placeholder intrinsics but not datasheet ones', () => {
    const flagged = checkPlan(fixture())
      .filter((i) => i.code === 'nominal-intrinsics')
      .map((i) => i.objectId);
    expect(new Set(flagged)).toEqual(new Set(['cam-gopro', 'cam-iphone']));
    // Both IR cameras are seeded from a datasheet, so neither may be flagged.
    expect(flagged).not.toContain('cam-lwir-t650');
    expect(flagged).not.toContain('cam-mwir');
  });

  it('flags a plan with no burner', () => {
    expect(codes(newPlan('empty'))).toContain('no-burner');
  });

  // -- vertical translation --------------------------------------------
  //
  // The renderer applies the object transform and then the local opening or soffit
  // height, so a hood or a ceiling moved in Z is drawn where the transform puts it.
  // The checks read `height_m` alone and cleared a flame that was visibly inside
  // the canopy.

  const translated = (): PlanDocument => {
    const doc = newPlan('translated');
    doc.objects.push({
      id: 'burner-1', type: 'burner', transform: { position_m: [0, 0, 0] },
      footprint: { shape: 'circle', diameter_m: 0.3 }, rimHeight_m: 0.1,
      fire: { fuel: 'n-heptane', hrr_kw: 130, hrrCurve: null },
    } as never);
    doc.objects.push({
      id: 'hood-1', type: 'hood', transform: { position_m: [0, 0, -3] },
      opening_m: [4, 4], height_m: 4, skirtDepth_m: 0, duct: { diameter_m: 0.6, length_m: 2 },
    } as never);
    doc.objects.push({
      id: 'ceiling-1', type: 'ceiling', transform: { position_m: [0, 0, -3] },
      polygon_m: [[-3, -3], [3, -3], [3, 3], [-3, 3]], height_m: 4, thickness_m: 0.15,
    } as never);
    return doc;
  };

  it('judges a hood and a ceiling where their transforms put them', () => {
    const doc = translated();
    // A 130 kW, 0.3 m pan with a 0.1 m rim: mean tip at 1.44 m. Both surfaces are
    // drawn at 1 m, and both used to report all clear.
    expect(flameTipZM(primaryBurner(doc)!)).toBeCloseTo(1.440816, 5);
    expect(hoodOpeningZM(doc.objects[1] as never)).toBeCloseTo(1, 9);
    expect(hoodIntakeHeightM(doc.objects[1] as never)).toBeCloseTo(1, 9);
    expect(ceilingSoffitZM(doc.objects[2] as never)).toBeCloseTo(1, 9);
    expect(hoodChecks(doc).map((i) => i.code)).toContain('flame-impingement');
    expect(ceilingChecks(doc).map((i) => i.code)).toContain('ceiling-impingement');
  });

  it('still reads an untranslated hood and ceiling exactly as before', () => {
    const doc = translated();
    doc.objects[1].transform!.position_m = [0, 0, 0];
    doc.objects[2].transform!.position_m = [0, 0, 0];
    expect(hoodChecks(doc)).toEqual([]);
    expect(ceilingChecks(doc)).toEqual([]);
  });

  // -- more than one fire ----------------------------------------------

  it('checks a hood and a ceiling against every fire, naming the one it means', () => {
    const doc = fixture();
    doc.objects.push({
      id: 'burner-2', type: 'burner', name: 'Second pan',
      transform: { position_m: [5, 0, 0] },
      footprint: { shape: 'square', size_m: [0.3, 0.3] }, rimHeight_m: 0.1,
      fire: { fuel: 'n-heptane', hrr_kw: 5000, hrrCurve: null },
    } as never);
    // The reference hood does not cover the second fire...
    const offset = hoodChecks(doc).filter((i) => i.code === 'hood-offset');
    expect(offset).toHaveLength(1);
    expect(offset[0].message).toContain('Second pan');
    // ...and a 5 MW fire under a slab over it would reach it.
    doc.objects.push({
      id: 'ceiling-2', type: 'ceiling', transform: { position_m: [5, 0, 0] },
      polygon_m: [[-1, -1], [1, -1], [1, 1], [-1, 1]], height_m: 4,
    } as never);
    const hit = ceilingChecks(doc).filter((i) => i.objectId === 'ceiling-2');
    expect(hit.map((i) => i.code)).toContain('ceiling-impingement');
    expect(hit[0].message).toContain('Second pan');
    // And the plan says the framing does not look at that fire.
    const second = checkPlan(doc).filter((i) => i.code === 'secondary-burner');
    expect(second.map((i) => i.objectId)).toEqual(['burner-2']);
  });
});

// -- extents ------------------------------------------------------------

describe('what the layout occupies', () => {
  const zs = (pts: Vec3[]): number[] => pts.map((p) => p[2]);
  const xs = (pts: Vec3[]): number[] => pts.map((p) => p[0]);

  it('includes the actual rotated rectangular pan, beyond its equal-area flame diameter', () => {
    const doc = newPlan('long pan');
    doc.objects.push({ id: 'b', type: 'burner',
      transform: { position_m: [0, 0, 0], rotation_quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      footprint: { shape: 'rectangle', size_m: [20, 1] }, rimHeight_m: 0.1,
    } as BurnerObject);
    const ys = boundsPoints(doc).map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(-10, 9);
    expect(Math.max(...ys)).toBeCloseTo(10, 9);
  });

  it('includes an obstruction by its corners, not its origin', () => {
    // Fit saw a 20 x 12 x 8 m box as the point at its base centre and put the
    // camera inside it.
    const doc = newPlan('box');
    doc.objects.push({
      id: 'o', type: 'obstruction', transform: { position_m: [0, 0, 0] }, size_m: [20, 12, 8],
    } as never);
    const pts = boundsPoints(doc);
    expect(Math.max(...xs(pts))).toBeCloseTo(10, 9);
    expect(Math.min(...xs(pts))).toBeCloseTo(-10, 9);
    expect(Math.max(...zs(pts))).toBeCloseTo(8, 9);
  });

  it('includes a wall from its base height, and a slab where its transform puts it', () => {
    const doc = newPlan('raised');
    doc.objects.push({
      id: 'w', type: 'wall', transform: { position_m: [0, 0, 0] },
      polyline_m: [[0, 0], [1, 0]], height_m: 1, baseHeight_m: 10,
    } as never);
    doc.objects.push({
      id: 'c', type: 'ceiling', transform: { position_m: [0, 0, -3] },
      polygon_m: [[-1, -1], [1, -1], [1, 1], [-1, 1]], height_m: 4, thickness_m: 0.15,
    } as never);
    const pts = boundsPoints(doc);
    expect(Math.max(...zs(pts))).toBeCloseTo(11, 9);
    expect(zs(pts)).toContain(10);
    expect(zs(pts).some((z) => Math.abs(z - 1) < 1e-9)).toBe(true);
    expect(zs(pts).some((z) => Math.abs(z - 4) < 1e-9)).toBe(false);
  });

  it('reaches the hood apex, and the duct only when asked', () => {
    const doc = fixture();
    const hood = doc.objects.find((o) => o.type === 'hood')!;
    const opening = hoodOpeningZM(hood as never);
    const apex = opening + Math.max(Math.min(2.4384, 2.4384) * 0.45, 0.4);
    expect(Math.max(...zs(boundsPoints(doc)))).toBeCloseTo(apex, 6);
    expect(Math.max(...zs(boundsPoints(doc, { ducts: true })))).toBeGreaterThan(apex);
  });
});

// -- transforms -----------------------------------------------------------
//
// The 3D view applies rotation_quat to every object group, so anything that reads
// geometry back out -- checks, drawings, tables -- has to apply it too, or the
// picture and the verdict disagree about the same plan.

describe('object frames', () => {
  const slab = (quat?: Quat): CeilingObject => ({
    id: 'ceiling-1',
    type: 'ceiling',
    transform: { position_m: [0, 0, 0], ...(quat ? { rotation_quat: quat } : {}) },
    // Long in X, narrow in Y.
    polygon_m: [[-4, -0.5], [4, -0.5], [4, 0.5], [-4, 0.5]],
    height_m: 3,
  } as never);

  const yaw90: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

  it('rotates a footprint vertex into world space', () => {
    const [x, y] = footprintXY(slab(yaw90), [4, 0]);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(4, 9);
  });

  it('round-trips a point through toWorld and toLocal', () => {
    const o = slab(lookAtQuat([0, 0, 0], [1, 2, 3]));
    const back = toLocal(o, toWorld(o, [0.4, -1.2, 2]));
    expect(back[0]).toBeCloseTo(0.4, 9);
    expect(back[1]).toBeCloseTo(-1.2, 9);
    expect(back[2]).toBeCloseTo(2, 9);
  });

  it('judges ceiling coverage against the rotated footprint', () => {
    // (3, 0) is under the unrotated slab's long arm and outside it once yawed.
    expect(ceilingCoversXY(slab(), 3, 0)).toBe(true);
    expect(ceilingCoversXY(slab(yaw90), 3, 0)).toBe(false);
    expect(ceilingCoversXY(slab(yaw90), 0, 3)).toBe(true);
  });

  it('flags impingement only for the orientation actually drawn', () => {
    const doc = (quat?: Quat): PlanDocument => {
      const d = newPlan('rotated ceiling');
      d.objects.push({
        id: 'burner-main',
        type: 'burner',
        transform: { position_m: [3, 0, 0] },
        footprint: { shape: 'square', size_m: [0.3048, 0.3048] },
        rimHeight_m: 0.1,
        fire: { fuel: 'n-heptane', hrr_kw: 130, hrrCurve: null },
      } as never);
      d.objects.push({ ...slab(quat), height_m: 1.2 } as never);
      return d;
    };
    expect(new Set(ceilingChecks(doc()).map((i) => i.code))).toContain('ceiling-impingement');
    expect(new Set(ceilingChecks(doc(yaw90)).map((i) => i.code))).not.toContain('ceiling-impingement');
  });
});

// -- movement invariants --------------------------------------------------

describe('moving objects', () => {
  const camAt = (position: Vec3, target: Vec3 | null): CameraObject => ({
    id: 'cam-1',
    type: 'camera',
    transform: {
      position_m: position,
      rotation_quat: target ? lookAtQuat(position, target) : [0, 0, 0, 1],
      aimTarget_m: target,
    },
    camera: {
      modality: 'RGB', resolution_px: [1920, 1080], sensor_mm: [6.17, 4.55],
      focalLength_mm: 4.3, intrinsicsSource: 'nominal',
    },
    mount: { type: 'tripod', height_m: position[2] },
    recording: null,
  } as never);

  it('re-aims a camera carried to a new position', () => {
    // Without this, a camera dropped from the palette or dragged with the gizmo
    // keeps the orientation it was constructed with and points at nothing, while
    // still carrying an aimTarget_m claiming otherwise.
    const cam = camAt([-3, -1, 1.5], [0, 0, 0.75]);
    setPosition(cam, [3, 0, 1.5]);

    const off = angleBetweenDeg(
      sub(cam.transform!.aimTarget_m!, cam.transform!.position_m),
      forwardOf(cam.transform!.rotation_quat!),
    );
    expect(off).toBeLessThan(1e-6);
    expect(checkPlan({ ...newPlan('aim'), objects: [cam] }).map((i) => i.code))
      .not.toContain('aim-mismatch');
  });

  it('leaves a hand-rotated camera pointing where it was put', () => {
    const cam = camAt([-3, 0, 1.5], null);
    const before = [...cam.transform!.rotation_quat!];
    setPosition(cam, [2, 2, 1.5]);
    expect(cam.transform!.rotation_quat).toEqual(before);
  });

  it('keeps the advisory mount height in step with Z', () => {
    const cam = camAt([-3, 0, 1.5], [0, 0, 0.75]);
    setPosition(cam, [-3, 0, 2.2]);
    expect(cam.mount?.height_m).toBe(2.2);
  });

  it('drops the recorded aim when the orientation is set by hand', () => {
    const cam = camAt([-3, 0, 1.5], [0, 0, 0.75]);
    setRotation(cam, [0, 0, 0, 1]);
    expect(cam.transform!.aimTarget_m).toBeNull();
  });
});

// -- untrusted plan content -----------------------------------------------

describe('display colour', () => {
  const withColor = (color: unknown): CameraObject => {
    const doc = fixture();
    const cam = doc.objects.find((o) => o.type === 'camera') as CameraObject;
    cam.display = { ...(cam.display ?? {}), color } as never;
    return cam;
  };

  it('passes through a well-formed hex colour', () => {
    expect(cameraColor(withColor('#ff8800'))).toBe('#ff8800');
  });

  it('refuses a colour that would break out of an HTML attribute', () => {
    // A plan is someone else's file, and this value lands inside style="..." and
    // SVG fill="..." in the drawing export, which is assigned via innerHTML.
    const hostile = 'red"></span><img src=x onerror="alert(1)';
    const resolved = cameraColor(withColor(hostile));
    expect(resolved).toMatch(/^#[0-9a-f]{6}$/i);
    expect(resolved).not.toContain('<');
  });

  it('falls back for a non-string colour', () => {
    expect(cameraColor(withColor(42))).toMatch(/^#[0-9a-f]{6}$/i);
    expect(cameraColor(withColor(null))).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('rejects a bad colour at load time rather than sanitising it silently', () => {
    const doc = fixture();
    (doc.objects[0] as never as { display: unknown }).display = { color: 'red' };
    expect(validateStructure(doc).map((i) => i.code)).toContain('bad-color');
    // A legitimate one still loads.
    (doc.objects[0] as never as { display: unknown }).display = { color: '#A1B2C3' };
    expect(validateStructure(doc).map((i) => i.code)).not.toContain('bad-color');
  });
});

// -- ceilings -------------------------------------------------------------

describe('ceilings', () => {
  const planWith = (height: number, half = 3, offsetX = 0): PlanDocument => {
    const doc = newPlan('ceiling');
    doc.objects.push({
      id: 'burner-main',
      type: 'burner',
      transform: { position_m: [0, 0, 0] },
      footprint: { shape: 'square', size_m: [0.3048, 0.3048] },
      rimHeight_m: 0.1,
      fire: { fuel: 'n-heptane', hrr_kw: 130, hrrCurve: null },
    } as never);
    doc.objects.push({
      id: 'ceiling-main',
      type: 'ceiling',
      transform: { position_m: [offsetX, 0, 0] },
      polygon_m: [[-half, -half], [half, -half], [half, half], [-half, half]],
      height_m: height,
      thickness_m: 0.15,
    } as never);
    return doc;
  };

  const codes = (doc: PlanDocument): Set<string> =>
    new Set(ceilingChecks(doc).map((i) => i.code));

  it('flags a flame reaching the soffit', () => {
    expect(codes(planWith(1.2))).toContain('ceiling-impingement');
  });

  it('warns on marginal clearance before it impinges', () => {
    const found = codes(planWith(1.6));
    expect(found).toContain('ceiling-clearance');
    expect(found).not.toContain('ceiling-impingement');
  });

  it('stays silent under a high ceiling', () => {
    expect(ceilingChecks(planWith(6))).toEqual([]);
  });

  it('ignores a slab that does not cover the fire', () => {
    expect(ceilingChecks(planWith(1, 1, 10))).toEqual([]);
  });

  it('tests containment against the polygon, offset included', () => {
    const slab = ceilings(planWith(3, 2))[0];
    expect(ceilingCoversXY(slab, 0, 0)).toBe(true);
    expect(ceilingCoversXY(slab, 1.99, 1.99)).toBe(true);
    expect(ceilingCoversXY(slab, 2.01, 0)).toBe(false);
    expect(ceilingCoversXY(slab, 0, -2.5)).toBe(false);
  });

  it('computes area by the shoelace formula, including concave slabs', () => {
    expect(ceilingAreaM2(ceilings(planWith(3, 2.5))[0])).toBeCloseTo(25, 9);

    const doc = newPlan('L');
    doc.objects.push({
      id: 'c',
      type: 'ceiling',
      polygon_m: [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]],
      height_m: 3,
    } as never);
    expect(ceilingAreaM2(ceilings(doc)[0])).toBeCloseTo(12, 9);
  });

  it('agrees with the Python reader, which sees the same geometry', () => {
    // Both implementations must reach the same verdict or the editor and the
    // reader would disagree about whether a plan is sound.
    expect(codes(planWith(1.2))).toContain('ceiling-impingement');
    expect(ceilingChecks(planWith(6))).toEqual([]);
  });

  it('serialises in canonical key order', () => {
    const doc = newPlan('order');
    doc.objects.push({
      thickness_m: 0.15,
      height_m: 3,
      type: 'ceiling',
      polygon_m: [[0, 0], [1, 0], [1, 1]],
      id: 'c',
    } as never);
    expect(Object.keys(JSON.parse(serializePlan(doc)).objects[0]))
      .toEqual(['id', 'type', 'polygon_m', 'height_m', 'thickness_m']);
  });
});

// -- load-time validation -------------------------------------------------

describe('structural validation', () => {
  const codesOf = (doc: PlanDocument): Set<string> =>
    new Set(validateStructure(doc).map((i) => i.code));

  const withObject = (raw: unknown): PlanDocument => {
    const doc = newPlan('validation');
    doc.objects.push(raw as never);
    return doc;
  };

  it('accepts the reference fixture', () => {
    expect(validateStructure(fixture())).toEqual([]);
  });

  it('accepts a fresh empty plan', () => {
    expect(validateStructure(newPlan('empty'))).toEqual([]);
  });

  // These mirror the cases python/tests/test_roundtrip.py asserts the JSON Schema
  // rejects. Keeping the two lists aligned is what stops the browser check from
  // drifting away from the normative schema.
  it('rejects a camera missing its intrinsics', () => {
    const found = codesOf(withObject({
      id: 'cam', type: 'camera',
      camera: { modality: 'RGB', resolution_px: [640, 480] },
    }));
    expect(found).toContain('bad-sensor');
    expect(found).toContain('bad-focal-length');
  });

  it('rejects a populated recording block, which v1 reserves', () => {
    expect(codesOf(withObject({
      id: 'cam', type: 'camera',
      camera: { modality: 'RGB', resolution_px: [640, 480], sensor_mm: [6, 4.5], focalLength_mm: 4 },
      recording: { path: 'video.mp4' },
    }))).toContain('reserved-recording');
  });

  it('rejects a circular burner with no diameter', () => {
    expect(codesOf(withObject({
      id: 'b', type: 'burner', footprint: { shape: 'circle', size_m: [1, 1] },
    }))).toContain('bad-diameter');
  });

  it('rejects a degenerate obstruction', () => {
    for (const size of [[1, 0, 2], [1, 2, -2]]) {
      expect(codesOf(withObject({
        id: 'o', type: 'obstruction', transform: { position_m: [0, 0, 0] }, size_m: size,
      }))).toContain('bad-size');
    }
  });

  it('rejects a zero-area burner footprint', () => {
    expect(codesOf(withObject({
      id: 'b', type: 'burner', footprint: { shape: 'rectangle', size_m: [1, 0] },
    }))).toContain('bad-size');
  });

  it('rejects a ceiling with too few polygon points', () => {
    expect(codesOf(withObject({
      id: 'c', type: 'ceiling', polygon_m: [[0, 0], [1, 0]], height_m: 3,
    }))).toContain('bad-polygon');
  });

  it('rejects duplicate ids', () => {
    const doc = newPlan('dupes');
    for (let i = 0; i < 2; i += 1) {
      doc.objects.push({ id: 'same', type: 'burner', footprint: { shape: 'circle', diameter_m: 0.3 } } as never);
    }
    expect(codesOf(doc)).toContain('duplicate-id');
  });

  it('rejects a non-metric declaration', () => {
    const doc = newPlan('imperial');
    (doc.units as unknown as Record<string, unknown>).length = 'ft';
    expect(codesOf(doc)).toContain('bad-units');
  });

  it('rejects NaN and missing coordinates rather than letting them reach the renderer', () => {
    expect(codesOf(withObject({
      id: 'b', type: 'burner',
      transform: { position_m: [0, Number.NaN, 0] },
      footprint: { shape: 'circle', diameter_m: 0.3 },
    }))).toContain('bad-position');

    expect(codesOf(withObject({
      id: 'b2', type: 'burner',
      transform: { position_m: [0, 0] },
      footprint: { shape: 'circle', diameter_m: 0.3 },
    }))).toContain('bad-position');
  });

  it('leaves unknown object types alone', () => {
    expect(validateStructure(withObject({
      id: 'tc', type: 'thermocoupleTree', heights_m: [0.5, 1],
    }))).toEqual([]);
  });

  it('refuses a plan whose objects are not a list, rather than emptying it', () => {
    // `parsePlan` used to replace a map with `[]` before validation saw it, so the
    // file opened as "Objects (0)" and lost its collection on the next save.
    const text = JSON.stringify({ ...newPlan('map'), objects: { kept: { id: 'kept', type: 'burner' } } });
    const doc = parsePlan(text);
    expect(codesOf(doc)).toContain('bad-objects');
    expect(() => parseAndValidatePlan(text)).toThrow(/not a list/);
  });

  it('rejects wall openings the builder cannot slice', () => {
    // `openings: {}` passed, was installed, and threw out of the builder --
    // leaving stale panels over an empty scene and a Save offering the bad file.
    const wall = (openings: unknown) => ({
      id: 'w', type: 'wall', polyline_m: [[-1.5, 0], [1.5, 0]], height_m: 2.4, openings,
    });
    expect(codesOf(withObject(wall({})))).toContain('bad-openings');
    expect(codesOf(withObject(wall([{ offset_m: 0.5, width_m: -1, height_m: 2 }])))).toContain('bad-openings');
    expect(codesOf(withObject(wall([{ offset_m: 'a', width_m: 1, height_m: 2 }])))).toContain('bad-openings');
    expect(codesOf(withObject(wall([{ offset_m: 0.5, width_m: 0.8, height_m: 2, sillHeight_m: -1 }])))).toContain('bad-openings');
    expect(validateStructure(withObject(wall([{ offset_m: 0.5, width_m: 0.8, height_m: 2 }])))).toEqual([]);
    expect(validateStructure(withObject(wall(null)))).toEqual([]);
  });

  it('rejects malformed principal points before they reach preview projection', () => {
    for (const principalPoint_px of [[1], ['x', 2], {}, 'xy']) {
      const camera = fixture().objects.find((o) => o.type === 'camera') as CameraObject;
      camera.camera.principalPoint_px = principalPoint_px as never;
      expect(codesOf(withObject(camera))).toContain('bad-principal-point');
    }
  });

  it('accepts a negative wall base height allowed by every supported schema', () => {
    expect(validateStructure(withObject({
      id: 'w', type: 'wall', polyline_m: [[0, 0], [1, 0]], height_m: 2, baseHeight_m: -1,
    }))).toEqual([]);
  });

  it('rejects the optional lengths the builders multiply into geometry', () => {
    expect(codesOf(withObject({
      id: 'w', type: 'wall', polyline_m: [[0, 0], [1, 0]], height_m: 2, thickness_m: 'thick',
    }))).toContain('bad-thickness');
    expect(codesOf(withObject({
      id: 'w', type: 'wall', polyline_m: [[0, 0], [1, 0]], height_m: 2, baseHeight_m: Number.NaN,
    }))).toContain('bad-base-height');
    expect(codesOf(withObject({
      id: 'h', type: 'hood', opening_m: [2, 2], height_m: 2.7, skirtDepth_m: -0.3,
    }))).toContain('bad-skirt-depth');
    expect(codesOf(withObject({
      id: 'h', type: 'hood', opening_m: [2, 2], height_m: 2.7, duct: { diameter_m: 0 },
    }))).toContain('bad-duct');
    expect(codesOf(withObject({
      id: 'b', type: 'burner', footprint: { shape: 'circle', diameter_m: 0.3 }, rimHeight_m: 'x',
    }))).toContain('bad-rim-height');
    // Null is "unstated" everywhere, and the reference plan is untouched.
    expect(validateStructure(withObject({
      id: 'h', type: 'hood', opening_m: [2, 2], height_m: 2.7, skirtDepth_m: null, duct: null,
    }))).toEqual([]);
    expect(validateStructure(fixture())).toEqual([]);
  });

  it('rejects a radiative fraction outside the range the physics uses', () => {
    // Not merely a schema range. `radiativeFractionOf` substitutes 0.3 for
    // anything outside it, so a file that loads with 1.5 in it has every heat flux
    // in the plan computed from a number other than the one on screen and on disk,
    // with nothing said about it.
    for (const bad of [1.5, 0, -0.2, 'a third']) {
      expect(codesOf(withObject({
        id: 'b', type: 'burner',
        footprint: { shape: 'circle', diameter_m: 0.3 },
        fire: { hrr_kw: 100, radiativeFraction: bad },
      }))).toContain('bad-radiative-fraction');
    }
    // Absent and null both mean "use the default", and the endpoints are legal.
    for (const ok of [undefined, null, 0.35, 1]) {
      expect(codesOf(withObject({
        id: 'b', type: 'burner',
        footprint: { shape: 'circle', diameter_m: 0.3 },
        fire: { hrr_kw: 100, radiativeFraction: ok },
      }))).not.toContain('bad-radiative-fraction');
    }
  });

  it('rejects a mount type the schema does not have, per object kind', () => {
    // The camera and instrument mount enums differ deliberately: an instrument can
    // sit on the floor, and a format 1.0 camera could not say so.
    expect(codesOf(withObject({
      id: 'hf', type: 'heatFluxSensor', mount: { type: 'trapeze' },
    }))).toContain('bad-mount-type');
    expect(codesOf(withObject({
      id: 'cam', type: 'camera',
      camera: { modality: 'RGB', resolution_px: [640, 480], sensor_mm: [6, 4.5], focalLength_mm: 4 },
      mount: { type: 'floor' },
    }))).toContain('bad-mount-type');

    expect(codesOf(withObject({
      id: 'hf2', type: 'heatFluxSensor', mount: { type: 'floor', height_m: 0 },
    }))).not.toContain('bad-mount-type');
  });

  it('rejects a gauge kind and a bead diameter the schema would reject', () => {
    expect(codesOf(withObject({
      id: 'hf', type: 'heatFluxSensor', gauge: { kind: 'acme-2000' },
    }))).toContain('bad-gauge-kind');
    expect(codesOf(withObject({
      id: 'tc', type: 'thermocouple', thermocouple: { beadDiameter_mm: -1 },
    }))).toContain('bad-bead-diameter');

    expect(validateStructure(withObject({
      id: 'hf2', type: 'heatFluxSensor', gauge: { kind: 'gardon', waterCooled: true },
    }))).toEqual([]);
    expect(validateStructure(withObject({
      id: 'tc2', type: 'thermocouple', thermocouple: { tcType: 'T', beadDiameter_mm: 1.5 },
    }))).toEqual([]);
  });

  it('rejects top-level values the panels consume without looking', () => {
    // A string temperature reached `numberField().toFixed` and threw out of the
    // inspector before the toolbar existed; a display unit with no conversion row
    // turned every length on screen into NaN. The schema rejects all of these.
    const withEnv = (environment: unknown): PlanDocument => ({ ...newPlan('env'), environment } as PlanDocument);
    expect(codesOf(withEnv({ ambientTemperature_C: '20' }))).toContain('bad-environment');
    expect(codesOf(withEnv({ floorSize_m: [20] }))).toContain('bad-environment');
    expect(codesOf(withEnv({ floorSize_m: ['20', 20] }))).toContain('bad-environment');
    expect(codesOf(withEnv({ floorSize_m: [20, Number.NaN] }))).toContain('bad-environment');
    expect(codesOf(withEnv({ ceilingHeight_m: 0 }))).toContain('bad-environment');
    expect(codesOf(withEnv({ notes: 5 }))).toContain('bad-environment');
    expect(codesOf(withEnv([]))).toContain('bad-environment');
    // Null and absent both mean "unstated", as everywhere else in the format.
    expect(validateStructure(withEnv({ ambientTemperature_C: null, ceilingHeight_m: null, notes: null }))).toEqual([]);
    expect(validateStructure(withEnv(null))).toEqual([]);

    const withUnits = (display: unknown): PlanDocument => {
      const doc = newPlan('units');
      (doc.units as unknown as Record<string, unknown>).display = display;
      return doc;
    };
    expect(codesOf(withUnits({ length: 'yards' }))).toContain('bad-display-units');
    expect(codesOf(withUnits({ angle: 'grad' }))).toContain('bad-display-units');
    expect(codesOf(withUnits('ft'))).toContain('bad-display-units');
    expect(validateStructure(withUnits({ length: 'ft', angle: 'deg' }))).toEqual([]);

    const withMeta = (meta: unknown): PlanDocument => ({ ...newPlan('meta'), meta } as PlanDocument);
    expect(codesOf(withMeta({ title: 7 }))).toContain('bad-meta');
    expect(codesOf(withMeta('plan'))).toContain('bad-meta');
    expect(validateStructure(withMeta({ title: 'Plan', source: { tool: 'fds' }, anything: 1 }))).toEqual([]);

    const azimuth = newPlan('north');
    (azimuth.coordinateSystem as unknown as Record<string, unknown>).northAzimuth_rad = 'north';
    expect(codesOf(azimuth)).toContain('bad-north-azimuth');
    expect(validateStructure(fixture())).toEqual([]);
  });

  it('summarises errors for a dialog without dumping all of them', () => {
    const doc = newPlan('many');
    for (let i = 0; i < 20; i += 1) {
      doc.objects.push({ id: `h${i}`, type: 'hood', opening_m: [0, 0], height_m: -1 } as never);
    }
    const text = describeErrors(validateStructure(doc));
    expect(text).toContain('…and');
    expect(text.split('\n').length).toBeLessThanOrEqual(9);
  });
});

// -- units ----------------------------------------------------------------

describe('unit parsing', () => {
  it('reads a bare number in the display unit', () => {
    expect(parseLength('2.5', 'm')).toBeCloseTo(2.5, 9);
    expect(parseLength('9', 'ft')).toBeCloseTo(2.7432, 9);
  });

  it('lets an explicit suffix override the display unit', () => {
    // The point: someone working in metres can still type 9ft.
    expect(parseLength('9ft', 'm')).toBeCloseTo(2.7432, 9);
    expect(parseLength('250mm', 'ft')).toBeCloseTo(0.25, 9);
    expect(parseLength("9'", 'm')).toBeCloseTo(2.7432, 9);
    expect(parseLength('12"', 'm')).toBeCloseTo(0.3048, 9);
  });

  it('reads feet and inches as one value', () => {
    expect(parseLength(`5' 6"`, 'm')).toBeCloseTo(5 * 0.3048 + 6 * 0.0254, 9);
    expect(parseLength('5ft6in', 'm')).toBeCloseTo(5 * 0.3048 + 6 * 0.0254, 9);
  });

  it('rejects nonsense rather than storing NaN', () => {
    for (const bad of ['', 'abc', '12 furlongs', '--3']) {
      expect(parseLength(bad, 'm')).toBeNull();
    }
  });

  it('formats without trailing zeros', () => {
    expect(formatLength(2.74, 'm')).toBe('2.74');
    expect(formatLength(2.7432, 'ft')).toBe('9');
  });
});
