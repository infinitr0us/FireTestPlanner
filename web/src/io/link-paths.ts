/** Portable local path arithmetic. Works with Windows drives/UNC and POSIX paths,
 * without treating a URL or a foreign drive as relative to the current plan. */
import { LINK_TYPES, isLocalPath } from '../core/linked-files';

function parts(path: string): { root: string; segments: string[] } {
  const p = path.replace(/\\/g, '/');
  const root = /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/i.exec(p)?.[0] ?? '';
  const segments: string[] = [];
  for (const segment of p.slice(root.length).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && segments.length && segments.at(-1) !== '..') segments.pop();
    else if (segment !== '..' || !root) segments.push(segment);
  }
  return { root: root.replace(/\/$/, ''), segments };
}

export function absoluteLinkPath(path: string, planPath: string): string {
  if (!isLocalPath(path)) return path;
  if (/^(?:[a-z]:[/\\]|[/\\])/i.test(path)) return path.replace(/\\/g, '/');
  const directory = planPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  const p = parts(`${directory}/${path}`);
  return `${p.root}/${p.segments.join('/')}`;
}

export function relativeLinkPath(path: string, planPath: string): string {
  if (!isLocalPath(path) || !/^(?:[a-z]:[/\\]|[/\\])/i.test(path)) return path;
  const target = parts(path), base = parts(planPath);
  const fold = (s: string): string => /^[a-z]:$|^\/\//i.test(base.root) ? s.toLowerCase() : s;
  if (fold(target.root) !== fold(base.root)) return path.replace(/\\/g, '/');
  base.segments.pop();
  let common = 0;
  while (common < base.segments.length && common < target.segments.length && fold(base.segments[common]) === fold(target.segments[common])) common++;
  return [...base.segments.slice(common).map(() => '..'), ...target.segments.slice(common)].join('/') || '.';
}

/** The working desktop document uses absolute paths, including undo snapshots.
 * Only the saved copy is rebased. Save As therefore cannot invalidate undo or
 * links added while a save dialog was open. Old plans keep their exact bytes. */
export function mapLinkedPaths(text: string, planPath: string, mode: 'open' | 'save'): string {
  let doc;
  try { doc = JSON.parse(text); } catch { return text; } // the normal load gate reports it
  if (!Array.isArray(doc?.objects)) return text;
  let changed = false;
  for (const obj of doc.objects) {
    if (!LINK_TYPES.includes(obj?.type) || !Array.isArray(obj.linkedFiles)) continue;
    for (const link of obj.linkedFiles) {
      if (typeof link?.path !== 'string') continue;
      const path = mode === 'open' ? absoluteLinkPath(link.path, planPath) : relativeLinkPath(link.path, planPath);
      if (path !== link.path) { link.path = path; changed = true; }
    }
  }
  return changed ? JSON.stringify(doc, null, 2) + '\n' : text;
}
