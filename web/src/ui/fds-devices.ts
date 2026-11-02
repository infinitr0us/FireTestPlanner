import * as i18n from './i18n';
import {
  DEVICE_KINDS,
  deviceKind,
  deviceKinds,
  type DeviceDisplay,
  type DeviceKind,
} from '../core/fds-devices';
import type { ResultDevice } from '../core/fds-results';
import { h } from './dom';

/** Device controls depend only on the simulation, not on an open planning document. */
export class FdsDevicePanel {
  readonly root = h('section', { class: 'fds-results__devices', get 'aria-label'() { return i18n.t("Simulation devices"); } });
  private display: DeviceDisplay = {
    visible: true,
    kinds: new Set(deviceKinds),
    labels: false,
    direction: true,
  };
  private selected?: ResultDevice;
  private show = h('input', { type: 'checkbox', checked: true, get 'aria-label'() { return i18n.t("Show simulation devices"); } });
  private select = h('select', { get 'aria-label'() { return i18n.t("Simulation device"); } });
  private filters = new Map<DeviceKind, HTMLInputElement>();
  private count = h('div', { class: 'fds-results__note' });
  private choices = h('div', { class: 'fds-results__device-choices' });
  private detail = h('div', { class: 'fds-results__device-detail' });

  constructor(
    private devices: ResultDevice[],
    private onSelect: (device?: ResultDevice) => void,
    private onDisplay: (display: DeviceDisplay) => void
  ) {
    this.show.onchange = () => {
      this.display.visible = this.show.checked;
      this.refresh();
    };
    const kinds = h('div', { class: 'fds-results__device-filters' });
    this.select.append(h('option', { value: '' }, [i18n.t("Choose a device…")]));
    for (const kind of deviceKinds) {
      const members = devices.filter((d) => deviceKind(d) === kind);
      if (!members.length) continue;
      const spec = DEVICE_KINDS[kind];
      const check = h('input', {
        type: 'checkbox',
        checked: true,
        'aria-label': i18n.t("Show {p1}", { p1: spec.label.toLowerCase() }),
      });
      check.onchange = () => {
        if (check.checked) this.display.kinds.add(kind);
        else this.display.kinds.delete(kind);
        this.refresh();
      };
      this.filters.set(kind, check);
      kinds.append(
        h('label', { class: 'fds-results__check' }, [
          check,
          h('span', { style: { color: spec.color }, 'aria-hidden': 'true' }, [spec.symbol]),
          `${spec.label} (${members.length})`,
        ])
      );
      this.select.append(
        h(
          'optgroup',
          { label: spec.label },
          members.map((d) => h('option', { value: devices.indexOf(d) }, [d.id]))
        )
      );
    }
    this.select.disabled = !devices.length;
    this.select.onchange = () =>
      this.choose(this.select.value === '' ? undefined : devices[Number(this.select.value)]);
    const labels = h('input', { type: 'checkbox', 'aria-label': i18n.t("Device labels") });
    labels.onchange = () => {
      this.display.labels = labels.checked;
      this.refresh();
    };
    const direction = h('input', {
      type: 'checkbox',
      checked: true,
      'aria-label': i18n.t("Selected device direction"),
    });
    direction.onchange = () => {
      this.display.direction = direction.checked;
      this.refresh();
    };
    this.root.append(
      h('strong', {}, [i18n.t("Simulation devices")]),
      h('label', { class: 'fds-results__check' }, [this.show, i18n.t("Show devices")]),
      kinds,
      this.count,
      h('div', { class: 'fds-results__device-filters' }, [
        h('label', { class: 'fds-results__check' }, [labels, i18n.t("Labels")]),
        h('label', { class: 'fds-results__check' }, [direction, i18n.t("Selected direction")]),
      ]),
      h('label', {}, [i18n.t("Find / select a device"), this.select]),
      this.choices,
      this.detail,
      h('p', { class: 'fds-results__note' }, [
        i18n.t("Symbolic probes at recorded positions, visible through fields. Count badges group coincident probes. Click a marker to select. Cutaway hides probes above its height."),
      ])
    );
    this.refresh();
  }
  selectDevice(device?: ResultDevice, reveal = false): void {
    this.selected = device;
    this.select.value = device ? String(this.devices.indexOf(device)) : '';
    this.choices.replaceChildren();
    if (device && reveal) {
      this.display.visible = true;
      this.show.checked = true;
      const kind = deviceKind(device);
      this.display.kinds.add(kind);
      const check = this.filters.get(kind);
      if (check) check.checked = true;
    }
    this.refresh();
  }
  pick(devices: ResultDevice[]): void {
    if (devices.length === 1) {
      this.choose(devices[0]);
      return;
    }
    this.choices.replaceChildren(
      h('p', {}, [i18n.t("{p1} probes overlap here. Choose a device:", { p1: devices.length })]),
      ...devices.map((d) =>
        h('button', { type: 'button', onclick: () => this.choose(d) }, [`${d.id} · ${d.quantity}`])
      )
    );
    this.choices.scrollIntoView({ block: 'nearest' });
    this.choices.querySelector('button')?.focus({ preventScroll: true });
  }
  private choose(device?: ResultDevice): void {
    this.selectDevice(device, true);
    this.onSelect(device);
  }
  private refresh(): void {
    const enabled = this.display.visible
      ? this.devices.filter((d) => this.display.kinds.has(deviceKind(d))).length
      : 0;
    this.count.textContent = this.devices.length
      ? i18n.t("{p1} of {p2} probes enabled", { p1: enabled, p2: this.devices.length })
      : i18n.t("No device positions recorded in this metadata.");
    const d = this.selected;
    const format = (values: number[]) => values.map((v) => Number(v.toFixed(5))).join(', ');
    this.detail.replaceChildren(
      ...(d
        ? [
            h('strong', {}, [d.id]),
            h('div', {}, [d.quantity || i18n.t("Quantity not recorded")]),
            h('div', {}, [i18n.t("FDS XYZ: ({p1}) m", { p1: format(d.position) })]),
            h('div', {}, [
              d.orientation
                ? i18n.t("Recorded direction: ({p1}) · arrow length is symbolic", { p1: format(d.orientation) })
                : deviceKind(d) === 'surface' || deviceKind(d) === 'flux'
                  ? i18n.t("Direction not recorded")
                  : i18n.t("No facing for this point probe"),
            ]),
            !this.display.visible || !this.display.kinds.has(deviceKind(d))
              ? h('div', {}, [i18n.t("Selected probe hidden by device filters.")])
              : null,
          ].filter((node): node is HTMLElement => node !== null)
        : [])
    );
    // Give the scene a snapshot; later checkbox changes cannot mutate it mid-render.
    this.onDisplay({ ...this.display, kinds: new Set(this.display.kinds) });
  }
}
