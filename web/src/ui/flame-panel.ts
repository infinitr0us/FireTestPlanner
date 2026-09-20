/**
 * The inspector's sections for a reconstructed flame: where its frames come from,
 * what the manifest says about them, whether they are loaded, and how it is drawn.
 *
 * The link is the object's one `linkedFiles` entry, so the actions mirror the
 * Linked files section other objects have -- Relink, Show in folder, Remove -- with
 * a folder where they have a file, and a Refresh that re-reads the folder the way
 * Refresh plot re-reads a CSV.
 */

import { fileName } from '../core/linked-files';
import { burners, displayName, flameManifest, flameSequenceLink } from '../core/plan';
import type { FlameColorMode, ReconstructedFlameObject } from '../core/types';
import { shell } from '../io/files';
import type { FlameActions } from '../state/flame-actions';
import type { FlameStore } from '../state/flame-store';
import type { Store } from '../state/store';
import { h } from './dom';
import { button, readout, row, sectionTitle, selectField } from './fields';

const formatDate = (iso: string): string => iso.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC');

export class FlamePanel {
  private busy: string | null = null;
  private message: { documentId: number; objectId: string; text: string } | null = null;

  constructor(
    private store: Store,
    private flames: FlameStore,
    private actions: FlameActions,
    private rerender: () => void,
  ) {}

  /** Tell the panel a folder is being read; the inspector repaints on each change. */
  setProgress(text: string | null): void {
    this.busy = text;
    this.rerender();
  }

  render(flame: ReconstructedFlameObject, patch: (label: string, fn: (f: ReconstructedFlameObject) => void) => void): HTMLElement[] {
    const out: HTMLElement[] = [];
    const link = flameSequenceLink(flame);
    const manifest = flameManifest(flame);
    const bridge = shell();
    const run = (fn: () => Promise<void> | void): void => { void this.guard(flame.id, fn); };
    const disabled = (b: HTMLButtonElement): HTMLButtonElement => { b.disabled = this.busy !== null; return b; };

    const source = h('section', { class: 'linked-files', 'aria-label': 'Voxel sequence' }, [sectionTitle('Voxel sequence')]);
    if (!link) {
      source.append(
        h('p', { class: 'linked-files__hint' }, [
          'No folder of frames is linked. Link the reconstruction pipeline\'s voxels/ folder: one t_<seconds>s.npz per timestep.',
        ]),
        disabled(button('Link voxel folder…', () => run(() => this.actions.link(flame)))),
      );
    } else {
      const card = h('div', { class: 'linked-file' }, [
        h('strong', {}, [link.label || fileName(link.path)]),
        h('div', { class: 'linked-file__path', title: link.path }, [link.path]),
      ]);
      if (manifest) {
        const frames = manifest.frames;
        const span = `${frames[0][0]} – ${frames[frames.length - 1][0]} s`;
        card.append(h('div', { class: 'readouts' }, [
          readout('Frames', `${frames.length.toLocaleString()} · ${span}`),
          readout('Voxel pitch', `${(manifest.grid.pitch_m * 1000).toFixed(2)} mm` + (manifest.grid.resolution ? ` · ${manifest.grid.resolution}³ grid` : '')),
          readout('Largest frame', `${Math.max(...frames.map((f) => f[1])).toLocaleString()} voxels`),
          readout('Linked', formatDate(manifest.importedAt)),
        ]));
      }
      card.append(this.status(flame));
      const actions = h('div', { class: 'linked-file__actions' });
      if (bridge) {
        actions.append(
          disabled(button('Show in folder', () => run(async () => { await bridge.linkedFileAction(link.path, 'voxelSequence', 'folder'); }))),
          disabled(button('Refresh', () => run(() => this.actions.refresh(flame)))),
        );
      } else if (!this.flames.get(link)?.sequence) {
        actions.append(disabled(button('Load frames…', () => run(() => this.actions.load(flame)))));
      }
      actions.append(
        disabled(button('Relink…', () => run(() => this.actions.link(flame)))),
        disabled(button('Remove', () => this.actions.unlink(flame))),
      );
      card.append(actions);
      source.append(card);
    }
    source.append(h('p', { class: 'linked-files__hint' }, [
      bridge
        ? 'The frames stay in their folder and are read when the plan opens. Refresh after the pipeline is re-run; Relink if the folder moves.'
        : 'A browser tab keeps the folder name and the manifest. Load frames again after reopening; the desktop app reads them itself.',
    ]));
    if (this.busy) source.append(h('p', { role: 'status', class: 'linked-files__hint' }, [this.busy]));
    if (this.message?.documentId === this.store.documentId && this.message.objectId === flame.id) {
      source.append(h('p', { class: 'linked-files__message', role: 'status' }, [this.message.text]));
    }
    out.push(source);

    // Which fire it is, and how it looks.
    const burnerOptions = [{ value: '', label: 'Primary burner' },
      ...burners(this.store.document).map((b) => ({ value: b.id, label: displayName(b) }))];
    out.push(sectionTitle('Reconstruction'));
    out.push(
      row('Burner', selectField(flame.burnerId ?? '', burnerOptions, (v) =>
        patch('Set flame burner', (f) => { f.burnerId = v || null; })),
        'The fire this hull was reconstructed from. The placement checks measure against it'),
      row('Colour', selectField<FlameColorMode>(flame.display?.colorMode ?? 'height', [
        { value: 'height', label: 'Height ramp (blue base, red tip)' },
        { value: 'solid', label: 'Solid flame colour' },
      ], (v) => patch('Set flame colour', (f) => { f.display = { ...(f.display ?? {}), colorMode: v }; })),
        'The pipeline\'s own ramp, on a fixed scale over the whole sequence'),
      row('Opacity', this.opacityField(flame, patch), 'Hashed transparency: grainy on purpose, and honest about overlapping cubes'),
    );
    out.push(h('p', { class: 'linked-files__hint' }, [
      "The predicted Heskestad cone stays under the toolbar's Predicted toggle, so the two can be compared. "
      + "The transform above maps the reconstruction rig's frame onto the plan: the identity when the rig was set up from this plan; unlock the object to correct one that was not.",
    ]));
    return out;
  }

  private opacityField(flame: ReconstructedFlameObject, patch: (label: string, fn: (f: ReconstructedFlameObject) => void) => void): HTMLElement {
    const value = flame.display?.opacity ?? 1;
    const label = h('span', { class: 'field__static' }, [`${Math.round(value * 100)} %`]);
    const slider = h('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value, class: 'field__range', 'aria-label': 'Opacity',
      onchange: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        patch('Set flame opacity', (f) => {
          f.display = { ...(f.display ?? {}) };
          if (v >= 1) delete f.display.opacity; else f.display.opacity = v;
        });
      },
      oninput: (e: Event) => { label.textContent = `${Math.round(Number((e.target as HTMLInputElement).value) * 100)} %`; },
    });
    return h('div', { class: 'field__inline' }, [slider, label]);
  }

  private status(flame: ReconstructedFlameObject): HTMLElement {
    const link = flameSequenceLink(flame)!;
    const entry = this.flames.get(link);
    if (!entry) return h('p', { class: 'linked-files__hint' }, [shell() ? 'Frames not read yet.' : 'Frames not loaded in this tab.']);
    if (entry.status === 'loading') return h('p', { class: 'linked-files__hint', role: 'status' }, [`Reading frame ${entry.progress.done} of ${entry.progress.total}…`]);
    if (entry.status === 'error') return h('p', { class: 'linked-files__message', role: 'status' }, [entry.error ?? 'The folder could not be read.']);
    if (entry.changed) return h('p', { class: 'linked-files__message', role: 'status' }, [`The folder changed since it was linked: ${entry.changed}. Refresh to adopt it as it is now.`]);
    return h('p', { class: 'linked-files__hint' }, [`${entry.sequence!.frames.length.toLocaleString()} frames loaded.`]);
  }

  private async guard(objectId: string, fn: () => Promise<void> | void): Promise<void> {
    if (this.busy !== null) return;
    const documentId = this.store.documentId;
    this.message = null;
    try { await fn(); }
    catch (err) { this.message = { documentId, objectId, text: (err as Error).message }; }
    finally { this.rerender(); }
  }
}
