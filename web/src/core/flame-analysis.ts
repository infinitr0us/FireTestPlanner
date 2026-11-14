/**
 * Flame analysis folders (format 1.0, events 1.0 through 1.2): the manifests, their files
 * and the numbers the board shows. DOM-free; mirror of `python/fireplan/flame_analysis.py`,
 * and the schemas in `schema/flame-*.schema.json` are the normative definition
 * (CONVENTIONS.md section 13). The two engines are held to the same verdicts on
 * the synthetic test in `fixtures/flame-analysis/`.
 *
 * The format carries results, never how they were made, so nothing here knows a
 * pipeline's thresholds or coefficients.
 */

import * as i18n from '../ui/i18n';
import { DelimitedError, delimitedRows } from './delimited';
import { quatToColumns } from './math';
import { fxOf, fyOf, positionOf, principalPointOf, quatOf } from './plan';
import type { CameraObject } from './types';

export const ANALYSIS_FORMAT = 'fireplan-flame-analysis';
export const EVENT_FORMAT = 'fireplan-flame-event';
export const OUTLINES_FORMAT = 'fireplan-flame-outlines';
export const FORMAT_VERSION = '1.0.0';
/** Event manifests: 1.1 adds meshes and response times; 1.2 adds heat flux and object links. */
export const EVENT_VERSIONS = ['1.0.0', '1.1.0', '1.2.0'] as const;

export const STEP_IDS = ['cameras', 'frames', 'segmentation', 'reconstruction', 'size', 'hrr', 'limitations'] as const;
export type StepId = (typeof STEP_IDS)[number];

export type LocalText = string | { en: string; fr?: string };
export interface StepText { title?: LocalText; text: LocalText; watchFor?: LocalText }
export interface AnalysisCamera { id: string; planCameraId: string; label?: LocalText }
export interface AnalysisManifest {
  format: typeof ANALYSIS_FORMAT;
  version: string;
  title: LocalText;
  date?: string;
  sitePlan: string;
  timeBase: { label: string; description?: LocalText };
  cameras: AnalysisCamera[];
  steps?: Partial<Record<StepId, StepText>>;
  events: { id: string; label: LocalText; path: string }[];
}

export type Size = [number, number];
export interface EventImage {
  size_px: Size;
  display_px: Size;
  closeup?: { rect_px: [number, number, number, number]; display_px: Size };
}
export type SeriesRole = 'measured' | 'reconstructed' | 'estimated';
export type SeriesQuantity = 'hrr' | 'volume' | 'area' | 'height' | 'heatFlux';
export interface EventSeries {
  id: string;
  label: LocalText;
  role: SeriesRole;
  quantity: SeriesQuantity;
  unit: 'kW' | 'm3' | 'm2' | 'm' | 'kW/m2';
  basis?: 'convective' | 'total';
  file: string;
  time: string;
  value: string;
  note?: LocalText;
  /** 1.1: the first-order response time of a measured heat release rate. */
  responseTime_s?: number;
  /** 1.2: the site plan's heatFluxSensor that recorded this heat flux series. */
  object?: string;
}
export interface EventFiles { display: string; frame?: string; closeup?: string; outlines: string; hull: string; mesh?: string }
export interface EventManifest {
  format: typeof EVENT_FORMAT;
  version: string;
  id: string;
  label: LocalText;
  onset_s: number;
  cameras: string[];
  instants: { t_s: number[]; stem: string[] };
  files: EventFiles;
  images: Record<string, EventImage>;
  hull: { voxelSize_m: number; frame: 'plan' };
  series: EventSeries[];
  quality?: { noHull?: number[]; outsideFrame?: Record<string, number[]> };
  keyMoments?: { t_s: number; label: LocalText }[];
  notes?: Partial<Record<StepId, LocalText>>;
}

export class FlameAnalysisError extends Error {}

/** The text of a localised field in the interface language, English when the
 *  folder has none in that language. */
export function localText(value: LocalText | undefined, language: 'en' | 'fr' = i18n.language()): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return (language === 'fr' && value.fr) || value.en;
}

// -- validation -----------------------------------------------------------------

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const STEM = /^[A-Za-z0-9_.+-]{1,64}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const FORBIDDEN = /[\\:\x00-\x1f\x7f]/;

/** Collects problems with their place in the file, like the schema validator. */
class Problems {
  readonly list: string[] = [];
  add(place: string, message: string): void { this.list.push(`${place || '(top level)'}: ${message}`); }
  throwIfAny(where: string): void {
    if (!this.list.length) return;
    const more = this.list.length > 5 ? i18n.t(" (and {p1} more)", { p1: this.list.length - 5 }) : '';
    throw new FlameAnalysisError(`${i18n.t("{p1} fails schema validation{p2}:", { p1: where, p2: more })}\n  ${this.list.slice(0, 5).join('\n  ')}`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInteger = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min;

function closed(p: Problems, place: string, value: unknown, required: string[], optional: string[]): value is Record<string, unknown> {
  if (!isObject(value)) { p.add(place, i18n.t("must be an object")); return false; }
  for (const key of required) if (!(key in value)) p.add(place, i18n.t("'{p1}' is a required property", { p1: key }));
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) p.add(place, i18n.t("unexpected property '{p1}'", { p1: key }));
  }
  return true;
}
function text(p: Problems, place: string, value: unknown): void {
  if (typeof value === 'string') { if (!value) p.add(place, i18n.t("must not be empty")); return; }
  if (closed(p, place, value, ['en'], ['fr'])) {
    for (const key of ['en', 'fr']) {
      if (key in value && (typeof value[key] !== 'string' || !value[key])) p.add(`${place}/${key}`, i18n.t("must be a non-empty string"));
    }
  }
}
function id(p: Problems, place: string, value: unknown): void {
  if (typeof value !== 'string' || !ID.test(value)) p.add(place, i18n.t("must be an id (letters, digits, _ . -)"));
}
/** A relative '/' path with no '.' or '..' segment: it cannot leave the folder. */
export function pathProblem(path: unknown, template = false): string | null {
  if (typeof path !== 'string' || !path) return i18n.t("must be a non-empty path");
  const body = template ? path.replace(/\{cam\}|\{stem\}/g, 'x') : path;
  if (body.startsWith('/') || FORBIDDEN.test(body) || /[{}]/.test(body)) return i18n.t("must be a relative '/' path");
  if (body.split('/').some((s) => s === '' || s === '.' || s === '..')) return i18n.t("must not have empty, '.' or '..' segments");
  return null;
}
function path(p: Problems, place: string, value: unknown, template = false): void {
  const problem = pathProblem(value, template);
  if (problem) p.add(place, problem);
}
function size(p: Problems, place: string, value: unknown, count = 2, min = [1, 1]): void {
  if (!Array.isArray(value) || value.length !== count || !value.every((v, i) => isInteger(v, min[i] ?? 1))) {
    p.add(place, i18n.t("must be {p1} whole numbers", { p1: count }));
  }
}
function oneOf(p: Problems, place: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) p.add(place, i18n.t("must be one of {p1}", { p1: allowed.join(', ') }));
}
function header(p: Problems, data: Record<string, unknown>, format: string): void {
  if (data.format !== format) p.add('format', i18n.t("must be '{p1}'", { p1: format }));
  if (data.version !== FORMAT_VERSION) p.add('version', i18n.t("must be '{p1}'", { p1: FORMAT_VERSION }));
}
function steps(p: Problems, place: string, value: unknown, entry: (place: string, v: unknown) => void): void {
  if (!isObject(value)) { p.add(place, i18n.t("must be an object")); return; }
  for (const [key, v] of Object.entries(value)) {
    if (!(STEP_IDS as readonly string[]).includes(key)) p.add(place, i18n.t("unknown step '{p1}'", { p1: key }));
    else entry(`${place}/${key}`, v);
  }
}
function parseJson(textValue: string, where: string): unknown {
  try { return JSON.parse(textValue.replace(/^﻿/, '')); }
  catch (err) { throw new FlameAnalysisError(i18n.t("{p1}: not readable as JSON ({p2})", { p1: where, p2: (err as Error).message })); }
}

export function parseAnalysisManifest(textValue: string, where = 'analysis.json'): AnalysisManifest {
  const data = parseJson(textValue, where);
  const p = new Problems();
  if (closed(p, '', data, ['format', 'version', 'title', 'sitePlan', 'timeBase', 'cameras', 'events'], ['date', 'steps'])) {
    header(p, data, ANALYSIS_FORMAT);
    if ('title' in data) text(p, 'title', data.title);
    if ('date' in data && (typeof data.date !== 'string' || !DATE.test(data.date))) p.add('date', i18n.t("must be YYYY-MM-DD"));
    if ('sitePlan' in data) path(p, 'sitePlan', data.sitePlan);
    if ('timeBase' in data && closed(p, 'timeBase', data.timeBase, ['label'], ['description'])) {
      const tb = data.timeBase;
      // Characters, as the schema's maxLength counts them, not UTF-16 units.
      if (typeof tb.label !== 'string' || !tb.label || [...tb.label].length > 40) p.add('timeBase/label', i18n.t("must be a short non-empty string"));
      if ('description' in tb) text(p, 'timeBase/description', tb.description);
    }
    if ('cameras' in data) {
      if (!Array.isArray(data.cameras) || data.cameras.length < 1 || data.cameras.length > 8) p.add('cameras', i18n.t("must list 1 to 8 cameras"));
      else data.cameras.forEach((c, i) => {
        if (!closed(p, `cameras/${i}`, c, ['id', 'planCameraId'], ['label'])) return;
        if ('id' in c) id(p, `cameras/${i}/id`, c.id);
        if ('planCameraId' in c && (typeof c.planCameraId !== 'string' || !c.planCameraId)) p.add(`cameras/${i}/planCameraId`, i18n.t("must be a non-empty string"));
        if ('label' in c) text(p, `cameras/${i}/label`, c.label);
      });
    }
    if ('steps' in data) steps(p, 'steps', data.steps, (place, v) => {
      if (!closed(p, place, v, ['text'], ['title', 'watchFor'])) return;
      for (const key of ['title', 'text', 'watchFor']) if (key in v) text(p, `${place}/${key}`, v[key]);
    });
    if ('events' in data) {
      if (!Array.isArray(data.events) || !data.events.length) p.add('events', i18n.t("must list at least one event"));
      else data.events.forEach((e, i) => {
        if (!closed(p, `events/${i}`, e, ['id', 'label', 'path'], [])) return;
        if ('id' in e) id(p, `events/${i}/id`, e.id);
        if ('label' in e) text(p, `events/${i}/label`, e.label);
        if ('path' in e) path(p, `events/${i}/path`, e.path);
      });
    }
  }
  p.throwIfAny(where);
  const manifest = data as unknown as AnalysisManifest;
  const cameraIds = manifest.cameras.map((c) => c.id);
  const eventIds = manifest.events.map((e) => e.id);
  if (new Set(cameraIds).size !== cameraIds.length) throw new FlameAnalysisError(i18n.t("{p1}: camera ids repeat", { p1: where }));
  if (new Set(eventIds).size !== eventIds.length) throw new FlameAnalysisError(i18n.t("{p1}: event ids repeat", { p1: where }));
  return manifest;
}

const UNITS: Record<SeriesQuantity, string> = { hrr: 'kW', volume: 'm3', area: 'm2', height: 'm', heatFlux: 'kW/m2' };

/** Check a parsed event's instrument links after loading the analysis's site plan. */
export function seriesObjectProblems(event: EventManifest, objects: readonly { id: string; type: string }[]): string[] {
  const byId = new Map(objects.map(object => [object.id, object]));
  const problems: string[] = [];
  for (const series of event.series) {
    if (series.object === undefined) continue;
    const object = byId.get(series.object);
    const params = { p1: event.id, p2: series.id, p3: series.object };
    if (!object) problems.push(i18n.t("Event {p1}: series '{p2}' names missing site plan object '{p3}'", params));
    else if (object.type !== 'heatFluxSensor') problems.push(i18n.t("Event {p1}: series '{p2}' object '{p3}' must be a heat flux sensor", params));
  }
  return problems;
}

export function parseEventManifest(textValue: string, where = 'event.json'): EventManifest {
  const data = parseJson(textValue, where);
  const p = new Problems();
  const required = ['format', 'version', 'id', 'label', 'onset_s', 'cameras', 'instants', 'files', 'images', 'hull', 'series'];
  if (closed(p, '', data, required, ['quality', 'keyMoments', 'notes'])) {
    if (data.format !== EVENT_FORMAT) p.add('format', i18n.t("must be '{p1}'", { p1: EVENT_FORMAT }));
    if (!(EVENT_VERSIONS as readonly unknown[]).includes(data.version)) p.add('version', i18n.t("must be '{p1}'", { p1: EVENT_VERSIONS.join("' or '") }));
    if ('id' in data) id(p, 'id', data.id);
    if ('label' in data) text(p, 'label', data.label);
    if ('onset_s' in data && !isNumber(data.onset_s)) p.add('onset_s', i18n.t("must be a number"));
    if ('cameras' in data) {
      const cams = data.cameras;
      if (!Array.isArray(cams) || cams.length < 1 || cams.length > 8 || new Set(cams).size !== cams.length) p.add('cameras', i18n.t("must list 1 to 8 different cameras"));
      else cams.forEach((c, i) => id(p, `cameras/${i}`, c));
    }
    if ('instants' in data && closed(p, 'instants', data.instants, ['t_s', 'stem'], [])) {
      const { t_s, stem } = data.instants;
      if (!Array.isArray(t_s) || !t_s.length || !t_s.every(isNumber)) p.add('instants/t_s', i18n.t("must be a non-empty list of numbers"));
      if (!Array.isArray(stem) || !stem.length || !stem.every((s) => typeof s === 'string' && STEM.test(s)) || new Set(stem).size !== stem.length) {
        p.add('instants/stem', i18n.t("must be a non-empty list of different file stems"));
      }
    }
    const v12 = data.version === '1.2.0';
    const v11 = data.version === '1.1.0' || v12;
    if ('files' in data && closed(p, 'files', data.files, ['display', 'outlines', 'hull'], ['frame', 'closeup', ...(v11 ? ['mesh'] : [])])) {
      const files = data.files;
      for (const key of ['display', 'frame', 'closeup']) {
        if (!(key in files)) continue;
        path(p, `files/${key}`, files[key], true);
        if (typeof files[key] === 'string' && !(/\{cam\}/.test(files[key] as string) && /\{stem\}/.test(files[key] as string))) p.add(`files/${key}`, i18n.t("needs {cam} and {stem}"));
      }
      if ('outlines' in files) {
        path(p, 'files/outlines', files.outlines, true);
        if (typeof files.outlines === 'string' && (!/\{cam\}/.test(files.outlines) || /\{stem\}/.test(files.outlines))) p.add('files/outlines', i18n.t("needs {cam} and no {stem}"));
      }
      if ('mesh' in files) {
        path(p, 'files/mesh', files.mesh, true);
        if (typeof files.mesh === 'string' && (!/\{stem\}/.test(files.mesh) || /\{cam\}/.test(files.mesh))) p.add('files/mesh', i18n.t("needs {stem} and no {cam}"));
      }
      if ('hull' in files) {
        path(p, 'files/hull', files.hull, true);
        if (typeof files.hull === 'string' && (!/\{stem\}/.test(files.hull) || /\{cam\}/.test(files.hull))) p.add('files/hull', i18n.t("needs {stem} and no {cam}"));
      }
    }
    if ('images' in data) {
      if (!isObject(data.images) || !Object.keys(data.images).length) p.add('images', i18n.t("must be an object with an entry per camera"));
      else for (const [cam, image] of Object.entries(data.images)) {
        id(p, `images/${cam}`, cam);
        if (!closed(p, `images/${cam}`, image, ['size_px', 'display_px'], ['closeup'])) continue;
        if ('size_px' in image) size(p, `images/${cam}/size_px`, image.size_px);
        if ('display_px' in image) size(p, `images/${cam}/display_px`, image.display_px);
        if ('closeup' in image && closed(p, `images/${cam}/closeup`, image.closeup, ['rect_px', 'display_px'], [])) {
          if ('rect_px' in image.closeup) size(p, `images/${cam}/closeup/rect_px`, image.closeup.rect_px, 4, [0, 0, 1, 1]);
          if ('display_px' in image.closeup) size(p, `images/${cam}/closeup/display_px`, image.closeup.display_px);
        }
      }
    }
    if ('hull' in data && closed(p, 'hull', data.hull, ['voxelSize_m', 'frame'], [])) {
      if (!isNumber(data.hull.voxelSize_m) || data.hull.voxelSize_m <= 0) p.add('hull/voxelSize_m', i18n.t("must be a positive number"));
      if (data.hull.frame !== 'plan') p.add('hull/frame', i18n.t("must be 'plan'"));
    }
    if ('series' in data) {
      if (!Array.isArray(data.series)) p.add('series', i18n.t("must be a list"));
      else data.series.forEach((s, i) => {
        const place = `series/${i}`;
        if (!closed(p, place, s, ['id', 'label', 'role', 'quantity', 'unit', 'file', 'time', 'value'], ['basis', 'note', ...(v11 ? ['responseTime_s'] : []), ...(v12 ? ['object'] : [])])) return;
        if ('id' in s) id(p, `${place}/id`, s.id);
        if ('label' in s) text(p, `${place}/label`, s.label);
        if ('role' in s) oneOf(p, `${place}/role`, s.role, s.quantity === 'heatFlux' ? ['measured', 'estimated'] : ['measured', 'reconstructed', 'estimated']);
        const quantities = Object.keys(UNITS).filter(q => v12 || q !== 'heatFlux') as SeriesQuantity[];
        if ('quantity' in s) oneOf(p, `${place}/quantity`, s.quantity, quantities);
        if ('unit' in s) oneOf(p, `${place}/unit`, s.unit, quantities.map(q => UNITS[q]));
        if (typeof s.quantity === 'string' && s.quantity in UNITS && s.unit !== UNITS[s.quantity as SeriesQuantity]) {
          p.add(`${place}/unit`, i18n.t("must be {p1} for {p2}", { p1: UNITS[s.quantity as SeriesQuantity], p2: s.quantity }));
        }
        if ('basis' in s) {
          if (s.quantity !== 'hrr') p.add(`${place}/basis`, i18n.t("is for heat release rate only"));
          oneOf(p, `${place}/basis`, s.basis, ['convective', 'total']);
        }
        if ('object' in s) {
          id(p, `${place}/object`, s.object);
          if (s.quantity !== 'heatFlux') p.add(`${place}/object`, i18n.t("is for heat flux only"));
        }
        if ('file' in s) path(p, `${place}/file`, s.file);
        for (const key of ['time', 'value']) if (key in s && (typeof s[key] !== 'string' || !s[key])) p.add(`${place}/${key}`, i18n.t("must name a column"));
        if ('note' in s) text(p, `${place}/note`, s.note);
        if ('responseTime_s' in s) {
          if (!isNumber(s.responseTime_s) || s.responseTime_s <= 0) p.add(`${place}/responseTime_s`, i18n.t("must be a positive number"));
          if (s.role !== 'measured' || s.quantity !== 'hrr') p.add(`${place}/responseTime_s`, i18n.t("is for a measured heat release rate only"));
        }
      });
    }
    const indices = (place: string, v: unknown): void => {
      if (!Array.isArray(v) || !v.every((i) => isInteger(i, 0)) || new Set(v).size !== v.length) p.add(place, i18n.t("must be a list of different instant indices"));
    };
    if ('quality' in data && closed(p, 'quality', data.quality, [], ['noHull', 'outsideFrame'])) {
      if ('noHull' in data.quality) indices('quality/noHull', data.quality.noHull);
      if ('outsideFrame' in data.quality) {
        if (!isObject(data.quality.outsideFrame)) p.add('quality/outsideFrame', i18n.t("must be an object"));
        else for (const [cam, v] of Object.entries(data.quality.outsideFrame)) { id(p, `quality/outsideFrame/${cam}`, cam); indices(`quality/outsideFrame/${cam}`, v); }
      }
    }
    if ('keyMoments' in data) {
      if (!Array.isArray(data.keyMoments)) p.add('keyMoments', i18n.t("must be a list"));
      else data.keyMoments.forEach((k, i) => {
        if (!closed(p, `keyMoments/${i}`, k, ['t_s', 'label'], [])) return;
        if (!isNumber(k.t_s)) p.add(`keyMoments/${i}/t_s`, i18n.t("must be a number"));
        if ('label' in k) text(p, `keyMoments/${i}/label`, k.label);
      });
    }
    if ('notes' in data) steps(p, 'notes', data.notes, (place, v) => text(p, place, v));
  }
  p.throwIfAny(where);
  const event = data as unknown as EventManifest;
  if (event.instants.t_s.length !== event.instants.stem.length) {
    throw new FlameAnalysisError(i18n.t("{p1}: {p2} times but {p3} stems", { p1: where, p2: event.instants.t_s.length, p3: event.instants.stem.length }));
  }
  if (event.instants.t_s.some((t, i, times) => !Number.isFinite(t) || (i > 0 && t <= times[i - 1]))) {
    throw new FlameAnalysisError(i18n.t("{p1}: instant times must be finite and strictly increasing", { p1: event.id }));
  }
  const seen = new Set<string>();
  for (const s of event.series) {
    if (seen.has(s.id)) throw new FlameAnalysisError(i18n.t("Event {p1}: series id '{p2}' repeats", { p1: event.id, p2: s.id }));
    seen.add(s.id);
  }
  return event;
}

/** File-independent event consistency, after parsing. Codes mirror FlameEvent.check. */
export function checkEvent(event: EventManifest, entry: Pick<AnalysisManifest['events'][number], 'id'>,
  series: ReadonlyMap<string, Series> = new Map()): { code: string; message: string }[] {
  const problems: { code: string; message: string }[] = [];
  const add = (code: string, message: string): void => { problems.push({ code, message: `${event.id}: ${message}` }); };
  if (event.id !== entry.id) add('event-id', i18n.t("event.json says '{p1}', analysis.json lists '{p2}'", { p1: event.id, p2: entry.id }));
  const cameras = new Set(event.cameras), images = Object.keys(event.images);
  if (images.length !== cameras.size || images.some(cam => !cameras.has(cam))) {
    add('images-cameras', i18n.t("images must list exactly the event's cameras"));
  }
  for (const [cam, image] of Object.entries(event.images)) {
    if (Boolean(event.files.closeup) !== Boolean(image.closeup)) {
      add('closeup', i18n.t("{p1}: files.closeup and images close-up rectangles must be present together", { p1: cam }));
    }
    if (image.closeup) {
      const [x, y, w, h] = image.closeup.rect_px;
      if (x < 0 || y < 0 || x + w > image.size_px[0] || y + h > image.size_px[1]) {
        add('closeup', i18n.t("{p1}: the close-up leaves the picture", { p1: cam }));
      }
    }
  }
  const n = event.instants.t_s.length;
  const bad = [...(event.quality?.noHull ?? [])];
  for (const [cam, indices] of Object.entries(event.quality?.outsideFrame ?? {})) {
    if (!cameras.has(cam)) add('quality-camera', i18n.t("outsideFrame names camera '{p1}' outside the event", { p1: cam }));
    bad.push(...indices);
  }
  if (bad.some(i => !Number.isInteger(i) || i < 0 || i >= n)) {
    add('quality-index', i18n.t("quality indices must be within the {p1} instants", { p1: n }));
  }
  for (const s of event.series) {
    if ((s.quantity === 'volume' || s.quantity === 'area') && series.get(s.id)?.v.some(v => Number.isFinite(v) && v < 0)) {
      add('series-negative', i18n.t("Series '{p1}' contains negative {p2}", { p1: s.id, p2: s.quantity }));
    }
  }
  return problems;
}

// -- paths ------------------------------------------------------------------------

/** Join a manifest's folder (relative to the analysis folder, '' at its top) and a
 *  path from that manifest. Validated paths have no '.' or '..' segments. */
export function joinPath(folder: string, relative: string): string {
  const problem = pathProblem(relative);
  if (problem) throw new FlameAnalysisError(`${relative}: ${problem}`);
  return folder ? `${folder}/${relative}` : relative;
}
export const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function fillTemplate(template: string, cam?: string, stem?: string): string {
  const problem = pathProblem(template, true);
  if (problem) throw new FlameAnalysisError(`${template}: ${problem}`);
  const result = template.replace(/\{([a-z]+)\}/g, (_, name: string) => {
    const value = name === 'cam' ? cam : name === 'stem' ? stem : undefined;
    if (value === undefined) throw new FlameAnalysisError(i18n.t("template {p1} needs {{p2}}", { p1: template, p2: name }));
    return value;
  });
  const filledProblem = pathProblem(result);
  if (filledProblem) throw new FlameAnalysisError(`${result}: ${filledProblem}`);
  return result;
}

// -- data files -------------------------------------------------------------------

export interface Series { t: Float64Array; v: Float64Array }

/** Two columns of a series CSV; an empty value cell is NaN. Anything else that is
 *  not a finite number is refused with its row, as fireplan does. */
export function parseSeriesCsv(textValue: string, timeColumn: string, valueColumn: string, where = 'series'): Series {
  const lines: number[] = [];
  let rows: string[][];
  try { rows = delimitedRows(textValue, ',', 'empty-lines', Infinity, lines); }
  catch (error) {
    if (error instanceof DelimitedError) throw new FlameAnalysisError(i18n.t("{p1} row {p2}: {p3}", { p1: where, p2: error.line, p3: error.message }));
    throw error;
  }
  if (!rows.length) throw new FlameAnalysisError(i18n.t("{p1}: no samples", { p1: where }));
  const names = rows[0].map((n) => n.trim());
  const columns = [timeColumn, valueColumn].map((name) => {
    const index = names.indexOf(name);
    if (index < 0) throw new FlameAnalysisError(i18n.t("{p1}: no column '{p2}'", { p1: where, p2: name }));
    return index;
  });
  const n = rows.length - 1;
  if (!n) throw new FlameAnalysisError(i18n.t("{p1}: no samples", { p1: where }));
  const t = new Float64Array(n).fill(NaN), v = new Float64Array(n).fill(NaN);
  for (let r = 1; r < rows.length; r++) {
    columns.forEach((c, k) => {
      const cell = (rows[r][c] ?? '').trim();
      if (cell === '') return;
      const value = Number(cell);
      if (!Number.isFinite(value) || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cell)) {
        throw new FlameAnalysisError(i18n.t("{p1} row {p2}: '{p3}' in column '{p4}' is not a finite number", { p1: where, p2: lines[r], p3: cell, p4: names[c] }));
      }
      (k === 0 ? t : v)[r - 1] = value;
    });
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(t[i]) || (i > 0 && !(t[i] > t[i - 1]))) {
      throw new FlameAnalysisError(i18n.t("{p1}: times must be present and strictly increasing (row {p2})", { p1: where, p2: lines[i + 1] }));
    }
  }
  return { t, v };
}

/** One camera's outlines: per instant, rings as flat `[x0, y0, ...]` pixel arrays. */
export function parseOutlines(textValue: string, camera: string, instants: number, where = 'outlines', expectedSize?: Size): Float32Array[][] {
  const data = parseJson(textValue, where);
  const p = new Problems();
  if (closed(p, '', data, ['format', 'version', 'camera', 'size_px', 'outlines'], [])) {
    header(p, data, OUTLINES_FORMAT);
    if (data.camera !== camera) p.add('camera', i18n.t("holds camera {p1}, not {p2}", { p1: String(data.camera), p2: camera }));
    size(p, 'size_px', data.size_px);
    if (expectedSize && (!Array.isArray(data.size_px) || data.size_px.some((v, i) => v !== expectedSize[i]))) {
      p.add('size_px', i18n.t("must equal images.{p1}.size_px", { p1: camera }));
    }
    if (!Array.isArray(data.outlines)) p.add('outlines', i18n.t("must be a list"));
    else if (data.outlines.length !== instants) p.add('outlines', i18n.t("{p1} instants, the event has {p2}", { p1: data.outlines.length, p2: instants }));
  }
  p.throwIfAny(where);
  return (data as { outlines: unknown[][] }).outlines.map((instant, i) => {
    if (!Array.isArray(instant)) throw new FlameAnalysisError(i18n.t("{p1}: instant {p2} is not a list of rings", { p1: where, p2: i }));
    return instant.map((ring) => {
      if (!Array.isArray(ring) || ring.length < 6 || ring.length % 2 || !ring.every(isNumber)) {
        throw new FlameAnalysisError(i18n.t("{p1}: instant {p2} has a ring that is not 3 or more x, y pairs", { p1: where, p2: i }));
      }
      return Float32Array.from(ring as number[]);
    });
  });
}

// -- what the board computes ------------------------------------------------------

/** Index of the instant shown at `t`: the last at or before it, -1 before the first. */
export function instantAt(times: ArrayLike<number>, t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
}

/** Mean of the samples within `halfWidth` seconds either side of each sample, the
 *  one-second average the plots draw thick. Missing samples are left out; a window
 *  with none stays missing. */
export function centredMean({ t, v }: Series, halfWidth = 0.5): Float64Array {
  const out = new Float64Array(t.length).fill(NaN);
  let lo = 0, hi = 0, sum = 0, count = 0;
  for (let i = 0; i < t.length; i++) {
    while (hi < t.length && t[hi] <= t[i] + halfWidth + 1e-9) { if (Number.isFinite(v[hi])) { sum += v[hi]; count++; } hi++; }
    while (t[lo] < t[i] - halfWidth - 1e-9) { if (Number.isFinite(v[lo])) { sum -= v[lo]; count--; } lo++; }
    if (count) out[i] = sum / count;
  }
  return out;
}

export interface Peak { value: number; t: number }
export function peakOf({ t, v }: { t: ArrayLike<number>; v: ArrayLike<number> }, from = -Infinity, to = Infinity): Peak | null {
  let best: Peak | null = null;
  for (let i = 0; i < t.length; i++) {
    if (t[i] < from || t[i] > to || !Number.isFinite(v[i])) continue;
    if (!best || v[i] > best.value) best = { value: v[i], t: t[i] };
  }
  return best;
}

/**
 * The integral of a series over [from, to] by the trapezoid rule, in value x
 * seconds (kW s = kJ for heat release rate). Intervals with a missing end are left
 * out; the series is not extended past its own first and last samples.
 */
export interface Integral { value: number; covered_s: number; coverage: number }

/** Shared clipped, interpolated trapezoids for totals and running heat. */
function* trapezoids({ t, v }: Series, from: number, to: number): Generator<{ a: number; b: number; area: number }> {
  for (let i = 1; i < t.length; i++) {
    const a = Math.max(t[i - 1], from), b = Math.min(t[i], to);
    if (!(b > a) || !Number.isFinite(v[i - 1]) || !Number.isFinite(v[i])) continue;
    const span = t[i] - t[i - 1];
    const va = v[i - 1] + ((v[i] - v[i - 1]) * (a - t[i - 1])) / span;
    const vb = v[i - 1] + ((v[i] - v[i - 1]) * (b - t[i - 1])) / span;
    yield { a, b, area: ((va + vb) / 2) * (b - a) };
  }
}

// Keep the scalar API for numerical consumers; callers displaying heat request coverage.
export function integrate(data: Series, from: number, to: number): number;
export function integrate(data: Series, from: number, to: number, report: true): Integral;
export function integrate(data: Series, from: number, to: number, report = false): number | Integral {
  let value = 0, covered_s = 0;
  for (const part of trapezoids(data, from, to)) { value += part.area; covered_s += part.b - part.a; }
  return report ? { value, covered_s, coverage: to > from ? Math.min(1, covered_s / (to - from)) : 0 } : value;
}

export interface EstimateNumbers {
  id: string;
  peak: Peak;
  heat_kJ: number;
  coverage: number;
  comparison: 'same' | 'different' | 'unstated';
  /** The raw estimate against the hood; null when the two cannot be compared. */
  peakRatio: number | null;
  heatRatio: number | null;
  /** With a hood response time (event 1.1): the estimate as the hood would record
   *  it, and that against the hood. A hood averages over its response time, so at
   *  a peak it reads lower than the flame; this is the like-for-like comparison. */
  asHood?: { peak: Peak; heat_kJ: number; peakRatio: number | null; heatRatio: number | null };
}
/** The event's reference measurement: its first measured heat release rate. The key
 *  numbers, the response time and the Heskestad height all take this one series, so a
 *  card, a plot and a note never speak of different hoods. */
export function hoodOf(event: Pick<EventManifest, 'series'>): EventSeries | undefined {
  return event.series.find((s) => s.quantity === 'hrr' && s.role === 'measured');
}

export interface KeyNumbers {
  window: [number, number];
  hood?: { id: string; peak: Peak; heat_kJ: number; coverage: number; responseTime_s?: number };
  estimates: EstimateNumbers[];
  volume?: { peakMean: Peak };
  height?: { peak: Peak };
}

/**
 * The numbers above the board, over the event's instants (first to last): the
 * measured heat release rate's peak and heat, each estimate's against it (raw, and
 * as the hood would record it when the folder gives the hood's response time), the
 * largest one-second mean flame volume and the tallest flame.
 */
export function keyNumbers(event: EventManifest, series: Map<string, Series>): KeyNumbers {
  const times = event.instants.t_s;
  const window: [number, number] = [times[0], times[times.length - 1]];
  const out: KeyNumbers = { window, estimates: [] };
  const hrr = event.series.filter((s) => s.quantity === 'hrr' && series.has(s.id));
  const reference = hoodOf(event);
  const measured = reference && series.has(reference.id) ? reference : undefined;
  if (measured) {
    const data = series.get(measured.id)!;
    const peak = peakOf(data, ...window) ?? { value: NaN, t: NaN };
    const heat = integrate(data, ...window, true);
    out.hood = { id: measured.id, peak, heat_kJ: heat.value, coverage: heat.coverage,
      ...(measured.responseTime_s ? { responseTime_s: measured.responseTime_s } : {}) };
  }
  const hood = out.hood;
  for (const s of hrr.filter((x) => x.role === 'estimated')) {
    const data = series.get(s.id)!;
    const peak = peakOf(data, ...window) ?? { value: NaN, t: NaN };
    const heat = integrate(data, ...window, true);
    const comparison = !s.basis || !measured?.basis ? 'unstated' : s.basis === measured.basis ? 'same' : 'different';
    const comparable = comparison === 'same' && heat.coverage >= 0.995 && (hood?.coverage ?? 0) >= 0.995;
    const against = (p: Peak, heat_kJ: number): { peakRatio: number | null; heatRatio: number | null } => ({
      peakRatio: comparable && hood && hood.peak.value > 0 && Number.isFinite(p.value) ? p.value / hood.peak.value : null,
      heatRatio: comparable && hood && hood.heat_kJ > 0 ? heat_kJ / hood.heat_kJ : null,
    });
    const estimate: EstimateNumbers = { id: s.id, peak, heat_kJ: heat.value, coverage: heat.coverage, comparison, ...against(peak, heat.value) };
    if (hood?.responseTime_s) {
      const seen = asHoodSees(data, hood.responseTime_s, window[0]);
      const seenPeak = peakOf(seen, ...window) ?? { value: NaN, t: NaN };
      const seenHeat = integrate(seen, ...window);
      estimate.asHood = { peak: seenPeak, heat_kJ: seenHeat, ...against(seenPeak, seenHeat) };
    }
    out.estimates.push(estimate);
  }
  const volume = event.series.find((s) => s.quantity === 'volume' && series.has(s.id));
  if (volume) {
    const data = series.get(volume.id)!;
    const peak = peakOf({ t: data.t, v: centredMean(data) }, ...window);
    if (peak) out.volume = { peakMean: peak };
  }
  const height = event.series.find((s) => s.quantity === 'height' && series.has(s.id));
  if (height) {
    const peak = peakOf(series.get(height.id)!, ...window);
    if (peak) out.height = { peak };
  }
  return out;
}

// -- format 1.1: meshes, and what the board derives from the series ----------------

export interface Mesh { positions: Float32Array; indices: Uint32Array }

/** A format 1.1 mesh file: binary little-endian PLY, float x y z vertices, triangles
 *  as (uchar 3, int32 x 3). Mirror of `read_mesh` in fireplan. */
export function parseMesh(bytes: Uint8Array, where = 'mesh'): Mesh {
  const expected = [/^ply$/, /^format binary_little_endian 1\.0$/, /^element vertex ([0-9]+)$/,
    /^property float x$/, /^property float y$/, /^property float z$/, /^element face ([0-9]+)$/,
    /^property list uchar int vertex_indices$/, /^end_header$/];
  const counts: number[] = [];
  let start = 0;
  for (let i = 0; i < expected.length; i++) {
    let end = start;
    while (end < Math.min(bytes.length, 64 * 1024) && bytes[end] !== 10) end++;
    const rawLine = bytes.subarray(start, end);
    const line = new TextDecoder().decode(rawLine);
    const match = expected[i].exec(line);
    if (end >= Math.min(bytes.length, 64 * 1024) || rawLine.some(byte => byte > 127 || byte === 13) || !match) {
      throw new FlameAnalysisError(i18n.t("{p1}: not an exact-layout PLY header within 64 KiB", { p1: where }));
    }
    if (i === 2 || i === 6) counts.push(Number(match[1]));
    start = end + 1;
  }
  const [nv, nf] = counts;
  if (!Number.isSafeInteger(nv) || !Number.isSafeInteger(nf)) {
    throw new FlameAnalysisError(i18n.t("{p1}: PLY count exceeds the file size", { p1: where }));
  }
  if (bytes.length - start !== nv * 12 + nf * 13) {
    throw new FlameAnalysisError(i18n.t("{p1}: {p2} bytes after the header, {p3} vertices and {p4} triangles need {p5}",
      { p1: where, p2: bytes.length - start, p3: nv, p4: nf, p5: nv * 12 + nf * 13 }));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, bytes.length - start);
  const positions = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) {
    positions[i] = view.getFloat32(i * 4, true);
    if (!Number.isFinite(positions[i])) throw new FlameAnalysisError(i18n.t("{p1}: vertices must be finite", { p1: where }));
  }
  const indices = new Uint32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const at = nv * 12 + f * 13;
    if (view.getUint8(at) !== 3) throw new FlameAnalysisError(i18n.t("{p1}: faces must be triangles of existing vertices", { p1: where }));
    for (let k = 0; k < 3; k++) {
      const index = view.getInt32(at + 1 + 4 * k, true);
      if (index < 0 || index >= nv) throw new FlameAnalysisError(i18n.t("{p1}: faces must be triangles of existing vertices", { p1: where }));
      indices[f * 3 + k] = index;
    }
  }
  return { positions, indices };
}

/**
 * A series as an instrument with a first-order response time `tau` would record it:
 * y' = (x - y) / tau, stepped exactly between samples (the input held over each
 * step). Starts at the first finite sample; a missing sample holds the last input.
 */
export function firstOrderResponse({ t, v }: Series, tau: number): Series {
  const out = new Float64Array(v.length).fill(NaN);
  let y = NaN, input = NaN;
  for (let i = 0; i < t.length; i++) {
    if (Number.isNaN(y)) {
      if (Number.isFinite(v[i])) { y = v[i]; input = v[i]; }
      out[i] = y;
      continue;
    }
    y += (input - y) * (1 - Math.exp(-(t[i] - t[i - 1]) / tau));
    if (Number.isFinite(v[i])) input = v[i];
    out[i] = y;
  }
  return { t, v: out };
}

/**
 * A series as the hood would record it over an event that starts at `from`: its
 * first-order response, worked out from the unbroken run of samples that reaches
 * `from`. What lies before a missing sample is history the response cannot be
 * carried across: holding the last value through an unknown stretch would start the
 * event from an invented state. So a series with a gap before the event starts
 * again at the first sample after it, as a series that begins at the event does.
 * Gaps inside the event are held as `firstOrderResponse` holds them; the key numbers
 * compare only series that cover 99.5 % of it.
 */
export function asHoodSees(data: Series, tau: number, from: number): Series {
  const { t, v } = data;
  let start = 0;
  while (start < t.length && t[start] < from) start++;
  // Back over the finite samples before the event: real history, as far as it is unbroken.
  if (start < t.length && Number.isFinite(v[start])) while (start > 0 && Number.isFinite(v[start - 1])) start--;
  return firstOrderResponse(start ? { t: t.subarray(start), v: v.subarray(start) } : data, tau);
}

/** Running heat on the event window, with the same trapezoids as integrate.
 * Missing intervals break the line; the total resumes without inventing heat. */
export function cumulative(data: Series, from = data.t[0], to = data.t[data.t.length - 1]): Series {
  const times: number[] = [], values: number[] = [];
  const add = (t: number, v: number): void => {
    if (times.at(-1) === t) values[values.length - 1] = v;
    else { times.push(t); values.push(v); }
  };
  for (const t of data.t) if (t < from) add(t, NaN);
  add(from, 0);
  let total = 0, end = from;
  for (const { a, b, area } of trapezoids(data, from, to)) {
    if (a > end) add((end + a) / 2, NaN);
    add(a, total);
    total += area;
    add(b, total);
    end = b;
  }
  if (to > end) { add((end + to) / 2, NaN); add(to, total); }
  return { t: Float64Array.from(times), v: Float64Array.from(values) };
}

/**
 * Heskestad's mean flame height for a measured heat release rate: L = 0.235 Q^0.4 -
 * 1.02 D, with Q the total heat release rate (a convective one is divided by
 * 1 - radiative fraction first) and D the fire's effective diameter. A pool-fire
 * correlation: for a jet it is a reference, not a prediction of that flame.
 */
export function heskestadSeries({ t, v }: Series, diameterM: number, convective: boolean, radiativeFraction: number,
  height: (q: number, d: number) => number): Series {
  const out = new Float64Array(v.length).fill(NaN);
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) continue;
    const total = convective ? Math.max(0, v[i]) / Math.max(1e-6, 1 - radiativeFraction) : Math.max(0, v[i]);
    out[i] = height(total, diameterM);
  }
  return { t, v: out };
}

// -- the hull check: the 3-D flame through a camera ----------------------------------

export interface HullProjection {
  /** Pixel coordinates (u, v pairs) of the points in front of the camera, in the
   *  full-resolution picture (pixel centres at integers, as `projectToPixels`). */
  uv: Float32Array;
  /** About how many pixels one cube spans in that picture, at the points' distance. */
  size: number;
  /** Quantitative footprints: minU, minV, maxU, maxV per cube, without display inflation. */
  rectangles?: Float64Array;
}

/** Project points (x, y, z flat, metres) through a plan camera: `projectToPixels`
 *  with the camera's basis computed once, for the tens of thousands of cells of an
 *  instant. */
export function projectHull(camera: CameraObject, points: ArrayLike<number>, pitch: number): HullProjection {
  const cols = quatToColumns(quatOf(camera));
  const [px, py, pz] = positionOf(camera);
  const right = cols[0], down = [-cols[1][0], -cols[1][1], -cols[1][2]], fwd = [-cols[2][0], -cols[2][1], -cols[2][2]];
  const [cx, cy] = principalPointOf(camera);
  const fx = fxOf(camera), fy = fyOf(camera);
  const uv = new Float32Array((points.length / 3) * 2);
  const rectangles: number[] = [];
  let n = 0, depth = 0;
  for (let i = 0; i < points.length; i += 3) {
    const dx = points[i] - px, dy = points[i + 1] - py, dz = points[i + 2] - pz;
    const z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
    if (z <= 0) continue;
    const x = dx * right[0] + dy * right[1] + dz * right[2];
    const y = dx * down[0] + dy * down[1] + dz * down[2];
    uv[n++] = (fx * x) / z + cx;
    uv[n++] = (fy * y) / z + cy;
    depth += z;
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity, valid = true;
    for (const ox of [-pitch / 2, pitch / 2]) for (const oy of [-pitch / 2, pitch / 2]) for (const oz of [-pitch / 2, pitch / 2]) {
      const qx = dx + ox, qy = dy + oy, qz = dz + oz;
      const cz = qx * fwd[0] + qy * fwd[1] + qz * fwd[2];
      if (cz <= 0) { valid = false; continue; }
      const u = fx * (qx * right[0] + qy * right[1] + qz * right[2]) / cz + cx;
      const v = fy * (qx * down[0] + qy * down[1] + qz * down[2]) / cz + cy;
      u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v);
    }
    if (valid) rectangles.push(u0, v0, u1, v1);
  }
  const count = n / 2;
  return { uv: uv.subarray(0, n), size: count ? (fx * pitch) / (depth / count) : 0, rectangles: Float64Array.from(rectangles) };
}
