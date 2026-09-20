/**
 * Where a flame's frames come from, in each shell.
 *
 * A browser tab is handed File objects by a folder picker and can read nothing
 * else; the desktop shell lists a folder and serves its frames over the loopback
 * bridge; a shared page or the bundled Example carries the packed sequence inside
 * itself. All three end in the same `FlameSource` the store reads.
 */

import { FRAME_NAME, FlameSequence, gunzip, gzip } from '../core/flame';
import type { FlameSource } from '../state/flame-store';
import { h } from '../ui/dom';
import type { ShellBridge } from './files';

/** Pick a folder of frames in a browser tab: the folder picker Chromium offers on
 *  a file input, falling back to a multi-select of `.npz` files where it does not. */
export function pickVoxelFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, hidden: true, accept: '.npz' });
    input.setAttribute('webkitdirectory', '');
    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (files: File[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(focusTimer);
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(files.filter((f) => FRAME_NAME.test(f.name)));
    };
    const onFocus = (): void => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => done(Array.from(input.files ?? [])), 500);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.append(input);
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

/** The folder's name as the picker reported it: the first path segment of any file. */
export function pickedFolderName(files: File[]): string {
  const relative = (files[0] as File & { webkitRelativePath?: string })?.webkitRelativePath ?? '';
  return relative.split('/')[0] || 'voxels';
}

export const filesSource = (files: File[]): FlameSource => ({ kind: 'files', files });

export const shellSource = (bridge: ShellBridge, path: string): FlameSource => ({
  kind: 'shell',
  path,
  list: () => bridge.listFlameFrames(path),
  read: (name) => bridge.readFlameFrame(path, name),
});

// -- embedding -----------------------------------------------------------------

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** A sequence as a page carries it: the packed form, gzipped, base64. */
export async function encodeEmbedded(sequence: FlameSequence): Promise<string> {
  return bytesToBase64(await gzip(sequence.pack()));
}

export async function decodeEmbedded(text: string): Promise<FlameSequence> {
  return FlameSequence.unpack(await gunzip(base64ToBytes(text)));
}

export async function packedSource(text: string): Promise<FlameSource> {
  return { kind: 'packed', bytes: await gunzip(base64ToBytes(text)) };
}
