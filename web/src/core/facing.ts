/** A gauge's facing as a crew sets it: the plan axis it looks along, how far it is
 *  turned off that axis in plan, and its tilt ("toward -X, 6° down"). A unit normal
 *  is exact but nobody can mount a gauge from (-0.995, 0.000, -0.104). */
export function facingText(n: readonly number[]): string {
  const tilt = Math.round(Math.asin(Math.max(-1, Math.min(1, n[2]))) * 180 / Math.PI);
  if (Math.abs(tilt) >= 89) return tilt > 0 ? 'straight up' : 'straight down';
  const name = (deg: number): string =>
    ({ 0: '+X', 90: '+Y', 180: '-X', 270: '-Y' } as Record<number, string>)[((deg % 360) + 360) % 360];
  const bearing = Math.atan2(n[1], n[0]) * 180 / Math.PI;
  const axis = Math.round(bearing / 90) * 90;
  const off = Math.round(bearing - axis);
  return `toward ${name(axis)}`
    + (off !== 0 ? `, ${Math.abs(off)}° toward ${name(axis + Math.sign(off) * 90)}` : '')
    + (tilt !== 0 ? `, ${Math.abs(tilt)}° ${tilt > 0 ? 'up' : 'down'}` : '');
}

