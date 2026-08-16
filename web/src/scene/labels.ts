/**
 * Screen-space labels via CSS2DRenderer.
 *
 * HTML rather than sprite textures: labels stay crisp at any zoom, cost nothing to
 * restyle, and the dimension callouts end up looking like a drawing instead of
 * blurry billboards.
 */

import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export type LabelKind = 'object' | 'dimension' | 'warning';

export function makeLabel(text: string, kind: LabelKind = 'object', color?: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = `scene-label scene-label--${kind}`;
  el.textContent = text;
  if (color) el.style.setProperty('--label-accent', color);
  const label = new CSS2DObject(el);
  // Labels must never swallow clicks meant for the viewport behind them.
  el.style.pointerEvents = 'none';
  return label;
}

/** Free the DOM node behind a label; CSS2DObject does not do this on removal. */
export function disposeLabel(label: CSS2DObject): void {
  label.element.remove();
}
