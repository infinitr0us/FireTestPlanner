import type { ResultDevice, ResultSeries, XYZ } from './fds-results';

export const DEVICE_KINDS = {
  thermocouple: { label: 'Thermocouples', color: '#ffca70', symbol: '●' },
  surface: { label: 'Surface temperatures', color: '#d5a4ff', symbol: '◆' },
  flux: { label: 'Heat-flux probes', color: '#67e8f9', symbol: '■' },
  other: { label: 'Other probes', color: '#c5d4e5', symbol: '○' },
} as const;
export type DeviceKind = keyof typeof DEVICE_KINDS;
export const deviceKinds = Object.keys(DEVICE_KINDS) as DeviceKind[];
export function deviceKind(device: ResultDevice): DeviceKind {
  const q = device.quantity.trim().toUpperCase();
  if (q === 'THERMOCOUPLE') return 'thermocouple';
  if (
    [
      'WALL TEMPERATURE',
      'INSIDE WALL TEMPERATURE',
      'BACK WALL TEMPERATURE',
      'ADIABATIC SURFACE TEMPERATURE',
    ].includes(q)
  )
    return 'surface';
  if (q.includes('HEAT FLUX') || q === 'RADIOMETER') return 'flux';
  return 'other'; // A numerical gas-temperature probe is not necessarily a thermocouple.
}

export interface DeviceDisplay {
  visible: boolean;
  kinds: Set<DeviceKind>;
  labels: boolean;
  direction: boolean;
}
export interface DeviceSite {
  position: XYZ;
  devices: ResultDevice[];
}
/** Only exact source-coordinate matches are grouped. Never move or round probes. */
export function deviceSites(devices: ResultDevice[], display: DeviceDisplay): DeviceSite[] {
  const sites = new Map<string, DeviceSite>();
  if (!display.visible) return [];
  for (const device of devices) {
    if (!display.kinds.has(deviceKind(device))) continue;
    const key = device.position.join(',');
    if (!sites.has(key)) sites.set(key, { position: device.position, devices: [] });
    sites.get(key)!.devices.push(device);
  }
  return [...sites.values()];
}

/** A missing or ambiguous CSV column must never borrow another probe's reading. */
export function deviceHistory(device: ResultDevice, series: ResultSeries[]): ResultSeries | undefined {
  const matches = series.filter((s) => s.name === device.id);
  return matches.length === 1 ? matches[0] : undefined;
}

export interface ProjectedSite {
  site: DeviceSite;
  x: number;
  y: number;
}
/** Include nearby projected sites too: depth and dense layouts can overlap on screen. */
export function pickDevices(sites: ProjectedSite[], x: number, y: number): ResultDevice[] {
  return sites
    .map((site) => ({ site, distance: Math.hypot(site.x - x, site.y - y) }))
    .filter((hit) => hit.distance <= 12)
    .sort((a, b) => a.distance - b.distance)
    .flatMap((hit) => hit.site.site.devices);
}
