/**
 * Dimensioned plan and elevation drawings as SVG.
 *
 * SVG rather than a canvas raster: the output goes into a document people print,
 * and a dimension line that turns to mush at 200% zoom is not a drawing. It is also
 * dependency-free, which keeps the single-file build self-contained.
 */

import {
  beadOffsetsOf,
  burnerDiameterM,
  burners,
  cameras,
  ceilings,
  displayName,
  cameraColor,
  flameTipZM,
  footprintXY,
  fuelSurfaceZM,
  gaugeViewAngleDeg,
  heatFluxSensors,
  hfovRadOf,
  hoodIntakeHeightM,
  hoodOpeningCornersXY,
  hoods,
  objectColor,
  plumeRadiusAtZ,
  positionOf,
  quatOf,
  standoffHorizontalM,
  thermocouples,
  toWorld,
  walls,
} from '../core/plan';
import { forwardOf } from '../core/math';
import { formatLengthWithUnit } from '../core/units';
import type { LengthUnit, PlanDocument, Vec3 } from '../core/types';

export type DrawingView = 'plan' | 'front' | 'side';

const PAGE_WIDTH_PX = 900;
const MARGIN_PX = 56;
const MIN_SPAN_M = 2;

const COLORS = {
  ink: '#1f2937',
  faint: '#cbd5e1',
  grid: '#eef2f7',
  dim: '#0369a1',
  burner: '#7c3aed',
  flame: '#f59e0b',
  hood: '#0284c7',
  wall: '#64748b',
  ceiling: '#94a3b8',
};

export const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);

/** Maps world metres onto SVG pixels for one of the three standard views. */
class Projector {
  constructor(
    private view: DrawingView,
    private scale: number,
    private offsetX: number,
    private offsetY: number,
  ) {}

  /** World -> the view's own 2D axes, before scaling. SVG y grows downward, so the
   *  vertical component is negated to keep "up" up. */
  plane(p: Vec3): [number, number] {
    switch (this.view) {
      case 'plan':
        return [p[0], -p[1]];
      case 'front':
        return [p[0], -p[2]];
      case 'side':
        return [p[1], -p[2]];
    }
  }

  project(p: Vec3): [number, number] {
    const [u, v] = this.plane(p);
    return [u * this.scale + this.offsetX, v * this.scale + this.offsetY];
  }

  get pxPerMetre(): number {
    return this.scale;
  }
}

interface Bounds {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
}

/** Every point the drawing must contain, in the view's own 2D axes. */
function collectPoints(doc: PlanDocument, view: DrawingView): Vec3[] {
  const pts: Vec3[] = [[0, 0, 0]];

  for (const b of burners(doc)) {
    const p = positionOf(b);
    const r = burnerDiameterM(b) / 2;
    pts.push([p[0] - r, p[1] - r, p[2]], [p[0] + r, p[1] + r, p[2]]);
    const tip = flameTipZM(b);
    if (tip !== null) pts.push([p[0], p[1], tip]);
  }
  for (const hd of hoods(doc)) {
    for (const [x, y] of hoodOpeningCornersXY(hd)) pts.push([x, y, 0], [x, y, hd.height_m]);
  }
  for (const wl of walls(doc)) {
    const p = positionOf(wl);
    for (const v of wl.polyline_m) {
      const [x, y] = footprintXY(wl, v);
      pts.push([x, y, p[2]], [x, y, p[2] + wl.height_m]);
    }
  }
  for (const cl of ceilings(doc)) {
    for (const v of cl.polygon_m) {
      const [x, y] = footprintXY(cl, v);
      pts.push([x, y, cl.height_m]);
    }
  }
  for (const cam of cameras(doc)) {
    const p = positionOf(cam);
    pts.push([p[0], p[1], p[2]], [p[0], p[1], 0]); // include the tripod foot
  }
  for (const s of heatFluxSensors(doc)) {
    const p = positionOf(s);
    pts.push([p[0], p[1], p[2]], [p[0], p[1], 0]);
  }
  for (const tc of thermocouples(doc)) {
    // Every bead, not the origin: a rake reaching to the ceiling would otherwise
    // be scaled as though it were a point on the floor.
    for (const offset of beadOffsetsOf(tc)) pts.push(toWorld(tc, [0, 0, offset]));
    const p = positionOf(tc);
    pts.push([p[0], p[1], 0]);
  }

  if (view !== 'plan') pts.push([0, 0, 0]); // the ground line always shows
  return pts;
}

function makeProjector(doc: PlanDocument, view: DrawingView): { projector: Projector; height: number } {
  const raw = collectPoints(doc, view);
  const planar = raw.map((p) => {
    switch (view) {
      case 'plan': return [p[0], -p[1]] as [number, number];
      case 'front': return [p[0], -p[2]] as [number, number];
      case 'side': return [p[1], -p[2]] as [number, number];
    }
  });

  const bounds: Bounds = {
    minU: Math.min(...planar.map((q) => q[0])),
    maxU: Math.max(...planar.map((q) => q[0])),
    minV: Math.min(...planar.map((q) => q[1])),
    maxV: Math.max(...planar.map((q) => q[1])),
  };

  const spanU = Math.max(bounds.maxU - bounds.minU, MIN_SPAN_M);
  const spanV = Math.max(bounds.maxV - bounds.minV, MIN_SPAN_M);
  const scale = (PAGE_WIDTH_PX - 2 * MARGIN_PX) / spanU;
  const height = spanV * scale + 2 * MARGIN_PX;

  return {
    projector: new Projector(view, scale, MARGIN_PX - bounds.minU * scale, MARGIN_PX - bounds.minV * scale),
    height,
  };
}

// -- primitives -----------------------------------------------------------

const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, extra = ''): string =>
  `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${stroke}" ${extra}/>`;

const text = (x: number, y: number, s: string, extra = ''): string =>
  `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" ${extra}>${escapeXml(s)}</text>`;

const polygon = (points: Array<[number, number]>, extra: string): string =>
  `<polygon points="${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}" ${extra}/>`;

/**
 * Keeps co-located labels from overprinting into an unreadable smear.
 *
 * Instruments cluster: a gauge and a rake on the same wall are one point in plan,
 * and a camera row is one point in elevation. Both views need the same treatment,
 * so both use this rather than each growing its own copy.
 */
class LabelStacker {
  private occupied = new Map<string, number>();

  /** How many labels already sit near this point. Call once per label. */
  claim(x: number, y: number): number {
    const key = `${Math.round(x / 12)}:${Math.round(y / 12)}`;
    const n = this.occupied.get(key) ?? 0;
    this.occupied.set(key, n + 1);
    return n;
  }
}

/** One line of stacked-label clearance. */
const LABEL_LINE_PX = 11;

/**
 * An object label that stays inside the drawing.
 *
 * Names like "FLIR T650 LWIR" are wider than the margin, so a label anchored the
 * wrong way against an edge is simply clipped away. Flip the anchor near either
 * edge rather than losing the text.
 */
function objectLabel(x: number, y: number, s: string): string {
  const estimated = s.length * 5.4;
  let anchor = 'middle';
  let dx = 0;
  if (x - estimated / 2 < 4) {
    anchor = 'start';
    dx = 6;
  } else if (x + estimated / 2 > PAGE_WIDTH_PX - 4) {
    anchor = 'end';
    dx = -6;
  }
  return text(x + dx, y, s, `class="obj-label" text-anchor="${anchor}"`);
}

/**
 * A dimension line with ticks and a centred label.
 *
 * The label is drawn on a white plate so it stays readable where it crosses
 * geometry -- the same reason a draughtsman breaks the line for the number.
 */
function dimension(
  x1: number, y1: number, x2: number, y2: number, label: string,
): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const tick = 4;
  const tx = Math.cos(angle + Math.PI / 2) * tick;
  const ty = Math.sin(angle + Math.PI / 2) * tick;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const width = label.length * 5.4 + 8;

  return [
    line(x1, y1, x2, y2, COLORS.dim, 'stroke-width="0.8"'),
    line(x1 - tx, y1 - ty, x1 + tx, y1 + ty, COLORS.dim, 'stroke-width="0.8"'),
    line(x2 - tx, y2 - ty, x2 + tx, y2 + ty, COLORS.dim, 'stroke-width="0.8"'),
    `<rect x="${(mx - width / 2).toFixed(2)}" y="${(my - 7).toFixed(2)}" width="${width.toFixed(2)}" height="12" fill="#ffffff" opacity="0.92"/>`,
    text(mx, my + 3, label, `class="dim-text" text-anchor="middle"`),
  ].join('');
}

// -- views ----------------------------------------------------------------

function drawPlan(doc: PlanDocument, p: Projector, unit: LengthUnit): string {
  const out: string[] = [];
  // Shared with drawInstrumentsPlan: a gauge on the wall behind a camera must not
  // land its label on top of the camera's.
  const labels = new LabelStacker();

  // Footprints go through footprintXY, so a rotated wall or slab is drawn in the
  // orientation the 3D view shows rather than its unrotated one.
  for (const cl of ceilings(doc)) {
    const pts = cl.polygon_m.map((v) => p.project([...footprintXY(cl, v), 0]));
    out.push(polygon(pts, `fill="none" stroke="${COLORS.ceiling}" stroke-width="0.8" stroke-dasharray="6 3"`));
  }

  for (const wl of walls(doc)) {
    const pts = wl.polyline_m.map((v) => p.project([...footprintXY(wl, v), 0]));
    const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    const widthPx = Math.max((wl.thickness_m ?? 0.1) * p.pxPerMetre, 2);
    out.push(`<path d="${d}" fill="none" stroke="${COLORS.wall}" stroke-width="${widthPx.toFixed(2)}" stroke-linecap="butt"/>`);
  }

  for (const hd of hoods(doc)) {
    out.push(polygon(hoodOpeningCornersXY(hd).map(([x, y]) => p.project([x, y, 0])),
      `fill="${COLORS.hood}" fill-opacity="0.06" stroke="${COLORS.hood}" stroke-width="1" stroke-dasharray="8 4"`));
  }

  // Camera fields of view, drawn as wedges so overlap is visible at a glance.
  for (const cam of cameras(doc)) {
    const origin = positionOf(cam);
    const fwd = forwardOf(quatOf(cam));
    const heading = Math.atan2(fwd[1], fwd[0]);
    const half = hfovRadOf(cam) / 2;
    const reach = Math.max(standoffHorizontalM(cam) * 1.25, 1);
    const [ax, ay] = p.project(origin);
    const arm = (a: number): [number, number] =>
      p.project([origin[0] + Math.cos(a) * reach, origin[1] + Math.sin(a) * reach, origin[2]]);
    // cameraColor already rejects anything but #rrggbb; escaping as well means a
    // future caller that widens it cannot break out of the attribute.
    const color = escapeXml(cameraColor(cam));
    out.push(polygon([[ax, ay], arm(heading - half), arm(heading + half)],
      `fill="${color}" fill-opacity="0.07" stroke="${color}" stroke-width="0.6" stroke-opacity="0.55"`));
  }

  for (const b of burners(doc)) {
    const origin = positionOf(b);
    const [cx, cy] = p.project(origin);
    const r = (burnerDiameterM(b) / 2) * p.pxPerMetre;
    if (b.footprint.shape === 'circle') {
      out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${Math.max(r, 2).toFixed(2)}" fill="${COLORS.flame}" fill-opacity="0.25" stroke="${COLORS.burner}" stroke-width="1.4"/>`);
    } else {
      const [w, d] = b.footprint.size_m ?? [0.3, 0.3];
      const corners: Array<[number, number]> = [
        [-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2],
      ];
      out.push(polygon(corners.map((c) => p.project([...footprintXY(b, c), 0])),
        `fill="${COLORS.flame}" fill-opacity="0.25" stroke="${COLORS.burner}" stroke-width="1.4"`));
    }
  }

  // Camera markers, labels, and the standoff dimensions that make this a plan.
  for (const cam of cameras(doc)) {
    const origin = positionOf(cam);
    const [cx, cy] = p.project(origin);
    const [ox, oy] = p.project([0, 0, 0]);
    out.push(dimension(ox, oy, cx, cy, formatLengthWithUnit(standoffHorizontalM(cam), unit)));
    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4" fill="${escapeXml(cameraColor(cam))}" stroke="#ffffff" stroke-width="1"/>`);
    out.push(objectLabel(cx, cy - 9 - labels.claim(cx, cy) * LABEL_LINE_PX, displayName(cam)));
  }

  out.push(drawInstrumentsPlan(doc, p, labels));

  const [ox, oy] = p.project([0, 0, 0]);
  out.push(line(ox - 10, oy, ox + 10, oy, COLORS.ink, 'stroke-width="0.8"'));
  out.push(line(ox, oy - 10, ox, oy + 10, COLORS.ink, 'stroke-width="0.8"'));

  return out.join('\n');
}

/**
 * Gauges and thermocouples in plan.
 *
 * A gauge gets its sight line drawn, for the same reason a camera gets its field
 * of view: the direction is not decoration, it is a term in what the instrument
 * reads, and a rig sheet that omits it cannot be checked on site.
 */
function drawInstrumentsPlan(doc: PlanDocument, p: Projector, labels: LabelStacker): string {
  const out: string[] = [];

  for (const s of heatFluxSensors(doc)) {
    const origin = positionOf(s);
    const fwd = forwardOf(quatOf(s));
    const heading = Math.atan2(fwd[1], fwd[0]);
    const color = escapeXml(objectColor(s));
    const [cx, cy] = p.project(origin);
    const reach = Math.max(Math.hypot(origin[0], origin[1]) * 0.6, 0.4);
    const viewAngle = gaugeViewAngleDeg(s);
    const arm = (a: number): [number, number] =>
      p.project([origin[0] + Math.cos(a) * reach, origin[1] + Math.sin(a) * reach, origin[2]]);

    if (viewAngle < 180) {
      const half = ((viewAngle / 2) * Math.PI) / 180;
      out.push(polygon([[cx, cy], arm(heading - half), arm(heading + half)],
        `fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="0.6" stroke-opacity="0.6"`));
    } else {
      const [ex, ey] = arm(heading);
      out.push(line(cx, cy, ex, ey, color, 'stroke-width="0.8" stroke-dasharray="4 3"'));
    }

    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4" fill="${color}" stroke="#ffffff" stroke-width="1"/>`);
    out.push(objectLabel(cx, cy - 9 - labels.claim(cx, cy) * LABEL_LINE_PX, displayName(s)));
  }

  for (const tc of thermocouples(doc)) {
    const beads = beadOffsetsOf(tc);
    // An upright rake stacks every bead on one point in plan, so the count is the
    // only thing plan view can honestly say about it.
    const [cx, cy] = p.project(positionOf(tc));
    const color = escapeXml(objectColor(tc));
    const arm = 4.5;
    out.push(line(cx - arm, cy, cx + arm, cy, color, 'stroke-width="1.4"'));
    out.push(line(cx, cy - arm, cx, cy + arm, color, 'stroke-width="1.4"'));
    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="2" fill="${color}"/>`);
    out.push(objectLabel(cx, cy - 9 - labels.claim(cx, cy) * LABEL_LINE_PX,
      beads.length > 1 ? `${displayName(tc)} (×${beads.length})` : displayName(tc)));
  }

  return out.join('\n');
}

function drawElevation(doc: PlanDocument, p: Projector, unit: LengthUnit, view: DrawingView): string {
  const out: string[] = [];
  const lateral = (pt: Vec3): number => (view === 'side' ? pt[1] : pt[0]);

  // Ground line spanning the drawing.
  const groundLeft = p.project([-1000, -1000, 0]);
  const groundRight = p.project([1000, 1000, 0]);
  out.push(line(0, groundLeft[1], PAGE_WIDTH_PX, groundRight[1], COLORS.ink, 'stroke-width="1.4"'));

  // An elevation shows an object's extent along the view's lateral axis, so the
  // footprint has to be rotated before it is flattened -- a wall turned 90 degrees
  // spans a different width on the page.
  for (const cl of ceilings(doc)) {
    const coords = cl.polygon_m.map((v) => lateral([...footprintXY(cl, v), 0]));
    const lo = Math.min(...coords);
    const hi = Math.max(...coords);
    const a = p.project(view === 'side' ? [0, lo, cl.height_m] : [lo, 0, cl.height_m]);
    const b = p.project(view === 'side' ? [0, hi, cl.height_m] : [hi, 0, cl.height_m]);
    out.push(line(a[0], a[1], b[0], b[1], COLORS.ceiling, 'stroke-width="3"'));
    out.push(text(b[0] + 6, b[1] + 3, formatLengthWithUnit(cl.height_m, unit), 'class="obj-label"'));
  }

  for (const wl of walls(doc)) {
    const origin = positionOf(wl);
    const coords = wl.polyline_m.map((v) => lateral([...footprintXY(wl, v), 0]));
    const lo = Math.min(...coords);
    const hi = Math.max(...coords);
    const base = origin[2] + (wl.baseHeight_m ?? 0);
    const corner = (u: number, z: number): [number, number] =>
      p.project(view === 'side' ? [0, u, z] : [u, 0, z]);
    out.push(polygon([
      corner(lo, base), corner(hi, base), corner(hi, base + wl.height_m), corner(lo, base + wl.height_m),
    ], `fill="${COLORS.wall}" fill-opacity="0.18" stroke="${COLORS.wall}" stroke-width="1"`));
  }

  for (const hd of hoods(doc)) {
    // Extent of the rotated opening along this view's axis, not the raw opening
    // dimension: a hood at 45 degrees presents a wider face than either side.
    const coords = hoodOpeningCornersXY(hd).map(([x, y]) => lateral([x, y, 0]));
    const span = Math.max(...coords) - Math.min(...coords);
    const centre = (Math.max(...coords) + Math.min(...coords)) / 2;
    const intake = hoodIntakeHeightM(hd);
    const at = (u: number, z: number): [number, number] =>
      p.project(view === 'side' ? [0, u, z] : [u, 0, z]);
    const apex = hd.height_m + Math.max(span * 0.45, 0.4);
    out.push(polygon([
      at(centre - span / 2, intake),
      at(centre + span / 2, intake),
      at(centre + span / 2, hd.height_m),
      at(centre + 0.15, apex),
      at(centre - 0.15, apex),
      at(centre - span / 2, hd.height_m),
    ], `fill="${COLORS.hood}" fill-opacity="0.1" stroke="${COLORS.hood}" stroke-width="1.2"`));

    const edge = at(centre + span / 2, intake);
    out.push(dimension(edge[0] + 26, at(0, 0)[1], edge[0] + 26, edge[1],
      formatLengthWithUnit(intake, unit)));
  }

  for (const b of burners(doc)) {
    const origin = positionOf(b);
    const centre = lateral(origin);
    const surface = fuelSurfaceZM(b);
    const dEff = burnerDiameterM(b);
    const at = (u: number, z: number): [number, number] =>
      p.project(view === 'side' ? [0, u, z] : [u, 0, z]);

    out.push(polygon([
      at(centre - dEff / 2, origin[2]),
      at(centre + dEff / 2, origin[2]),
      at(centre + dEff / 2, surface),
      at(centre - dEff / 2, surface),
    ], `fill="${COLORS.burner}" fill-opacity="0.3" stroke="${COLORS.burner}" stroke-width="1.2"`));

    const tip = flameTipZM(b);
    if (tip !== null) {
      out.push(polygon([
        at(centre - dEff / 2, surface), at(centre + dEff / 2, surface), at(centre, tip),
      ], `fill="${COLORS.flame}" fill-opacity="0.35" stroke="${COLORS.flame}" stroke-width="1"`));

      // Plume envelope, dashed: it is a correlation, not a measurement.
      const top = surface + (tip - surface) * 2.2;
      const rTop = plumeRadiusAtZ(b, top) ?? 0;
      const rMid = plumeRadiusAtZ(b, surface) ?? 0;
      for (const side of [-1, 1]) {
        const a = at(centre + side * rMid, surface);
        const c = at(centre + side * rTop, top);
        out.push(line(a[0], a[1], c[0], c[1], COLORS.flame, 'stroke-width="0.8" stroke-dasharray="4 3" stroke-opacity="0.75"'));
      }

      const tipPt = at(centre, tip);
      out.push(dimension(tipPt[0] - 30, at(0, 0)[1], tipPt[0] - 30, tipPt[1],
        formatLengthWithUnit(tip, unit)));
    }
  }

  // A camera row is usually a line of tripods at one standoff, so in elevation
  // several cameras land on the same spot.
  const labels = new LabelStacker();

  for (const cam of cameras(doc)) {
    const origin = positionOf(cam);
    const u = lateral(origin);
    const at = (uu: number, z: number): [number, number] =>
      p.project(view === 'side' ? [0, uu, z] : [uu, 0, z]);
    const [cx, cy] = at(u, origin[2]);
    const [fx, fy] = at(u, 0);

    const stacked = labels.claim(cx, cy);

    out.push(line(cx, cy, fx, fy, COLORS.faint, 'stroke-width="1" stroke-dasharray="3 3"'));
    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4" fill="${escapeXml(cameraColor(cam))}" stroke="#ffffff" stroke-width="1"/>`);
    out.push(objectLabel(cx, cy - 9 - stacked * LABEL_LINE_PX, displayName(cam)));
    if (stacked === 0) {
      out.push(text(cx + 7, cy + 4, formatLengthWithUnit(origin[2], unit), 'class="dim-text"'));
    }
  }

  // Instruments, after the cameras so the same label-stacking map keeps them all
  // apart -- a gauge and a tripod at the same standoff otherwise overprint.
  for (const s of heatFluxSensors(doc)) {
    const origin = positionOf(s);
    const at = (uu: number, z: number): [number, number] =>
      p.project(view === 'side' ? [0, uu, z] : [uu, 0, z]);
    const [cx, cy] = at(lateral(origin), origin[2]);
    const [fx, fy] = at(lateral(origin), 0);
    const color = escapeXml(objectColor(s));

    const stacked = labels.claim(cx, cy);

    out.push(line(cx, cy, fx, fy, COLORS.faint, 'stroke-width="1" stroke-dasharray="3 3"'));
    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4" fill="${color}" stroke="#ffffff" stroke-width="1"/>`);
    out.push(objectLabel(cx, cy - 9 - stacked * LABEL_LINE_PX, displayName(s)));
    if (stacked === 0) {
      out.push(text(cx + 7, cy + 4, formatLengthWithUnit(origin[2], unit), 'class="dim-text"'));
    }
  }

  for (const tc of thermocouples(doc)) {
    const beads = beadOffsetsOf(tc).map((offset) => toWorld(tc, [0, 0, offset]));
    const color = escapeXml(objectColor(tc));
    const at = (w: Vec3): [number, number] =>
      p.project(view === 'side' ? [0, w[1], w[2]] : [w[0], 0, w[2]]);

    // Elevation is the view a rake is FOR: this is where a bead spacing against
    // the flame tip and the hood is readable at a glance.
    const zs = beads.map((b) => b[2]);
    const lowest = beads[zs.indexOf(Math.min(...zs))];
    const highest = beads[zs.indexOf(Math.max(...zs))];
    const foot = at([lowest[0], lowest[1], 0]);
    const top = at(highest);
    out.push(line(top[0], top[1], foot[0], foot[1], color, 'stroke-width="1.2"'));

    for (const bead of beads) {
      const [bx, by] = at(bead);
      out.push(`<circle cx="${bx.toFixed(2)}" cy="${by.toFixed(2)}" r="2.6" fill="${color}" stroke="#ffffff" stroke-width="0.7"/>`);
    }
    out.push(objectLabel(top[0], top[1] - 8 - labels.claim(top[0], top[1]) * LABEL_LINE_PX,
      displayName(tc)));
  }

  return out.join('\n');
}

// -- scale bar ------------------------------------------------------------

function scaleBar(p: Projector, unit: LengthUnit, y: number): string {
  // 1, 2, 5, 10, 20, 50 in the active unit -- the increments a drawing is read in.
  const candidates = unit === 'ft' || unit === 'in'
    ? [0.3048, 0.6096, 1.524, 3.048, 6.096, 15.24]
    : [0.5, 1, 2, 5, 10, 20];
  // Largest round length that still fits, not the smallest that qualifies: a longer
  // bar is easier to read a distance off.
  const fitting = candidates.filter((m) => m * p.pxPerMetre <= 240);
  const chosen = fitting.length > 0 ? fitting[fitting.length - 1] : candidates[0];
  const width = chosen * p.pxPerMetre;

  return [
    line(MARGIN_PX, y, MARGIN_PX + width, y, COLORS.ink, 'stroke-width="2"'),
    line(MARGIN_PX, y - 4, MARGIN_PX, y + 4, COLORS.ink, 'stroke-width="2"'),
    line(MARGIN_PX + width, y - 4, MARGIN_PX + width, y + 4, COLORS.ink, 'stroke-width="2"'),
    text(MARGIN_PX + width + 8, y + 4, formatLengthWithUnit(chosen, unit), 'class="dim-text"'),
  ].join('');
}

/** A complete drawing for one view. */
export function buildViewSvg(doc: PlanDocument, view: DrawingView, unit: LengthUnit): string {
  const { projector, height } = makeProjector(doc, view);
  const body = view === 'plan'
    ? drawPlan(doc, projector, unit)
    : drawElevation(doc, projector, unit, view);
  const total = height + 34;

  return [
    `<svg class="drawing" viewBox="0 0 ${PAGE_WIDTH_PX} ${total.toFixed(0)}" width="100%" xmlns="http://www.w3.org/2000/svg">`,
    `<rect width="${PAGE_WIDTH_PX}" height="${total.toFixed(0)}" fill="#ffffff"/>`,
    body,
    scaleBar(projector, unit, total - 12),
    '</svg>',
  ].join('\n');
}
