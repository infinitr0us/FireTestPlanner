/**
 * File in, file out.
 *
 * In the browser this is download/upload; under the pywebview shell the same
 * functions defer to native dialogs when `window.fireplanShell` is present, so the
 * desktop build gets real Save As without a second code path.
 */

import type { PlanDocument } from '../core/types';

export interface ShellBridge {
  openPlan(): Promise<{ path: string; text: string } | null>;
  savePlan(text: string, suggestedName: string): Promise<string | null>;
  saveHtml(html: string, suggestedName: string): Promise<string | null>;
}

declare global {
  interface Window {
    fireplanShell?: ShellBridge;
  }
}

export const shell = (): ShellBridge | undefined => window.fireplanShell;

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

/** A plan baked into the page by a previous 'export shareable viewer', if any. */
export function embeddedPlan(): PlanDocument | null {
  const el = document.getElementById(EMBED_ID);
  const text = el?.textContent?.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as PlanDocument;
  } catch {
    console.warn('Embedded plan is not valid JSON; ignoring it.');
    return null;
  }
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

export async function savePlanText(text: string, suggestedName: string): Promise<string | null> {
  const bridge = shell();
  if (bridge) return bridge.savePlan(text, suggestedName);
  download(new Blob([text], { type: 'application/json' }), suggestedName);
  return suggestedName;
}

export async function openPlanText(): Promise<{ name: string; text: string } | null> {
  const bridge = shell();
  if (bridge) {
    const result = await bridge.openPlan();
    return result ? { name: result.path.split(/[\\/]/).pop() ?? 'plan.ftp.json', text: result.text } : null;
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.ftp.json,application/json';
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
