/**
 * Heskestad plume correlations. Mirror of python/fireplan/correlations.py --
 * keep the two in step. HRR in kW, lengths in m. CONVENTIONS.md section 5.
 */

export const DEFAULT_PLUME_HALF_ANGLE_RAD = (15 * Math.PI) / 180;

/** Radiated fraction of the heat release when the burner does not say. Fuel
 *  dependent -- roughly 0.35 heptane, 0.2 methanol -- hence the override. */
export const DEFAULT_RADIATIVE_FRACTION = 0.3;

/**
 * Point-source radiation: q" = X_r * Q * cos(theta) / (4 pi r^2), in kW/m2.
 *
 * The whole fire is collapsed to one isotropic emitter at mid-flame height. That
 * is the standard first-order estimate and it is what a gauge placement is sized
 * with, but it only holds in the far field -- see `POINT_SOURCE_MIN_DIAMETERS`.
 *
 * `cosTheta` is the angle between the gauge's outward normal and the line to the
 * fire. A gauge facing away receives nothing, and is reported as nothing rather
 * than as a negative flux.
 */
export function pointSourceFluxKwM2(
  hrrKw: number,
  distanceM: number,
  cosTheta = 1,
  radiativeFraction = DEFAULT_RADIATIVE_FRACTION,
): number {
  if (hrrKw <= 0 || distanceM <= 0) return 0;
  if (cosTheta <= 0) return 0;
  return (radiativeFraction * hrrKw * cosTheta) / (4 * Math.PI * distanceM * distanceM);
}

/**
 * How many effective diameters away the point-source model starts to be believable.
 *
 * Closer than this the fire is plainly not a point and the estimate is only an
 * order of magnitude, so the UI says so rather than printing two decimal places
 * and letting someone size a gauge on them.
 */
export const POINT_SOURCE_MIN_DIAMETERS = 2;

/**
 * Heskestad plume centreline temperature rise above ambient, in kelvin.
 *
 *     dT = 25.0 * Qc^(2/3) * (z - z0)^(-5/3)
 *
 * where `Qc` is the CONVECTIVE heat release, taken as the part not radiated away.
 * The 25.0 is not a fitted constant: it is 9.1 * (T_inf / (g cp^2 rho_inf^2))^(1/3)
 * evaluated for air at 20 C.
 *
 * Valid in the plume only -- above the mean flame tip, on the axis. Callers must
 * check that themselves; this returns a number for any `z` above the virtual
 * origin, and it would be a badly wrong number inside the flame.
 */
export function plumeCentrelineRiseK(
  heightM: number,
  hrrKw: number,
  diameterM: number,
  radiativeFraction = DEFAULT_RADIATIVE_FRACTION,
): number | null {
  const above = heightM - virtualOriginM(hrrKw, diameterM);
  if (hrrKw <= 0 || above <= 0) return null;
  const convectiveKw = Math.max(0, 1 - radiativeFraction) * hrrKw;
  if (convectiveKw <= 0) return null;
  return 25.0 * Math.pow(convectiveKw, 2 / 3) * Math.pow(above, -5 / 3);
}

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
 * The heat release rate whose Heskestad mean flame height is `flameHeightM`:
 * Q = ((L_f + 1.02 D) / 0.235)^(5/2), the exact inverse of `flameHeightM` for a
 * positive height. What typing a flame height stores, the way typing a field of
 * view stores a focal length. Null for a height or diameter that is not positive.
 */
export function hrrForFlameHeightKw(flameHeight: number, diameterM: number): number | null {
  if (!(flameHeight > 0) || !(diameterM > 0)) return null;
  return Math.pow((flameHeight + 1.02 * diameterM) / 0.235, 2.5);
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
