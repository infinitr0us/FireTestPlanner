import { DEVICE_KINDS, deviceKind, deviceKinds, type DeviceDisplay, type DeviceKind } from '../core/fds-devices';
import type { ResultDevice } from '../core/fds-results';
import { h } from './dom';

/** Device controls depend only on the simulation, not on an open planning document. */
export class FdsDevicePanel {
  readonly root = h('section', { class: 'fds-results__devices', 'aria-label': 'Simulation devices' });
  private display: DeviceDisplay = { visible: true, kinds: new Set(deviceKinds), labels: false, direction: true };
  private selected?: ResultDevice;
  private show = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Show simulation devices' });
  private select = h('select', { 'aria-label': 'Simulation device' });
  private filters = new Map<DeviceKind, HTMLInputElement>();
  private count = h('div', { class: 'fds-results__note' });
  private choices = h('div', { class: 'fds-results__device-choices' });
  private detail = h('div', { class: 'fds-results__device-detail' });

  constructor(private devices: ResultDevice[], private onSelect: (device?: ResultDevice) => void,
    private onDisplay: (display: DeviceDisplay) => void) {
    this.show.onchange = () => { this.display.visible = this.show.checked; this.refresh(); };
    const kinds = h('div', { class: 'fds-results__device-filters' });
    this.select.append(h('option', { value: '' }, ['Choose a device…']));
    for (const kind of deviceKinds) {
      const members = devices.filter(d => deviceKind(d) === kind);
      if (!members.length) continue;
      const spec = DEVICE_KINDS[kind];
      const check = h('input', { type: 'checkbox', checked: true, 'aria-label': `Show ${spec.label.toLowerCase()}` });
      check.onchange = () => { if (check.checked) this.display.kinds.add(kind); else this.display.kinds.delete(kind); this.refresh(); };
      this.filters.set(kind, check);
      kinds.append(h('label', { class: 'fds-results__check' }, [check,
        h('span', { style: { color: spec.color }, 'aria-hidden': 'true' }, [spec.symbol]), `${spec.label} (${members.length})`]));
      this.select.append(h('optgroup', { label: spec.label }, members.map(d => h('option', { value: devices.indexOf(d) }, [d.id]))));
    }
    this.select.disabled = !devices.length;
    this.select.onchange = () => this.choose(this.select.value === '' ? undefined : devices[Number(this.select.value)]);
    const labels = h('input', { type: 'checkbox', 'aria-label': 'Device labels' });
    labels.onchange = () => { this.display.labels = labels.checked; this.refresh(); };
    const direction = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Selected device direction' });
    direction.onchange = () => { this.display.direction = direction.checked; this.refresh(); };
    this.root.append(h('strong', {}, ['Simulation devices']), h('label', { class: 'fds-results__check' }, [this.show, 'Show devices']),
      kinds, this.count,
      h('div', { class: 'fds-results__device-filters' }, [h('label', { class: 'fds-results__check' }, [labels, 'Labels']),
        h('label', { class: 'fds-results__check' }, [direction, 'Selected direction'])]),
      h('label', {}, ['Find / select a device', this.select]), this.choices, this.detail,
      h('p', { class: 'fds-results__note' }, ['Symbolic probes at recorded positions, visible through fields. Count badges group coincident probes. Click a marker to select. Cutaway hides probes above its height.']));
    this.refresh();
  }
  selectDevice(device?: ResultDevice, reveal = false): void {
    this.selected = device; this.select.value = device ? String(this.devices.indexOf(device)) : '';
    this.choices.replaceChildren();
    if (device && reveal) {
      this.display.visible = true; this.show.checked = true;
      const kind = deviceKind(device); this.display.kinds.add(kind);
      const check = this.filters.get(kind); if (check) check.checked = true;
    }
    this.refresh();
  }
  pick(devices: ResultDevice[]): void {
    if (devices.length === 1) { this.choose(devices[0]); return; }
    this.choices.replaceChildren(h('p', {}, [`${devices.length} probes overlap here. Choose a device:`]),
      ...devices.map(d => h('button', { type: 'button', onclick: () => this.choose(d) }, [`${d.id} · ${d.quantity}`])));
    this.choices.scrollIntoView({ block: 'nearest' });
    this.choices.querySelector('button')?.focus({ preventScroll: true });
  }
  private choose(device?: ResultDevice): void { this.selectDevice(device, true); this.onSelect(device); }
  private refresh(): void {
    const enabled = this.display.visible ? this.devices.filter(d => this.display.kinds.has(deviceKind(d))).length : 0;
    this.count.textContent = this.devices.length ? `${enabled} of ${this.devices.length} probes enabled` : 'No device positions recorded in this metadata.';
    const d = this.selected;
    const format = (values: number[]) => values.map(v => Number(v.toFixed(5))).join(', ');
    this.detail.replaceChildren(...(d ? [h('strong', {}, [d.id]), h('div', {}, [d.quantity || 'Quantity not recorded']),
      h('div', {}, [`FDS XYZ: (${format(d.position)}) m`]),
      h('div', {}, [d.orientation ? `Recorded direction: (${format(d.orientation)}) · arrow length is symbolic` : 'Direction not recorded']),
      !this.display.visible || !this.display.kinds.has(deviceKind(d)) ? h('div', {}, ['Selected probe hidden by device filters.']) : null,
    ].filter((node): node is HTMLElement => node !== null) : []));
    // Give the scene a snapshot; later checkbox changes cannot mutate it mid-render.
    this.onDisplay({ ...this.display, kinds: new Set(this.display.kinds) });
  }
}
