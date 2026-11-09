/**
 * Where a flame analysis folder's files come from, in each shell.
 *
 * A browser tab is handed the folder's files by a folder picker; the desktop shell
 * serves the folder it opened over the loopback bridge, one whole file at a time.
 * Both give the board the same thing: a file by its '/' path inside the folder that
 * holds `analysis.json`, as bytes or as a Blob a picture can be decoded from.
 */

import * as i18n from '../ui/i18n';
import { closeShellAnalysis, readShellAnalysisFile, type OpenedAnalysis } from './files';

export interface AnalysisSource {
  /** The folder's name, for the title and messages. */
  readonly name: string;
  read(path: string): Promise<Uint8Array>;
  blob(path: string): Promise<Blob>;
  close(): void;
}

export const readText = async (source: AnalysisSource, path: string): Promise<string> =>
  new TextDecoder().decode(await source.read(path));

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
