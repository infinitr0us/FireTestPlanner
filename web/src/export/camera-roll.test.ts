import { afterEach, describe, expect, it } from 'vitest';
import { lookAtQuat, withRoll } from '../core/math';
import { newPlan } from '../core/plan';
import type { CameraObject } from '../core/types';
import { setLanguage } from '../ui/i18n';
import { buildViewSvg } from './drawing';
import { buildReportBody } from './report';

afterEach(() => setLanguage('en'));

const setup = (deg: number) => {
  const doc = newPlan('roll');
  const cam: CameraObject = { id: 'cam', type: 'camera', name: 'MWIR',
    transform: { position_m: [0, -35, 5], aimTarget_m: [0, 0, 5],
      rotation_quat: withRoll(lookAtQuat([0, -35, 5], [0, 0, 5]), deg * Math.PI / 180) },
    camera: { modality: 'MWIR', resolution_px: [1280, 720], sensor_mm: [17.92, 10.08], focalLength_mm: 50 } };
  doc.objects.push(cam);
  return doc;
};

describe('printed camera roll', () => {
  it.each([90, -90, 89.6, -90.4])('says a quarter-turned camera is on its side (%s)', deg => {
    expect(buildReportBody(setup(deg), 'm')).toContain(`, on its side (roll ${Math.sign(deg) * 90}°)`);
  });
  it.each([30, -45, 179.9, 89.4])('prints any other roll as a roll (%s)', deg => {
    const body = buildReportBody(setup(deg), 'm');
    expect(body).toContain(`, rolled ${Math.sign(deg) * Math.round(Math.abs(deg))}°`);
    expect(body).not.toContain('on its side');
  });
  it('omits negligible roll and includes both signs beyond the half-degree threshold', () => {
    for (const deg of [0, 0.49, -0.49]) expect(buildReportBody(setup(deg), 'm')).not.toContain('rolled');
    expect(buildReportBody(setup(0.51), 'm')).toContain(', rolled 1°');
    expect(buildReportBody(setup(-0.51), 'm')).toContain(', rolled -1°');
    expect(buildReportBody(setup(0.5), 'm')).toContain(', rolled 1°');
    expect(buildReportBody(setup(-0.5), 'm')).toContain(', rolled -1°');
  });
  it('prints the mounting instruction in Canadian French', () => {
    setLanguage('fr');
    expect(buildReportBody(setup(90), 'm')).toContain(', sur le côté (roulis de 90°)');
  });
  it.each([0, 90])('projects the real frustum corners in plan (%s)', deg => {
    const doc = setup(deg);
    for (const view of ['plan'] as const) {
      const svg = buildViewSvg(doc, view, 'm');
      const frustum = svg.split('\n').find(line => line.startsWith('<polygon') && line.includes('fill-opacity="0.07"'));
      expect(frustum, view).toBeDefined();
      const points = /points="([^"]+)"/.exec(frustum!)![1].split(' ').map(pt => pt.split(',').map(Number));
      const width = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
      const height = Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]));
      // Page scale cancels: a level camera spreads its long sensor axis across the
      // plan, a rolled one its short axis.
      const expected = (deg === 0 ? 17.92 : 10.08) / 50;
      expect(width / height, view).toBeCloseTo(expected, 3);
    }
  });
});
