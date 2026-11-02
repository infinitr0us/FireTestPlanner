import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newPlan, parsePlan } from '../core/plan';
import type { WallObject } from '../core/types';
import { buildViewSvg, escapeXml } from './drawing';
import { buildReportBody, REPORT_CSS } from './report';

function openingPlan() {
  const doc = newPlan();
  const wall: WallObject = {
    id: 'w', type: 'wall', polyline_m: [[0, 0], [4, 0]],
    height_m: 3, thickness_m: 0.2,
    openings: [
      { id: 'door', offset_m: 0.5, width_m: 1, height_m: 2 },
      { id: 'window', offset_m: 2, width_m: 1, height_m: 1, sillHeight_m: 1 },
    ],
  };
  doc.objects.push(wall);
  return { doc, wall };
}

describe('wall opening drawings', () => {
  it('cuts the door and window at their projected front coordinates', () => {
    const { doc } = openingPlan();
    // Width 4 m -> scale 197 px/m; wall top y=56, base y=647.
    const svg = buildViewSvg(doc, 'front', 'm');
    expect(svg).toMatch(/<mask[^>]+id="[^"]+"/);
    expect(svg).toContain('class="wall-opening"');
    expect(svg).toContain('points="154.50,647.00 351.50,647.00 351.50,253.00 154.50,253.00"');
    expect(svg).toContain('points="450.00,450.00 647.00,450.00 647.00,253.00 450.00,253.00"');
    expect(svg).toContain('>width 1.000 m</text>');
    expect(svg).toContain('>sill 1.000 m</text>');
  });

  it('projects translated, rotated openings in side, angled and edge-on views', () => {
    const { doc, wall } = openingPlan();
    wall.transform = { position_m: [1, 2, 0.5], rotation_quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] };
    wall.baseHeight_m = 0.5;
    const side = buildViewSvg(doc, 'side', 'ft-in');
    // World Y spans 0..6, Z spans 0..4. Door at Y=2.5..3.5, Z=1..3.
    expect(side).toContain('points="515.67,450.00 384.33,450.00 384.33,187.33 515.67,187.33"');
    const edge = buildViewSvg(doc, 'front', 'm');
    expect(edge.match(/class="wall-opening"/g)).toHaveLength(2);
    expect(edge).not.toMatch(/NaN|Infinity/);
    // Seen edge-on, the openings keep their outlines but carry no dimensions: the
    // facing elevation and the plan give them, and here they collided with others.
    expect(edge).not.toMatch(/edge-on|width |sill /);
    wall.transform.rotation_quat = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
    const angled = buildViewSvg(doc, 'front', 'm');
    // Projected opening width is cos(45 degrees), dimension remains the actual 1 m.
    expect(angled).toContain('>width 1.000 m</text>');
    expect(angled).not.toBe(edge);
  });

  it('marks the window with thin parallel lines and labels its width in plan', () => {
    const { doc } = openingPlan();
    const svg = buildViewSvg(doc, 'plan', 'ft-in');
    const window = svg.match(/<g class="wall-window"[^>]*>([\s\S]*?)<\/g>/)?.[1];
    expect(window).toBeDefined();
    expect(window!.match(/<line /g)).toHaveLength(2);
    expect(window).toContain('stroke-width="0.8"');
    expect(svg).toContain(escapeXml(`width 3' 3 3/8"`));
  });

  it('splits an opening across polyline corners and ignores zero-length segments', () => {
    const { doc, wall } = openingPlan();
    wall.polyline_m = [[0, 0], [2.5, 0], [2.5, 0], [2.5, 2]];
    expect(buildViewSvg(doc, 'front', 'm').match(/class="wall-opening"/g)).toHaveLength(3);
    expect(buildViewSvg(doc, 'plan', 'm').match(/class="wall-window"/g)).toHaveLength(2);
  });

  it('unions overlapping holes, clips at the wall limits, and preserves explicit color', () => {
    const { doc, wall } = openingPlan();
    wall.display = { color: '#123456' };
    wall.openings!.push({ offset_m: 2.5, width_m: 3, sillHeight_m: 0.5, height_m: 5 });
    const svg = buildViewSvg(doc, 'front', 'm');
    const mask = svg.match(/<mask[\s\S]*?<\/mask>/)![0];
    // All holes subtract black from the same mask, including their intersection.
    expect(mask.match(/fill="#000000"/g)).toHaveLength(3);
    expect(mask).toContain('points="548.50,548.50 844.00,548.50 844.00,56.00 548.50,56.00"');
    expect(svg).toContain('class="wall-opening" fill="none" stroke="#123456"');
    expect(buildViewSvg(doc, 'plan', 'm')).toContain('stroke="#123456" stroke-width="0.8"');
  });
});

describe('crew set-out table', () => {
  const load = () => parsePlan(readFileSync(new URL('../../../fixtures/flame/flame-test.ftp.json', import.meta.url), 'utf8'));
  const table = (html: string) => html.match(/<table class="set-out">[\s\S]*?<\/table>/)![0];
  const row = (html: string, id: string) => html.match(new RegExp(`<tr data-object-id="${id}">([\\s\\S]*?)</tr>`))![1];
  const has = (r: string, text: string) => expect(r).toContain(escapeXml(text));

  it.each(['ft', 'ft-in'] as const)('lists all 12 physical Example objects in %s', unit => {
    const doc = load();
    const body = buildReportBody(doc, unit);
    const t = table(body);
    expect(t.match(/<tr data-object-id=/g)).toHaveLength(12);
    for (const obj of doc.objects.filter(o => o.type !== 'reconstructedFlame')) has(row(t, obj.id), obj.name!);
    expect(t).not.toContain('flame-main');
    expect(body.indexOf('<h2>Set-out</h2>')).toBeGreaterThan(body.indexOf('<h2>Equipment</h2>'));
    expect(body.indexOf('<h2>Set-out</h2>')).toBeLessThan(body.indexOf('<h2>Camera coverage</h2>'));
    expect(body).toContain('Origin: burner centre at floor level; +X');
    if (unit === 'ft') {
      for (const value of ['-9.000', '-2.461', '4.921', '9.330 / 10.549', 'X 0.000', 'Z 2.461']) has(row(t, 'cam-mwir'), value);
      for (const value of ['Base 0.000', 'Bead 1: 0.984', 'Bead 4: 6.890']) has(row(t, 'tc-east-wall'), value);
      for (const value of ['P1: 4.921', 'P2: 4.921', 'Base 0.000', 'Top 7.874']) has(row(t, 'wall-east'), value);
      has(row(t, 'hood-main'), 'Intake 8.000'); // 9 ft opening minus the 1 ft skirt
      has(row(t, 'burner-main'), '0.328');
    } else {
      for (const value of [`-9' 0"`, `-2' 5 1/2"`, `4' 11 1/16"`, `9' 3 15/16" / 10' 6 9/16"`, `Z 2' 5 1/2"`]) has(row(t, 'cam-mwir'), value);
      has(row(t, 'tc-east-wall'), `Bead 4: 6' 10 11/16"`);
      has(row(t, 'hood-main'), `Intake 8' 0"`);
      has(row(t, 'burner-main'), `0' 3 15/16"`);
    }
    // Facing in words a crew can set: the east wall gauge looks back along -X at the
    // flame, tipped down to mid-flame; the north wall gauge along -Y.
    has(row(t, 'hf-east'), 'toward -X, 6° down');
    has(row(t, 'hf-north'), 'toward -Y, 4° down');
    const expected = unit === 'ft' ? {
      'cam-lwir-t650': ['-9.000', '-0.820', '4.921', '9.037 / 10.290'],
      'cam-gopro': ['-9.000', '0.820', '3.937', '9.037 / 9.858'],
      'cam-iphone': ['-9.000', '2.461', '3.937', '9.330 / 10.127'],
      'hf-east': ['4.757', '0.000', '2.953', 'Z 2.454'],
      'hf-north': ['0.000', '6.398', '2.953', 'Z 2.454'],
      'wall-north': ['P1: 4.921', 'P2: -6.562', 'P1: 6.562', 'P2: 6.562', 'Top 7.874'],
      'tc-plume': ['0.820', 'Base 0.000', 'Bead 1: 5.249', 'Bead 2: 6.234', 'Bead 3: 7.218'],
    } : {
      'cam-lwir-t650': [`-9' 0"`, `-0' 9 13/16"`, `4' 11 1/16"`, `9' 0 7/16" / 10' 3 1/2"`],
      'cam-gopro': [`-9' 0"`, `0' 9 13/16"`, `3' 11 1/4"`, `9' 0 7/16" / 9' 10 5/16"`],
      'cam-iphone': [`-9' 0"`, `2' 5 1/2"`, `3' 11 1/4"`, `9' 3 15/16" / 10' 1 1/2"`],
      'hf-east': [`4' 9 1/16"`, `0' 0"`, `2' 11 7/16"`, `Z 2' 5 7/16"`],
      'hf-north': [`0' 0"`, `6' 4 3/4"`, `2' 11 7/16"`, `Z 2' 5 7/16"`],
      'wall-north': [`P1: 4' 11 1/16"`, `P2: -6' 6 3/4"`, `P1: 6' 6 3/4"`, `P2: 6' 6 3/4"`, `Top 7' 10 1/2"`],
      'tc-plume': [`0' 9 13/16"`, `Base 0' 0"`, `Bead 1: 5' 3"`, `Bead 2: 6' 2 13/16"`, `Bead 3: 7' 2 5/8"`],
    };
    for (const [id, values] of Object.entries(expected)) for (const value of values) has(row(t, id), value);
  });

  it('includes boxes, slabs and single beads, with world heights and safe text', () => {
    const doc = newPlan();
    doc.objects.push(
      { id: 'box', type: 'obstruction', name: '<box>', size_m: [1, 2, 3], transform: { position_m: [4, 5, 6] } },
      { id: 'slab', type: 'ceiling', polygon_m: [[0, 0], [1, 0], [1, 1]], height_m: 3, transform: { position_m: [1, 2, 4] } },
      { id: 'bead', type: 'thermocouple', transform: { position_m: [1, 2, 3] } },
    );
    const t = table(buildReportBody(doc, 'm'));
    has(row(t, 'box'), '<box>');
    has(row(t, 'box'), 'Top 9.000');
    has(row(t, 'slab'), '7.000');
    has(row(t, 'bead'), 'Bead 1: 3.000');
    expect(REPORT_CSS).toMatch(/\.report \.set-out tr\s*\{[^}]*break-inside: avoid/);
  });

  it('uses full instrument transforms, authoritative facing, and recorded axis orientation', () => {
    const doc = newPlan();
    doc.coordinateSystem.northAzimuth_rad = Math.PI;
    doc.objects.push(
      { id: 'rake', type: 'thermocouple', beadOffsets_m: [0, 2], transform: { position_m: [1, 2, 3], rotation_quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2] } },
      { id: 'gauge', type: 'heatFluxSensor', transform: { position_m: [1, 2, 3], rotation_quat: [0, 0, 0, 1], aimTarget_m: [1, 5, 3] } },
      { id: 'wall', type: 'wall', polyline_m: [[0, 0], [2, 0]], height_m: 3, baseHeight_m: 0.5,
        transform: { position_m: [2, 3, 1], rotation_quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } },
    );
    const body = buildReportBody(doc, 'm'), t = table(body);
    for (const value of ['Bead 2: 3.000', 'Bead 2: 2.000']) has(row(t, 'rake'), value);
    // Facing follows the quaternion (identity looks down -Z), not the advisory aim.
    for (const value of ['straight down', 'Y 5.000']) has(row(t, 'gauge'), value);
    for (const value of ['P1: 2.000', 'P2: 2.000', 'P1: 3.000', 'P2: 5.000', 'Base 1.500', 'Top 4.500']) has(row(t, 'wall'), value);
    expect(body).toContain('+X west (right in plan); +Y south (up in plan)');
  });
});

describe('facingText', () => {
  it('names the axis, the turn off it and the tilt, in whole degrees', async () => {
    const { facingText } = await import('./report');
    const deg = Math.PI / 180;
    expect(facingText([1, 0, 0])).toBe('toward +X');
    expect(facingText([0, -1, 0])).toBe('toward -Y');
    expect(facingText([-Math.cos(6 * deg), 0, -Math.sin(6 * deg)])).toBe('toward -X, 6° down');
    expect(facingText([Math.cos(20 * deg), Math.sin(20 * deg), 0])).toBe('toward +X, 20° toward +Y');
    expect(facingText([-Math.cos(30 * deg), -Math.sin(30 * deg), 0])).toBe('toward -X, 30° toward -Y');
    expect(facingText([0, 0, 1])).toBe('straight up');
    expect(facingText([0.01, 0, -0.9999])).toBe('straight down');
  });
});
