/**
 * What the palette, the inspector and the bar do to a flame's data: link a folder,
 * relink it, refresh its manifest, read its frames. One module, so the three
 * surfaces cannot disagree about what a link is.
 *
 * Linking reads the folder first and writes the document second: the manifest the
 * document stores comes from the frames actually read, and a folder that cannot be
 * read links nothing. Every document change is one undoable edit; the loaded
 * frames go to the session cache, keyed so that undoing the link still finds them.
 */

import { createReconstructedFlame } from '../core/factory';
import { flameSequenceLink, reconstructedFlames } from '../core/plan';
import type { LinkedFile, PlanDocument, ReconstructedFlameObject } from '../core/types';
import { shell } from '../io/files';
import { filesSource, pickVoxelFolder, pickedFolderName, shellSource } from '../io/flame-sources';
import { FlameStore, type FlameSource } from './flame-store';
import type { Store } from './store';

export interface FlameActions {
  /** Pick a folder and link it to `flame`, or to a new flame object when null. */
  link(flame: ReconstructedFlameObject | null, burnerId?: string | null): Promise<void>;
  /** Read the linked folder again and adopt what it holds now. Desktop only. */
  refresh(flame: ReconstructedFlameObject): Promise<void>;
  /** Read a flame's frames into the session; asks for the folder in a browser tab. */
  load(flame: ReconstructedFlameObject): Promise<void>;
  /** Drop the link. The folder and its frames stay where they are. */
  unlink(flame: ReconstructedFlameObject): void;
}

export interface FlameActionsHost {
  /** Told while a folder is being read, and with null when it is done. */
  onProgress?: (text: string | null) => void;
}

/** A picked folder: where it is, and how to read it. */
interface Picked {
  path: string;
  source: FlameSource;
}

async function pickFolder(): Promise<Picked | null> {
  const bridge = shell();
  if (bridge) {
    const path = await bridge.pickFolder();
    return path ? { path, source: shellSource(bridge, path) } : null;
  }
  const files = await pickVoxelFolder();
  if (!files.length) return null;
  return { path: pickedFolderName(files), source: filesSource(files) };
}

export function flameActions(store: Store, flames: FlameStore, host: FlameActionsHost = {}): FlameActions {
  const progress = (done: number, total: number): void =>
    host.onProgress?.(total ? `Reading frame ${done} of ${total}…` : 'Listing the folder…');

  const edit = (label: string, flameId: string, fn: (flame: ReconstructedFlameObject, doc: PlanDocument) => void): void => {
    store.edit(label, (doc) => {
      const flame = reconstructedFlames(doc).find((f) => f.id === flameId);
      if (flame) fn(flame, doc);
    });
    store.commit();
  };

  const assertSame = (documentId: number, revision: number): void => {
    if (store.documentId !== documentId || store.revision !== revision) {
      throw new Error('The plan changed while the folder was being read. Please try again.');
    }
  };

  return {
    async link(flame, burnerId = null) {
      const picked = await pickFolder();
      if (!picked) return;
      const identity = store.identity();
      host.onProgress?.('Listing the folder…');
      let sequence;
      try {
        sequence = await FlameStore.readSource(picked.source, progress);
      } finally {
        host.onProgress?.(null);
      }
      assertSame(identity.documentId, identity.revision);
      const link: LinkedFile = { id: 'voxels', kind: 'voxelSequence', path: picked.path, sequence: sequence.manifest() };
      const existing = flame ? flameSequenceLink(flame) : undefined;
      if (existing?.label) link.label = existing.label;
      if (flame) {
        edit(existing ? 'Relink voxel folder' : 'Link voxel folder', flame.id, (f) => { f.linkedFiles = [link]; });
        flames.attach(link, sequence);
      } else {
        const created = createReconstructedFlame(store.document, burnerId);
        created.linkedFiles = [link];
        store.addObject(created);
        flames.attach(link, sequence);
      }
    },

    async refresh(flame) {
      const link = flameSequenceLink(flame);
      const bridge = shell();
      if (!link || !bridge) return;
      const identity = store.identity();
      host.onProgress?.('Listing the folder…');
      let sequence;
      try {
        sequence = await FlameStore.readSource(shellSource(bridge, link.path), progress);
      } finally {
        host.onProgress?.(null);
      }
      assertSame(identity.documentId, identity.revision);
      const refreshed: LinkedFile = { ...link, sequence: sequence.manifest() };
      edit('Refresh voxel sequence', flame.id, (f) => {
        f.linkedFiles = f.linkedFiles?.map((l) => (l.id === link.id ? refreshed : l));
      });
      flames.attach(refreshed, sequence);
    },

    async load(flame) {
      const link = flameSequenceLink(flame);
      if (!link) return;
      const bridge = shell();
      try {
        if (bridge) {
          await flames.load(link, shellSource(bridge, link.path));
        } else {
          const files = await pickVoxelFolder();
          if (!files.length) return;
          await flames.load(link, filesSource(files));
        }
      } catch {
        // Reported through the store's entry, which the bar and the inspector show.
      }
    },

    unlink(flame) {
      edit('Remove voxel folder link', flame.id, (f) => { delete f.linkedFiles; });
    },
  };
}
