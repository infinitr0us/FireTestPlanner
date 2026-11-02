import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lookAtQuat } from './math';
import { FLAME_SAMPLE_COUNT, OCCLUSION_ENDPOINT_TOLERANCE_M, firstOccluder } from './occlusion';
import { checkPlan, framingOf, gaugeVerdict, heatFluxEstimate, heatFluxSensors, newPlan, parsePlan } from './plan';
import type { CameraObject, HeatFluxSensorObject, PlanObject, Vec3 } from './types';
import { buildReportBody } from '../export/report';

const fixture = (path: string): string => readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), 'utf8');
const shared = JSON.parse(fixture('occlusion/check-cases.json')) as {
  burner: PlanObject;
  cases: Array<{ name: string; objects: PlanObject[]; visible: number; at?: Vec3; cameraAim?: Vec3;
    cameraFocal?: number; inFrame?: number; visibleInFrame?: number; blocker?: string; blockers?: string[] }>;
  segments: Array<{ name: string; objects: PlanObject[]; a: Vec3; b: Vec3; blocker: string | null }>;
};

describe('shared line of sight cases (mirrored in Python)', () => {
  it('pins the sampling and endpoint rules', () => {
    expect(FLAME_SAMPLE_COUNT).toBe(9);
    expect(OCCLUSION_ENDPOINT_TOLERANCE_M).toBe(0.05);
  });
  for (const c of shared.cases) it(c.name, () => {
    const doc = newPlan(c.name);
    const at = c.at ?? [-4, 0, 1];
    const gauge: HeatFluxSensorObject = { id: 'gauge', type: 'heatFluxSensor', name: 'Test gauge',
      transform: { position_m: at, rotation_quat: lookAtQuat(at, [0, 0, 1]) }, gauge: { range_kw_m2: 50 } };
    const camera: CameraObject = { id: 'camera', type: 'camera', name: 'Test camera',
      transform: { position_m: at, rotation_quat: lookAtQuat(at, c.cameraAim ?? [0, 0, 1]) },
      camera: { modality: 'RGB', resolution_px: [1000, 1000], sensor_mm: [36, 24], focalLength_mm: c.cameraFocal ?? 10 } };
    doc.objects = structuredClone([shared.burner, gauge, camera, ...c.objects]);
    const before = JSON.stringify(doc);
    const clear = { ...doc, objects: doc.objects.filter(o => ['burner', 'camera', 'heatFluxSensor'].includes(o.type)) };
    const estimate = heatFluxEstimate(doc, gauge)!;
    expect(estimate.visibleFraction).toBe(c.visible / 9);
    expect(estimate.incidentKwM2).toBe(heatFluxEstimate(clear, gauge)!.incidentKwM2 * (c.visible / 9));
    const framing = framingOf(doc, camera)!;
    const cameraShare = c.inFrame === 0 ? null : (c.visibleInFrame ?? c.visible) / (c.inFrame ?? 9);
    expect(framing.unobstructed).toBe(cameraShare);
    const clearFraming = framingOf(clear, camera)!;
    expect([framing.base, framing.tip, framing.fraction]).toEqual([clearFraming.base, clearFraming.tip, clearFraming.fraction]);
    const issues = checkPlan(doc);
    const los = issues.filter(i => ['gauge-no-line-of-sight', 'gauge-partly-shadowed'].includes(i.code));
    expect(los.map(i => i.code)).toEqual(c.visible === 9 ? [] : [c.visible === 0 ? 'gauge-no-line-of-sight' : 'gauge-partly-shadowed']);
    if (los.length) {
      expect(los[0].objectId).toBe('gauge');
      expect(los[0].message).toContain('Test gauge');
      expect(los[0].severity).toBe(c.visible === 0 ? 'error' : 'warning');
      expect(gaugeVerdict(doc, gauge)!.status).toBe(c.visible === 0 ? 'bad' : 'warn');
    }
    // A gauge that cannot see the fire gets one finding, not also "fit a more
    // sensitive gauge": every other gauge check judges radiation it cannot receive.
    if (c.visible === 0) {
      expect(issues.filter(i => i.objectId === 'gauge').map(i => i.code)).toEqual(['gauge-no-line-of-sight']);
    }
    const blocked = issues.filter(i => i.code === 'camera-view-blocked');
    expect(blocked.length).toBe(cameraShare !== null && cameraShare < 1 ? 1 : 0);
    if (blocked.length) {
      expect(blocked[0].objectId).toBe('camera');
      expect(blocked[0].severity).toBe('warning');
      expect(blocked[0].message).toContain(c.blocker);
      for (const name of c.blockers ?? []) expect(blocked[0].message).toContain(name);
      expect(blocked[0].message).toContain(`${Math.round((1 - cameraShare!) * 100)}%`);
      expect(buildReportBody(doc, 'm')).toContain(c.blocker);
    }
    expect(JSON.stringify(doc)).toBe(before);
  });
  for (const c of shared.segments) it(c.name, () => {
    const doc = newPlan(c.name);
    doc.objects = structuredClone(c.objects);
    expect(firstOccluder(doc, c.a, c.b)?.id ?? null).toBe(c.blocker);
    expect(firstOccluder(doc, c.b, c.a)?.id ?? null).toBe(c.blocker);
  });
});

it('scales each admitted fire before summing and ignores an unadmitted shadow', () => {
  const doc = newPlan('two fires');
  const second = { ...structuredClone(shared.burner), id: 'second', transform: { position_m: [0, 4, 0] as Vec3 } };
  const gauge: HeatFluxSensorObject = { id: 'gauge', type: 'heatFluxSensor',
    transform: { position_m: [-4, 0, 1], rotation_quat: lookAtQuat([-4, 0, 1], [0, 0, 1]) }, gauge: { range_kw_m2: 50 } };
  const wall: PlanObject = { id: 'wall', type: 'wall', polyline_m: [[-2, -1], [-2, 1]], thickness_m: 0.2, height_m: 3 };
  doc.objects = [structuredClone(shared.burner), second, gauge];
  const clear = heatFluxEstimate(doc, gauge)!;
  const secondOnly = heatFluxEstimate({ ...doc, objects: [second, gauge] }, gauge)!;
  doc.objects.push(wall);
  const shadowed = heatFluxEstimate(doc, gauge)!;
  expect(shadowed.incidentKwM2).toBe(secondOnly.incidentKwM2);
  expect(shadowed.visibleFraction).toBe(secondOnly.incidentKwM2 / clear.incidentKwM2);
  expect(shadowed.sourceId).toBe('second');
  expect(gaugeVerdict(doc, gauge)!.status).toBe('warn');
  gauge.transform!.rotation_quat = lookAtQuat([-4, 0, 1], [0, 4, 1]);
  gauge.gauge!.viewAngle_deg = 20;
  expect(heatFluxEstimate(doc, gauge)!.visibleFraction).toBe(1);
  expect(checkPlan(doc).some(i => i.code === 'gauge-partly-shadowed')).toBe(false);
});

it('uses the scaled estimate for low-signal and over-range verdicts', () => {
  const doc = newPlan('range checks');
  const gauge: HeatFluxSensorObject = { id: 'gauge', type: 'heatFluxSensor',
    transform: { position_m: [-4, 0, 1], rotation_quat: lookAtQuat([-4, 0, 1], [0, 0, 1]) }, gauge: {} };
  doc.objects = [structuredClone(shared.burner), gauge];
  const flux = heatFluxEstimate(doc, gauge)!.incidentKwM2;
  gauge.gauge!.range_kw_m2 = flux * 0.8;
  expect(checkPlan(doc).some(i => i.code === 'gauge-over-range')).toBe(true);
  doc.objects.push(...structuredClone(shared.cases.find(c => c.name === 'lower four samples hidden')!.objects));
  expect(checkPlan(doc).some(i => i.code === 'gauge-over-range')).toBe(false);
  expect(gaugeVerdict(doc, gauge)!.status).toBe('warn');
  gauge.gauge!.range_kw_m2 = flux * 15;
  expect(checkPlan(doc).some(i => i.code === 'gauge-low-signal')).toBe(true);
  doc.objects.pop();
  expect(checkPlan(doc).some(i => i.code === 'gauge-low-signal')).toBe(false);
});

it('still reports the sampled share for a gauge on the singular point source', () => {
  const doc = newPlan('in fire');
  const gauge: HeatFluxSensorObject = { id: 'gauge', type: 'heatFluxSensor', transform: { position_m: [0, 0, 1] } };
  doc.objects = [structuredClone(shared.burner), gauge,
    { id: 'box', type: 'obstruction', size_m: [2, 2, 4] }];
  const estimate = heatFluxEstimate(doc, gauge)!;
  expect(estimate.visibleFraction).toBe(1 / 9); // Only the coincident centre sample is within tolerance.
  expect(estimate.incidentKwM2).toBe(Infinity);
  expect(gaugeVerdict(doc, gauge)!.label).toBe('in the fire');
});

it('keeps reference bytes and the Example gauge numbers', () => {
  for (const [path, hash] of [
    ['pool-fire-camera-row.ftp.json', 'a1451e00a36c10e893237c54cc30cb402c9345aacf010b4d2135f76dc32aff19'],
    ['flame/flame-test.ftp.json', '7206263f12fa9da063f3ced9b91129314b9b1c8db9cf5f8f9ea423e477605dae'],
    ['fds/room_corner.ftp.json', '01686fb2bbf7dd882ccc18b83ab2661693bc80950d8473772233c7d0457bb15b'],
  ]) expect(createHash('sha256').update(fixture(path)).digest('hex')).toBe(hash);
  const doc = parsePlan(fixture('flame/flame-test.ftp.json'));
  for (const [name, flux, range] of [['East wall', 1.0, 50], ['North wall', 0.6, 10]] as const) {
    const gauge = heatFluxSensors(doc).find(s => s.name?.includes(name))!;
    const e = heatFluxEstimate(doc, gauge)!;
    expect(e.visibleFraction).toBe(1);
    expect(e.incidentKwM2).toBeCloseTo(flux, 1);
    expect(e.fractionOfRange).toBeCloseTo(flux / range, 2);
  }
});
