/**
 * Loaded flame sequences: a session cache beside the document.
 *
 * The document holds a reference and a manifest; the frames themselves live here,
 * keyed by the link's path and manifest rather than by object id. So undoing "Link
 * sequence", or duplicating the object, finds the frames already loaded, and a
 * relink to a different folder -- which rewrites the manifest -- is a different
 * key. Everything is dropped when the document is replaced.
 *
 * Loading is one frame at a time with a yield between frames, so the page stays
 * responsive without a worker: the fixture's 80 frames take a tenth of a second,
 * and a run a hundred times larger shows its progress in the bar rather than
 * freezing it. A frame that fails is reported by name and the sequence is not
 * adopted with holes in it.
 */

import { FlameSequence, frameTimestamp, parseFrameFile, type RawFrame } from '../core/flame';
import { voxelSequenceProblem } from '../core/linked-files';
import type { LinkedFile, VoxelSequenceManifest } from '../core/types';

/** Where a sequence's bytes come from. Each shell supplies the one it can. */
export type FlameSource =
  /** A browser tab: the File objects a folder or multi-select picker handed over. */
  | { kind: 'files'; files: File[] }
  /** The desktop shell: a folder it lists and serves, frame by frame. */
  | { kind: 'shell'; path: string; list: () => Promise<string[]>; read: (name: string) => Promise<Uint8Array> }
  /** Already packed: an embedded payload in a shared page, or the bundled Example. */
  | { kind: 'packed'; bytes: Uint8Array };

export interface FlameEntry {
  status: 'loading' | 'ready' | 'error';
  sequence?: FlameSequence;
  /** Frames read so far, and how many there are. */
  progress: { done: number; total: number };
  error?: string;
  /** Set when the folder no longer matches the manifest the plan holds. */
  changed?: string;
}

type Listener = () => void;

/** Identity of a link's data: the same folder with the same manifest is the same sequence. */
export function flameKey(link: LinkedFile): string {
  const s = link.sequence;
  return JSON.stringify([link.path, s?.importedAt ?? null, s?.frames.length ?? 0, s?.bounds_m ?? null]);
}

/**
 * How a freshly read sequence differs from the manifest a plan carries, or null.
 *
 * Timestamps and counts are compared exactly: the manifest was computed by this
 * same code (or its Python mirror) from the folder as it was, so any difference is
 * a folder that changed since -- frames added, dropped or re-run.
 */
export function manifestDrift(sequence: FlameSequence, manifest: VoxelSequenceManifest): string | null {
  const now = sequence.manifest(manifest.importedAt);
  if (now.frames.length !== manifest.frames.length) return `the folder holds ${now.frames.length} frames; the plan expected ${manifest.frames.length}`;
  for (let i = 0; i < now.frames.length; i += 1) {
    if (now.frames[i][0] !== manifest.frames[i][0]) return `the folder has a frame at ${now.frames[i][0]} s where the plan expected ${manifest.frames[i][0]} s`;
    if (now.frames[i][1] !== manifest.frames[i][1]) return `the frame at ${now.frames[i][0]} s holds ${now.frames[i][1]} voxels; the plan expected ${manifest.frames[i][1]}`;
  }
  if (now.grid.pitch_m !== manifest.grid.pitch_m || now.grid.voxelSize_m !== manifest.grid.voxelSize_m) return 'the folder\'s voxel grid is not the one the plan expected';
  return null;
}

const yieldToPage = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class FlameStore {
  private entries = new Map<string, FlameEntry>();
  private cancels = new Map<string, () => void>();
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get(link: LinkedFile): FlameEntry | undefined {
    return this.entries.get(flameKey(link));
  }

  sequenceOf(link: LinkedFile): FlameSequence | undefined {
    return this.get(link)?.sequence;
  }

  /** Everything loaded, for the clock's range. */
  get sequences(): FlameSequence[] {
    return [...this.entries.values()].flatMap((e) => (e.sequence ? [e.sequence] : []));
  }

  /** Forget a link's data: a relink, or a folder that has to be read again. */
  forget(link: LinkedFile): void {
    const key = flameKey(link);
    this.cancels.get(key)?.();
    this.cancels.delete(key);
    if (this.entries.delete(key)) this.emit();
  }

  /** Drop everything: the document was replaced. */
  clear(): void {
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
    this.entries.clear();
    this.emit();
  }

  /** Adopt an already-built sequence, checking it against the plan's manifest. */
  attach(link: LinkedFile, sequence: FlameSequence): FlameEntry {
    const entry: FlameEntry = { status: 'ready', sequence, progress: { done: sequence.frames.length, total: sequence.frames.length } };
    const drift = link.sequence ? manifestDrift(sequence, link.sequence) : null;
    if (drift) entry.changed = drift;
    this.entries.set(flameKey(link), entry);
    this.emit();
    return entry;
  }

  /**
   * Read a link's frames from `source`. Resolves to the sequence, or rejects with
   * the first frame's problem; either way the entry is updated and announced. A
   * second call for the same link while one is in flight joins it.
   */
  async load(link: LinkedFile, source: FlameSource): Promise<FlameSequence> {
    const key = flameKey(link);
    const existing = this.entries.get(key);
    if (existing?.status === 'ready' && existing.sequence) return existing.sequence;
    if (existing?.status === 'loading') return this.pending.get(key)!;
    const entry: FlameEntry = { status: 'loading', progress: { done: 0, total: 0 } };
    this.entries.set(key, entry);
    this.emit();
    let cancelled = false;
    this.cancels.set(key, () => { cancelled = true; });
    const promise = (async () => {
      try {
        const sequence = await this.read(source, entry, () => cancelled);
        if (cancelled) throw new Error('cancelled');
        this.attach(link, sequence);
        return sequence;
      } catch (err) {
        if (!cancelled) {
          entry.status = 'error';
          entry.error = (err as Error).message;
          this.emit();
        }
        throw err;
      } finally {
        this.cancels.delete(key);
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, promise);
    return promise;
  }

  private pending = new Map<string, Promise<FlameSequence>>();

  /**
   * Read a sequence without caching it: what linking a folder does before there is
   * a manifest to key the cache by. `progress` is told after each frame.
   */
  static async readSource(source: FlameSource, progress?: (done: number, total: number) => void): Promise<FlameSequence> {
    const entry: FlameEntry = { status: 'loading', progress: { done: 0, total: 0 } };
    const store = new FlameStore();
    if (progress) store.subscribe(() => progress(entry.progress.done, entry.progress.total));
    return store.read(source, entry, () => false);
  }

  private async read(source: FlameSource, entry: FlameEntry, cancelled: () => boolean): Promise<FlameSequence> {
    if (source.kind === 'packed') {
      const sequence = FlameSequence.unpack(source.bytes);
      entry.progress = { done: sequence.frames.length, total: sequence.frames.length };
      return sequence;
    }
    const names = source.kind === 'files'
      ? source.files.map((f) => f.name)
      : await source.list();
    const frameNames = names.filter((n) => frameTimestamp(n) !== null);
    if (!frameNames.length) throw new Error('No t_<seconds>s.npz frames were found in the folder.');
    entry.progress = { done: 0, total: frameNames.length };
    this.emit();
    const raw: RawFrame[] = [];
    for (const name of frameNames) {
      if (cancelled()) throw new Error('cancelled');
      const bytes = source.kind === 'files'
        ? new Uint8Array(await source.files.find((f) => f.name === name)!.arrayBuffer())
        : await source.read(name);
      raw.push(await parseFrameFile(name, bytes));
      entry.progress = { done: raw.length, total: frameNames.length };
      this.emit();
      await yieldToPage();
    }
    const sequence = FlameSequence.fromFrames(raw);
    const problem = voxelSequenceProblem(sequence.manifest());
    if (problem) throw new Error(problem);
    return sequence;
  }
}
