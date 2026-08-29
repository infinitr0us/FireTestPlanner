/**
 * Document store: state, selection, and undo/redo.
 *
 * Undo is snapshot-based rather than a command log. Plans are a few tens of KB, so
 * a deep copy per edit is free, and it makes undo correct by construction for edits
 * that touch several objects at once (delete a burner, re-aim every camera).
 */

import { newPlan } from '../core/plan';
import { serializePlan } from '../core/serialize';
import { parseAndValidatePlan } from '../core/validate';
import { maxVersion, requiredFormatVersion } from '../core/types';
import type { LengthUnit, PlanDocument, PlanObject } from '../core/types';

const HISTORY_LIMIT = 100;

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
  /** True when there are unsaved edits. Drives the title bar and the close prompt. */
  dirty = false;

  constructor(doc?: PlanDocument) {
    this.doc = doc ?? newPlan();
  }

  // -- subscription ------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: StoreEvent): void {
    for (const fn of this.listeners) fn(event);
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
    this.dirty = true;
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
    this.dirty = true;
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
    this.doc = JSON.parse(prev) as PlanDocument;
    this.pendingLabel = null;
    this.pruneSelection();
    this.dirty = true;
    this.emit('document');
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(next) as PlanDocument;
    this.pendingLabel = null;
    this.pruneSelection();
    this.dirty = true;
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
        const t = copy.transform ?? (copy.transform = { position_m: [0, 0, 0] });
        t.position_m = [t.position_m[0] + 0.5, t.position_m[1] + 0.5, t.position_m[2]];
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

  replaceDocument(doc: PlanDocument, fileName: string): void {
    this.doc = doc;
    this.fileName = fileName;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pendingLabel = null;
    this.selectedIds = [];
    this.dirty = false;
    this.emit('document');
    this.emit('selection');
  }

  /** Throws before touching state if the text is not a valid plan. */
  loadFromText(text: string, fileName: string): void {
    this.replaceDocument(parseAndValidatePlan(text), fileName);
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
    this.dirty = true;
    this.emit('dirty');
  }

  markSaved(fileName?: string): void {
    if (fileName) this.fileName = fileName;
    this.dirty = false;
    this.emit('dirty');
  }
}
