/**
 * Document store: state, selection, and undo/redo.
 *
 * Undo uses document snapshots, including recorded measurements, so edits touching
 * several objects restore together. Consecutive drag updates share one history
 * entry; large reconstruction snapshots still contribute to history memory use.
 */

import { newPlan } from '../core/plan';
import { serializePlan } from '../core/serialize';
import { setPosition } from '../core/transform';
import { parseAndValidatePlan } from '../core/validate';
import { maxVersion, requiredFormatVersion } from '../core/types';
import type { LengthUnit, PlanDocument, PlanObject } from '../core/types';

const HISTORY_LIMIT = 100;

/**
 * What a save has to bring back to be credited to the document it wrote.
 *
 * A save is asynchronous under the desktop shell, and the document can change
 * underneath it: the user types on while the dialog is up, or opens another file.
 * `documentId` says which document the bytes came from and `revision` says which
 * edit, so the store can tell "this file is now saved" from "an older state of it
 * is now saved" from "a document that is no longer open is now saved".
 */
export interface SaveIdentity {
  documentId: number;
  revision: number;
  /** The shell's handle on the file this document came from, or null. */
  token: string | null;
}

/**
 * Four standard views. The three orthographic ones share a camera and differ only
 * in direction, which is how engineers actually read a layout: plan for footprint
 * and standoff, elevations for heights.
 */
export type ViewMode = 'plan' | 'front' | 'side' | '3d';

export const ORTHO_MODES: ViewMode[] = ['plan', 'front', 'side'];
export const isOrthoMode = (m: ViewMode): boolean => ORTHO_MODES.includes(m);
export type StoreEvent = 'document' | 'selection' | 'view' | 'dirty';
type Listener = (event: StoreEvent) => void;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class Store {
  private doc: PlanDocument;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private pendingLabel: string | null = null;

  selectedIds: string[] = [];
  viewMode: ViewMode = '3d';
  fileName = 'untitled.ftp.json';
  /**
   * The desktop shell's handle on the file this document was read from or last
   * written to, or null when no file stands behind it. The page never learns a path;
   * this is what lets a plain Save mean "write back to that file" without the shell
   * guessing from a basename -- which is how a rejected file, or the Example plan,
   * used to get written over the file that was open before it.
   */
  documentToken: string | null = null;
  /** Counts document replacements, so a save that lands late can tell whether the
   *  document it wrote is still the one on screen. */
  documentId = 0;
  /** Counts every change to the document, so a save can tell whether anything was
   *  typed while it was pending. */
  revision = 0;
  /** True when there are unsaved edits. Drives the title bar and the close prompt. */
  dirty = false;
  /**
   * The document as it stands in its file, as `JSON.stringify` spells it, or null
   * when no file holds it (a new plan, an import). Undo and redo compare against it,
   * so stepping back to exactly what was saved clears the bullet again.
   */
  private savedText: string | null = null;

  constructor(doc?: PlanDocument) {
    this.doc = doc ?? newPlan();
    this.savedText = JSON.stringify(this.doc);
  }

  /** Every mutation goes through here, so nothing can dirty the document without
   *  also advancing the revision a pending save will be checked against. */
  private touch(): void {
    this.revision += 1;
    this.dirty = true;
  }

  /** Snapshot to take BEFORE serialising for a save; hand it back to `markSaved`. */
  identity(): SaveIdentity {
    return { documentId: this.documentId, revision: this.revision, token: this.documentToken };
  }

  // -- subscription ------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Tell every listener, even when one throws.
   *
   * The panels, the scene and the title bar are separate listeners, and a throw in
   * one used to skip every listener after it -- the scene kept drawing an object the
   * document no longer had. The first error still propagates once all have run, so
   * `replaceDocument` can put the previous document back.
   */
  private emit(event: StoreEvent): void {
    let failure: { error: unknown } | null = null;
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  // -- document ----------------------------------------------------------

  get document(): PlanDocument {
    return this.doc;
  }

  get displayUnit(): LengthUnit {
    return this.doc.units.display?.length ?? 'm';
  }

  setDisplayUnit(unit: LengthUnit): void {
    // Not an undoable edit: it is a view preference that happens to live in the
    // file, and burying it in history would make undo feel unpredictable.
    this.doc.units.display = { ...(this.doc.units.display ?? {}), length: unit };
    this.touch();
    this.emit('document');
  }

  setViewMode(mode: ViewMode): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.emit('view');
  }

  /**
   * Run a mutation as one undoable step.
   *
   * The snapshot is taken BEFORE the mutation, so undo restores the prior state.
   * `label` is what the UI shows; identical consecutive labels coalesce, which is
   * what makes dragging a gizmo produce one history entry instead of sixty.
   */
  edit(label: string, mutate: (doc: PlanDocument) => void): void {
    const coalesce = this.pendingLabel === label;
    if (!coalesce) {
      this.undoStack.push(JSON.stringify(this.doc));
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.pendingLabel = label;
    mutate(this.doc);
    this.touch();
    this.emit('document');
  }

  /** End a coalescing run, so the next edit with the same label starts a new step. */
  commit(): void {
    this.pendingLabel = null;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(JSON.stringify(this.doc));
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(JSON.stringify(this.doc));
    this.restore(next);
  }

  /**
   * Install a history snapshot.
   *
   * The display unit is a view preference kept out of history on purpose (see
   * `setDisplayUnit`), but every snapshot carries it -- so undoing an edit made
   * before a switch to feet used to switch the panels back to metres, and the next
   * save wrote the reverted unit. The unit on screen is kept.
   */
  private restore(snapshot: string): void {
    const length = this.doc.units.display?.length;
    this.doc = JSON.parse(snapshot) as PlanDocument;
    if (length !== undefined) this.doc.units.display = { ...(this.doc.units.display ?? {}), length };
    this.pendingLabel = null;
    this.pruneSelection();
    this.touch();
    // Back at exactly what is in the file: nothing unsaved (review 2026-09-22, UI-11).
    this.dirty = this.savedText === null || JSON.stringify(this.doc) !== this.savedText;
    this.emit('document');
  }

  // -- objects -----------------------------------------------------------

  addObject(obj: PlanObject, label = `Add ${obj.type}`): void {
    this.edit(label, (d) => {
      d.objects.push(obj);
    });
    this.commit();
    this.select([obj.id]);
  }

  removeSelected(): void {
    if (this.selectedIds.length === 0) return;
    const ids = new Set(this.selectedIds);
    this.edit(`Delete ${ids.size} object${ids.size > 1 ? 's' : ''}`, (d) => {
      d.objects = d.objects.filter((o) => !ids.has(o.id));
    });
    this.commit();
    this.select([]);
  }

  duplicateSelected(): void {
    if (this.selectedIds.length === 0) return;
    const created: string[] = [];
    this.edit('Duplicate', (d) => {
      for (const id of this.selectedIds) {
        const src = d.objects.find((o) => o.id === id);
        if (!src) continue;
        const copy = clone(src);
        const taken = new Set(d.objects.map((o) => o.id).concat(created));
        let i = 2;
        while (taken.has(`${src.id}-${i}`)) i += 1;
        copy.id = `${src.id}-${i}`;
        if (copy.name) copy.name = `${copy.name} (copy)`;
        // Offset so the copy is visible rather than hidden inside the original.
        // Through `setPosition`, like every other move: a camera or a gauge keeps
        // its recorded target and is re-aimed at it from the new spot, instead of
        // carrying an orientation that now disagrees with the target it claims.
        const p = copy.transform?.position_m ?? [0, 0, 0];
        setPosition(copy, [p[0] + 0.5, p[1] + 0.5, p[2]]);
        d.objects.push(copy);
        created.push(copy.id);
      }
    });
    this.commit();
    this.select(created);
  }

  // -- selection ---------------------------------------------------------

  select(ids: string[]): void {
    const next = ids.filter((id) => this.doc.objects.some((o) => o.id === id));
    if (next.length === this.selectedIds.length && next.every((id, i) => id === this.selectedIds[i])) {
      return;
    }
    this.selectedIds = next;
    this.emit('selection');
  }

  toggleSelect(id: string): void {
    this.select(
      this.selectedIds.includes(id)
        ? this.selectedIds.filter((x) => x !== id)
        : [...this.selectedIds, id],
    );
  }

  get selected(): PlanObject[] {
    return this.doc.objects.filter((o) => this.selectedIds.includes(o.id));
  }

  get soleSelected(): PlanObject | undefined {
    return this.selectedIds.length === 1 ? this.selected[0] : undefined;
  }

  private pruneSelection(): void {
    const alive = new Set(this.doc.objects.map((o) => o.id));
    const next = this.selectedIds.filter((id) => alive.has(id));
    if (next.length !== this.selectedIds.length) {
      this.selectedIds = next;
      this.emit('selection');
    }
  }

  // -- files -------------------------------------------------------------

  /**
   * Install a document that came from elsewhere: a file, the Example, an import.
   *
   * `token` is the shell's handle on the file the document was read from. Anything
   * that is not that file -- the Example plan, an FDS import -- passes none, so the
   * first Save asks for a destination instead of aiming at whatever was open before.
   *
   * If a listener throws while adopting the document -- a builder choking on a
   * shape the load boundary let through -- the previous document, history and file
   * identity are put back and re-announced before the error propagates. Leaving the
   * broken document installed would show stale panels over an empty scene and offer
   * to save the very file that could not be rendered.
   */
  replaceDocument(doc: PlanDocument, fileName: string, token: string | null = null): void {
    const previous = {
      doc: this.doc, fileName: this.fileName, token: this.documentToken,
      undo: this.undoStack, redo: this.redoStack, pendingLabel: this.pendingLabel,
      selectedIds: this.selectedIds, dirty: this.dirty, savedText: this.savedText,
      documentId: this.documentId, revision: this.revision,
    };
    this.doc = doc;
    this.fileName = fileName;
    this.documentToken = token;
    this.undoStack = [];
    this.redoStack = [];
    this.pendingLabel = null;
    this.selectedIds = [];
    this.dirty = false;
    this.savedText = JSON.stringify(doc);
    this.documentId += 1;
    this.revision += 1;
    try {
      this.emit('document');
      this.emit('selection');
    } catch (err) {
      this.doc = previous.doc;
      this.fileName = previous.fileName;
      this.documentToken = previous.token;
      this.undoStack = previous.undo;
      this.redoStack = previous.redo;
      this.pendingLabel = previous.pendingLabel;
      this.selectedIds = previous.selectedIds;
      this.dirty = previous.dirty;
      this.savedText = previous.savedText;
      this.documentId = previous.documentId;
      this.revision = previous.revision;
      this.emit('document');
      this.emit('selection');
      throw err;
    }
  }

  /** Throws before touching state if the text is not a valid plan. */
  loadFromText(text: string, fileName: string, token: string | null = null): void {
    this.replaceDocument(parseAndValidatePlan(text), fileName, token);
  }

  serialize(): string {
    this.doc.meta = { ...(this.doc.meta ?? {}), modified: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    // The writer derives the declared version from the contents; adopt it here too,
    // so the checks panel stops reporting `version-understated` about a file where
    // it is no longer true the moment the plan is saved.
    const version = maxVersion(String(this.doc.version ?? ''), requiredFormatVersion(this.doc));
    const bumped = version !== this.doc.version;
    this.doc.version = version;
    const text = serializePlan(this.doc);
    // Only the 'document' event re-renders the checks panel, and this method used
    // to change the document without emitting one -- so `version-understated`
    // stayed on screen after the save that made it untrue, which is exactly what
    // the comment above promised would not happen.
    if (bumped) this.emit('document');
    return text;
  }

  /**
   * Mark the document as having unsaved changes, without editing it.
   *
   * An imported plan is new work that has never been written. `replaceDocument`
   * reasonably treats a freshly adopted document as clean -- it usually came off
   * disk -- but for an import that would let someone close the window and lose the
   * conversion in silence, and would make Save look like a no-op.
   */
  markDirty(): void {
    this.touch();
    // No file holds this document, so no undo can bring it back to one.
    this.savedText = null;
    this.emit('dirty');
  }

  /**
   * Record that a save landed -- but only for the document and revision it wrote.
   *
   * `identity` is the snapshot taken before serialising. A save that completes
   * after the document was replaced says nothing about the one now open and is
   * ignored outright. One that completes after further edits did write a real
   * file -- so the name and the shell's handle are adopted -- but those edits are
   * not in it, so the document stays dirty rather than the bullet disappearing
   * over work that was never written.
   */
  markSaved(fileName: string, identity: SaveIdentity, token: string | null = identity.token): void {
    if (identity.documentId !== this.documentId) return;
    this.fileName = fileName;
    this.documentToken = token;
    if (identity.revision === this.revision) {
      this.dirty = false;
      this.savedText = JSON.stringify(this.doc);
    }
    this.emit('dirty');
  }
}
