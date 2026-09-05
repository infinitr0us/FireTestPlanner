import { canLinkFiles, extension, fileName, MAX_CSV_BYTES, parseReconstructionCsv, SPREADSHEET_EXTENSIONS, VIDEO_EXTENSIONS } from '../core/linked-files';
import type { LinkedFile, PlanObject } from '../core/types';
import { shell, type PickedLinkedFile } from '../io/files';
import type { Store } from '../state/store';
import { h } from './dom';
import { button, row, sectionTitle, textField } from './fields';

async function pickFiles(kind: LinkedFile['kind']): Promise<PickedLinkedFile[]> {
  const bridge = shell();
  if (bridge) return bridge.pickLinkedFiles(kind);
  const files = await new Promise<File[]>((resolve) => {
    const input = h('input', { type: 'file', multiple: true, hidden: true,
      accept: (kind === 'video' ? VIDEO_EXTENSIONS : SPREADSHEET_EXTENSIONS).map((e) => `.${e}`).join(',') });
    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (files: File[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(focusTimer);
      window.removeEventListener('focus', onFocus);
      input.remove(); resolve(files);
    };
    // Older browsers may only return focus on dismissal. Give change/files time
    // to arrive before the fallback settles, and clean up both paths together.
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
  return Promise.all(files.map(async (file): Promise<PickedLinkedFile> => {
    const result: PickedLinkedFile = { path: file.name, file };
    if (['csv', 'tsv'].includes(extension(file.name))) {
      if (file.size > MAX_CSV_BYTES) result.warning = 'CSV exceeds the 5 MiB plot limit.';
      else {
        try { result.text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
        catch { result.warning = 'CSV must be UTF-8 encoded.'; }
      }
    }
    return result;
  }));
}

/** Linked records are document edits; browser File handles and progress are session state. */
export class LinkedFilesPanel {
  private busy = false;
  private message: { documentId: number; objectId: string; text: string } | null = null;
  private browserFiles = new Map<string, File>();
  private cacheDocumentId = -1;

  constructor(private store: Store, private rerender: () => void) {}

  render(obj: PlanObject): HTMLElement | null {
    if (!canLinkFiles(obj)) return null;
    if (this.cacheDocumentId !== this.store.documentId) {
      this.browserFiles.clear();
      this.cacheDocumentId = this.store.documentId;
    }
    const section = h('section', { class: 'linked-files', 'aria-label': 'Linked files' }, [sectionTitle('Linked files')]);
    const action = (label: string, fn: () => Promise<void> | void, title?: string): HTMLButtonElement => {
      const b = button(label, () => { void this.run(obj.id, fn); });
      b.disabled = this.busy;
      if (title) b.title = title;
      return b;
    };
    const links = obj.linkedFiles ?? [];
    section.append(action(obj.type === 'camera' ? 'Link videos…' : 'Link spreadsheets…', () => this.choose(obj)));
    for (const link of links) {
      const card = h('div', { class: 'linked-file' }, [
        h('strong', {}, [link.label || fileName(link.path)]),
        h('div', { class: 'linked-file__path', title: link.path }, [link.path]),
        row('Label', textField(link.label ?? '', (label) => this.change(obj.id, 'Label linked file', (o) => {
          const target = o.linkedFiles?.find((f) => f.id === link.id);
          if (target) { if (label.trim()) target.label = label.trim(); else delete target.label; }
        }))),
      ]);
      const actions = h('div', { class: 'linked-file__actions' });
      const bridge = shell();
      if (bridge) {
        actions.append(
          action('Open', async () => { await bridge.linkedFileAction(link.path, link.kind, 'open'); }, 'Open in the default desktop program'),
          action('Show in folder', async () => { await bridge.linkedFileAction(link.path, link.kind, 'folder'); }),
        );
      } else {
        const download = action('Download', () => this.download(link));
        download.disabled ||= !this.browserFiles.has(this.key(link));
        download.title = 'Relink to select the original file in this browser session.';
        actions.append(download);
      }
      actions.append(
        action('Relink…', () => this.choose(obj, link)),
        action('Remove', () => this.change(obj.id, 'Remove linked file', (o) => {
          o.linkedFiles = o.linkedFiles?.filter((f) => f.id !== link.id);
          if (!o.linkedFiles?.length) delete o.linkedFiles;
        }), 'Remove the reference; the original file stays on disk'),
      );
      if (obj.type === 'burner' && ['csv', 'tsv'].includes(extension(link.path)) && bridge) {
        actions.append(action(link.plot ? 'Refresh plot' : 'Load plot', async () => {
          const identity = this.store.identity();
          const result = await bridge.linkedFileAction(link.path, link.kind, 'read');
          const plot = parseReconstructionCsv(result.text ?? '');
          this.assertUnchanged(identity.documentId, identity.revision);
          this.change(obj.id, 'Refresh reconstruction plot', (o) => {
            const target = o.linkedFiles?.find((f) => f.id === link.id);
            if (target) target.plot = plot;
          });
        }));
      }
      card.append(actions);
      if (link.plot) card.append(h('p', { class: 'linked-files__hint' }, [
        `${link.plot.samples.length.toLocaleString()} samples · snapshot ${link.plot.importedAt.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC')}`,
      ]));
      section.append(card);
    }
    section.append(h('p', { class: 'linked-files__hint' }, [
      shell() ? 'Files stay on disk. Save the plan to keep these links. Relink if a file moves.'
        : 'The plan keeps file names and plot snapshots. Relink after reopening to download originals. Desktop provides Open and Show in folder.',
    ]));
    if (obj.type === 'burner') section.append(h('p', { class: 'linked-files__hint' }, [
      'CSV / TSV plot columns: timestamp_s, volume_m3, surface_area_m2. Excel workbooks can be linked; export to CSV to plot.',
    ]));
    if (this.busy) section.append(h('p', { role: 'status' }, ['Working…']));
    if (this.message?.documentId === this.store.documentId && this.message.objectId === obj.id) {
      section.append(h('p', { class: 'linked-files__message', role: 'status' }, [this.message.text]));
    }
    return section;
  }

  private key(link: LinkedFile): string { return `${link.id}\0${link.path}`; }

  private async run(objectId: string, fn: () => Promise<void> | void): Promise<void> {
    if (this.busy) return;
    const documentId = this.store.documentId;
    this.busy = true;
    this.message = null;
    this.rerender();
    try { await fn(); }
    catch (err) { this.message = { documentId, objectId, text: (err as Error).message }; }
    finally { this.busy = false; this.rerender(); }
  }

  private assertUnchanged(documentId: number, revision: number): void {
    if (this.store.documentId !== documentId || this.store.revision !== revision) {
      throw new Error('The plan changed while the file operation was pending. Please try again.');
    }
  }

  private change(id: string, label: string, fn: (obj: PlanObject) => void): void {
    this.store.edit(label, (doc) => {
      const obj = doc.objects.find((o) => o.id === id);
      if (obj) fn(obj);
    });
    this.store.commit();
  }

  private async choose(obj: PlanObject, replace?: LinkedFile): Promise<void> {
    const identity = this.store.identity();
    const kind = obj.type === 'camera' ? 'video' : 'spreadsheet';
    const picked = await pickFiles(kind);
    if (!picked.length) return;
    this.assertUnchanged(identity.documentId, identity.revision);
    if (replace && picked.length !== 1) throw new Error('Relink needs exactly one file. Use Link to add several.');
    if (!replace && (obj.linkedFiles?.length ?? 0) + picked.length > 100) throw new Error('Each object can link at most 100 files.');
    const warnings: string[] = [];
    const links = picked.map((file): LinkedFile => {
      if (!(kind === 'video' ? VIDEO_EXTENSIONS : SPREADSHEET_EXTENSIONS).includes(extension(file.path))) throw new Error(`Unsupported ${kind} file: ${fileName(file.path)}`);
      // A relink has a fresh ID so undo can recover the previous browser File too.
      const link: LinkedFile = { id: `file-${crypto.randomUUID()}`, kind, path: file.path };
      if (replace?.label) link.label = replace.label;
      if (obj.type === 'burner' && ['csv', 'tsv'].includes(extension(file.path))) {
        if (file.warning) warnings.push(`${fileName(file.path)}: ${file.warning}`);
        else {
          try { link.plot = parseReconstructionCsv(file.text ?? ''); }
          catch (err) { warnings.push(`${fileName(file.path)}: ${(err as Error).message}`); }
        }
      }
      return link;
    });
    // Keep browser files before the document event re-renders their Download buttons.
    picked.forEach((file, i) => {
      const key = this.key(links[i]);
      if (file.file) this.browserFiles.set(key, file.file);
      else this.browserFiles.delete(key);
    });
    this.change(obj.id, replace ? 'Relink file' : 'Link files', (o) => {
      o.linkedFiles = replace ? o.linkedFiles?.map((f) => f.id === replace.id ? links[0] : f)
        : [...(o.linkedFiles ?? []), ...links];
    });
    if (warnings.length) this.message = { documentId: this.store.documentId, objectId: obj.id,
      text: `File linked, but no plot was imported. ${warnings.join(' ')}` };
  }

  private download(link: LinkedFile): void {
    const file = this.browserFiles.get(this.key(link));
    if (!file) throw new Error('Relink this file to select its original in this browser session.');
    const url = URL.createObjectURL(file);
    const anchor = h('a', { href: url, download: file.name });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
