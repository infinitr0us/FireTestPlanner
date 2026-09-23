/**
 * The document store: what a save is credited to, what a duplicate keeps, and what
 * happens when adopting a document fails halfway.
 *
 * None of this touches a DOM, so it runs as a plain unit test; the behaviours here
 * were found in the browser and are pinned here so they stay found.
 */

import { describe, expect, it } from 'vitest';

import { lookAtQuat } from '../core/math';
import { checkPlan, newPlan } from '../core/plan';
import type { CameraObject, PlanDocument } from '../core/types';
import { Store } from './store';

const withCamera = (): PlanDocument => {
  const doc = newPlan('store test');
  const position: [number, number, number] = [-3, 0, 1.5];
  const target: [number, number, number] = [0, 0, 0.75];
  const cam: CameraObject = {
    id: 'cam-1', type: 'camera', name: 'Cam',
    transform: { position_m: position, rotation_quat: lookAtQuat(position, target), aimTarget_m: target },
    camera: { modality: 'RGB', resolution_px: [1920, 1080], sensor_mm: [6.17, 4.55], focalLength_mm: 4.3 },
    mount: { type: 'tripod', height_m: 1.5 },
    recording: null,
  };
  doc.objects.push(cam);
  return doc;
};

describe('crediting a save', () => {
  it('clears the dirty flag only when nothing changed while the save was pending', () => {
    const store = new Store(withCamera());
    store.edit('Rename', (d) => { d.meta = { ...d.meta, title: 'saved snapshot' }; });
    store.commit();
    expect(store.dirty).toBe(true);

    // The save serialises this state and goes off to the shell...
    const identity = store.identity();
    // ...and the user keeps typing while the dialog is up.
    store.edit('Rename', (d) => { d.meta = { ...d.meta, title: 'newer, unsaved' }; });
    store.commit();

    store.markSaved('case.ftp.json', identity, 'tok-1');
    // The file is real, so the name and handle are adopted -- but the newer title
    // was never written, and the bullet must say so.
    expect(store.fileName).toBe('case.ftp.json');
    expect(store.documentToken).toBe('tok-1');
    expect(store.dirty).toBe(true);

    // Saving the current state does clear it.
    store.markSaved('case.ftp.json', store.identity(), 'tok-2');
    expect(store.dirty).toBe(false);
    expect(store.documentToken).toBe('tok-2');
  });

  it('ignores a save that lands after the document it wrote was replaced', () => {
    const store = new Store(withCamera());
    store.edit('Rename', (d) => { d.meta = { ...d.meta, title: 'first' }; });
    const identity = store.identity();

    store.replaceDocument(newPlan('second'), 'second.ftp.json', 'tok-second');
    store.markDirty();

    store.markSaved('first.ftp.json', identity, 'tok-first');
    expect(store.fileName).toBe('second.ftp.json');
    expect(store.documentToken).toBe('tok-second');
    expect(store.dirty).toBe(true);
  });

  it('drops the shell handle when a document without a file replaces one with', () => {
    const store = new Store(withCamera());
    store.replaceDocument(withCamera(), 'case.ftp.json', 'tok-case');
    expect(store.documentToken).toBe('tok-case');
    // The Example, an import: no file behind them, so no token.
    store.replaceDocument(newPlan('example'), 'pool-fire-camera-row.ftp.json');
    expect(store.documentToken).toBeNull();
  });

  it('advances the revision on every kind of change', () => {
    const store = new Store(withCamera());
    const r0 = store.revision;
    store.edit('x', () => {});
    store.commit();
    store.undo();
    store.redo();
    store.setDisplayUnit('ft');
    store.markDirty();
    expect(store.revision).toBe(r0 + 5);
  });
});

describe('duplicating', () => {
  it('re-aims the copy at the original target rather than carrying a stale orientation', () => {
    // The copy is offset by half a metre; a quaternion copied verbatim would then be
    // 9 degrees off the target it still claims, and Checks said so on every
    // duplicated camera in the Example plan.
    const store = new Store(withCamera());
    store.select(['cam-1']);
    store.duplicateSelected();
    expect(store.document.objects).toHaveLength(2);
    expect(checkPlan(store.document).map((i) => i.code)).not.toContain('aim-mismatch');
    const copy = store.document.objects[1];
    expect(copy.transform!.aimTarget_m).toEqual([0, 0, 0.75]);
    expect(copy.transform!.position_m).toEqual([-2.5, 0.5, 1.5]);
  });
});

describe('replacing the document', () => {
  it('puts the previous document back when a listener cannot adopt the new one', () => {
    const store = new Store(withCamera());
    store.edit('Rename', (d) => { d.meta = { ...d.meta, title: 'before' }; });
    store.commit();
    const before = store.identity();
    const seen: string[] = [];
    let armed = true;
    store.subscribe((event) => {
      if (event !== 'document') return;
      seen.push(store.document.meta?.title ?? '');
      if (armed) {
        armed = false;
        throw new Error('builder choked');
      }
    });

    const bad = newPlan('broken');
    expect(() => store.replaceDocument(bad, 'broken.ftp.json', 'tok-bad')).toThrow('builder choked');

    // Same document, name, handle, history and revision as before the attempt.
    expect(store.document.meta?.title).toBe('before');
    expect(store.fileName).toBe('untitled.ftp.json');
    expect(store.documentToken).toBeNull();
    expect(store.canUndo).toBe(true);
    expect(store.dirty).toBe(true);
    expect(store.identity()).toEqual(before);
    // And the listeners were told to show it again, not left on the broken one.
    expect(seen).toEqual(['broken', 'before']);
  });
});

describe('undo and the saved state (review 2026-09-22)', () => {
  it('is clean again after undoing back to what was saved (UI-11)', () => {
    const store = new Store();
    store.replaceDocument(withCamera(), 'plan.ftp.json', 'tok');
    store.edit('Rename', (d) => { d.meta = { ...d.meta, title: 'changed' }; });
    store.commit();
    expect(store.dirty).toBe(true);
    store.undo();
    expect(store.dirty).toBe(false);
    store.redo();
    expect(store.dirty).toBe(true);

    // Saved in the changed state: undo now leaves the file behind, redo returns.
    store.markSaved('plan.ftp.json', store.identity());
    expect(store.dirty).toBe(false);
    store.undo();
    expect(store.dirty).toBe(true);
    store.redo();
    expect(store.dirty).toBe(false);
  });

  it('stays dirty through undo when no file holds the document', () => {
    // An import is new work: no undo brings it back to a file.
    const store = new Store();
    store.replaceDocument(withCamera(), 'imported.ftp.json');
    store.markDirty();
    store.edit('Rename', (d) => { d.meta = { ...d.meta, title: 'changed' }; });
    store.commit();
    store.undo();
    expect(store.dirty).toBe(true);
  });

  it('keeps the display unit on screen through undo and redo (UI-6)', () => {
    const store = new Store(withCamera());
    store.edit('Rename', (d) => { d.meta = { ...d.meta, title: 'changed' }; });
    store.commit();
    store.setDisplayUnit('ft');
    store.undo();
    expect(store.document.meta?.title).toBe('store test');
    expect(store.displayUnit).toBe('ft');
    store.redo();
    expect(store.displayUnit).toBe('ft');
    // The unit is not what the file holds, so undo does not call it saved.
    store.undo();
    expect(store.dirty).toBe(true);
  });

  it('tells every listener even when one throws, then reports the error', () => {
    const store = new Store(withCamera());
    const seen: string[] = [];
    store.subscribe(() => { seen.push('first'); throw new Error('panel failed'); });
    store.subscribe((event) => { seen.push(`second:${event}`); });
    expect(() => store.select(['cam-1'])).toThrow('panel failed');
    expect(seen).toEqual(['first', 'second:selection']);
  });
});
