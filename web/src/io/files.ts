/**
 * File in, file out.
 *
 * In the browser this is download/upload; under the pywebview shell the same
 * functions defer to native dialogs when `window.fireplanShell` is present, so the
 * desktop build gets real Save As without a second code path.
 */

import { readNamelist } from '../core/namelist';
import type { Issue, LinkedFileKind } from '../core/types';
import { mapLinkedPaths } from './link-paths';
import { LINK_TYPES, fileName } from '../core/linked-files';

export interface PickedLinkedFile { path: string; text?: string; warning?: string; file?: File }

/**
 * A plan the shell read from disk.
 *
 * `token` is the shell's handle on that file. The page hands it back on a plain
 * Save, and the shell writes to the file the token names -- and to nothing else.
 * The page never learns a path, and the shell never guesses which file the page is
 * showing from a basename: the token is issued when a file is read or written, and
 * the page keeps it only for as long as that document is the one on screen.
 */
export interface OpenedPlan {
  path: string;
  text: string;
  token: string | null;
}

/** Where a plan was written, and the handle for writing back to it next time. */
export interface SavedPlan {
  path: string;
  token: string | null;
}

export interface ShellBridge {
  pickLinkedFiles(kind: LinkedFileKind): Promise<PickedLinkedFile[]>;
  linkedFileAction(path: string, kind: LinkedFileKind, action: 'open' | 'folder' | 'read'): Promise<{ text?: string }>;
  openPlan(): Promise<OpenedPlan | null>;
  /** Pick an FDS input and read it. The conversion happens in the shared core, so
   *  this is only the native dialog a browser tab cannot open. */
  openFds(): Promise<{ path: string; text: string } | null>;
  /** One file an `&CATF` names, read from beside the input that named it. Null when
   *  it is not there. The shell confines this to that folder and to bare filenames. */
  readFdsInclude(name: string): Promise<string | null>;
  /** `saveAs` forces a destination dialog; otherwise the shell writes back to the
   *  file `token` names, and asks for a destination when there is no token.
   *  Resolves to null when the user cancels, and REJECTS when the write fails. */
  savePlan(
    text: string, suggestedName: string, saveAs: boolean, token: string | null,
  ): Promise<SavedPlan | null>;
  saveHtml(html: string, suggestedName: string): Promise<string | null>;
  recentFiles(): Promise<string[]>;
  /** A plan from the recent list. Rejects with the shell's reason otherwise. */
  openRecent(path: string): Promise<OpenedPlan | null>;
  /** The page put the document `token` came with on screen: only now does the file
   *  join the recent list and the window title. */
  adopted(token: string): Promise<void>;
  /** Unsaved changes on screen or not. The shell arms its close prompt from this,
   *  because WebView2 does not run `beforeunload` when the window is closed. */
  setDirty(dirty: boolean): Promise<void>;
  /** The user's camera preset library, kept in the shell's per-profile settings
   *  rather than in browser storage -- see `presets.ts` for why. */
  loadPresets(): Promise<unknown[]>;
  /** Replace the library. Resolves to true only when the write reached the disk. */
  savePresets(presets: unknown[]): Promise<boolean>;
  /** Native folder dialog for a voxel sequence. Null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** The frame files a linked voxel folder holds, by name. The shell registers the
   *  folder so `readFlameFrame` can serve from it, and from nowhere else. */
  listFlameFrames(path: string): Promise<string[]>;
  /** One frame's bytes from a registered folder. */
  readFlameFrame(path: string, name: string): Promise<Uint8Array>;
}

/** What the shell's save routes answer: a destination, a reason, or null for cancel. */
type SaveResult = { path?: string; token?: string; error?: string } | null;

/**
 * Cancel and failure look the same from the outside -- both leave the file unwritten
 * -- but they are opposites to the user: one is what they asked for, the other is
 * their work not being on disk. A cancel is null; a failure throws, so the caller has
 * to deal with it rather than silently doing nothing.
 */
function unwrapSave(result: SaveResult): SavedPlan | null {
  if (!result) return null;
  if (result.error) throw new Error(result.error);
  if (!result.path) return null;
  return { path: result.path, token: typeof result.token === 'string' ? result.token : null };
}

const withToken = (r: { path: string; text: string; token?: unknown } | null): OpenedPlan | null =>
  r ? { path: r.path, text: mapLinkedPaths(r.text, r.path, 'open'), token: typeof r.token === 'string' ? r.token : null } : null;

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
    pickLinkedFiles: async (kind) => {
      const result = await call<{ files?: PickedLinkedFile[]; error?: string }>('/api/pick-linked-files', { kind });
      if (result?.error) throw new Error(result.error);
      return result?.files ?? [];
    },
    linkedFileAction: async (path, kind, action) => {
      const result = await call<{ text?: string; error?: string }>('/api/linked-file', { path, kind, action });
      if (result?.error) throw new Error(result.error);
      if (!result) throw new Error('Desktop file operation did not complete.');
      return result;
    },
    openPlan: () => call<{ path: string; text: string; token?: unknown } | null>('/api/open', {}).then(withToken),
    openFds: () => call<{ path: string; text: string } | null>('/api/open-fds', {}).then((r) => r ?? null),
    readFdsInclude: (name) =>
      call<{ text?: string }>('/api/read-fds-include', { name })
        .then((r) => (typeof r?.text === 'string' ? r.text : null)),
    savePlan: async (text, name, saveAs, token) => {
      const target = unwrapSave(await call<SaveResult>('/api/save-target', { name, saveAs, token }));
      if (!target) return null;
      return unwrapSave(await call<SaveResult>('/api/save', {
        text: mapLinkedPaths(text, target.path, 'save'), name, saveAs: false, token: target.token,
      }));
    },
    saveHtml: (html, name) =>
      call<SaveResult>('/api/save-html', { html, name }).then((r) => unwrapSave(r)?.path ?? null),
    recentFiles: () => call<string[]>('/api/recent').then((r) => (Array.isArray(r) ? r : [])),
    openRecent: async (path) => {
      const result = await call<{ path: string; text: string; token?: unknown; error?: string } | null>(
        '/api/open-recent', { path });
      if (result?.error) throw new Error(result.error);
      return withToken(result);
    },
    adopted: async (token) => { await call('/api/adopted', { token }); },
    setDirty: async (dirty) => { await call('/api/dirty', { dirty }); },
    loadPresets: () => call<unknown[]>('/api/presets').then((r) => (Array.isArray(r) ? r : [])),
    savePresets: (presets) =>
      call<{ saved?: boolean }>('/api/presets', { presets }).then((r) => Boolean(r?.saved)),
    pickFolder: async () => {
      const result = await call<{ path?: string; error?: string } | null>('/api/pick-folder', {});
      if (result?.error) throw new Error(result.error);
      return result?.path ?? null;
    },
    listFlameFrames: async (path) => {
      const result = await call<{ frames?: string[]; error?: string }>('/api/flame/list', { path });
      if (result?.error) throw new Error(result.error);
      return result?.frames ?? [];
    },
    readFlameFrame: async (path, name) => {
      const response = await fetch(`/api/flame/frame?${new URLSearchParams({ path, name })}`, {
        headers: { 'X-Shell-Token': shellToken ?? '' },
      });
      if (!response.ok) {
        let message = `Shell could not read ${name}: ${response.status}`;
        try { message = ((await response.json()) as { error?: string }).error ?? message; } catch { /* not JSON */ }
        throw new Error(message);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
  onReady();
}

/**
 * Tell the shell the app is up, and hand it enough detail to self-check.
 * Resolves with a plan the shell wants opened, if one was named on its command line.
 */
export async function announceReady(
  info: Record<string, unknown>,
): Promise<OpenedPlan | null> {
  if (!shellToken) return null;
  const result = await call<{ queuedPlan: { path: string; text: string; token?: unknown } | null }>(
    '/api/ready', info,
  );
  return withToken(result?.queuedPlan ?? null);
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

/** The browser's File System Access save picker, where there is one (Chromium). */
interface WritableFileHandle {
  name: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
type SavePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<WritableFileHandle>;

/** Files a browser tab saved through the picker, by the token handed to the store,
 *  so a plain Save writes back to the file chosen rather than asking again. */
const browserHandles = new Map<string, WritableFileHandle>();
let browserHandleCount = 0;

export async function savePlanText(
  text: string,
  suggestedName: string,
  saveAs = false,
  token: string | null = null,
): Promise<SavedPlan | null> {
  const bridge = shell();
  if (bridge) return bridge.savePlan(text, suggestedName, saveAs, token);
  // A browser tab with the File System Access API gets a real save: the picker
  // says whether the user chose a file or cancelled, and the write says whether it
  // landed. A plain download reports neither, so treating it as saved cleared the
  // unsaved-changes bullet -- and disarmed the close-tab warning -- even when the
  // download's Save-As dialog had been cancelled.
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker === 'function') {
    let handle = !saveAs && token ? browserHandles.get(token) : undefined;
    if (!handle) {
      try {
        handle = await picker({
          suggestedName,
          types: [{ description: 'Fire test plan', accept: { 'application/json': ['.json'] } }],
        });
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return null;
        throw err;
      }
    }
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    const issued = `browser:${++browserHandleCount}`;
    browserHandles.set(issued, handle);
    return { path: handle.name, token: issued };
  }
  // Elsewhere a download is all there is, and the browser does not say whether it
  // happened; the plan is treated as saved, as it always has been.
  download(new Blob([text], { type: 'application/json' }), suggestedName);
  return { path: suggestedName, token: null };
}

/** A file picked by the user: its basename, its text, and the shell's handle on it
 *  when there is a shell (null in a browser tab, where there is no write-back). */
export interface PickedText {
  name: string;
  text: string;
  token: string | null;
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
  viaShell: (b: ShellBridge) => Promise<{ path: string; text: string; token?: string | null } | null>,
  fallbackName: string,
): Promise<PickedText | null> {
  const bridge = shell();
  if (bridge) {
    const result = await viaShell(bridge);
    return result
      ? {
        name: result.path.split(/[\\/]/).pop() ?? fallbackName,
        text: result.text,
        token: result.token ?? null,
      }
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
      file.text().then((text) => resolve({ name: file.name, text, token: null }));
    });
    // Cancelling a file dialog fires no event in most browsers, so this promise
    // simply never settles on cancel. Acceptable: nothing is awaiting it but the
    // click handler.
    input.click();
  });
}

/** An FDS input file's text. The conversion is `fdsToPlan`, in the shared core. */
export const openFdsText = (): Promise<PickedText | null> =>
  pickText('.fds,text/plain', (b) => b.openFds(), 'model.fds');

const includeIssue = (severity: Issue['severity'], code: string, message: string): Issue =>
  ({ severity, code, message });

/**
 * An included file as FDS copies it into the run (`COPY_FILE_TO_CAT`, read.f90):
 * its `&HEAD` left out, and nothing past its first `&TAIL` or `&CATF`, where FDS
 * stops copying that file. So a child's `&TAIL` ends the child, not the model --
 * the parent carries on after its `&CATF` line -- and a child's own `&CATF` is
 * never read: FDS does not follow nested includes. Mirror of `_as_included` in
 * python/fireplan/fds.py.
 */
function asIncluded(child: string, name: string, issues: Issue[]): string {
  const records = readNamelist(child);
  const stop = records.find((r) => r.group === 'TAIL' || r.group === 'CATF');
  const end = stop ? stop.start : child.length;
  if (stop?.group === 'CATF') {
    issues.push(includeIssue('info', 'fds-catf-nested',
      `${name} includes further files with &CATF; FDS stops copying an included file at `
      + 'its own &CATF line and never reads nested includes, so neither does this import'));
  } else if (stop && /^[ \t]*&/m.test(child.slice(stop.end))) {
    issues.push(includeIssue('info', 'fds-catf-tail',
      `the included file ${name} has records after its &TAIL; FDS copies an included `
      + 'file only up to its &TAIL, and so does this import'));
  }
  const pieces: string[] = [];
  let pos = 0;
  for (const rec of records) {
    if (rec.start >= end) break;
    if (rec.group !== 'HEAD') continue;
    pieces.push(child.slice(pos, rec.start));
    pos = rec.end;
  }
  pieces.push(child.slice(pos, end));
  return pieces.join('');
}

/**
 * `text` with every `&CATF` include spliced in **where it sits**, as FDS does.
 *
 * The position matters as much as the content. `&CATF` belongs in the body of the
 * input, before `&TAIL` -- that is where the official validation cases put it --
 * and reading stops at `&TAIL`, so a child appended after the parent's last line is
 * a child nobody reads. Each child goes through `asIncluded`. Mirror of
 * `_read_source` in python/fireplan/fds.py, which is why the record offsets exist on
 * `NamelistRecord`.
 *
 * Everything the splice could not do is an issue with the same code Python's reader
 * files, so the import preview names it whichever engine did the reading: a file
 * that is not there, a file included twice, the input including itself, and a
 * child's own includes or trailing records that FDS would not read either.
 */
async function spliceIncludes(
  text: string, read: (name: string) => Promise<string | null>,
  self: string | null, unresolved: string[], issues: Issue[],
): Promise<string> {
  const pieces: string[] = [];
  let pos = 0;
  // Names compare case-blind: Windows, where these inputs live, does.
  const seen = new Set<string>();

  for (const rec of readNamelist(text)) {
    if (rec.group !== 'CATF') continue;
    const included: string[] = [];
    for (const name of rec.strings('OTHER_FILES')) {
      if (!name) continue;
      const key = name.toLowerCase();
      if (self !== null && key === self.toLowerCase()) {
        issues.push(includeIssue('warning', 'fds-catf-cycle',
          `&CATF includes ${name} from inside itself; the repeat was skipped`));
        continue;
      }
      if (seen.has(key)) {
        // Two &CATF names for one file, which FDS would splice twice. Once is
        // enough here -- the second copy could only redefine what the first said.
        issues.push(includeIssue('info', 'fds-catf-repeat',
          `${name} is included more than once; it was read the first time`));
        continue;
      }
      seen.add(key);
      // eslint-disable-next-line no-await-in-loop
      const child = await read(name);
      if (child === null) {
        unresolved.push(name);
        issues.push(includeIssue('warning', 'fds-catf-missing',
          `&CATF names ${name} but it is not beside the input; anything it defined is `
          + 'missing from this plan'));
        continue;
      }
      included.push(asIncluded(child, name, issues));
    }
    if (included.length > 0) {
      pieces.push(text.slice(pos, rec.end), `\n${included.join('\n')}\n`);
      pos = rec.end;
    }
  }
  pieces.push(text.slice(pos));
  return pieces.join('');
}

/** What splicing produced, and everything it has to say about how it went. */
export interface SplicedFds {
  text: string;
  /** `&CATF` names `read` could not find. Also reported in `issues`. */
  unresolved: string[];
  /** Diagnostics in the import's own vocabulary, ready to prepend to its report. */
  issues: Issue[];
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
  text: string, read: (name: string) => Promise<string | null>, self: string | null = null,
): Promise<SplicedFds> {
  const unresolved: string[] = [];
  const issues: Issue[] = [];
  const spliced = await spliceIncludes(text, read, self, unresolved, issues);
  return { text: spliced, unresolved, issues };
}

/**
 * An FDS input's text with the files it `&CATF`s in pulled alongside it.
 *
 * Only the desktop shell can do this: it has a folder to resolve names against. A
 * browser tab is handed one file's bytes and says so, and the import reports what
 * is therefore missing rather than presenting a fraction of a model as a whole one.
 */
export async function resolveFdsIncludes(
  text: string, self: string | null = null,
): Promise<SplicedFds & { resolved: boolean }> {
  const bridge = shell();
  if (!bridge) return { text, resolved: false, unresolved: [], issues: [] };
  const spliced = await spliceFdsIncludes(text, (name) => bridge.readFdsInclude(name), self);
  return { ...spliced, resolved: true };
}

export const openPlanText = (): Promise<PickedText | null> =>
  pickText('.json,.ftp.json,application/json', (b) => b.openPlan(), 'plan.ftp.json');

/**
 * JSON text made safe to sit inside a `<script>` element.
 *
 * The HTML parser reads script content as raw text and ends it at the first thing
 * that looks like a closing tag -- and "looks like" is wider than the exact string
 * `</script>`: `</script >`, `</SCRIPT\t>` and `</script/>` all end it, and `<!--`
 * changes how the rest is read. JSON escaping does none of that for us, because to
 * JSON these are ordinary characters inside a string. So every `<` becomes the JSON
 * escape sequence backslash-u-003c, which is the same character to `JSON.parse` and
 * nothing at all to the HTML parser. `<` only ever appears inside a JSON string, so
 * this cannot touch the structure of the document.
 */
export const escapeJsonForScript = (json: string): string => json.replace(/</g, '\\u003c');

/**
 * `bootHtml` with `planJson` baked into its embedded-plan tag and `title` set.
 *
 * Pure, so the escaping can be tested without a DOM; `buildShareableHtml` is the
 * thin wrapper that supplies the page captured at boot.
 */
/**
 * Packed flame sequences a shared page carries, keyed by `objectId/linkId`.
 *
 * They ride inside the plan copy as `linkedFiles[].embedded`, a key no saved plan
 * ever holds: `splitEmbeddedFlames` lifts them out before the plan is validated,
 * so the viewer's document is an ordinary one and a Save from it writes no blob.
 */
export type EmbeddedFlames = Map<string, string>;

export const embeddedFlameKey = (objectId: string, linkId: string): string => `${objectId}/${linkId}`;

export function embedPlanInHtml(boot: string, planJson: string, title: string, flames: EmbeddedFlames = new Map()): string {
  // A shared viewer cannot use desktop directories. Keep only attachment names,
  // labels and snapshots, including for cross-drive, UNC and relative paths.
  // Every object's links, not only the types this build knows: an object from a
  // newer format carries its links the same way, and its directories are no more
  // the recipient's business than a camera's.
  const shared = JSON.parse(planJson);
  for (const obj of shared.objects ?? []) {
    if (!Array.isArray(obj?.linkedFiles)) continue;
    for (const link of obj.linkedFiles) {
      if (typeof link?.path === 'string') link.path = fileName(link.path);
      if (!LINK_TYPES.includes(obj.type)) continue;
      const payload = flames.get(embeddedFlameKey(String(obj.id), String(link?.id)));
      if (payload) link.embedded = payload;
    }
  }
  const safe = escapeJsonForScript(JSON.stringify(shared));
  let html = boot.replace(
    new RegExp(`(<script[^>]*id="${EMBED_ID}"[^>]*>)([\\s\\S]*?)(</script>)`, 'i'),
    (_m, open: string, _body: string, close: string) => `${open}\n${safe}\n${close}`,
  );
  // A replacer function, not a replacement string: in a string `$'`, `` $` `` and
  // `$&` splice parts of the page back in, so a title like "Budget $' test" copied
  // the whole application into <title>.
  const titleTag = `<title>${escapeHtml(title)}</title>`;
  html = html.replace(/<title>[\s\S]*?<\/title>/i, () => titleTag);
  return html;
}

/**
 * A single self-contained HTML file with the plan baked in.
 *
 * Only meaningful for the single-file build, where the boot HTML already carries
 * the whole application inline. A split dev build produces a page that cannot find
 * its own assets, so the caller warns instead.
 */
export function buildShareableHtml(planJson: string, title: string, flames?: EmbeddedFlames): string {
  if (!bootHtml) throw new Error('Boot HTML was never captured');
  return embedPlanInHtml(bootHtml, planJson, title, flames);
}

/**
 * Lift embedded flame payloads out of a plan's text before it is validated.
 *
 * Returns the plan without them and the payloads by `objectId/linkId`. Text that
 * is not JSON, is not shaped like a plan, or carries none, comes back untouched,
 * so the normal load gate reports whatever is wrong with it. This runs ahead of
 * that gate, so nothing here may assume a shape: `objects` that is a map rather
 * than a list is the gate's `bad-objects` to report, not an exception to throw.
 */
export function splitEmbeddedFlames(text: string): { text: string; flames: EmbeddedFlames } {
  const flames: EmbeddedFlames = new Map();
  let doc: { objects?: unknown };
  try { doc = JSON.parse(text); } catch { return { text, flames }; }
  const objects = doc !== null && typeof doc === 'object' && Array.isArray(doc.objects) ? doc.objects as unknown[] : [];
  for (const obj of objects) {
    const links = (obj as { linkedFiles?: unknown } | null)?.linkedFiles;
    if (!Array.isArray(links)) continue;
    for (const link of links as ({ id?: unknown; embedded?: unknown } | null)[]) {
      if (typeof link?.embedded !== 'string') continue;
      flames.set(embeddedFlameKey(String((obj as { id?: unknown }).id), String(link.id)), link.embedded);
      delete link.embedded;
    }
  }
  return { text: flames.size ? JSON.stringify(doc) : text, flames };
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


export interface OpenedResults { token: string; smv: string; files: { name: string; size: number }[] }
export async function openShellResults(): Promise<OpenedResults | null> {
  const result = await call<OpenedResults & { error?: string }>('/api/results/open', {});
  if (result?.error) throw new Error(result.error);
  return result;
}
export async function readShellResult(token: string, name: string, offset: number, length: number): Promise<Uint8Array> {
  const url = `/api/results/read?${new URLSearchParams({ token, name, offset: String(offset), length: String(length) })}`;
  // A short successful response is a transport failure, not corrupt Fortran data.
  // Retry this idempotent range once; never decode incomplete bytes or retry a
  // server rejection (which may mean a changed file or a closed session).
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, { headers: { 'X-Shell-Token': shellToken ?? '' }, cache: 'no-store' });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Could not read ${name}: HTTP ${response.status}.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === length) return bytes;
    console.warn(`Incomplete results response for ${name} at byte ${offset}: expected ${length} bytes, received ${bytes.length} (attempt ${attempt + 1}/2).`);
    if (attempt === 1) throw new Error(`Incomplete read of ${name} at byte ${offset}: expected ${length} bytes, received ${bytes.length}. Retry the frame.`);
  }
  throw new Error(`Could not read ${name}.`);
}
export function closeShellResults(token: string): void {
  void call('/api/results/close', { token }).catch(err => console.warn('Results session close failed', err));
}


/** Desktop snapshots use a native Save dialog, independent of WebView downloads. */
export async function saveResultPng(data: string): Promise<string | null> {
  return unwrapSave(await call<SaveResult>('/api/results/png', { data }))?.path ?? null;
}
