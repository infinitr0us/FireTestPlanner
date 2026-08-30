/**
 * File in, file out.
 *
 * In the browser this is download/upload; under the pywebview shell the same
 * functions defer to native dialogs when `window.fireplanShell` is present, so the
 * desktop build gets real Save As without a second code path.
 */

import { readNamelist } from '../core/namelist';

export interface ShellBridge {
  openPlan(): Promise<{ path: string; text: string } | null>;
  /** Pick an FDS input and read it. The conversion happens in the shared core, so
   *  this is only the native dialog a browser tab cannot open. */
  openFds(): Promise<{ path: string; text: string } | null>;
  /** One file an `&CATF` names, read from beside the input that named it. Null when
   *  it is not there. The shell confines this to that folder and to bare filenames. */
  readFdsInclude(name: string): Promise<string | null>;
  /** `saveAs` forces a destination dialog; otherwise the shell writes back to the
   *  file it opened, if the page is still showing that document.
   *  Resolves to null when the user cancels, and REJECTS when the write fails. */
  savePlan(text: string, suggestedName: string, saveAs: boolean): Promise<string | null>;
  saveHtml(html: string, suggestedName: string): Promise<string | null>;
  recentFiles(): Promise<string[]>;
  openRecent(path: string): Promise<{ path: string; text: string } | null>;
  /** The user's camera preset library, kept in the shell's per-profile settings
   *  rather than in browser storage -- see `presets.ts` for why. */
  loadPresets(): Promise<unknown[]>;
  /** Replace the library. Resolves to true only when the write reached the disk. */
  savePresets(presets: unknown[]): Promise<boolean>;
}

/** What the shell's save routes answer: a destination, a reason, or null for cancel. */
type SaveResult = { path?: string; error?: string } | null;

/**
 * Cancel and failure look the same from the outside -- both leave the file unwritten
 * -- but they are opposites to the user: one is what they asked for, the other is
 * their work not being on disk. A cancel is null; a failure throws, so the caller has
 * to deal with it rather than silently doing nothing.
 */
function unwrapSave(result: SaveResult): string | null {
  if (!result) return null;
  if (result.error) throw new Error(result.error);
  return result.path ?? null;
}

let bridge: ShellBridge | undefined;
let shellToken: string | null = null;

export const shell = (): ShellBridge | undefined => bridge;

/**
 * Call the desktop shell's local API.
 *
 * Same origin as the page -- the shell serves both -- so there is no CORS to
 * arrange. The token proves the caller is the page the shell opened rather than
 * some other process on the machine that fancies driving a file dialog.
 */
async function call<T>(route: string, body?: unknown): Promise<T | null> {
  if (!shellToken) return null;
  const response = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-Shell-Token': shellToken,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Shell call ${route} failed: ${response.status}`);
  return (await response.json()) as T | null;
}

/**
 * Adopt the desktop bridge if the shell launched this page.
 *
 * A loopback HTTP API rather than pywebview's `js_api`: with `js_api` bound to this
 * page the WebView2 message channel never came up at all (see python/shell/app.py).
 * HTTP is also the right shape for Phase 2, where flame sequences want range
 * requests rather than a JS bridge.
 */
export function connectShell(onReady: () => void): void {
  const token = new URLSearchParams(window.location.search).get('shell');
  if (!token) return; // an ordinary browser tab
  shellToken = token;

  bridge = {
    openPlan: () => call<{ path: string; text: string } | null>('/api/open', {}).then((r) => r ?? null),
    openFds: () => call<{ path: string; text: string } | null>('/api/open-fds', {}).then((r) => r ?? null),
    readFdsInclude: (name) =>
      call<{ text?: string }>('/api/read-fds-include', { name })
        .then((r) => (typeof r?.text === 'string' ? r.text : null)),
    savePlan: (text, name, saveAs) =>
      call<SaveResult>('/api/save', { text, name, saveAs }).then(unwrapSave),
    saveHtml: (html, name) => call<SaveResult>('/api/save-html', { html, name }).then(unwrapSave),
    recentFiles: () => call<string[]>('/api/recent').then((r) => r ?? []),
    openRecent: (path) => call<{ path: string; text: string } | null>('/api/open-recent', { path }),
    loadPresets: () => call<unknown[]>('/api/presets').then((r) => (Array.isArray(r) ? r : [])),
    savePresets: (presets) =>
      call<{ saved?: boolean }>('/api/presets', { presets }).then((r) => Boolean(r?.saved)),
  };
  onReady();
}

/**
 * Tell the shell the app is up, and hand it enough detail to self-check.
 * Resolves with a plan the shell wants opened, if one was named on its command line.
 */
export async function announceReady(
  info: Record<string, unknown>,
): Promise<{ path: string; text: string } | null> {
  if (!shellToken) return null;
  const result = await call<{ queuedPlan: { path: string; text: string } | null }>('/api/ready', info);
  return result?.queuedPlan ?? null;
}

const EMBED_ID = 'embedded-plan';

/**
 * The page's HTML as it was before the app touched the DOM.
 *
 * Captured synchronously at boot because 'export a shareable viewer' means handing
 * someone the app itself with a plan baked in -- and by the time they click export,
 * the live DOM is full of canvases and panel markup.
 */
let bootHtml = '';

export function captureBootHtml(): void {
  bootHtml = `<!doctype html>\n${document.documentElement.outerHTML}`;
}

/**
 * Raw text of a plan baked into the page by a previous 'export shareable viewer'.
 *
 * Text, not a parsed document: a shared page is a file from someone else, and it has
 * to go through the same parse-and-validate boundary as a plan opened from disk
 * rather than being trusted because it arrived inside the HTML.
 */
export function embeddedPlanText(): string | null {
  const el = document.getElementById(EMBED_ID);
  return el?.textContent?.trim() || null;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick: revoking synchronously can cancel the download in
  // some browsers before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function savePlanText(
  text: string,
  suggestedName: string,
  saveAs = false,
): Promise<string | null> {
  const bridge = shell();
  // Only the desktop shell can distinguish the two: a browser download always
  // goes through the browser's own destination handling.
  if (bridge) return bridge.savePlan(text, suggestedName, saveAs);
  download(new Blob([text], { type: 'application/json' }), suggestedName);
  return suggestedName;
}

/**
 * Pick a file and read its text.
 *
 * Shared by Open and Import FDS, which differ only in the filter and in what the
 * caller does with the text -- so the shell branch, the browser branch and the
 * cancel-never-settles caveat exist once.
 */
async function pickText(
  accept: string,
  viaShell: (b: ShellBridge) => Promise<{ path: string; text: string } | null>,
  fallbackName: string,
): Promise<{ name: string; text: string } | null> {
  const bridge = shell();
  if (bridge) {
    const result = await viaShell(bridge);
    return result
      ? { name: result.path.split(/[\\/]/).pop() ?? fallbackName, text: result.text }
      : null;
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then((text) => resolve({ name: file.name, text }));
    });
    // Cancelling a file dialog fires no event in most browsers, so this promise
    // simply never settles on cancel. Acceptable: nothing is awaiting it but the
    // click handler.
    input.click();
  });
}

/** An FDS input file's text. The conversion is `fdsToPlan`, in the shared core. */
export const openFdsText = (): Promise<{ name: string; text: string } | null> =>
  pickText('.fds,text/plain', (b) => b.openFds(), 'model.fds');

/** How deep `&CATF` includes are followed before the reader gives up. Mirrors
 *  `CATF_MAX_DEPTH` in python/fireplan/fds.py. */
const CATF_MAX_DEPTH = 8;

/**
 * `text` with every `&CATF` include spliced in **where it sits**.
 *
 * The position matters as much as the content. `&CATF` belongs in the body of the
 * input, before `&TAIL` -- that is where the official validation cases put it --
 * and reading stops at `&TAIL`, so a child appended after the parent's last line is
 * a child nobody reads. Mirror of `_read_source` in python/fireplan/fds.py, which
 * is why the record offsets exist on `NamelistRecord`.
 */
async function spliceIncludes(
  text: string, read: (name: string) => Promise<string | null>,
  seen: Set<string>, depth: number, unresolved: string[],
): Promise<string> {
  if (depth > CATF_MAX_DEPTH) return text;
  const pieces: string[] = [];
  let pos = 0;

  for (const rec of readNamelist(text)) {
    if (rec.group !== 'CATF') continue;
    const included: string[] = [];
    for (const name of rec.strings('OTHER_FILES')) {
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue; // a file two others share is read once
      seen.add(key);
      // eslint-disable-next-line no-await-in-loop
      const child = await read(name);
      if (child === null) {
        unresolved.push(name);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      included.push(await spliceIncludes(child, read, seen, depth + 1, unresolved));
    }
    if (included.length > 0) {
      pieces.push(text.slice(pos, rec.end), `\n${included.join('\n')}\n`);
      pos = rec.end;
    }
  }
  pieces.push(text.slice(pos));
  return pieces.join('');
}

/**
 * `text` with its `&CATF` includes spliced in, and the names `read` could not find.
 *
 * Separate from `resolveFdsIncludes` so the splicing can be tested against a reader
 * that is not a filesystem -- this is the mirror of a Python function held to the
 * same behaviour, and "it only runs under the desktop shell" is not a reason for it
 * to be the untested half.
 */
export async function spliceFdsIncludes(
  text: string, read: (name: string) => Promise<string | null>,
): Promise<{ text: string; unresolved: string[] }> {
  const unresolved: string[] = [];
  const spliced = await spliceIncludes(text, read, new Set<string>(), 0, unresolved);
  return { text: spliced, unresolved };
}

/**
 * An FDS input's text with the files it `&CATF`s in pulled alongside it.
 *
 * Only the desktop shell can do this: it has a folder to resolve names against. A
 * browser tab is handed one file's bytes and says so, and the import reports what
 * is therefore missing rather than presenting a fraction of a model as a whole one.
 */
export async function resolveFdsIncludes(
  text: string,
): Promise<{ text: string; resolved: boolean; unresolved: string[] }> {
  const bridge = shell();
  if (!bridge) return { text, resolved: false, unresolved: [] };
  const spliced = await spliceFdsIncludes(text, (name) => bridge.readFdsInclude(name));
  return { ...spliced, resolved: true };
}

export const openPlanText = (): Promise<{ name: string; text: string } | null> =>
  pickText('.json,.ftp.json,application/json', (b) => b.openPlan(), 'plan.ftp.json');

/**
 * A single self-contained HTML file with the plan baked in.
 *
 * Only meaningful for the single-file build, where the boot HTML already carries
 * the whole application inline. A split dev build produces a page that cannot find
 * its own assets, so the caller warns instead.
 */
export function buildShareableHtml(planJson: string, title: string): string {
  if (!bootHtml) throw new Error('Boot HTML was never captured');

  // A plan's notes could legitimately contain the characters `</script>`, which
  // would terminate the embedding tag early and corrupt the page.
  const safe = planJson.replace(/<\/script>/gi, '<\\/script>');

  let html = bootHtml.replace(
    new RegExp(`(<script[^>]*id="${EMBED_ID}"[^>]*>)([\\s\\S]*?)(</script>)`, 'i'),
    (_m, open: string, _body: string, close: string) => `${open}\n${safe}\n${close}`,
  );
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  return html;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);

export async function saveShareableHtml(html: string, suggestedName: string): Promise<string | null> {
  const bridge = shell();
  if (bridge) return bridge.saveHtml(html, suggestedName);
  download(new Blob([html], { type: 'text/html' }), suggestedName);
  return suggestedName;
}

export const isSingleFileBuild = (): boolean =>
  bootHtml.length > 200_000 && !bootHtml.includes('/@vite/client');
