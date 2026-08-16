/**
 * Heskestad plume correlations. Mirror of python/fireplan/correlations.py --
 * keep the two in step. HRR in kW, lengths in m. CONVENTIONS.md section 5.
 */

export const DEFAULT_PLUME_HALF_ANGLE_RAD = (15 * Math.PI) / 180;

/** Diameter of the circle with the same burning area. */
export function effectiveDiameterM(areaM2: number): number {
  return Math.sqrt((4 * areaM2) / Math.PI);
}

/**
 * Mean flame height: L_f = 0.235 Q^(2/5) - 1.02 D.
 *
 * 'Mean' is the height the intermittent tip exceeds half the time, not a maximum.
 * Clamped at zero, since a negative flame height is not meaningful.
 */
export function flameHeightM(hrrKw: number, diameterM: number): number {
  return Math.max(0, 0.235 * Math.pow(hrrKw, 0.4) - 1.02 * diameterM);
}

/**
 * Virtual origin: z0 = 0.083 Q^(2/5) - 1.02 D.
 *
 * Routinely negative for larger pools. Deliberately not clamped -- clamping would
 * distort the plume cone.
 */
export function virtualOriginM(hrrKw: number, diameterM: number): number {
  return 0.083 * Math.pow(hrrKw, 0.4) - 1.02 * diameterM;
}

/** Plume radius at `heightM` above the fuel surface. */
export function plumeRadiusM(
  heightM: number,
  hrrKw: number,
  diameterM: number,
  halfAngleRad = DEFAULT_PLUME_HALF_ANGLE_RAD,
): number {
  return Math.max(0, Math.tan(halfAngleRad) * (heightM - virtualOriginM(hrrKw, diameterM)));
}
