/**
 * Format 1.1: camera zoom, heat flux gauges, thermocouple rakes, the derived
 * version stamp, and the user-editable preset library.
 *
 * The physics here is mirrored in python/tests/test_instruments.py. Where a value
 * is pinned, the arithmetic is in a comment rather than obtained by calling the
 * code under test -- these numbers are what a fire engineer sizes instruments on.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RADIATIVE_FRACTION, plumeCentrelineRiseK, pointSourceFluxKwM2 } from './correlations';
import { createHeatFluxSensor, createThermocouple } from './factory';
import { forwardOf, lookAtQuat, upOf } from './math';
import { setAimTarget } from './transform';
import {
  beadOffsetsOf,
  beadVerdict,
  cameras,
  effectiveFocalLengthMm,
  firePointSourceM,
  flameRadiusAtZ,
  framingOf,
  fuelSurfaceZM,
  fxOf,
  gaugeRangeKwM2,
  gaugeVerdict,
  gaugeViewAngleDeg,
  groundSampleDistanceM,
  hfovDegOf,
  heatFluxEstimate,
  heatFluxSensors,
  instrumentChecks,
  isPointVisible,
  newPlan,
  objectColor,
  parsePlan,
  positionOf,
  quatOf,
  radiativeFractionOf,
  tcMaxTemperatureC,
  TC_MAX_TEMPERATURE_C,
  standoffM,
  thermocoupleBeads,
  thermocoupleVerdict,
  thermocouples,
  verticalCoverageM,
  vfovDegOf,
  zoomOf,
  checkPlan,
  plotSequenceMismatch,
} from './plan';
import type { CameraPreset } from './presets';
import {
  adoptShellPresets,
  applyPresetToSpec,
  BUILTIN_CAMERA_PRESETS,
  cameraPresets,
  customCameraPresets,
  deleteCustomPreset,
  findPreset,
  isCustomPreset,
  keepPresetsForSession,
  presetFromCamera,
  presetIdFromLabel,
  presetsArePersistent,
  reloadCustomPresets,
  resetCustomPresets,
  saveCustomPreset,
  specFromPreset,
} from './presets';
import { canonicalize, serializePlan } from './serialize';
import { maxVersion, requiredFormatVersion } from './types';
import type {
  BurnerObject,
  CameraObject,
  HeatFluxSensorObject,
  PlanDocument,
  ThermocoupleObject,
  Vec3,
} from './types';
import { validateStructure } from './validate';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../fixtures/pool-fire-camera-row.ftp.json', import.meta.url),
);
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const fixture = (): PlanDocument => parsePlan(FIXTURE_TEXT);

const codes = (doc: PlanDocument): Set<string> =>
  new Set(instrumentChecks(doc).map((i) => i.code));

/** A plan holding one camera placed from `preset` -- what the app writes to disk
 *  after the user picks it, and therefore what the load boundary later sees. */
const planWithCameraFrom = (preset: CameraPreset): PlanDocument => {
  const doc = newPlan('placed from a preset');
  doc.objects.push({
    id: 'cam', type: 'camera',
    transform: { position_m: [-2, 0, 1] },
    camera: specFromPreset(preset),
  });
  return doc;
};

/** A 1 ft heptane pan at the origin -- the reference fire, without the rig. */
function firePlan(hrrKw = 130, radiativeFraction?: number): PlanDocument {
  const doc = newPlan('instrument test');
  const burner: BurnerObject = {
    id: 'burner-main',
    type: 'burner',
    transform: { position_m: [0, 0, 0] },
    footprint: { shape: 'square', size_m: [0.3048, 0.3048] },
    rimHeight_m: 0.1,
    fire: { fuel: 'n-heptane', hrr_kw: hrrKw, hrrCurve: null },
  };
  if (radiativeFraction !== undefined) burner.fire!.radiativeFraction = radiativeFraction;
  doc.objects.push(burner);
  return doc;
}

function addGauge(
  doc: PlanDocument,
  position: Vec3,
  opts: { aim?: Vec3; range?: number | null; viewAngle?: number; id?: string } = {},
): HeatFluxSensorObject {
  const aim = opts.aim ?? (firePointSourceM(doc) as Vec3);
  const gauge: HeatFluxSensorObject = {
    id: opts.id ?? 'hf-1',
    type: 'heatFluxSensor',
    transform: {
      position_m: position,
      rotation_quat: lookAtQuat(position, aim),
      aimTarget_m: aim,
    },
    gauge: {
      range_kw_m2: opts.range === undefined ? 50 : opts.range,
      viewAngle_deg: opts.viewAngle ?? 180,
    },
  };
  doc.objects.push(gauge);
  return gauge;
}

function addRake(
  doc: PlanDocument,
  position: Vec3,
  offsets: number[],
  opts: { tcType?: 'K' | 'J' | 'T'; id?: string } = {},
): ThermocoupleObject {
  const rake: ThermocoupleObject = {
    id: opts.id ?? 'tc-1',
    type: 'thermocouple',
    transform: { position_m: position },
    beadOffsets_m: offsets,
    thermocouple: { tcType: opts.tcType ?? 'K' },
  };
  doc.objects.push(rake);
  return rake;
}

const camera = (spec: Partial<CameraObject['camera']> = {}): CameraObject => ({
  id: 'cam',
  type: 'camera',
  transform: { position_m: [-2, 0, 0], rotation_quat: lookAtQuat([-2, 0, 0], [0, 0, 0]) },
  camera: {
    modality: 'RGB',
    resolution_px: [1000, 500],
    sensor_mm: [10, 5],
    focalLength_mm: 20,
    ...spec,
  },
});

// -- camera zoom ----------------------------------------------------------

describe('camera zoom', () => {
  it('defaults to 1x and is not stored', () => {
    const cam = camera();
    expect(zoomOf(cam)).toBe(1);
    expect(effectiveFocalLengthMm(cam)).toBe(20);
    // 1x is the absence of a zoom rather than a value, so a plan that does not use
    // the feature keeps declaring format 1.0.
    expect('zoomFactor' in cam.camera).toBe(false);
  });

  it('multiplies the effective focal length but leaves the lens alone', () => {
    const cam = camera({ zoomFactor: 2 });
    expect(effectiveFocalLengthMm(cam)).toBe(40);
    expect(cam.camera.focalLength_mm).toBe(20);
  });

  it('halves both fields of view at 2x', () => {
    const plain = camera();
    const zoomed = camera({ zoomFactor: 2 });
    // hfov = 2 atan(10 / (2*40)) = 2 atan(0.125)
    expect(hfovDegOf(zoomed)).toBeCloseTo((2 * Math.atan(0.125) * 180) / Math.PI, 9);
    expect(Math.tan((hfovDegOf(zoomed) * Math.PI) / 360))
      .toBeCloseTo(Math.tan((hfovDegOf(plain) * Math.PI) / 360) / 2, 9);
    expect(Math.tan((vfovDegOf(zoomed) * Math.PI) / 360))
      .toBeCloseTo(Math.tan((vfovDegOf(plain) * Math.PI) / 360) / 2, 9);
  });

  it('scales fx and the ground sample distance', () => {
    expect(fxOf(camera({ zoomFactor: 2 }))).toBeCloseTo(4000, 9);
    expect(groundSampleDistanceM(camera({ zoomFactor: 2 })))
      .toBeCloseTo(groundSampleDistanceM(camera()) / 2, 12);
  });

  it('narrows what the camera can actually see', () => {
    // Half the vertical field is atan(2.5/20) = 7.13 deg, which is 0.25 m of height
    // at the 2 m standoff. A point at 0.2 m is inside that and outside half of it.
    const edge: Vec3 = [0, 0, 0.2];
    expect(isPointVisible(camera(), edge)).toBe(true);
    expect(isPointVisible(camera({ zoomFactor: 2 }), edge)).toBe(false);
  });

  it('reports a coverage the framing verdict agrees with', () => {
    // The strip height and "is the flame tip in frame?" must not disagree. They
    // would if coverage came from the field of view, which spans the whole sensor
    // while `isPointVisible` judges pixel CENTRES -- half a pixel per side, which
    // is invisible until a camera is marginal and then reads as a contradiction.
    //
    // Measured across the optical axis, which is what the figure means: the camera
    // is tilted down at the fire, so this is not a vertical span in world Z.
    const doc = fixture();
    const cam = cameras(doc).find((c) => c.id === 'cam-mwir')!;
    const covers = verticalCoverageM(cam);
    const d = standoffM(cam);
    const p = positionOf(cam);
    const fwd = forwardOf(quatOf(cam));
    const up = upOf(quatOf(cam));
    const eps = 1e-4;
    const at = (offset: number): Vec3 => [
      p[0] + fwd[0] * d + up[0] * offset,
      p[1] + fwd[1] * d + up[1] * offset,
      p[2] + fwd[2] * d + up[2] * offset,
    ];

    for (const edge of [covers / 2, -covers / 2]) {
      const inward = -Math.sign(edge) * eps;
      expect(isPointVisible(cam, at(edge + inward))).toBe(true);
      expect(isPointVisible(cam, at(edge - inward))).toBe(false);
    }

    // And it is genuinely narrower than the geometric field, not equal to it.
    const geometric = 2 * Math.tan((vfovDegOf(cam) * Math.PI) / 360) * d;
    expect(covers).toBeLessThan(geometric);
    expect(covers).toBeGreaterThan(geometric * 0.99);
  });

  it.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY, null])(
    'falls back to 1x rather than infinity for %p',
    (bad) => {
      const cam = camera({ zoomFactor: bad as number | null });
      expect(zoomOf(cam)).toBe(1);
      expect(fxOf(cam)).toBeCloseTo(2000, 9);
    },
  );

  it('rejects a non-positive zoom at the load boundary', () => {
    const doc = newPlan('bad zoom');
    doc.objects.push(camera({ zoomFactor: 0 }));
    expect(validateStructure(doc).map((i) => i.code)).toContain('bad-zoom');
  });

  it('serialises the zoom next to the focal length it modifies', () => {
    const doc = newPlan('zoomed');
    doc.objects.push(camera({ zoomFactor: 2 }));
    const keys = Object.keys(
      (canonicalize(doc).objects as Array<Record<string, unknown>>)[0].camera as object,
    );
    expect(keys.indexOf('zoomFactor')).toBe(keys.indexOf('focalLength_mm') + 1);
  });
});

// -- the point source -----------------------------------------------------

describe('a second fire', () => {
  it('still names the secondary fire when the primary has no HRR', () => {
    const doc = firePlan(100);
    (doc.objects[0] as BurnerObject).fire!.hrr_kw = null;
    const second = withSecondBurner(doc);
    expect(checkPlan(doc).filter((i) => i.code === 'secondary-burner').map((i) => i.objectId))
      .toEqual([second.id]);
  });
  const withSecondBurner = (
    doc: PlanDocument, position: Vec3 = [5, 0, 0], hrrKw = 1000, id = 'burner-2',
  ): BurnerObject => {
    const burner: BurnerObject = {
      id, type: 'burner', name: 'Second pan',
      transform: { position_m: position },
      footprint: { shape: 'square', size_m: [0.3, 0.3] },
      rimHeight_m: 0.1,
      fire: { fuel: 'n-heptane', hrr_kw: hrrKw, hrrCurve: null },
    };
    doc.objects.push(burner);
    return burner;
  };

  it('puts a bead above a second burner in that burner\'s fire', () => {
    // The reviewer's case: a type-T bead half a metre above a megawatt secondary
    // was called "outside the plume" and predicted to read close to ambient,
    // because the only fire the beads were placed against was the primary.
    const doc = firePlan(100);
    const second = withSecondBurner(doc);
    doc.objects.push({
      id: 'tc-1', type: 'thermocouple', transform: { position_m: [5, 0, 0.5] },
      beadOffsets_m: [0], thermocouple: { tcType: 'T' },
    } as never);

    const bead = thermocoupleBeads(doc, doc.objects[2] as ThermocoupleObject)[0];
    expect(bead.region).toBe('flame');
    expect(bead.radialM).toBeCloseTo(0, 9);
    const found = codes(doc);
    expect(found).toContain('tc-over-temperature');
    expect(found).not.toContain('tc-outside-plume');
    // And the plan says the framing does not look at that fire.
    expect(checkPlan(doc).filter((i) => i.code === 'secondary-burner').map((i) => i.objectId))
      .toEqual([second.id]);
  });

  it('reads the hotter centreline for a bead inside two plumes', () => {
    const doc = firePlan(100);
    withSecondBurner(doc, [0.6, 0, 0], 1000);
    doc.objects.push({
      id: 'tc-1', type: 'thermocouple', transform: { position_m: [0.3, 0, 6] }, beadOffsets_m: [0],
    } as never);
    const bead = thermocoupleBeads(doc, doc.objects[2] as ThermocoupleObject)[0];
    expect(bead.region).toBe('plume');

    // The same 1000 kW pan on its own gives the same figure: the 100 kW plume the
    // bead also sits in is cooler up here, and does not add to it.
    const alone = newPlan('one big fire');
    withSecondBurner(alone, [0.6, 0, 0], 1000, 'burner-main');
    alone.objects.push({
      id: 'tc-1', type: 'thermocouple', transform: { position_m: [0.3, 0, 6] }, beadOffsets_m: [0],
    } as never);
    const ref = thermocoupleBeads(alone, alone.objects[1] as ThermocoupleObject)[0];
    expect(bead.gasTemperatureC).toBeCloseTo(ref.gasTemperatureC!, 9);
    expect(bead.gasTemperatureC!).toBeGreaterThan(100);
  });

  it('sums incident flux over every fire and names the dominant one', () => {
    const doc = firePlan(130);
    const second = withSecondBurner(doc, [5, 0, 0], 130);
    const z = firePointSourceM(doc)![2];
    // Facing the primary from 2 m away, with the second fire 7 m behind the source.
    const gauge = addGauge(doc, [-2, 0, z]);
    const e = heatFluxEstimate(doc, gauge)!;
    const alone = firePlan(130);
    const ref = heatFluxEstimate(alone, addGauge(alone, [-2, 0, z]))!;
    expect(e.sourceId).toBe('burner-main');
    expect(e.distanceM).toBeCloseTo(2, 9);
    expect(e.incidentKwM2).toBeGreaterThan(ref.incidentKwM2);
    // Not to nine places: the two pans differ by 5 mm of side, so the second
    // source sits a hair off the primary's height and its cosine is not exactly 1.
    expect(e.incidentKwM2).toBeCloseTo(ref.incidentKwM2 * (1 + 4 / 49), 6);

    // Facing the second fire instead: the primary is behind the face and adds
    // nothing, and the figures are to the second fire.
    const other = addGauge(doc, [2.5, 0, z], { aim: [5, 0, z], id: 'hf-2' });
    const e2 = heatFluxEstimate(doc, other)!;
    expect(e2.sourceId).toBe(second.id);
    expect(e2.facesFire).toBe(true);
    expect(e2.distanceM).toBeCloseTo(2.5, 4);   // the pans differ by 5 mm of side
    // The near-field message names the fire it is near, not the primary.
    const near = addGauge(doc, [4.6, 0, z], { aim: [5, 0, z], id: 'hf-3' });
    expect(heatFluxEstimate(doc, near)!.nearField).toBe(true);
    expect(instrumentChecks(doc).some((i) => i.objectId === 'hf-3' && i.code === 'gauge-near-field'))
      .toBe(true);
  });
});

describe('the fire as a point source', () => {
  it('sits at mid-flame on the burner axis', () => {
    const doc = firePlan();
    const source = firePointSourceM(doc) as Vec3;
    expect(source[0]).toBeCloseTo(0, 12);
    expect(source[1]).toBeCloseTo(0, 12);
    expect(source[2]).toBeGreaterThan(0.1);
  });

  it('is null without an HRR, rather than a guess', () => {
    const doc = firePlan();
    (doc.objects[0] as BurnerObject).fire!.hrr_kw = null;
    expect(firePointSourceM(doc)).toBeNull();
  });

  it('defaults the radiative fraction, and refuses a nonsense one', () => {
    expect(radiativeFractionOf(firePlan().objects[0] as BurnerObject))
      .toBeCloseTo(DEFAULT_RADIATIVE_FRACTION, 12);
    expect(radiativeFractionOf(firePlan(130, 1.5).objects[0] as BurnerObject))
      .toBeCloseTo(DEFAULT_RADIATIVE_FRACTION, 12);
    expect(radiativeFractionOf(firePlan(130, 0.35).objects[0] as BurnerObject))
      .toBeCloseTo(0.35, 12);
  });
});

// -- heat flux ------------------------------------------------------------

describe('heat flux gauges', () => {
  it('matches the point-source formula', () => {
    // q" = X_r Q cos(theta) / (4 pi r^2), aimed square on so cos(theta) is 1.
    const doc = firePlan(130, 0.35);
    const z = (firePointSourceM(doc) as Vec3)[2];
    const gauge = addGauge(doc, [2, 0, z]);
    const est = heatFluxEstimate(doc, gauge)!;

    expect(est.distanceM).toBeCloseTo(2, 9);
    expect(est.offAxisDeg).toBeCloseTo(0, 6);
    expect(est.incidentKwM2).toBeCloseTo((0.35 * 130) / (4 * Math.PI * 4), 9);
  });

  it('falls off as one over r squared', () => {
    const doc = firePlan();
    const z = (firePointSourceM(doc) as Vec3)[2];
    const near = heatFluxEstimate(doc, addGauge(doc, [1, 0, z], { id: 'hf-near' }))!;
    const far = heatFluxEstimate(doc, addGauge(doc, [2, 0, z], { id: 'hf-far' }))!;
    expect(near.incidentKwM2).toBeCloseTo(4 * far.incidentKwM2, 9);
  });

  it('reads the cosine of a tilted gauge', () => {
    const doc = firePlan();
    const z = (firePointSourceM(doc) as Vec3)[2];
    const square = heatFluxEstimate(doc, addGauge(doc, [2, 0, z], { id: 'hf-sq' }))!;

    const tilted = firePlan();
    const at: Vec3 = [2, 0, z];
    const away: Vec3 = [at[0] - Math.cos(Math.PI / 3), at[1] + Math.sin(Math.PI / 3), at[2]];
    const est = heatFluxEstimate(tilted, addGauge(tilted, at, { aim: away }))!;
    expect(est.offAxisDeg).toBeCloseTo(60, 6);
    expect(est.incidentKwM2).toBeCloseTo(0.5 * square.incidentKwM2, 9);
  });

  it('receives nothing when it faces away, rather than a negative flux', () => {
    const doc = firePlan();
    const z = (firePointSourceM(doc) as Vec3)[2];
    const gauge = addGauge(doc, [2, 0, z], { aim: [4, 0, z] });
    const est = heatFluxEstimate(doc, gauge)!;
    expect(est.facesFire).toBe(false);
    expect(est.incidentKwM2).toBe(0);
    expect(codes(doc)).toContain('gauge-facing-away');
  });

  it('reports only the facing problem when a gauge is turned away', () => {
    // A gauge pointed at the wall has one problem, and it is not its range.
    const doc = firePlan();
    const z = (firePointSourceM(doc) as Vec3)[2];
    addGauge(doc, [2, 0, z], { aim: [4, 0, z], range: 0.001 });
    expect([...codes(doc)]).toEqual(['gauge-facing-away']);
  });

  it('flags an over-range gauge as an error and a starved one as a warning', () => {
    const hot = firePlan();
    addGauge(hot, [0.8, 0, (firePointSourceM(hot) as Vec3)[2]], { range: 1 });
    expect(codes(hot)).toContain('gauge-over-range');

    const cold = firePlan();
    addGauge(cold, [6, 0, (firePointSourceM(cold) as Vec3)[2]], { range: 50 });
    expect(codes(cold)).toContain('gauge-low-signal');
  });

  it('reports a gauge standing in the fire, rather than an infinite flux', () => {
    // Everything else would divide by a zero distance and print "Infinity kW/m²",
    // which is not a finding anybody can act on.
    const doc = firePlan();
    const source = firePointSourceM(doc) as Vec3;
    const gauge = addGauge(doc, source, { aim: [source[0] + 1, source[1], source[2]] });
    expect(Number.isFinite(heatFluxEstimate(doc, gauge)!.incidentKwM2)).toBe(false);
    expect([...codes(doc)]).toEqual(['gauge-in-fire']);
  });

  it('says nothing about range when none is recorded', () => {
    const doc = firePlan();
    const gauge = addGauge(doc, [0.8, 0, (firePointSourceM(doc) as Vec3)[2]], { range: null });
    expect(gaugeRangeKwM2(gauge)).toBeNull();
    expect(heatFluxEstimate(doc, gauge)!.fractionOfRange).toBeNull();
    expect(codes(doc).has('gauge-over-range')).toBe(false);
    expect(codes(doc).has('gauge-low-signal')).toBe(false);
  });

  it('flags a gauge inside two effective diameters as near field', () => {
    // D_eff of a 1 ft square pan is 0.344 m, so two diameters is 0.69 m.
    const doc = firePlan();
    addGauge(doc, [0.4, 0, (firePointSourceM(doc) as Vec3)[2]], { range: 200 });
    expect(heatFluxEstimate(doc, heatFluxSensors(doc)[0])!.nearField).toBe(true);
    expect(codes(doc)).toContain('gauge-near-field');
  });

  it('flags a view tube that misses the flame, but never an open hemisphere', () => {
    const build = (viewAngle: number): PlanDocument => {
      const doc = firePlan();
      const z = (firePointSourceM(doc) as Vec3)[2];
      const at: Vec3 = [2, 0, z];
      const away: Vec3 = [at[0] - Math.cos(Math.PI / 6), at[1] + Math.sin(Math.PI / 6), at[2]];
      addGauge(doc, at, { aim: away, viewAngle });
      return doc;
    };
    expect(codes(build(20))).toContain('gauge-view-restricted');
    expect(codes(build(180)).has('gauge-view-restricted')).toBe(false);
  });

  it('defaults an absent or impossible view angle to an open hemisphere', () => {
    const doc = firePlan();
    const gauge = addGauge(doc, [2, 0, 0.5]);
    gauge.gauge!.viewAngle_deg = null;
    expect(gaugeViewAngleDeg(gauge)).toBe(180);
    gauge.gauge!.viewAngle_deg = 400;
    expect(gaugeViewAngleDeg(gauge)).toBe(180);
  });

  it('gives no estimate at all when there is no fire', () => {
    const doc = firePlan();
    (doc.objects[0] as BurnerObject).fire!.hrr_kw = null;
    const gauge = addGauge(doc, [2, 0, 0.5], { aim: [0, 0, 0.5] });
    expect(heatFluxEstimate(doc, gauge)).toBeNull();
    expect([...codes(doc)]).toEqual([]);
  });

  it('gets the same aim-mismatch check a camera gets', () => {
    // The quaternion is authoritative, so a stale target is a lie about what the
    // gauge measures -- exactly as it is for a camera.
    const doc = firePlan();
    doc.objects.push({
      id: 'hf-1',
      type: 'heatFluxSensor',
      transform: {
        position_m: [2, 0, 0.7],
        rotation_quat: [0, 0, 0, 1],
        aimTarget_m: [0, 0, 0.7],
      },
    } as HeatFluxSensorObject);
    expect(checkPlan(doc).map((i) => i.code)).toContain('aim-mismatch');
  });

  it('agrees with the standalone correlation', () => {
    expect(pointSourceFluxKwM2(130, 2, 1, 0.35))
      .toBeCloseTo((0.35 * 130) / (4 * Math.PI * 4), 12);
    expect(pointSourceFluxKwM2(130, 2, -0.5, 0.35)).toBe(0);
    expect(pointSourceFluxKwM2(0, 2, 1, 0.35)).toBe(0);
  });
});

// -- thermocouples --------------------------------------------------------

describe('thermocouple rakes', () => {
  it('treats a bare thermocouple as a one-bead rake', () => {
    const doc = firePlan();
    const rake = addRake(doc, [1, 0, 0.5], [0]);
    expect(beadOffsetsOf(rake)).toEqual([0]);
    expect(thermocoupleBeads(doc, rake)[0].world).toEqual([1, 0, 0.5]);
  });

  it('defaults a missing or unusable offset list to a single bead', () => {
    const doc = firePlan();
    const rake = addRake(doc, [1, 0, 0.5], []);
    expect(beadOffsetsOf(rake)).toEqual([0]);
    rake.beadOffsets_m = undefined;
    expect(beadOffsetsOf(rake)).toEqual([0]);
  });

  it('runs offsets along local +Z, through the object frame', () => {
    // CONVENTIONS section 5a: vertex lists are local. 90 degrees about +Y takes
    // local +Z onto world +X, so a rake laid on its side has horizontal beads.
    const doc = firePlan();
    const s = Math.SQRT1_2;
    const rake = addRake(doc, [1, 0, 0.5], [1]);
    rake.transform!.rotation_quat = [0, s, 0, s];
    const [x, y, z] = thermocoupleBeads(doc, rake)[0].world;
    expect(x).toBeCloseTo(2, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0.5, 9);
  });

  it('places each bead in the flame, the plume, or neither', () => {
    const doc = firePlan();
    const tip = (firePointSourceM(doc) as Vec3)[2] * 2 - 0.1; // fuel surface + L_f
    const rake = addRake(doc, [0, 0, 0], [0.3, tip + 0.5]);
    const beads = thermocoupleBeads(doc, rake);
    expect(beads[0].region).toBe('flame');
    expect(beads[1].region).toBe('plume');

    const aside = firePlan();
    expect(thermocoupleBeads(aside, addRake(aside, [3, 0, 0], [1.5]))[0].region)
      .toBe('outside');
  });

  it('quotes a temperature only where the plume correlation applies', () => {
    const doc = firePlan();
    const tip = (firePointSourceM(doc) as Vec3)[2] * 2 - 0.1;
    const beads = thermocoupleBeads(doc, addRake(doc, [0, 0, 0], [0.3, tip + 0.5]));
    // Inside the flame the plume correlation is not imprecise, it is the wrong
    // correlation, so the honest answer is no answer.
    expect(beads[0].gasTemperatureC).toBeNull();
    expect(beads[1].gasTemperatureC).not.toBeNull();
  });

  it('cools with height and is measured from ambient', () => {
    const doc = firePlan();
    const tip = (firePointSourceM(doc) as Vec3)[2] * 2 - 0.1;
    const temps = thermocoupleBeads(doc, addRake(doc, [0, 0, 0], [tip + 0.3, tip + 0.8, tip + 1.3]))
      .map((b) => b.gasTemperatureC as number);
    expect(temps[0]).toBeGreaterThan(temps[1]);
    expect(temps[1]).toBeGreaterThan(temps[2]);

    const warm = firePlan();
    warm.environment!.ambientTemperature_C = 40;
    const hot = thermocoupleBeads(warm, addRake(warm, [0, 0, 0], [tip + 0.3]))[0];
    expect((hot.gasTemperatureC as number) - temps[0]).toBeCloseTo(20, 6);
  });

  it('reproduces the reference plume rake', () => {
    // Qc = (1 - 0.35) * 130 = 84.5 kW; dT = 25 Qc^(2/3) (z - z0)^(-5/3) over 20 C.
    // Mirrored in python/tests/test_instruments.py.
    const doc = fixture();
    const rake = thermocouples(doc).find((t) => t.id === 'tc-plume')!;
    const temps = thermocoupleBeads(doc, rake).map((b) => b.gasTemperatureC as number);
    expect(temps[0]).toBeCloseTo(344, 0);
    expect(temps[1]).toBeCloseTo(247, 0);
    expect(temps[2]).toBeCloseTo(190, 0);
  });

  it('agrees with the standalone correlation', () => {
    expect(plumeCentrelineRiseK(-1, 130, 0.344)).toBeNull();
    expect(plumeCentrelineRiseK(2, 0, 0.344)).toBeNull();
    expect(plumeCentrelineRiseK(2, 130, 0.344, 1)).toBeNull(); // nothing convected
  });

  it('takes its limit from the letter type unless one is recorded', () => {
    const doc = firePlan();
    for (const [letter, limit] of Object.entries(TC_MAX_TEMPERATURE_C)) {
      const rake = addRake(doc, [5, 0, 0], [0.5], { id: `tc-${letter}` });
      rake.thermocouple = { tcType: letter as 'K' };
      expect(tcMaxTemperatureC(rake)).toBe(limit);
      rake.thermocouple.maxTemperature_C = 200;
      expect(tcMaxTemperatureC(rake)).toBe(200);
    }
  });

  it('errors on a bead the type cannot survive and warns on one it can', () => {
    const fragile = firePlan();
    addRake(fragile, [0, 0, 0], [0.3], { tcType: 'T' }); // limited to 370 C
    expect(codes(fragile)).toContain('tc-over-temperature');

    const rugged = firePlan();
    addRake(rugged, [0, 0, 0], [0.3], { tcType: 'K' }); // good to 1260 C
    expect(codes(rugged)).toContain('tc-in-flame');
    expect(codes(rugged).has('tc-over-temperature')).toBe(false);
  });

  it('errors when the predicted plume passes the bead limit', () => {
    const doc = firePlan(2000);
    const tip = (firePointSourceM(doc) as Vec3)[2] * 2 - 0.1;
    addRake(doc, [0, 0, 0], [tip + 0.05], { tcType: 'T' });
    expect(codes(doc)).toContain('tc-over-temperature');
  });

  it('notes a rake that will read ambient, without calling it an error', () => {
    const doc = fixture();
    const found = instrumentChecks(doc).filter((i) => i.objectId === 'tc-east-wall');
    expect(found.map((i) => [i.severity, i.code])).toEqual([['info', 'tc-outside-plume']]);
  });

  it('rejects an empty or non-numeric offset list at the load boundary', () => {
    const doc = newPlan('bad rake');
    doc.objects.push({
      id: 'tc-1', type: 'thermocouple', beadOffsets_m: [],
    } as unknown as ThermocoupleObject);
    expect(validateStructure(doc).map((i) => i.code)).toContain('bad-beads');
  });
});

// -- the reference plan ---------------------------------------------------

// -- one verdict, three surfaces -----------------------------------------

describe('instrument verdicts', () => {
  /** The worst thing `instrumentChecks` says about one object. The verdict has to
   *  agree with it, or a printed table contradicts the checks list a page below. */
  const worstSeverity = (doc: PlanDocument, id: string): 'error' | 'warning' | 'ok' => {
    const mine = instrumentChecks(doc).filter((i) => i.objectId === id);
    if (mine.some((i) => i.severity === 'error')) return 'error';
    if (mine.some((i) => i.severity === 'warning')) return 'warning';
    return 'ok';
  };
  const EXPECTED = { bad: 'error', warn: 'warning', ok: 'ok', muted: 'ok' } as const;

  it('never calls a bead in the flame "in the plume"', () => {
    // The report said exactly that, in green, about a bead the checks list was
    // simultaneously calling an over-temperature error.
    const doc = firePlan();
    const rake = addRake(doc, [0, 0, 0], [0.3], { tcType: 'T' });
    const bead = thermocoupleBeads(doc, rake)[0];
    expect(bead.region).toBe('flame');

    const verdict = beadVerdict(bead, tcMaxTemperatureC(rake));
    expect(verdict.status).toBe('bad');
    expect(verdict.label).toContain('in the flame');
    expect(verdict.label).not.toContain('plume');
    expect(thermocoupleVerdict(doc, rake)).toEqual(verdict);
  });

  it('warns rather than failing a bead whose wire survives the flame', () => {
    const doc = firePlan();
    const rake = addRake(doc, [0, 0, 0], [0.3], { tcType: 'K' }); // good to 1260 C
    expect(thermocoupleVerdict(doc, rake).status).toBe('warn');
  });

  it('leaves a rake outside the plume neutral rather than green', () => {
    // `instrumentChecks` files it as info: a rake on a wall is there to read the
    // wall. Colouring it "good" would be a claim nobody made.
    const doc = firePlan();
    const rake = addRake(doc, [3, 0, 0], [1.5]);
    expect(thermocoupleVerdict(doc, rake)).toEqual({ status: 'muted', label: 'outside the plume' });
  });

  it('reads the rake as its worst bead', () => {
    const doc = firePlan();
    const tip = (firePointSourceM(doc) as Vec3)[2] * 2 - 0.1;
    const rake = addRake(doc, [0, 0, 0], [tip + 0.5, 0.3], { tcType: 'T' });
    expect(thermocoupleVerdict(doc, rake).status).toBe('bad');
  });

  it('does not call a near-field estimate usable', () => {
    // `gauge-near-field` says the figure is an order of magnitude, "not a value to
    // size a gauge on" -- and the report printed it in green.
    const doc = firePlan();
    const gauge = addGauge(doc, [0.4, 0, 0.2], { range: 100 });
    expect(heatFluxEstimate(doc, gauge)!.nearField).toBe(true);
    expect(gaugeVerdict(doc, gauge)).toEqual({ status: 'warn', label: 'near field' });
  });

  it('has no verdict where there is no fire to have one about', () => {
    const doc = newPlan('no fire');
    const gauge = createHeatFluxSensor(doc, [1, 0, 0.5]);
    doc.objects.push(gauge);
    expect(gaugeVerdict(doc, gauge)).toBeNull();
  });

  it('agrees with the worst finding the checks list files, case by case', () => {
    const cases: Array<[string, () => PlanDocument]> = [
      ['usable gauge', () => { const d = firePlan(); addGauge(d, [1.2, 0, 0.3], { range: 5 }); return d; }],
      ['over range', () => { const d = firePlan(); addGauge(d, [0.8, 0, 0.3], { range: 0.5 }); return d; }],
      ['low signal', () => { const d = firePlan(); addGauge(d, [4, 0, 0.3], { range: 50 }); return d; }],
      ['near field', () => { const d = firePlan(); addGauge(d, [0.4, 0, 0.2], { range: 100 }); return d; }],
      ['facing away', () => { const d = firePlan(); addGauge(d, [2, 0, 0.3], { aim: [9, 0, 0.3] }); return d; }],
      ['view tube', () => { const d = firePlan(); addGauge(d, [2, 0, 0.3], { aim: [2, 0, 9], viewAngle: 20 }); return d; }],
      ['in the fire', () => {
        const d = firePlan();
        const g = addGauge(d, [1, 0, 0.3]);
        g.transform!.position_m = firePointSourceM(d) as Vec3;
        return d;
      }],
    ];
    for (const [name, build] of cases) {
      const doc = build();
      const gauge = heatFluxSensors(doc)[0];
      const verdict = gaugeVerdict(doc, gauge)!;
      expect([name, EXPECTED[verdict.status]]).toEqual([name, worstSeverity(doc, gauge.id)]);
    }
  });

  it('agrees with the checks list for thermocouples too', () => {
    const tip = (firePointSourceM(firePlan()) as Vec3)[2] * 2 - 0.1;
    const cases: Array<[string, () => PlanDocument]> = [
      ['plume', () => { const d = firePlan(); addRake(d, [0, 0, 0], [tip + 0.5]); return d; }],
      ['flame, type K', () => { const d = firePlan(); addRake(d, [0, 0, 0], [0.3]); return d; }],
      ['flame, type T', () => { const d = firePlan(); addRake(d, [0, 0, 0], [0.3], { tcType: 'T' }); return d; }],
      ['outside', () => { const d = firePlan(); addRake(d, [3, 0, 0], [1.5]); return d; }],
      ['plume over limit', () => {
        const d = firePlan(); addRake(d, [0, 0, 0], [tip + 0.1], { tcType: 'T' }); return d;
      }],
    ];
    for (const [name, build] of cases) {
      const doc = build();
      const rake = thermocouples(doc)[0];
      const verdict = thermocoupleVerdict(doc, rake);
      expect([name, EXPECTED[verdict.status]]).toEqual([name, worstSeverity(doc, rake.id)]);
    }
  });
});

// -- degenerate input the loader accepts ----------------------------------

describe('input the schema allows but the maths cannot use', () => {
  it('places a bead below the fuel surface outside the flame, not inside it', () => {
    // `flameRadiusAtZ` reports 0 outside the cone height band, so a test of only
    // the upper bound reduced to `radialM <= 0` -- true exactly on the burner axis,
    // where a rake with no transform sits by default. A bead in the concrete drew
    // an over-temperature ERROR. Mirrored in python/tests/test_instruments.py.
    const doc = firePlan(); // rimHeight_m 0.1, so the fuel surface is at z = 0.1
    const rake = addRake(doc, [0, 0, 0], [0.05, -1], { tcType: 'T' });
    expect(thermocoupleBeads(doc, rake).map((b) => b.region)).toEqual(['outside', 'outside']);
    expect(codes(doc)).not.toContain('tc-over-temperature');

    // Inclusive: a bead resting exactly on the fuel surface is in the flame.
    const onIt = firePlan();
    expect(thermocoupleBeads(onIt, addRake(onIt, [0, 0, 0], [0.1]))[0].region).toBe('flame');
  });

  it('gives a flame that clamps to zero height no flame region at all', () => {
    // 1 kW on a 0.3 m pan: Heskestad L_f clamps to 0, the tip is the fuel surface,
    // and there is no cone. Python collapsed that into "a cone of zero radius" and
    // reported an ERROR where this engine reported info -- opposite verdicts from
    // the two engines on the same file.
    const doc = firePlan(1);
    const burner = doc.objects[0] as BurnerObject;
    expect(flameRadiusAtZ(burner, fuelSurfaceZM(burner))).toBeNull();

    const rake = addRake(doc, [0, 0, 0], [0, 0.05], { tcType: 'T' });
    expect(thermocoupleBeads(doc, rake).map((b) => b.region)).toEqual(['outside', 'outside']);
    expect(instrumentChecks(doc).map((i) => [i.severity, i.code]))
      .toEqual([['info', 'tc-outside-plume']]);
  });

  it('survives a zero-length quaternion instead of losing every finding to it', () => {
    // Four numbers is all the schema asks for; "unit" is prose. `quatToColumns`
    // throws on a zero-length one, and `checkPlan` reached it through both new
    // instrument types -- so one hand-edited object cost the user the whole checks
    // list, including the finding that named the bad data.
    const doc = firePlan();
    const gauge = addGauge(doc, [1, 0, 0.5]);
    gauge.transform!.rotation_quat = [0, 0, 0, 0];
    const rake = addRake(doc, [1, 0, 0.5], [0]);
    rake.transform!.rotation_quat = [0, 0, 0, 0];

    expect(validateStructure(doc)).toEqual([]); // the loader accepts it, so the maths must
    const found = checkPlan(doc).map((i) => i.code);
    expect(found).toContain('non-unit-quaternion');
    expect(heatFluxEstimate(doc, gauge)).not.toBeNull();
    expect(thermocoupleBeads(doc, rake)[0].world).toEqual([1, 0, 0.5]);
  });

  it('refuses an aim at the object own position rather than half-applying one', () => {
    // Since 1.1 a gauge standing on the point source is a modelled state
    // (`gauge-in-fire`), so "Aim at fire" on one asks for the direction from a
    // point to itself. `lookAtQuat` threw -- after `aimTarget_m` had been written.
    const doc = firePlan();
    const source = firePointSourceM(doc) as Vec3;
    const gauge = addGauge(doc, [1, 0, 0.3]);
    gauge.transform!.position_m = source;
    const before = JSON.stringify(gauge.transform);

    expect(setAimTarget(gauge, source)).toBe(false);
    expect(JSON.stringify(gauge.transform)).toBe(before);

    // A real target still works, and still records the intent.
    expect(setAimTarget(gauge, [3, 0, 0.5])).toBe(true);
    expect(gauge.transform!.aimTarget_m).toEqual([3, 0, 0.5]);
  });

  it('names the object, not "the camera", when a gauge aims at itself', () => {
    const doc = firePlan();
    const gauge = addGauge(doc, [1, 0, 0.5]);
    gauge.transform!.aimTarget_m = [1, 0, 0.5];
    const issue = checkPlan(doc).find((i) => i.code === 'degenerate-aim')!;
    expect(issue.message).not.toContain('camera');
  });
});

describe('the reference plan', () => {
  it('has no errors', () => {
    expect(checkPlan(fixture()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('reproduces the east-wall gauge being lost in its own noise', () => {
    // 1.70 kW/m2 on a 50 kW/m2 scale -- the point the plan is there to make.
    const doc = fixture();
    const gauge = heatFluxSensors(doc).find((s) => s.id === 'hf-east')!;
    const est = heatFluxEstimate(doc, gauge)!;
    expect(est.incidentKwM2).toBeCloseTo(1.703, 3);
    expect(est.fractionOfRange).toBeLessThan(0.05);
    expect(instrumentChecks(doc).filter((i) => i.objectId === 'hf-east').map((i) => i.code))
      .toEqual(['gauge-low-signal']);
  });

  it('leaves the correctly sized north-wall gauge alone', () => {
    expect(instrumentChecks(fixture()).filter((i) => i.objectId === 'hf-north')).toEqual([]);
  });

  it('gives instruments a stable colour, and drops an untrusted one', () => {
    const doc = fixture();
    const gauge = heatFluxSensors(doc)[0];
    expect(objectColor(gauge)).toBe('#ef4444');
    gauge.display = { color: 'red; onload=alert(1)' };
    expect(objectColor(gauge)).toBe('#ef4444');
    gauge.display = { color: '#123abc' };
    expect(objectColor(gauge)).toBe('#123abc');
  });
});

// -- the declared format version ------------------------------------------

describe('the declared format version', () => {
  const versionOf = (doc: PlanDocument): string =>
    JSON.parse(serializePlan(doc)).version as string;

  it('stays at 1.0.0 for a plan that uses nothing newer', () => {
    const doc = firePlan();
    expect(requiredFormatVersion(doc)).toBe('1.0.0');
    expect(versionOf(doc)).toBe('1.0.0');
  });

  it('rises to 1.1.0 for each thing that needs it', () => {
    const withGauge = firePlan();
    addGauge(withGauge, [2, 0, 0.7]);
    expect(versionOf(withGauge)).toBe('1.1.0');

    const withRake = firePlan();
    addRake(withRake, [2, 0, 0], [0.5]);
    expect(versionOf(withRake)).toBe('1.1.0');

    const withZoom = newPlan('zoomed');
    withZoom.objects.push(camera({ zoomFactor: 2 }));
    expect(versionOf(withZoom)).toBe('1.1.0');

    expect(versionOf(firePlan(130, 0.35))).toBe('1.1.0');
  });

  it('only ever goes up, and never past a version it does not know', () => {
    const doc = firePlan();
    doc.version = '2.3.4';
    expect(versionOf(doc)).toBe('2.3.4');
    expect(maxVersion('1.1.0', '1.0.0')).toBe('1.1.0');
    expect(maxVersion('1.0.0', '1.1.0')).toBe('1.1.0');
  });

  it('drops an explicit-null 1.1 key rather than emitting a file it would reject', () => {
    // Null and absent are the same thing to the version derivation -- but not to
    // the 1.0 schema, which closes these objects and rejects the KEY whatever its
    // value. Kept, the key made this writer emit a 1.0.0 file that fails 1.0.
    // Mirrored in python/tests/test_roundtrip.py.
    const zoomed = newPlan('explicit null zoom');
    zoomed.objects.push(camera({ zoomFactor: null as unknown as number }));
    expect(requiredFormatVersion(zoomed)).toBe('1.0.0');
    const writtenCam = JSON.parse(serializePlan(zoomed));
    expect(writtenCam.version).toBe('1.0.0');
    expect('zoomFactor' in writtenCam.objects[0].camera).toBe(false);

    const radiating = firePlan();
    (radiating.objects[0] as BurnerObject).fire!.radiativeFraction = null as unknown as number;
    expect(requiredFormatVersion(radiating)).toBe('1.0.0');
    const writtenBurner = JSON.parse(serializePlan(radiating));
    expect(writtenBurner.version).toBe('1.0.0');
    expect('radiativeFraction' in writtenBurner.objects[0].fire).toBe(false);
  });

  it('leaves a real 1.1 value alone while dropping the null one', () => {
    const doc = newPlan('one of each');
    doc.objects.push(camera({ zoomFactor: 2 }));
    const written = JSON.parse(serializePlan(doc));
    expect(written.objects[0].camera.zoomFactor).toBe(2);
    expect(written.version).toBe('1.1.0');
  });

  it('reports a file whose label understates its contents', () => {
    // Only a hand edit or a broken writer produces one, but the label is what a
    // consumer checks before deciding it can read the file.
    const doc = firePlan();
    addRake(doc, [2, 0, 0], [0.5]);
    doc.version = '1.0.0';
    expect(checkPlan(doc).map((i) => i.code)).toContain('version-understated');
  });

  it('is 1.1.0 on the reference plan, and clean once saved', () => {
    const doc = fixture();
    expect(doc.version).toBe('1.1.0');
    expect(checkPlan(doc).map((i) => i.code)).not.toContain('version-understated');
  });
});

// -- the preset library ---------------------------------------------------

describe('the camera preset library', () => {
  beforeEach(() => resetCustomPresets());

  it('ships the two FLIR presets with their datasheet intrinsics', () => {
    // The A-series sheet designates this lens by angle -- "Included Lenses: 24 deg"
    // -- and prints no focal length, so the preset back-solves one from the 640 x
    // 480 array at 12 um pitch. 24.0 x 18.1 deg is what that reproduces; both are
    // derived rather than printed. See docs/datasheets/README.md.
    const a700 = findPreset('flir-a700-24deg')!;
    expect(a700.resolution_px).toEqual([640, 480]);
    expect(a700.sensor_mm[0]).toBeCloseTo(640 * 0.012, 6);
    expect(hfovDegOf({ camera: specFromPreset(a700) } as CameraObject)).toBeCloseTo(24, 1);
    expect(vfovDegOf({ camera: specFromPreset(a700) } as CameraObject)).toBeCloseTo(18.1, 1);
    expect(a700.intrinsicsSource).toBe('datasheet');

    // 1280 x 720 at 14 um, straight off the datasheet, and the 25 mm lens is used
    // as printed -- this sheet designates lenses by focal length, so nothing needs
    // back-solving. The field of view is the derived half.
    const a8303 = findPreset('flir-a8303sc-25mm')!;
    expect(a8303.resolution_px).toEqual([1280, 720]);
    expect(a8303.sensor_mm[0]).toBeCloseTo(1280 * 0.014, 6);
    expect(a8303.focalLength_mm).toBe(25);
    expect(hfovDegOf({ camera: specFromPreset(a8303) } as CameraObject)).toBeCloseTo(39.4, 1);
    expect(a8303.spectralBand_um).toEqual([3, 5]);
  });

  it('keeps every shipped preset internally consistent', () => {
    const ids = BUILTIN_CAMERA_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of BUILTIN_CAMERA_PRESETS) {
      expect(p.focalLength_mm).toBeGreaterThan(0);
      expect(p.sensor_mm.every((s) => s > 0)).toBe(true);
      expect(p.resolution_px.every((r) => Number.isInteger(r) && r > 0)).toBe(true);
    }
  });

  it('never lets a preset claim to be calibrated', () => {
    // A calibration -- principal point, distortion -- belongs to one physical unit,
    // and a preset carries neither. Lifting one out of a calibrated camera kept
    // the label while dropping the numbers, so the next camera placed from it said
    // `calibrated` with a null principal point and the Python reader's
    // `is_reconstruction_ready` believed it.
    const doc = fixture();
    const cam = cameras(doc)[0];
    cam.camera.intrinsicsSource = 'calibrated';
    cam.camera.principalPoint_px = [250, 200];
    cam.camera.distortion = { model: 'opencv', coefficients: [-0.1, 0.02, 0, 0, 0] };

    const preset = presetFromCamera(cam, 'Unit 7');
    expect(preset.intrinsicsSource).toBe('datasheet');
    const placed = specFromPreset(preset);
    expect(placed.intrinsicsSource).toBe('datasheet');
    expect(placed.principalPoint_px).toBeNull();
    expect(placed.distortion).toBeNull();

    // A stored library entry that says so -- written by an older build -- is read
    // the same way, and a datasheet or nominal one is left alone.
    adoptShellPresets([{ ...preset, intrinsicsSource: 'calibrated' }], async () => true);
    expect(customCameraPresets()[0].intrinsicsSource).toBe('datasheet');
    cam.camera.intrinsicsSource = 'nominal';
    expect(presetFromCamera(cam, 'Nominal').intrinsicsSource).toBe('nominal');
  });

  it('lifts a preset out of a camera that is already in a plan', () => {
    // How a preset crosses machines without ever becoming a file: the intrinsics
    // are already inline in every camera.
    const cam = camera({ zoomFactor: 3, presetId: 'something-else' });
    const preset = presetFromCamera(cam, 'My rig');
    expect(preset.label).toBe('My rig');
    expect(preset.sensor_mm).toEqual([10, 5]);
    expect(preset.focalLength_mm).toBe(20);
    // The lens belongs to the preset; the zoom belongs to the shot.
    expect('zoomFactor' in preset).toBe(false);
  });

  it('adds a custom preset to the end of the library', () => {
    const before = cameraPresets().length;
    const saved = saveCustomPreset(presetFromCamera(camera(), 'My rig'));
    expect(cameraPresets()).toHaveLength(before + 1);
    expect(cameraPresets()[before].id).toBe(saved.id);
    expect(isCustomPreset(saved.id)).toBe(true);
    expect(customCameraPresets().map((p) => p.id)).toEqual([saved.id]);
  });

  it('replaces rather than duplicates when the same id is saved again', () => {
    const first = saveCustomPreset(presetFromCamera(camera(), 'My rig'));
    saveCustomPreset({ ...first, focalLength_mm: 35 });
    expect(customCameraPresets()).toHaveLength(1);
    expect(findPreset(first.id)!.focalLength_mm).toBe(35);
  });

  it('refuses to shadow a shipped preset', () => {
    // Seeded presets are the ones backed by a datasheet in docs/datasheets/, and
    // shadowing one would make intrinsicsSource "datasheet" uncheckable.
    const builtin = BUILTIN_CAMERA_PRESETS[0];
    const saved = saveCustomPreset(presetFromCamera(camera(), 'Mine', builtin.id));
    expect(saved.id).not.toBe(builtin.id);
    expect(findPreset(builtin.id)!.focalLength_mm).toBe(builtin.focalLength_mm);
  });

  it('makes unique, readable ids from labels', () => {
    expect(presetIdFromLabel('FLIR A700 — 24° lens')).toBe('flir-a700-24-lens');
    const first = saveCustomPreset(presetFromCamera(camera(), 'My rig'));
    expect(presetIdFromLabel('My rig')).toBe(`${first.id}-2`);
    expect(presetIdFromLabel('!!!')).toBe('camera');
  });

  it('deletes only custom presets, and says whether it did', () => {
    const saved = saveCustomPreset(presetFromCamera(camera(), 'My rig'));
    expect(deleteCustomPreset(saved.id)).toBe(true);
    expect(deleteCustomPreset(saved.id)).toBe(false);
    expect(deleteCustomPreset(BUILTIN_CAMERA_PRESETS[0].id)).toBe(false);
    expect(cameraPresets().length).toBe(BUILTIN_CAMERA_PRESETS.length);
  });

  it('still works, in memory, where there is no storage to persist to', () => {
    // Node has no localStorage, which is the same situation as a private window
    // or a browser with site data disabled. A preset made there has to last the
    // session rather than throwing.
    expect(presetsArePersistent()).toBe(false);
    const saved = saveCustomPreset(presetFromCamera(camera(), 'My rig'));
    expect(findPreset(saved.id)).toBeDefined();
  });

  it('keeps the zoom when the lens is swapped', () => {
    // "The lens belongs to the preset, the zoom setting belongs to the shot."
    // Replacing the whole spec took the shot with it -- silently, and on a plan
    // where zoom was the only 1.1 feature the next save relabelled the file 1.0.0.
    const cam = camera({ zoomFactor: 2, focalLength_mm: 20 });
    const preset = findPreset('flir-a700-24deg')!;
    cam.camera = applyPresetToSpec(cam.camera, preset);

    expect(cam.camera.zoomFactor).toBe(2);
    expect(cam.camera.focalLength_mm).toBe(preset.focalLength_mm);
    expect(cam.camera.presetId).toBe(preset.id);

    // An unzoomed camera stays unzoomed rather than gaining an explicit 1.
    const plain = camera();
    plain.camera = applyPresetToSpec(plain.camera, preset);
    expect('zoomFactor' in plain.camera).toBe(false);
  });

  it('drops a stored preset whose enums are not ones it would have written', () => {
    // `coerce` exists to stop a hand-edited entry reaching the intrinsics maths,
    // but it cast `modality` and `intrinsicsSource` instead of checking them -- so
    // a bogus value survived, was placed into a camera, and was written into the
    // plan, after which the app refused to open its own file.
    adoptShellPresets([
      {
        id: 'hand-edited', label: 'Hand edited', modality: 'GAMMA',
        intrinsicsSource: 'lab-grade', resolution_px: [640, 480],
        sensor_mm: [7.68, 5.76], focalLength_mm: 18,
      },
    ], async () => true);

    const [stored] = customCameraPresets();
    expect(stored.modality).toBe('other');
    expect(stored.intrinsicsSource).toBe('nominal');
    expect(validateStructure(planWithCameraFrom(stored))).toEqual([]);
  });

  it('takes its library from the desktop shell rather than browser storage', () => {
    // The shell binds a fresh loopback port on every launch, and localStorage is
    // scoped to the origin -- so a library kept there was in a namespace the next
    // launch could not see, while the UI promised it would survive a restart.
    const writes: unknown[][] = [];
    adoptShellPresets(
      [{ id: 'from-disk', label: 'From disk', modality: 'LWIR', resolution_px: [640, 480], sensor_mm: [7.68, 5.76], focalLength_mm: 18 }],
      async (presets) => { writes.push(presets); return true; },
    );

    expect(customCameraPresets().map((p) => p.id)).toEqual(['from-disk']);
    expect(cameraPresets()).toHaveLength(BUILTIN_CAMERA_PRESETS.length + 1);

    saveCustomPreset(presetFromCamera(camera(), 'My rig'));
    expect(writes).toHaveLength(1);
    expect((writes[0] as Array<{ id: string }>).map((p) => p.id)).toEqual(['from-disk', 'my-rig']);
  });

  it('says a preset is persistent only once a write has actually landed', async () => {
    // The old answer was "does a place to write exist", which is true of a browser
    // that hands out localStorage and then rejects every setItem -- and was true
    // of the desktop build that lost the library on the next launch.
    let ok = true;
    adoptShellPresets([], async () => ok);
    expect(presetsArePersistent()).toBe(true); // nothing written yet: the store is real

    saveCustomPreset(presetFromCamera(camera(), 'My rig'));
    await Promise.resolve();
    expect(presetsArePersistent()).toBe(true);

    ok = false;
    saveCustomPreset(presetFromCamera(camera(), 'Another'));
    await Promise.resolve();
    expect(presetsArePersistent()).toBe(false);
  });

  it('gives every stored preset an id of its own (UI-8)', () => {
    // A stored entry reusing a shipped id showed twice and offered "Delete preset"
    // on the shipped one; two sharing an id could not be told apart.
    const builtin = BUILTIN_CAMERA_PRESETS[0];
    const entry = { label: 'Mine', resolution_px: [640, 480], sensor_mm: [7.68, 5.76], focalLength_mm: 18 };
    adoptShellPresets([{ ...entry, id: builtin.id }, { ...entry, id: 'rig' }, { ...entry, id: 'rig' }], async () => true);
    const ids = customCameraPresets().map((p) => p.id);
    expect(ids).toEqual([`${builtin.id}-2`, 'rig', 'rig-2']);
    expect(isCustomPreset(builtin.id)).toBe(false);
    expect(new Set(cameraPresets().map((p) => p.id)).size).toBe(cameraPresets().length);
  });

  it('writes back the stored entries it could not use (UI-8)', () => {
    const writes: unknown[][] = [];
    const broken = { id: 'broken', label: 'Broken', resolution_px: [640, 480], sensor_mm: [7.68, 5.76], focalLength_mm: 'x' };
    adoptShellPresets(
      [{ id: 'kept', label: 'Kept', resolution_px: [640, 480], sensor_mm: [7.68, 5.76], focalLength_mm: 18 }, broken],
      async (presets) => { writes.push(presets); return true; },
    );
    expect(customCameraPresets().map((p) => p.id)).toEqual(['kept']);
    saveCustomPreset(presetFromCamera(camera(), 'My rig'));
    expect((writes[0] as Array<{ id: string }>).map((p) => p.id)).toEqual(['kept', 'my-rig', 'broken']);
    expect(writes[0][2]).toEqual(broken);
  });

  it('moves an unreadable stored library aside before replacing it (UI-8)', () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => { items.set(k, v); },
      removeItem: (k: string) => { items.delete(k); },
    });
    try {
      items.set('fire-test-plan.cameraPresets.v1', '[{"id": "half-writ');
      reloadCustomPresets();
      expect(customCameraPresets()).toEqual([]);
      saveCustomPreset(presetFromCamera(camera(), 'My rig'));
      expect(items.get('fire-test-plan.cameraPresets.v1.unreadable')).toBe('[{"id": "half-writ');
      expect(JSON.parse(items.get('fire-test-plan.cameraPresets.v1')!).map((p: { id: string }) => p.id)).toEqual(['my-rig']);
      expect(presetsArePersistent()).toBe(true);
    } finally {
      resetCustomPresets();
      vi.unstubAllGlobals();
    }
  });

  it('says a desktop library the shell could not serve lasts the session only (UI-8)', () => {
    // The desktop page's origin changes every launch, so browser storage there is
    // not a place the library survives.
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    try {
      keepPresetsForSession();
      expect(presetsArePersistent()).toBe(false);
      saveCustomPreset(presetFromCamera(camera(), 'My rig'));
      expect(presetsArePersistent()).toBe(false);
      expect(customCameraPresets()).toHaveLength(1);
    } finally {
      resetCustomPresets();
      vi.unstubAllGlobals();
    }
  });

  it('places a camera whose intrinsics are inline, not a reference', () => {
    const preset = findPreset('flir-a700-24deg')!;
    const spec = specFromPreset(preset);
    expect(spec.presetId).toBe(preset.id);
    spec.sensor_mm[0] = 99;
    expect(preset.sensor_mm[0]).toBeCloseTo(7.68, 6); // the library is not aliased
  });
});

// -- factories ------------------------------------------------------------

describe('instrument factories', () => {
  it('aims a new gauge at the fire', () => {
    // Its orientation is a first-order term in what it reads, so a gauge dropped
    // facing an arbitrary direction would report a number that means nothing.
    const doc = firePlan();
    const gauge = createHeatFluxSensor(doc, [2, 0, 0.5]);
    doc.objects.push(gauge);
    expect(gauge.transform!.aimTarget_m).toEqual(firePointSourceM(doc));
    expect(heatFluxEstimate(doc, gauge)!.offAxisDeg).toBeCloseTo(0, 6);
  });

  it('creates a thermocouple as a single bead at the drop point', () => {
    const doc = firePlan();
    const rake = createThermocouple(doc, [1, 0, 0.5]);
    expect(rake.beadOffsets_m).toEqual([0]);
    expect(rake.thermocouple!.tcType).toBe('K');
  });

  it('records a mount height that agrees with where the object actually is', () => {
    // `setPosition` rewrites mount.height_m on every move because "a gauge whose
    // recorded mount height contradicts its own Z is a drawing waiting to be
    // wrong". A thermocouple was created 0.5 m up and recorded at 0, so every
    // newly dropped one was born contradicting itself and stayed that way until
    // first dragged -- into shared files, since nothing reads the field yet.
    const doc = firePlan();
    for (const obj of [createThermocouple(doc, [1, 0, 0.5]),
      createHeatFluxSensor(doc, [2, 0, 0.8])]) {
      expect(obj.mount!.height_m).toBe(positionOf(obj)[2]);
    }
    expect(createThermocouple(doc).mount!.height_m)
      .toBe(positionOf(createThermocouple(doc))[2]);
  });

  it('gives new instruments unique ids', () => {
    const doc = firePlan();
    doc.objects.push(createHeatFluxSensor(doc));
    doc.objects.push(createHeatFluxSensor(doc));
    expect(doc.objects[1].id).not.toBe(doc.objects[2].id);
  });
});

// -- review 2026-09-22: mirrored in python/tests/test_instruments.py -------------

describe('review 2026-09-22 physics', () => {
  const lit = (hrrKw: number, position: Vec3, id: string, footprint?: BurnerObject['footprint']): BurnerObject => ({
    id, type: 'burner', transform: { position_m: position },
    footprint: footprint ?? { shape: 'square', size_m: [0.3048, 0.3048] }, rimHeight_m: 0.1,
    fire: { fuel: 'n-heptane', hrr_kw: hrrKw, hrrCurve: null },
  });

  it('judges a bead below the mean tip against flame temperature (PHY-3)', () => {
    const doc = firePlan();
    const burner = doc.objects[0] as BurnerObject;
    const surface = fuelSurfaceZM(burner);
    const z = surface + 0.95 * ((firePointSourceM(doc) as Vec3)[2] - surface) * 2;
    const rake = addRake(doc, [0.015, 0, 0], [z], { tcType: 'T' });
    const bead = thermocoupleBeads(doc, rake)[0];
    expect([bead.region, bead.flameZone]).toEqual(['plume', true]);
    expect(beadVerdict(bead, tcMaxTemperatureC(rake)).status).toBe('bad');
    expect(instrumentChecks(doc).some((i) => i.code === 'tc-over-temperature')).toBe(true);
  });

  it("leaves fires outside a view tube's cone out of the sum (PHY-4)", () => {
    const build = (withB: boolean): PlanDocument => {
      const doc = firePlan(1000);
      if (withB) doc.objects.push(lit(500, [0, 4, 0], 'burner-b'));
      const aim = firePointSourceM(firePlan(1000)) as Vec3;
      addGauge(doc, [-4, 0, aim[2]], { aim, viewAngle: 20, range: null });
      return doc;
    };
    const alone = heatFluxEstimate(build(false), heatFluxSensors(build(false))[0])!;
    const both = build(true);
    expect(heatFluxEstimate(both, heatFluxSensors(both)[0])!.incidentKwM2).toBeCloseTo(alone.incidentKwM2, 9);
    heatFluxSensors(both)[0].gauge!.range_kw_m2 = alone.incidentKwM2 * 1.1;
    expect(instrumentChecks(both).map((i) => i.code)).not.toContain('gauge-over-range');
  });

  it('measures clearance from the fuel surface and skips a hood below the fire (PHY-7)', () => {
    const doc = newPlan('stand');
    doc.objects.push({ ...lit(5.7, [0, 0, 1.9], 'burner-main') } as BurnerObject);
    doc.objects.push({ id: 'slab', type: 'ceiling', transform: { position_m: [0, 0, 0] },
      polygon_m: [[-2, -2], [2, -2], [2, 2], [-2, 2]], height_m: 2.6 } as never);
    doc.objects.push({ id: 'hood', type: 'hood', transform: { position_m: [0, 0, 0] },
      opening_m: [2, 2], height_m: 1.5 } as never);
    const found = checkPlan(doc).map((i) => i.code);
    expect(found).not.toContain('ceiling-clearance');
    expect(found).not.toContain('flame-impingement');
    expect(found).not.toContain('hood-offset');
  });

  it('files hood-offset once per uncovered fire, not per hood (PHY-8)', () => {
    const hood = (id: string, x: number) => ({ id, type: 'hood', transform: { position_m: [x, 0, 0] },
      opening_m: [2, 2], height_m: 3 }) as never;
    const doc = firePlan();
    doc.objects.push(lit(130, [5, 0, 0], 'burner-2'), hood('hood-a', 0), hood('hood-b', 5));
    expect(checkPlan(doc).filter((i) => i.code === 'hood-offset')).toEqual([]);
    doc.objects = doc.objects.filter((o) => o.id !== 'hood-b');
    const offsets = checkPlan(doc).filter((i) => i.code === 'hood-offset');
    expect(offsets.map((i) => i.objectId)).toEqual(['hood-a']);
  });

  it('frames the flame at the pan, not only the plume cone (PHY-2)', () => {
    const doc = newPlan('pool');
    doc.objects.push(lit(2000, [0, 0, 0], 'pool', { shape: 'circle', diameter_m: 2.5 }));
    (doc.objects[0] as BurnerObject).rimHeight_m = 0;
    const cam = camera({ resolution_px: [500, 1000], sensor_mm: [5, 10], focalLength_mm: 10 });
    cam.transform = { position_m: [-4, 0, 1], rotation_quat: lookAtQuat([-4, 0, 1], [0, 0, 1]) };
    doc.objects.push(cam);
    expect(framingOf(doc, cam)!.fraction).toBeLessThan(1);
  });

  it('does not depend on which way the room is drawn (PHY-5)', () => {
    const fractions = [0, 15, 30, 45].map((deg) => {
      const doc = firePlan();
      const a = (deg * Math.PI) / 180;
      const at: Vec3 = [-2.2 * Math.cos(a), -2.2 * Math.sin(a), 1.2];
      const cam = camera({ resolution_px: [640, 480], sensor_mm: [10.88, 8.16], focalLength_mm: 24.6 });
      cam.transform = { position_m: at, rotation_quat: lookAtQuat(at, [0, 0, 0.8]) };
      doc.objects.push(cam);
      return framingOf(doc, cam)!.fraction;
    });
    expect(new Set(fractions).size).toBe(1);
  });

  it('prints a gauge with no range as unjudged, not usable (EXP-1)', () => {
    const doc = firePlan();
    addGauge(doc, [1.2, 0, 0.3], { range: null });
    expect(gaugeVerdict(doc, heatFluxSensors(doc)[0])).toEqual({ status: 'muted', label: 'no range set' });
  });

  it("matches a run's own CSV at small voxels and one-decimal frame names (FLM-2, FLM-3)", () => {
    const manifest = { importedAt: 'x', grid: { voxelSize_m: 0.005, pitch_m: 0.005025, resolution: 200 },
      bounds_m: [[0, 0, 0], [1, 1, 1]], frames: [[0.3, 1003]] } as never;
    expect(plotSequenceMismatch([[0.30000000000000004, 0.000125, 0]], manifest)).toBeNull();
    expect(plotSequenceMismatch([[0.4, 0.000125, 0]], manifest)).not.toBeNull();
  });
});
