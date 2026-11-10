import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AnalysisScene } from './flame-analysis';
import { deferred, settle } from '../ui/flame-analysis-test-support';

const mesh = (x: number) => ({ positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]), indices: new Uint32Array([0, 1, 2]) });
function scene(): any {
  return Object.assign(Object.create(AnalysisScene.prototype), {
    surface: new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()),
    surfaces: new Map(), surfaceIndex: -1, surfaceEvicted: false, surfaceGeneration: 0,
    frameIndex: 0, look: 'surface', zRange: [0, 1], disposed: false,
    flame: { setFrame: () => false, group: { visible: false } },
  });
}
afterEach(() => vi.unstubAllGlobals());

describe('the render loop', () => {
  it('stops while the board is closed, and starts again with one fresh frame when it opens', () => {
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const s: any = Object.assign(Object.create(AnalysisScene.prototype), { active: true, disposed: false, request: 7, dirty: false, animate: vi.fn() });
    s.setActive(false);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(7);
    expect(s.animate).not.toHaveBeenCalled();
    s.setActive(false); // already resting
    expect(cancel).toHaveBeenCalledOnce();
    s.setActive(true);
    expect(s.animate).toHaveBeenCalledOnce();
    expect(s.dirty).toBe(true);
    s.setActive(true); // already running: no second loop
    expect(s.animate).toHaveBeenCalledOnce();
    s.disposed = true;
    s.setActive(false);
    expect(cancel).toHaveBeenCalledTimes(2); // nothing more after disposal
  });
});

describe('surface ownership (B6, B7, reviewer R1/R2)', () => {
  it('clears the old surface and disposes its late completion without replacing the new event', async () => {
    const s = scene(), old = deferred(), current = deferred();
    const disposed = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    s.setSurfaces(() => old.promise); s.setFrame(0); await settle();
    s.setSurfaces(() => current.promise);
    expect(s.surface.visible).toBe(false);
    expect(s.surface.geometry.getAttribute('position')).toBeUndefined();
    s.setFrame(0); current.resolve(mesh(20)); await settle();
    expect(s.surface.geometry.attributes.position.array[0]).toBe(20);
    const before = disposed.mock.calls.length;
    old.resolve(mesh(10)); await settle();
    expect(s.surface.geometry.attributes.position.array[0]).toBe(20);
    expect(disposed.mock.calls.length).toBe(before + 1);
    disposed.mockRestore();
  });
  it('catches interactive failure, hides stale geometry, removes the entry, and retries once on export', async () => {
    const s = scene(), report = vi.fn(), loader = vi.fn(async (i: number) => {
      if (i === 1) throw new Error('Surface at 1 s, E1/mesh/t_1.ply: missing');
      return mesh(10);
    });
    s.setSurfaces(loader, undefined, report);
    s.setFrame(0); await settle(); expect(s.surface.visible).toBe(true);
    s.setFrame(1); await settle();
    expect(report).toHaveBeenCalledOnce(); expect(report.mock.calls[0][0].message).toContain('t_1.ply');
    expect(s.surface.visible).toBe(false); expect(s.surfaces.has(1)).toBe(false);
    loader.mockClear();
    await expect(s.prepareFrame(1)).rejects.toThrow('Surface at 1 s, E1/mesh/t_1.ply');
    expect(loader).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalledOnce();
    expect(s.surfaces.has(1)).toBe(false);
  });
  it('ignores failures from replaced generations', async () => {
    const s = scene(), old = deferred(), report = vi.fn();
    s.setSurfaces(() => old.promise, undefined, report); s.setFrame(0); await settle();
    s.setSurfaces(async () => mesh(20), undefined, report); s.setFrame(0); await settle();
    old.reject(new Error('old file')); await settle();
    expect(report).not.toHaveBeenCalled(); expect(s.surface.visible).toBe(true);
  });
});
