import * as i18n from './i18n';
import { devicesToFds } from '../core/fds-export';
import { readNamelist } from '../core/namelist';
import type { PlanDocument } from '../core/types';
import { saveFdsText } from '../io/files';
import { h } from './dom';
import { button } from './fields';

export function fdsExportSummary(text: string): string {
  const devices = readNamelist(text).filter(r => r.group === 'DEVC');
  const kinds = [
    ['GAUGE HEAT FLUX', i18n.t("gauge heat flux")],
    ['RADIATIVE HEAT FLUX GAS', i18n.t("radiative heat flux gas")],
    ['THERMOCOUPLE', i18n.t("thermocouple beads")],
    ['WALL TEMPERATURE', i18n.t("surface thermocouple beads")],
    ['U-VELOCITY', i18n.t("X velocity probes")], ['V-VELOCITY', i18n.t("Y velocity probes")],
    ['W-VELOCITY', i18n.t("Z velocity probes")], ['VELOCITY', i18n.t("velocity magnitude probes")],
    ['VOLUME FRACTION', i18n.t("gas species")],
  ].map(([quantity, label]) => ({ label, count: devices.filter(r => r.string('QUANTITY') === quantity).length }))
    .filter(kind => kind.count);
  return i18n.plural("{p1} device{p2}. Cameras and geometry are not exported.{p3}", "{p1} devices{p2}. Cameras and geometry are not exported.{p3}", devices.length, { p1: devices.length, p2: kinds.length ? ': ' + kinds.map(k => `${k.count} ${k.label}`).join(', ') : '', p3: (text.includes('load cell omitted') ? i18n.t(" Load cells are omitted.") : '') });
}

export class FdsExportDialog {
  private root: HTMLDialogElement | null = null;

  constructor(private onOpenChange: (open: boolean) => void) {}

  get isOpen(): boolean { return this.root !== null; }

  open(doc: PlanDocument, fileName: string): void {
    this.close();
    const text = devicesToFds(doc);
    const summary = fdsExportSummary(text);
    const area = h('textarea', { class: 'field__input fds-export__text', readOnly: true,
      spellcheck: false, wrap: 'off', value: text, 'aria-label': i18n.t("FDS device text") });
    const status = h('p', { class: 'fds-export__status', role: 'status', 'aria-live': 'polite' });
    const act = async (control: HTMLButtonElement, action: () => Promise<string>): Promise<void> => {
      control.disabled = true;
      status.classList.remove('fds-export__status--error');
      status.textContent = '';
      try { status.textContent = await action(); }
      catch (error) {
        status.classList.add('fds-export__status--error');
        status.textContent = (error as Error).message;
      } finally { control.disabled = false; }
    };
    const copy = button(i18n.t("Copy"), () => { void act(copy, async () => {
      await navigator.clipboard.writeText(text);
      return i18n.t("Copied.");
    }); });
    const download = button(i18n.t("Download .fds"), () => { void act(download, async () => {
      const name = fileName.replace(/\.ftp\.json$|\.json$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const saved = await saveFdsText(text, `${name || 'plan'}-devices.fds`);
      return saved ? i18n.t("Saved.") : i18n.t("Save cancelled.");
    }); }, 'btn--primary');
    const dialog = h('dialog', { class: 'modal__panel fds-export', 'aria-labelledby': 'fds-export-title' }, [
      h('h2', { class: 'modal__title', id: 'fds-export-title' }, [i18n.t("Export to FDS")]),
      h('p', { class: 'import__intro fds-export__summary' }, [summary]),
      area, status,
      h('div', { class: 'import__actions' }, [button(i18n.t("Close"), () => this.close()), copy, download]),
    ]);
    dialog.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
    this.root = dialog;
    document.body.append(dialog);
    this.onOpenChange(true);
    dialog.showModal();
    area.focus();
  }

  close(): void {
    if (!this.root) return;
    this.root.close();
    this.root.remove();
    this.root = null;
    this.onOpenChange(false);
  }
}
