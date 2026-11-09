/**
 * Where a flame analysis folder's files come from, in each shell.
 *
 * A browser tab is handed the folder's files by a folder picker; the desktop shell
 * serves the folder it opened over the loopback bridge, one whole file at a time.
 * Both give the board the same thing: a file by its '/' path inside the folder that
 * holds `analysis.json`, as bytes or as a Blob a picture can be decoded from.
 */

import * as i18n from '../ui/i18n';
import { checkEvent, fillTemplate, FlameAnalysisError, joinPath, parseOutlines,
  type AnalysisManifest, type EventManifest, type Series } from '../core/flame-analysis';
import { readFrameVoxelSize } from '../core/flame';
import { closeShellAnalysis, readShellAnalysisFile, type OpenedAnalysis } from './files';

export interface AnalysisSource {
  /** The folder's name, for the title and messages. */
  readonly name: string;
  read(path: string): Promise<Uint8Array>;
  blob(path: string): Promise<Blob>;
  close(): void;
}

function decodeText(bytes: Uint8Array, path: string): string {
  // Let the JSON/CSV parser consume the optional BOM exactly once.
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new FlameAnalysisError(i18n.t("{p1}: not readable as UTF-8", { p1: path })); }
}

export const readText = async (source: AnalysisSource, path: string): Promise<string> =>
  decodeText(await source.read(path), path);

/** Run the semantic check and enforce file metadata at the existing read boundary.
 * Local to one event selection; no global state or extra file reads. */
export function checkedEventSource(source: AnalysisSource, event: EventManifest,
  entry: AnalysisManifest['events'][number], series: ReadonlyMap<string, Series>, folder: string): AnalysisSource {
  const problems = checkEvent(event, entry, series);
  if (problems.length) throw new FlameAnalysisError(problems.map(p => p.message).join('\n'));
  const outlines = new Map(event.cameras.map(cam => [joinPath(folder, fillTemplate(event.files.outlines, cam)), cam]));
  const hulls = new Set(event.instants.stem.map(stem => joinPath(folder, fillTemplate(event.files.hull, undefined, stem))));
  return {
    name: source.name,
    close: () => source.close(),
    blob: path => source.blob(path),
    read: async path => {
      const bytes = await source.read(path);
      const cam = outlines.get(path);
      if (cam !== undefined) parseOutlines(decodeText(bytes, path), cam, event.instants.t_s.length, path, event.images[cam].size_px);
      if (hulls.has(path)) {
        const size = await readFrameVoxelSize(bytes, path), expected = event.hull.voxelSize_m;
        if (Math.abs(size - expected) > 1e-9 * Math.max(Math.abs(size), Math.abs(expected))) {
          throw new FlameAnalysisError(i18n.t("{p1}: voxel_size {p2} does not equal hull.voxelSize_m {p3}", { p1: path, p2: size, p3: expected }));
        }
      }
      return bytes;
    },
  };
}

/** A source over files already in hand, by their path inside the analysis folder. */
export function entriesSource(name: string, entries: Map<string, Blob>): AnalysisSource {
  const get = (path: string): Blob => {
    const file = entries.get(path);
    if (!file) throw new Error(i18n.t("Missing file: {p1}", { p1: path }));
    return file;
  };
  return {
    name,
    read: async (path) => new Uint8Array(await get(path).arrayBuffer()),
    blob: async (path) => get(path),
    close: () => entries.clear(),
  };
}

/**
 * The files a folder picker returned, rooted at the `analysis.json` nearest the top
 * (the picked folder itself, or a test folder one level inside it).
 */
export function pickedAnalysisSource(files: File[]): AnalysisSource {
  const pathOf = (f: File): string => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const manifests = files.map(pathOf).filter((p) => p.split('/').pop() === 'analysis.json')
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (!manifests.length) throw new Error(i18n.t("No analysis.json in the selected folder."));
  const top = manifests[0];
  const prefix = top.slice(0, top.length - 'analysis.json'.length);
  const entries = new Map<string, Blob>();
  for (const file of files) {
    const path = pathOf(file);
    if (path.startsWith(prefix)) entries.set(path.slice(prefix.length), file);
  }
  const folder = prefix.replace(/\/$/, '').split('/').pop() || 'analysis';
  return entriesSource(folder, entries);
}

export function shellAnalysisSource(opened: OpenedAnalysis): AnalysisSource {
  return {
    name: opened.name,
    read: async (path) => new Uint8Array(await (await readShellAnalysisFile(opened.token, path)).arrayBuffer()),
    blob: async (path) => (await readShellAnalysisFile(opened.token, path)).blob(),
    close: () => closeShellAnalysis(opened.token),
  };
}
