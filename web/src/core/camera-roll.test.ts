import { describe, expect, it } from 'vitest';
import { forwardOf, lookAtQuat, normalize, rollOf, sub, upOf, withRoll } from './math';
import { checkPlan, framingOf, isPointVisible, newPlan, projectToPixels, quatOf } from './plan';
import { setAimTarget, setPosition, setRotation, type AimableObject } from './transform';
import type { CameraObject, Vec3 } from './types';
import { recordAsBuilt } from './asbuilt';
import { Store } from '../state/store';

const radians = (deg: number): number => deg * Math.PI / 180;
const directions: Vec3[] = [[0, 1, 0], [1, 2, 3], [-2, 1, -3], [0.01, -0.02, 10],
  [0.01, -0.02, -10], [0, 0, 1], [0, 0, -1], [1e-6, 0, 1], [1e-6, 0, -1]];
const vectorClose = (actual: Vec3, expected: Vec3): void => {
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 10));
};
const camera = (): CameraObject => ({
  id: 'cam', type: 'camera',
  transform: { position_m: [0, -35, 5], aimTarget_m: [0, 0, 5],
    rotation_quat: lookAtQuat([0, -35, 5], [0, 0, 5]) },
  camera: { modality: 'MWIR', resolution_px: [1280, 720], sensor_mm: [17.92, 10.08], focalLength_mm: 50 },
});

describe('camera roll, matching the Python cases', () => {
  it.each(directions)('uses the level frame, including vertical fallback (%s, %s, %s)', (x, y, z) => {
    const q = lookAtQuat([0, 0, 0], [x, y, z]);
    expect(rollOf(q)).toBeCloseTo(0, 10);
    for (const deg of [-170, -90, -30, 30, 90, 179.9]) {
      const rolled = withRoll(q, radians(deg));
      expect(rollOf(rolled)).toBeCloseTo(radians(deg), 10);
      vectorClose(forwardOf(rolled), forwardOf(q));
      expect(Math.hypot(...rolled)).toBeCloseTo(1, 12);
      // Setting an absolute roll replaces the previous roll, even for -q.
      const opposite = rolled.map(v => -v) as typeof q;
      expect(rollOf(withRoll(opposite, radians(30)))).toBeCloseTo(radians(30), 10);
    }
  });

  it.each([-540, -180, 180, 540])('reports the half turn as +180 (%s)', deg => {
    expect(rollOf(withRoll(lookAtQuat([0, 0, 0], [0, 1, 0]), radians(deg))))
      .toBeCloseTo(Math.PI, 12);
  });

  it('puts the top edge on world +X for +90 when looking along +Y', () => {
    const q = withRoll(lookAtQuat([0, 0, 0], [0, 1, 0]), Math.PI / 2);
    vectorClose(upOf(q), [1, 0, 0]);
    vectorClose(forwardOf(q), [0, 1, 0]);
  });

  it.each(['camera', 'heatFluxSensor', 'velocityProbe'] as const)('keeps roll on moves and re-aims for %s', type => {
    const obj = { ...camera(), type } as AimableObject;
    obj.transform!.rotation_quat = withRoll(quatOf(obj), radians(-30));
    setPosition(obj, [3, -30, 2]);
    expect(rollOf(quatOf(obj))).toBeCloseTo(radians(-30), 10);
    vectorClose(forwardOf(quatOf(obj)), normalize(sub([0, 0, 5], [3, -30, 2])));
    expect(setAimTarget(obj, [1, 2, 10])).toBe(true);
    expect(rollOf(quatOf(obj))).toBeCloseTo(radians(-30), 10);
    vectorClose(forwardOf(quatOf(obj)), normalize(sub([1, 2, 10], [3, -30, 2])));
    const before = structuredClone(obj);
    expect(setAimTarget(obj, [3, -30, 2])).toBe(false);
    expect(obj).toEqual(before);
    setPosition(obj, [1, 2, 10]);
    expect(obj.transform!.rotation_quat).toEqual(before.transform!.rotation_quat);
  });

  it('defaults a missing quaternion to zero roll when re-aiming or moving', () => {
    for (const move of [false, true]) {
      const cam = camera();
      delete cam.transform!.rotation_quat;
      if (move) setPosition(cam, [3, -30, 2]);
      else setAimTarget(cam, [1, 2, 10]);
      expect(rollOf(quatOf(cam))).toBeCloseTo(0, 10);
    }
  });

  it('can still re-aim or move an object with a degenerate recorded quaternion', () => {
    for (const move of [false, true]) {
      const cam = camera();
      cam.transform!.rotation_quat = [0, 0, 0, 0];
      if (move) setPosition(cam, [3, -30, 2]);
      else setAimTarget(cam, [1, 2, 10]);
      expect(rollOf(quatOf(cam))).toBeCloseTo(0, 10);
    }
  });

  it('keeps hand rotations authoritative and unchanged on a move without a target', () => {
    const cam = camera();
    const q = withRoll(quatOf(cam), Math.PI / 2);
    setRotation(cam, q);
    expect(cam.transform!.aimTarget_m).toBeNull();
    setPosition(cam, [3, -30, 2]);
    expect(cam.transform!.rotation_quat).toEqual(q);
  });

  it('keeps measured roll independent when re-aiming or moving the survey pose', () => {
    const cam = camera();
    cam.transform!.rotation_quat = withRoll(quatOf(cam), Math.PI / 2);
    recordAsBuilt(cam);
    const planned = structuredClone(cam.transform);
    const measured = { ...cam, transform: cam.asBuilt!.transform };
    setAimTarget(measured, [1, 2, 10]);
    setPosition(measured, [3, -30, 2]);
    expect(rollOf(quatOf(measured))).toBeCloseTo(Math.PI / 2, 10);
    expect(cam.transform).toEqual(planned);
  });

  it('undoes a roll edit with its aim intact, and preserves roll on duplication', () => {
    const doc = newPlan(), cam = camera();
    doc.objects.push(cam);
    const store = new Store(doc);
    const original = structuredClone(cam.transform);
    store.edit('Roll', d => {
      d.objects[0].transform!.rotation_quat = withRoll(quatOf(d.objects[0]), Math.PI / 2);
    });
    store.commit();
    expect(store.document.objects[0].transform!.aimTarget_m).toEqual(original!.aimTarget_m);
    store.undo();
    expect(store.document.objects[0].transform).toEqual(JSON.parse(JSON.stringify(original)));
    store.redo();
    store.select(['cam']);
    store.duplicateSelected();
    expect(rollOf(quatOf(store.document.objects[1]))).toBeCloseTo(Math.PI / 2, 10);
    expect(checkPlan(store.document).map(i => i.code)).not.toContain('aim-mismatch');
  });

  it('frames a 10 m flame at 35 m with the long sensor axis vertical', () => {
    const cam = camera(), doc = newPlan();
    doc.objects.push(cam, { id: 'burner', type: 'burner', transform: { position_m: [0, 0, 0] },
      footprint: { shape: 'circle', diameter_m: 1 }, rimHeight_m: 0,
      fire: { hrr_kw: ((10 + 1.02) / 0.235) ** 2.5 } });
    expect(framingOf(doc, cam)).toMatchObject({ base: false, tip: false });
    const levelTip = projectToPixels(cam, [0, 0, 10]);
    expect(levelTip.u).toBeCloseTo(639.5, 9);
    expect(levelTip.v).toBeCloseTo(-150.704081632653, 9);
    cam.transform!.rotation_quat = withRoll(quatOf(cam), Math.PI / 2);
    expect(framingOf(doc, cam)).toMatchObject({ base: true, tip: true });
    const tip = projectToPixels(cam, [0, 0, 10]);
    expect(tip.u).toBeCloseTo(129.295918367347, 9);
    expect(tip.v).toBeCloseTo(359.5, 9);
    // Pixel-centre coverage is 7.0462 m level and 12.5342 m on its side.
    for (const [roll, span] of [[0, 7.0462], [90, 12.5342]]) {
      cam.transform!.rotation_quat = withRoll(quatOf(cam), radians(roll));
      expect(isPointVisible(cam, [0, 0, 5 + span / 2 - 1e-5])).toBe(true);
      expect(isPointVisible(cam, [0, 0, 5 + span / 2 + 1e-5])).toBe(false);
    }
    expect(checkPlan(doc).map(i => i.code)).not.toContain('aim-mismatch');
    setAimTarget(cam, [0, 10, 5]);
    expect(rollOf(quatOf(cam))).toBeCloseTo(Math.PI / 2, 10);
    expect(checkPlan(doc).map(i => i.code)).not.toContain('aim-mismatch');
    cam.transform!.aimTarget_m = [10, 0, 5];
    expect(checkPlan(doc).map(i => i.code)).toContain('aim-mismatch');
  });
});
