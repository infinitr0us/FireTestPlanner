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
import { columnsToQuat, forwardOf, lookAtQuat, quatToColumns } from './math';
import {
  burnerDiameterM,
  ceilingAreaM2,
  ceilingChecks,
  ceilingCoversXY,
  ceilings,
  checkPlan,
  flameTipZM,
  fxOf,
  hfovDegOf,
  hoodChecks,
  newPlan,
  parsePlan,
  primaryBurner,
  principalPointOf,
  standoffHorizontalM,
  standoffM,
  vfovDegOf,
} from './plan';
import { serializePlan } from './serialize';
import type { CameraObject, PlanDocument } from './types';
import { formatLength, parseLength } from './units';
import { describeErrors, validateStructure } from './validate';

const FIXTURE_PATH = fileURLToPath(new URL('../../../fixtures/pool-fire-camera-row.ftp.json', import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const fixture = (): PlanDocument => parsePlan(FIXTURE_TEXT);

// -- serialisation parity -------------------------------------------------

describe('canonical serialisation', () => {
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

  it('does not rewrite numeric-looking text inside strings', () => {
    const doc = newPlan('regex safety');
    doc.meta = { ...doc.meta, notes: 'measured at [1,2] and [3, 4]' };
    expect(parsePlan(serializePlan(doc)).meta?.notes).toBe('measured at [1,2] and [3, 4]');
  });

  it('rejects a file that is not a fire test plan', () => {
    expect(() => parsePlan('{"format":"something-else"}')).toThrow(/Not a fire test plan/);
    expect(() => parsePlan('{not json')).toThrow(/Invalid JSON/);
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
    expect(new Set(flagged)).toEqual(new Set(['cam-mwir', 'cam-gopro', 'cam-iphone']));
    expect(flagged).not.toContain('cam-lwir-t650');
  });

  it('flags a plan with no burner', () => {
    expect(codes(newPlan('empty'))).toContain('no-burner');
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
