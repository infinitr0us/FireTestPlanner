import { domainLabel } from '../ui/domain-labels';
import * as i18n from '../ui/i18n';
import { isNewInstrument, isVelocityProbe, isGasSampling } from '../core/types';
import { platformCorners } from '../core/instrument-placement';
/**
 * Dimensioned plan and elevation drawings as SVG.
 *
 * SVG rather than a canvas raster: the output goes into a document people print,
 * and a dimension line that turns to mush at 200% zoom is not a drawing. It is also
 * dependency-free, which keeps the single-file build self-contained.
 */

import {
  beadOffsetsOf,
  boundsPoints,
  burnerDiameterM,
  burners,
  cameraColor,
  cameras,
  ceilingSoffitZM,
  ceilings,
  displayName,
  flameTipZM,
  footprintXY,
  fuelSurfaceZM,
  gaugeViewAngleDeg,
  hasObjectColor,
  heatFluxSensors,
  hoodCanopyRiseM,
  hoodIntakeHeightM,
  hoodOpeningCornersXY,
  hoodOpeningZM,
  hoods,
  imagePlaneExtents,
  objectColor,
  obstructionCornersXY,
  obstructions,
  plumeRadiusAtZ,
  positionOf,
  quatOf,
  standoffHorizontalM,
  standoffM,
  thermocouples,
  toWorld,
  walls,
} from '../core/plan';
import { printedLensOf } from '../core/lenses';
import { forwardOf, rangeOf } from '../core/math';
import { formatLengthWithUnit } from '../ui/display-units';
import type { CameraObject, LengthUnit, PlanDocument, Vec3, WallObject, WallOpening } from '../core/types';

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
  obstruction: '#78716c',
};

export const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);

/**
 * World -> a view's own 2D axes, before scaling. SVG y grows downward, so the
 * vertical component is negated to keep "up" up.
 *
 * Each view is defined by where the viewer stands, and the lateral axis follows
 * from that -- the same way the editor's orthographic camera derives its right
 * vector from its viewing direction (`orientOrthoCamera` in scene/viewport.ts):
 *
 * - plan: looking down, north (+Y) up the page, east (+X) to the right;
 * - front: standing south, looking north (+Y); east (+X) is to the right;
 * - side: standing west, looking east (+X); north (+Y) is to the LEFT, so Y is
 *   negated. Mapping +Y to the right drew the side elevation mirrored against the
 *   editor's Side view while the heading claimed the same viewing direction.
 *
 * One function, used for the bounds and for every projected point, so the two
 * cannot disagree about which way a view faces.
 */
function planeOf(view: DrawingView, p: Vec3): [number, number] {
  switch (view) {
    case 'plan':
      return [p[0], -p[1]];
    case 'front':
      return [p[0], -p[2]];
    case 'side':
      return [-p[1], -p[2]];
  }
}

/** Maps world metres onto SVG pixels for one of the three standard views. */
class Projector {
  constructor(
    private view: DrawingView,
    private scale: number,
    private offsetX: number,
    private offsetY: number,
  ) {}

  plane(p: Vec3): [number, number] {
    return planeOf(this.view, p);
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

/**
 * Every point the drawing must contain.
 *
 * `boundsPoints` is the same list the viewport's Fit frames, built from the
 * primitives the scene and this file actually draw -- a wall from its base height,
 * a hood and a ceiling where their transforms put them, a box by its corners. The
 * page used to be sized from a wall's transform Z alone, so a wall with a base
 * height was drawn metres above the top edge of its own sheet.
 */
function collectPoints(doc: PlanDocument): Vec3[] {
  // The origin is always on the page: it is the datum every dimension refers to,
  // and in an elevation it is where the ground line sits.
  return [[0, 0, 0], ...boundsPoints(doc)];
}

function makeProjector(doc: PlanDocument, view: DrawingView): { projector: Projector; height: number } {
  const planar = collectPoints(doc).map((p) => planeOf(view, p));

  // A loop, not a spread: an imported model can hold a hundred thousand boxes.
  const [minU, maxU] = rangeOf(planar.map((q) => q[0]));
  const [minV, maxV] = rangeOf(planar.map((q) => q[1]));
  const bounds: Bounds = { minU, maxU, minV, maxV };

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
 * Keeps labels from overprinting into an unreadable smear.
 *
 * Instruments cluster: a gauge and a rake on the same wall are one point in plan,
 * and a camera row is one point in elevation. Both views need the same treatment,
 * so both use this rather than each growing its own copy.
 */
class LabelStacker {
  private occupied = new Map<string, number>();
  /** Every label placed so far: its baseline and the span its text covers. */
  private placed: Array<{ y: number; x0: number; x1: number }> = [];

  /** How many labels already sit near this point. Call once per label. */
  private claim(x: number, y: number): number {
    const key = `${Math.round(x / 12)}:${Math.round(y / 12)}`;
    const n = this.occupied.get(key) ?? 0;
    this.occupied.set(key, n + 1);
    return n;
  }

  /**
   * The label for a marker at (x, y), `gap` above it, and whether it is the first
   * label claimed at that point (the one that also gets the height beside it).
   *
   * Labels at one point stack a line apart, as they always have. Markers that are
   * merely close are not one point, though: tripods half a metre apart in a side
   * elevation each label on the same baseline, and a long name ("FLIR A8303sc
   * MWIR (50 mm)") ran into its neighbour's. So a label also moves up its own stack
   * until its text clears every label already on that line. Labels that do not
   * collide stay exactly where the point count puts them.
   */
  label(x: number, y: number, gap: number, s: string): { svg: string; first: boolean } {
    const first = this.claim(x, y);
    const { x0, x1 } = labelSpan(x, s);
    const clashes = (baseline: number): boolean => this.placed.some((b) =>
      Math.abs(b.y - baseline) < LABEL_LINE_PX && x0 < b.x1 + LABEL_PAD_PX && b.x0 < x1 + LABEL_PAD_PX);
    let n = first;
    // Bounded: a label that cannot clear in that many lines is printed rather than lost.
    while (n < first + 24 && clashes(stackedLabelY(y, n, gap))) n += 1;
    const baseline = stackedLabelY(y, n, gap);
    this.placed.push({ y: baseline, x0, x1 });
    return { svg: objectLabel(x, baseline, s), first: first === 0 };
  }
}

/** Clear space kept between two labels on one line. */
const LABEL_PAD_PX = 4;

/** One line of stacked-label clearance. */
const LABEL_LINE_PX = 11;

/** Highest baseline that still prints in full. Above it the ascenders are cut by
 *  the viewBox edge; at a negative baseline the label is not on the page at all. */
const LABEL_MIN_Y = 11;

/**
 * Baseline for the n-th label claimed at a point.
 *
 * Stacking upward is right in the middle of a drawing and wrong at the top of one.
 * Six co-located instruments on a north wall -- a gauge-and-rake row plus cameras,
 * which is a rig, not a contrivance -- put the last names above y = 0, outside the
 * viewBox, so a name went missing from the printed sheet with nothing to show it
 * had. Once the stack would leave the page the remainder grows downward from the
 * marker instead. The two halves cannot collide: one is above the point, the other
 * below it.
 */
function stackedLabelY(y: number, n: number, gap: number): number {
  const fits = Math.max(0, Math.floor((y - gap - LABEL_MIN_Y) / LABEL_LINE_PX) + 1);
  return n < fits
    ? y - gap - n * LABEL_LINE_PX
    : y + gap + LABEL_LINE_PX * (n - fits + 1);
}

/**
 * An object label that stays inside the drawing horizontally.
 *
 * Names like "FLIR T650 LWIR" are wider than the margin, so a label anchored the
 * wrong way against an edge is simply clipped away. Flip the anchor near either
 * edge rather than losing the text. The vertical half of "inside the drawing" is
 * `stackedLabelY`'s, since only the caller knows how deep the stack is.
 */
function objectLabel(x: number, y: number, s: string): string {
  const { anchor, dx } = labelSpan(x, s);
  return text(x + dx, y, s, `class="obj-label" text-anchor="${anchor}"`);
}

/**
 * How a label at x is anchored, and the span its text covers. The width is an
 * estimate, 5.4 px a character: a little over what 10 px Segoe UI measures on
 * average, so a neighbour is not judged clear when it is not.
 */
function labelSpan(x: number, s: string): { anchor: string; dx: number; x0: number; x1: number } {
  const w = s.length * 5.4;
  if (x - w / 2 < 4) return { anchor: 'start', dx: 6, x0: x + 6, x1: x + 6 + w };
  if (x + w / 2 > PAGE_WIDTH_PX - 4) return { anchor: 'end', dx: -6, x0: x - 6 - w, x1: x - 6 };
  return { anchor: 'middle', dx: 0, x0: x - w / 2, x1: x + w / 2 };
}

/** A camera's label, with its lens when the body has a choice of them: the drawing
 *  is what the crew sets up from, and the lens is part of the setup. */
function cameraLabel(cam: CameraObject): string {
  const lens = printedLensOf(cam);
  return lens ? `${displayName(cam)} (${lens.name})` : displayName(cam);
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
  const my = (y1 + y2) / 2;
  const width = label.length * 5.4 + 8;
  const mx = Math.max(width / 2 + 4, Math.min(PAGE_WIDTH_PX - width / 2 - 4, (x1 + x2) / 2));

  return [
    line(x1, y1, x2, y2, COLORS.dim, 'stroke-width="0.8"'),
    line(x1 - tx, y1 - ty, x1 + tx, y1 + ty, COLORS.dim, 'stroke-width="0.8"'),
    line(x2 - tx, y2 - ty, x2 + tx, y2 + ty, COLORS.dim, 'stroke-width="0.8"'),
    `<rect x="${(mx - width / 2).toFixed(2)}" y="${(my - 7).toFixed(2)}" width="${width.toFixed(2)}" height="12" fill="#ffffff" opacity="0.92"/>`,
    text(mx, my + 3, label, `class="dim-text" text-anchor="middle"`),
  ].join('');
}

/** Convex hull of page points (Andrew's monotone chain). */
function hull(points: Array<[number, number]>): Array<[number, number]> {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const turn = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Array<[number, number]>): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const q of list) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    return out.slice(0, -1);
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/** Below this horizontal share of a unit direction (sin 1 degree) there is no
 *  heading to draw in plan: the instrument faces straight up or down. */
const VERTICAL = Math.sin(Math.PI / 180);

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** The compass bearing of +Y, or null when the plan does not record one. */
function northAzimuth(doc: PlanDocument): number | null {
  const a = doc.coordinateSystem?.northAzimuth_rad;
  return typeof a === 'number' && Number.isFinite(a) ? a : null;
}

/**
 * What an elevation looks toward: the front view along +Y, the side view along +X,
 * named on the compass when `coordinateSystem.northAzimuth_rad` records where +Y
 * points. The headings used to say "looking north (+Y)" whatever the plan said --
 * which is wrong for every site where +Y is not north.
 */
export function elevationHeading(doc: PlanDocument, view: 'front' | 'side'): string {
  const axis = view === 'front' ? '+Y' : '+X';
  const azimuth = northAzimuth(doc);
  if (azimuth === null) return i18n.t("looking along {axis}", { axis });
  const bearing = azimuth + (view === 'side' ? Math.PI / 2 : 0);
  const index = ((Math.round(bearing / (Math.PI / 4)) % 8) + 8) % 8;
  return i18n.t("looking {direction} ({axis})", { direction: domainLabel(COMPASS[index]), axis });
}

/**
 * The plan's orientation mark, in the top-right margin: a north arrow where the
 * plan records which way north is, otherwise an arrow along +Y labelled as such.
 */
function orientationMark(doc: PlanDocument): string {
  const azimuth = northAzimuth(doc);
  // Page directions: x right, y down. North is +Y turned by the azimuth.
  const [dx, dy] = azimuth === null ? [0, -1] : [-Math.sin(azimuth), -Math.cos(azimuth)];
  const cx = PAGE_WIDTH_PX - 30;
  const cy = 30;
  const length = 15;
  const tip: [number, number] = [cx + dx * length, cy + dy * length];
  const tail: [number, number] = [cx - dx * length, cy - dy * length];
  const side = (sign: number): [number, number] =>
    [tip[0] - dx * 7 + sign * -dy * 4, tip[1] - dy * 7 + sign * dx * 4];
  return [
    line(tail[0], tail[1], tip[0], tip[1], COLORS.ink, 'stroke-width="1.2"'),
    polygon([tip, side(1), side(-1)], `fill="${COLORS.ink}"`),
    text(tip[0] + dx * 9, tip[1] + dy * 9 + 3, azimuth === null ? '+Y' : 'N',
      'class="dim-text" text-anchor="middle"'),
  ].join('');
}

/**
 * A wall's solid plan runs. Doors leave a gap; windows replace the heavy wall
 * stroke with thin parallel glazing lines. Both use cumulative polyline distance,
 * including openings that cross a corner, just as buildWall does in the scene.
 */
function wallPlanRuns(wl: WallObject): Array<Array<[number, number]>> {
  const pts = wl.polyline_m;
  const cumulative = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cumulative.push(cumulative[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cumulative[cumulative.length - 1];
  const pointAt = (s: number): [number, number] => {
    let i = 1;
    while (i < pts.length - 1 && cumulative[i] < s) i += 1;
    const span = cumulative[i] - cumulative[i - 1];
    const t = span > 0 ? (s - cumulative[i - 1]) / span : 0;
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  const gaps = (wl.openings ?? [])
    .filter((o) => (o.sillHeight_m ?? 0) < wl.height_m && o.height_m > 0)
    .map((o) => [Math.max(0, o.offset_m), Math.min(total, o.offset_m + o.width_m)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const solid: Array<[number, number]> = [];
  let from = 0;
  for (const [a, b] of gaps) {
    if (a > from) solid.push([from, a]);
    from = Math.max(from, b);
  }
  if (from < total) solid.push([from, total]);
  return solid
    .filter(([a, b]) => b - a > 1e-9)
    .map(([a, b]) => [
      pointAt(a),
      ...pts.filter((_, i) => cumulative[i] > a && cumulative[i] < b) as Array<[number, number]>,
      pointAt(b),
    ]);
}

/** Segment-local placement, matching scene/builders.ts buildWall. Degenerate
 * segments contribute no distance. Height bands are clipped to the wall. */
function wallSegments(wall: WallObject) {
  let travelled = 0;
  return wall.polyline_m.slice(1).flatMap((end, i) => {
    const start = wall.polyline_m[i];
    const dx = end[0] - start[0], dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return [];
    const openings = (wall.openings ?? []).map((opening, index) => ({
      opening, index,
      from: Math.max(0, opening.offset_m - travelled),
      to: Math.min(length, opening.offset_m + opening.width_m - travelled),
      sill: Math.max(0, opening.sillHeight_m ?? 0),
      head: Math.min(wall.height_m, (opening.sillHeight_m ?? 0) + opening.height_m),
    })).filter(o => o.to > o.from && o.head > o.sill);
    travelled += length;
    const xy = (s: number, across = 0): [number, number] =>
      [start[0] + dx * s / length - dy * across / length,
        start[1] + dy * s / length + dx * across / length];
    // Like the rest of the exported wall, upright with its transformed footprint.
    // Pitch/roll for structural objects remain unsupported (CONVENTIONS 5a).
    const world = (s: number, z: number): Vec3 =>
      [...footprintXY(wall, xy(s)), positionOf(wall)[2] + (wall.baseHeight_m ?? 0) + z];
    return [{ length, openings, xy, world }];
  });
}

function openingWidth(opening: WallOpening, span: number, unit: LengthUnit): string {
  const width = formatLengthWithUnit(span, unit, { fixed: true });
  return Math.abs(span - opening.width_m) < 1e-9 ? i18n.t("width {p1}", { p1: width })
    : i18n.t("part {p1} / total {p2}", { p1: width, p2: formatLengthWithUnit(opening.width_m, unit, { fixed: true }) });
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
    const color = escapeXml(hasObjectColor(wl) ? objectColor(wl) : COLORS.wall);
    const widthPx = Math.max((wl.thickness_m ?? 0.1) * p.pxPerMetre, 2);
    for (const run of wallPlanRuns(wl)) {
      const pts = run.map((v) => p.project([...footprintXY(wl, v), 0]));
      const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${widthPx.toFixed(2)}" stroke-linecap="butt"/>`);
    }
    for (const segment of wallSegments(wl)) for (const o of segment.openings) {
      if (o.sill <= 1e-9) continue;
      const at = (s: number, across = 0): [number, number] =>
        p.project([...footprintXY(wl, segment.xy(s, across)), 0]);
      out.push('<g class="wall-window">');
      for (const side of [-1, 1]) {
        const a = at(o.from, side * (wl.thickness_m ?? 0.1) / 6);
        const b = at(o.to, side * (wl.thickness_m ?? 0.1) / 6);
        out.push(line(...a, ...b, color, 'stroke-width="0.8"'));
      }
      out.push('</g>');
      const a = at(o.from), b = at(o.to);
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const gap = widthPx / 2 + 14;
      const dx = -Math.sin(angle) * gap, dy = Math.cos(angle) * gap;
      out.push(dimension(a[0] + dx, a[1] + dy, b[0] + dx, b[1] + dy,
        openingWidth(o.opening, o.to - o.from, unit)));
    }
  }

  // Solid fill, unlike the dashed ceiling: an obstruction is something you walk
  // into and cannot see past, and the plan view is where that gets judged.
  for (const ob of obstructions(doc)) {
    out.push(polygon(obstructionCornersXY(ob).map(([x, y]) => p.project([x, y, 0])),
      `fill="${COLORS.obstruction}" fill-opacity="0.22" stroke="${COLORS.obstruction}" stroke-width="1"`));
  }

  for (const hd of hoods(doc)) {
    out.push(polygon(hoodOpeningCornersXY(hd).map(([x, y]) => p.project([x, y, 0])),
      `fill="${COLORS.hood}" fill-opacity="0.06" stroke="${COLORS.hood}" stroke-width="1" stroke-dasharray="8 4"`));
  }

  // Camera fields of view, so overlap is visible at a glance: the frustum itself,
  // cut a quarter past the fire and laid flat. Built from the image's own edges
  // (fx, fy, principal point, zoom) through the camera's full orientation, like
  // the 3D frustum -- a wedge of the horizontal FOV about the heading drew a rolled
  // camera 60 percent too wide, and a camera looking straight down as a wedge with
  // an invented heading, where it covers a patch of floor around its own tripod.
  for (const cam of cameras(doc)) {
    const depth = Math.max(standoffM(cam) * 1.25, 1);
    const e = imagePlaneExtents(cam);
    const corners = [[e.left, e.bottom], [e.right, e.bottom], [e.right, e.top], [e.left, e.top]]
      .map(([u, v]) => p.project(toWorld(cam, [u * depth, v * depth, -depth])));
    // cameraColor already rejects anything but #rrggbb; escaping as well means a
    // future caller that widens it cannot break out of the attribute.
    const color = escapeXml(cameraColor(cam));
    out.push(polygon(hull([p.project(positionOf(cam)), ...corners]),
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
    out.push(dimension(ox, oy, cx, cy, formatLengthWithUnit(standoffHorizontalM(cam), unit, { fixed: true })));
    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4" fill="${escapeXml(cameraColor(cam))}" stroke="#ffffff" stroke-width="1"/>`);
    out.push(labels.label(cx, cy, 9, cameraLabel(cam)).svg);
  }

  out.push(drawInstrumentsPlan(doc, p, labels));

  const [ox, oy] = p.project([0, 0, 0]);
  out.push(line(ox - 10, oy, ox + 10, oy, COLORS.ink, 'stroke-width="0.8"'));
  out.push(line(ox, oy - 10, ox, oy + 10, COLORS.ink, 'stroke-width="0.8"'));
  out.push(orientationMark(doc));

  return out.join('\n');
}

/**
 * Gauges and thermocouples in plan.
 *
 * A gauge gets its sight line drawn, for the same reason a camera gets its field
 * of view: the direction is not decoration, it is a term in what the instrument
 * reads, and a rig sheet that omits it cannot be checked on site.
 */
function drawNewInstruments(doc: PlanDocument, p: Projector, labels: LabelStacker): string {
  const out: string[] = [];
  for (const obj of doc.objects.filter(isNewInstrument)) {
    const [x, y] = p.project(positionOf(obj)), color = escapeXml(objectColor(obj));
    out.push(`<g data-instrument="${obj.type}" data-object-id="${escapeXml(obj.id)}">`);
    let hint = '';
    if (isVelocityProbe(obj)) {
      if (obj.transform?.rotation_quat) {
        const [ex, ey] = p.project(toWorld(obj, [0, 0, -0.3]));
        const length = Math.hypot(ex - x, ey - y);
        if (length > 0.01) {
          const dx = (ex - x) / length * 7, dy = (ey - y) / length * 7;
          out.push(line(x - dx, y - dy, x + dx, y + dy, color, 'stroke-width="4"'));
          out.push(line(x, y, ex, ey, color, 'stroke-width="0.8" stroke-dasharray="3 2"'));
        } else out.push(`<circle cx="${x}" cy="${y}" r="3" fill="none" stroke="${color}" stroke-width="2"/>`);
      } else {
        hint = i18n.t(" (axis unstated)");
        out.push(`<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`);
      }
    } else if (isGasSampling(obj)) {
      out.push(`<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${color}" stroke-width="1.8"/>`);
    } else {
      if (obj.platform_m) out.push(polygon(platformCorners(obj).map(v => p.project(v)), `fill="${color}" fill-opacity="0.15" stroke="${color}" stroke-width="1.2"`));
      out.push(`<rect x="${x - 4}" y="${y - 3}" width="8" height="6" fill="${color}"/>`);
    }
    out.push(labels.label(x, y, 10, displayName(obj) + hint).svg, '</g>');
  }
  return out.join('\n');
}

function drawInstrumentsPlan(doc: PlanDocument, p: Projector, labels: LabelStacker): string {
  const out: string[] = [];

  for (const s of heatFluxSensors(doc)) {
    const origin = positionOf(s);
    const fwd = forwardOf(quatOf(s));
    const vertical = Math.hypot(fwd[0], fwd[1]) < VERTICAL;
    const color = escapeXml(objectColor(s));
    const [cx, cy] = p.project(origin);
    const reach = Math.max(Math.hypot(origin[0], origin[1]) * 0.6, 0.4);
    const viewAngle = gaugeViewAngleDeg(s);

    // Laid flat through the gauge's full orientation, like a camera's frustum. The
    // heading alone gave a gauge facing the ceiling a sight line pointing west.
    if (viewAngle < 180) {
      const half = ((viewAngle / 2) * Math.PI) / 180;
      const rim = Array.from({ length: 24 }, (_, i): [number, number] => {
        const t = (i / 24) * 2 * Math.PI;
        const r = Math.sin(half) * reach;
        return p.project(toWorld(s, [Math.cos(t) * r, Math.sin(t) * r, -Math.cos(half) * reach]));
      });
      out.push(polygon(hull([[cx, cy], ...rim]),
        `fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="0.6" stroke-opacity="0.6"`));
    } else if (!vertical) {
      const [ex, ey] = p.project(toWorld(s, [0, 0, -reach]));
      out.push(line(cx, cy, ex, ey, color, 'stroke-width="0.8" stroke-dasharray="4 3"'));
    } else {
      out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="8" fill="none" stroke="${color}" stroke-width="0.8" stroke-dasharray="2 2"/>`);
    }

    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4" fill="${color}" stroke="#ffffff" stroke-width="1"/>`);
    const facing = vertical ? (fwd[2] > 0 ? i18n.t(" (faces up)") : i18n.t(" (faces down)")) : '';
    out.push(labels.label(cx, cy, 9, displayName(s) + facing).svg);
  }

  for (const tc of thermocouples(doc)) {
    const beads = beadOffsetsOf(tc).map((offset) => p.project(toWorld(tc, [0, 0, offset])));
    const [cx, cy] = p.project(positionOf(tc));
    const color = escapeXml(objectColor(tc));
    const spread = Math.max(0, ...beads.map(([x, y]) => Math.hypot(x - beads[0][0], y - beads[0][1])));
    if (beads.length > 1 && spread > 3) {
      // A leaning or horizontal rake spreads its beads across the plan: they are
      // drawn where they are, not collapsed onto the rake's origin.
      const d = beads.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.2"/>`);
      for (const [bx, by] of beads) {
        out.push(`<circle cx="${bx.toFixed(2)}" cy="${by.toFixed(2)}" r="2.6" fill="${color}" stroke="#ffffff" stroke-width="0.7"/>`);
      }
      out.push(labels.label(cx, cy, 9, displayName(tc)).svg);
      continue;
    }
    // An upright rake stacks every bead on one point in plan, so the count is the
    // only thing plan view can honestly say about it.
    const arm = 4.5;
    out.push(line(cx - arm, cy, cx + arm, cy, color, 'stroke-width="1.4"'));
    out.push(line(cx, cy - arm, cx, cy + arm, color, 'stroke-width="1.4"'));
    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="2" fill="${color}"/>`);
    out.push(labels.label(cx, cy, 9,
      beads.length > 1 ? `${displayName(tc)} (×${beads.length})` : displayName(tc)).svg);
  }

  out.push(drawNewInstruments(doc, p, labels));
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
  // Heights are world-space -- a slab or a hood whose transform has been moved in Z
  // is drawn where the 3D view puts it, and where the checks judge it.
  for (const cl of ceilings(doc)) {
    const coords = cl.polygon_m.map((v) => lateral([...footprintXY(cl, v), 0]));
    const lo = Math.min(...coords);
    const hi = Math.max(...coords);
    const soffit = ceilingSoffitZM(cl);
    const a = p.project(view === 'side' ? [0, lo, soffit] : [lo, 0, soffit]);
    const b = p.project(view === 'side' ? [0, hi, soffit] : [hi, 0, soffit]);
    out.push(line(a[0], a[1], b[0], b[1], COLORS.ceiling, 'stroke-width="3"'));
    // The label sits past whichever end is on the right of the PAGE, which in the
    // side view is the low-Y end.
    const rightX = Math.max(a[0], b[0]);
    out.push(text(rightX + 6, b[1] + 3, formatLengthWithUnit(soffit, unit, { fixed: true }), 'class="obj-label"'));
  }

  const openingLabels: string[] = [];
  walls(doc).forEach((wl, wallIndex) => {
    const color = escapeXml(hasObjectColor(wl) ? objectColor(wl) : COLORS.wall);
    wallSegments(wl).forEach((segment, segmentIndex) => {
      const at = (s: number, z: number): [number, number] => p.project(segment.world(s, z));
      const rect = (from: number, to: number, bottom: number, top: number): Array<[number, number]> =>
        [at(from, bottom), at(to, bottom), at(to, top), at(from, top)];
      const face = rect(0, segment.length, 0, wl.height_m);
      const holes = segment.openings.map(o => rect(o.from, o.to, o.sill, o.head));
      // A mask subtracts the UNION of openings, so overlapping windows cannot
      // fill one another back in (as an even-odd compound path would).
      const maskId = `wall-cut-${view}-${wallIndex}-${segmentIndex}`;
      if (holes.length) {
        const ys = face.map(pt => pt[1]);
        out.push(`<defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="${Math.min(...ys) - 2}" width="${PAGE_WIDTH_PX}" height="${Math.max(...ys) - Math.min(...ys) + 4}">`
          + `<rect x="0" y="${Math.min(...ys) - 2}" width="${PAGE_WIDTH_PX}" height="${Math.max(...ys) - Math.min(...ys) + 4}" fill="#ffffff"/>`
          + holes.map(hole => polygon(hole, 'fill="#000000"')).join('') + '</mask></defs>');
      }
      out.push(polygon(face, `fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1"${holes.length ? ` mask="url(#${maskId})"` : ''}`));
      segment.openings.forEach((o, index) => {
        out.push(polygon(holes[index], `class="wall-opening" fill="none" stroke="${color}" stroke-width="1"`));
        const a = at(o.from, o.head), b = at(o.to, o.head);
        // An edge-on opening has zero projected width. Its outline stays (no invented
        // span), but its dimensions do not: the elevation the wall faces and the plan
        // already give them, and here they would print over a facing wall's own.
        if (Math.abs(b[0] - a[0]) < 1) return;
        const width = openingWidth(o.opening, o.to - o.from, unit);
        openingLabels.push(dimension(a[0], a[1] - 14, b[0], b[1] - 14, width));
        if (o.sill > 1e-9) {
          const base = at(o.to, 0), sill = at(o.to, o.sill);
          const x = Math.max(a[0], b[0]) + 14;
          openingLabels.push(dimension(x, base[1], x, sill[1],
            i18n.t("sill {p1}", { p1: formatLengthWithUnit(o.sill, unit, { fixed: true }) })));
        }
      });
    });
  });
  out.push(...openingLabels);

  for (const ob of obstructions(doc)) {
    const coords = obstructionCornersXY(ob).map(([x, y]) => lateral([x, y, 0]));
    const lo = Math.min(...coords);
    const hi = Math.max(...coords);
    const base = positionOf(ob)[2];
    const corner = (u: number, z: number): [number, number] =>
      p.project(view === 'side' ? [0, u, z] : [u, 0, z]);
    out.push(polygon([
      corner(lo, base), corner(hi, base),
      corner(hi, base + ob.size_m[2]), corner(lo, base + ob.size_m[2]),
    ], `fill="${COLORS.obstruction}" fill-opacity="0.28" stroke="${COLORS.obstruction}" stroke-width="1"`));
  }

  for (const hd of hoods(doc)) {
    // Extent of the rotated opening along this view's axis, not the raw opening
    // dimension: a hood at 45 degrees presents a wider face than either side.
    const coords = hoodOpeningCornersXY(hd).map(([x, y]) => lateral([x, y, 0]));
    const span = Math.max(...coords) - Math.min(...coords);
    const centre = (Math.max(...coords) + Math.min(...coords)) / 2;
    const intake = hoodIntakeHeightM(hd);
    const opening = hoodOpeningZM(hd);
    const at = (u: number, z: number): [number, number] =>
      p.project(view === 'side' ? [0, u, z] : [u, 0, z]);
    // The rise the 3D view draws and Fit sizes the page for (`hoodCanopyRiseM`):
    // one computed from the span on this page ran a wide canopy off the sheet.
    const apex = opening + hoodCanopyRiseM(hd);
    out.push(polygon([
      at(centre - span / 2, intake),
      at(centre + span / 2, intake),
      at(centre + span / 2, opening),
      at(centre + 0.15, apex),
      at(centre - 0.15, apex),
      at(centre - span / 2, opening),
    ], `fill="${COLORS.hood}" fill-opacity="0.1" stroke="${COLORS.hood}" stroke-width="1.2"`));

    // The intake dimension stands off the edge that is on the right of the PAGE.
    const edgeX = Math.max(at(centre - span / 2, intake)[0], at(centre + span / 2, intake)[0]);
    const edgeY = at(centre, intake)[1];
    out.push(dimension(edgeX + 26, at(0, 0)[1], edgeX + 26, edgeY,
      formatLengthWithUnit(intake, unit, { fixed: true })));
  }

  for (const b of burners(doc)) {
    const origin = positionOf(b);
    const surface = fuelSurfaceZM(b);
    const at = (u: number, z: number): [number, number] =>
      p.project(view === 'side' ? [0, u, z] : [u, 0, z]);
    // The pan's own extent along this view, like a wall's or a box's: a 2 m by
    // 0.25 m line burner is 2 m wide seen from one side and 0.25 m from the other.
    // The equal-area diameter drew it 0.8 m wide in both.
    const [w, d] = b.footprint.size_m ?? [0.3, 0.3];
    const coords = b.footprint.shape === 'circle'
      ? [lateral(origin) - burnerDiameterM(b) / 2, lateral(origin) + burnerDiameterM(b) / 2]
      : [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
        .map(([x, y]) => lateral([...footprintXY(b, [x, y]), 0]));
    const [lo, hi] = rangeOf(coords);
    // The predicted flame and plume are the correlations' equal-area cone about the
    // burner's centre, as the 3D view draws them and every check computes them --
    // only the pan takes the rectangular extent.
    const centre = lateral(origin);
    const dEff = burnerDiameterM(b);

    out.push(polygon([
      at(lo, origin[2]),
      at(hi, origin[2]),
      at(hi, surface),
      at(lo, surface),
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
        formatLengthWithUnit(tip, unit, { fixed: true })));
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

    const label = labels.label(cx, cy, 9, cameraLabel(cam));

    out.push(line(cx, cy, fx, fy, COLORS.faint, 'stroke-width="1" stroke-dasharray="3 3"'));
    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4" fill="${escapeXml(cameraColor(cam))}" stroke="#ffffff" stroke-width="1"/>`);
    out.push(label.svg);
    if (label.first) {
      out.push(text(cx + 7, cy + 4, formatLengthWithUnit(origin[2], unit, { fixed: true }), 'class="dim-text"'));
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

    const label = labels.label(cx, cy, 9, displayName(s));

    out.push(line(cx, cy, fx, fy, COLORS.faint, 'stroke-width="1" stroke-dasharray="3 3"'));
    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4" fill="${color}" stroke="#ffffff" stroke-width="1"/>`);
    out.push(label.svg);
    if (label.first) {
      out.push(text(cx + 7, cy + 4, formatLengthWithUnit(origin[2], unit, { fixed: true }), 'class="dim-text"'));
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
    out.push(labels.label(top[0], top[1], 8, displayName(tc)).svg);
  }

  out.push(drawNewInstruments(doc, p, labels));
  return out.join('\n');
}

// -- scale bar ------------------------------------------------------------

function scaleBar(p: Projector, unit: LengthUnit, y: number): string {
  // 1, 2, 5, 10, 20, 50 in the active unit -- the increments a drawing is read in.
  const candidates = unit === 'ft' || unit === 'ft-in' || unit === 'in'
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
    text(MARGIN_PX + width + 8, y + 4, formatLengthWithUnit(chosen, unit, { fixed: true }), 'class="dim-text"'),
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
