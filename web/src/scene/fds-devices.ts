import * as THREE from 'three';
import { visualTheme } from '../ui/theme';
import {
  DEVICE_KINDS,
  deviceKind,
  deviceSites,
  pickDevices,
  deviceKinds,
  type DeviceDisplay,
  type DeviceSite,
  type ProjectedSite,
} from '../core/fds-devices';
import type { ResultDevice } from '../core/fds-results';

/** Screen-sized symbols anchored to original FDS coordinates. No plan transform or
 * invented hardware dimensions. The separate layer also makes exports deterministic. */
export class FdsDeviceLayer {
  readonly canvas = document.createElement('canvas');
  private devices: ResultDevice[] = [];
  private sites: DeviceSite[] = [];
  private projected: ProjectedSite[] = [];
  private selected?: ResultDevice;
  private display: DeviceDisplay = {
    visible: true,
    kinds: new Set(deviceKinds),
    labels: false,
    direction: true,
  };
  private width = 0;
  private height = 0;
  private ratio = 1;
  private clipZ = Infinity;
  private down?: { x: number; y: number; id: number; moved: boolean };
  private theme: ReturnType<typeof visualTheme>;
  onPick?: (devices: ResultDevice[]) => void;

  constructor(
    private camera: THREE.Camera,
    private target: HTMLCanvasElement
  ) {
    this.theme = visualTheme(target);
    this.canvas.className = 'fds-results__devices-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    target.parentElement!.append(this.canvas);
    target.addEventListener('pointerdown', this.pointerDown);
    target.addEventListener('pointermove', this.pointerMove);
    target.addEventListener('pointerup', this.pointerUp);
    target.addEventListener('pointercancel', this.pointerCancel);
  }
  setDevices(devices: ResultDevice[]): void {
    this.devices = devices;
    this.selected = undefined;
    this.refresh();
  }
  setDisplay(display: DeviceDisplay): void {
    this.display = display;
    this.refresh();
  }
  setSelected(device?: ResultDevice): void {
    this.selected = device;
  }
  setCutaway(z: number): void {
    this.clipZ = z;
  }
  private refresh(): void {
    this.sites = deviceSites(this.devices, this.display);
    this.projected = [];
  }
  resize(width: number, height: number, ratio: number): void {
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }
  private project(position: readonly number[]): THREE.Vector3 {
    return new THREE.Vector3(...position).project(this.camera);
  }
  draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.projected = [];
    for (const site of this.sites) {
      if (site.position[2] > this.clipZ) continue;
      const p = this.project(site.position);
      if (
        ![p.x, p.y, p.z].every(Number.isFinite) ||
        p.z < -1 ||
        p.z > 1 ||
        Math.abs(p.x) > 1 ||
        Math.abs(p.y) > 1
      )
        continue;
      this.projected.push({ site, x: ((p.x + 1) * this.width) / 2, y: ((1 - p.y) * this.height) / 2 });
    }
    const selected = this.projected.find((p) => this.selected && p.site.devices.includes(this.selected));
    // Render the selection last so dense vertical arrays cannot cover its outline.
    for (const p of this.projected) if (p !== selected) this.marker(ctx, p, false);
    if (selected) {
      this.marker(ctx, selected, true);
      if (this.display.direction && this.selected?.orientation)
        this.arrow(ctx, selected, this.selected.orientation);
    }
    const occupied: number[][] = [];
    if (selected) this.label(ctx, selected, this.selected!.id, occupied);
    if (this.display.labels)
      for (const p of this.projected)
        if (p !== selected) {
          this.label(
            ctx,
            p,
            p.site.devices.length > 1
              ? `${p.site.devices[0].id} +${p.site.devices.length - 1}`
              : p.site.devices[0].id,
            occupied
          );
        }
  }
  private marker(ctx: CanvasRenderingContext2D, p: ProjectedSite, selected: boolean): void {
    const { x, y, site } = p;
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.theme.background;
    if (site.devices.length > 1) {
      ctx.fillStyle = this.theme.background;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fill();
      // One sector per type, with a count for coincident probes of any type.
      const kinds = [...new Set(site.devices.map(deviceKind))];
      kinds.forEach((kind, i) => {
        ctx.strokeStyle = DEVICE_KINDS[kind].color;
        ctx.lineWidth = 3;
        ctx.setLineDash(kind === 'surface' ? [2, 2] : []);
        ctx.beginPath();
        ctx.arc(x, y, 8, (i * Math.PI * 2) / kinds.length, ((i + 1) * Math.PI * 2) / kinds.length);
        ctx.stroke();
        ctx.setLineDash([]);
      });
      ctx.fillStyle = this.theme.text;
      ctx.font = 'bold 10px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(site.devices.length), x, y);
    } else {
      const kind = deviceKind(site.devices[0]);
      ctx.fillStyle = DEVICE_KINDS[kind].color;
      ctx.beginPath();
      if (kind === 'flux') ctx.rect(x - 5, y - 5, 10, 10);
      else if (kind === 'surface') {
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x + 7, y);
        ctx.lineTo(x, y + 7);
        ctx.lineTo(x - 7, y);
        ctx.closePath();
      } else ctx.arc(x, y, 5, 0, Math.PI * 2);
      if (kind === 'other' || kind === 'surface') {
        // A dark halo separates hollow probes from bright scalar fields.
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = ctx.fillStyle;
        ctx.stroke();
      } else {
        ctx.fill();
        ctx.stroke();
      }
    }
    if (selected) {
      ctx.strokeStyle = this.theme.background;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = this.theme.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  private arrow(ctx: CanvasRenderingContext2D, p: ProjectedSite, orientation: readonly number[]): void {
    const end = this.project(p.site.position.map((v, a) => v + orientation[a] * 0.25));
    if (end.z < -1 || end.z > 1) return;
    const x = ((end.x + 1) * this.width) / 2,
      y = ((1 - end.y) * this.height) / 2;
    const angle = Math.atan2(y - p.y, x - p.x);
    if (Math.hypot(x - p.x, y - p.y) < 4) return;
    ctx.strokeStyle = this.theme.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(x, y);
    for (const delta of [-0.5, 0.5]) {
      ctx.moveTo(x, y);
      ctx.lineTo(x - 7 * Math.cos(angle + delta), y - 7 * Math.sin(angle + delta));
    }
    ctx.stroke();
  }
  private label(ctx: CanvasRenderingContext2D, p: ProjectedSite, text: string, occupied: number[][]): void {
    ctx.font = '11px ' + this.theme.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const label = text.length > 45 ? text.slice(0, 42) + '…' : text;
    const width = Math.min(this.width, ctx.measureText(label).width + 12);
    const x = Math.max(0, Math.min(this.width - width, p.x + 16)),
      y = Math.max(10, Math.min(this.height - 10, p.y));
    if (occupied.some((b) => x < b[0] + b[2] && x + width > b[0] && Math.abs(y - b[1]) < 21)) return;
    occupied.push([x, y, width]);
    ctx.fillStyle = this.theme.labelBackground;
    ctx.beginPath();
    ctx.roundRect(x, y - 10, width, 20, 4);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = p.site.devices.includes(this.selected!)
      ? this.theme.accent
      : DEVICE_KINDS[deviceKind(p.site.devices[0])].color;
    ctx.stroke();
    ctx.fillStyle = this.theme.text;
    ctx.fillText(label, x + 6, y, Math.max(1, width - 12));
  }
  private pointerDown = (e: PointerEvent): void => {
    if (e.button === 0 && e.isPrimary)
      this.down = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
  };
  private pointerMove = (e: PointerEvent): void => {
    if (this.down?.id === e.pointerId && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5)
      this.down.moved = true;
  };
  private pointerUp = (e: PointerEvent): void => {
    const down = this.down;
    this.down = undefined;
    if (
      !down ||
      down.id !== e.pointerId ||
      down.moved ||
      Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5
    )
      return;
    const rect = this.target.getBoundingClientRect();
    const devices = pickDevices(this.projected, e.clientX - rect.left, e.clientY - rect.top);
    if (devices.length) this.onPick?.(devices);
  };
  private pointerCancel = (): void => {
    this.down = undefined;
  };
  dispose(): void {
    this.target.removeEventListener('pointerdown', this.pointerDown);
    this.target.removeEventListener('pointermove', this.pointerMove);
    this.target.removeEventListener('pointerup', this.pointerUp);
    this.target.removeEventListener('pointercancel', this.pointerCancel);
    this.onPick = undefined;
    this.projected = [];
    this.sites = [];
    this.devices = [];
    this.canvas.remove();
  }
}
