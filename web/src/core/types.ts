/**
 * TypeScript mirror of the schemas in schema/, newest first.
 *
 * The schema is normative; this file exists so the editor gets completion and
 * type errors. When they disagree, the schema wins. Fields added after 1.0 are
 * marked, because whether one is present is what decides the version a file
 * declares -- see `requiredFormatVersion` at the foot of this module.
 */

export const FORMAT = 'fire-test-plan';

/**
 * Format versions this build understands, oldest first.
 *
 * A plan declares the LOWEST version that describes its own contents, not the
 * newest this build can write -- see `requiredFormatVersion`. So `FORMAT_VERSION`
 * is the floor a new plan starts at, and `FORMAT_VERSION_LATEST` is the ceiling.
 */
export const FORMAT_VERSIONS = ['1.0.0', '1.1.0', '1.2.0'] as const;
export const FORMAT_VERSION = '1.0.0';
export const FORMAT_VERSION_LATEST = '1.2.0';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Unit quaternion, XYZW (Three.js ordering). */
export type Quat = [number, number, number, number];

export type Modality = 'RGB' | 'LWIR' | 'MWIR' | 'SWIR' | 'NIR' | 'other';
export type IntrinsicsSource = 'nominal' | 'datasheet' | 'calibrated';
export type FootprintShape = 'circle' | 'square' | 'rectangle';
export type MountType = 'tripod' | 'pole' | 'ceiling' | 'wall' | 'handheld' | 'other';
/** Instruments can sit on the floor; a camera in format 1.0 could not say so. */
export type InstrumentMountType = MountType | 'floor';
export type GaugeKind = 'schmidt-boelter' | 'gardon' | 'thermopile' | 'other';
export type TcType = 'K' | 'J' | 'T' | 'E' | 'N' | 'R' | 'S' | 'B';

export interface Transform {
  position_m: Vec3;
  /** Object-to-world, in the stored OpenGL-style local frame: looks down local -Z. */
  rotation_quat?: Quat;
  /** Authoring intent. Advisory -- rotation_quat is authoritative. */
  aimTarget_m?: Vec3 | null;
}

export interface Display {
  color?: string | null;
  visible?: boolean;
  locked?: boolean;
}

export interface BaseObject {
  id: string;
  type: string;
  name?: string | null;
  transform?: Transform;
  display?: Display;
  notes?: string | null;
}

export interface CameraSpec {
  modality: Modality;
  presetId?: string | null;
  resolution_px: [number, number];
  /** With focalLength_mm this is the authoritative pair. FOV is derived, never stored. */
  sensor_mm: Vec2;
  /** The lens. Never scaled by zoomFactor -- a 25 mm lens stays 25 mm. */
  focalLength_mm: number;
  /** Format 1.1. Multiplier on the effective focal length; absent means 1. */
  zoomFactor?: number | null;
  /** Null means the OpenCV image centre, ((w-1)/2, (h-1)/2). */
  principalPoint_px?: Vec2 | null;
  distortion?: { model: 'opencv'; coefficients: number[] } | null;
  intrinsicsSource?: IntrinsicsSource;
  spectralBand_um?: Vec2 | null;
  framerate_hz?: number | null;
}

export interface CameraObject extends BaseObject {
  type: 'camera';
  camera: CameraSpec;
  mount?: { type?: MountType; height_m?: number | null };
  /** Reserved for the post-test record. Must be null throughout format 1.x. */
  recording?: null;
}

export interface Footprint {
  shape: FootprintShape;
  diameter_m?: number | null;
  size_m?: Vec2 | null;
}

export interface BurnerObject extends BaseObject {
  type: 'burner';
  footprint: Footprint;
  rimHeight_m?: number | null;
  fire?: {
    fuel?: string | null;
    hrr_kw?: number | null;
    /** Format 1.1. Radiated fraction of the HRR; absent means 0.3. */
    radiativeFraction?: number | null;
    hrrCurve?: null;
  };
}

export interface HoodObject extends BaseObject {
  type: 'hood';
  opening_m: Vec2;
  height_m: number;
  skirtDepth_m?: number | null;
  duct?: { diameter_m: number; length_m?: number | null } | null;
}

export interface WallOpening {
  id?: string | null;
  offset_m: number;
  width_m: number;
  height_m: number;
  sillHeight_m?: number | null;
}

export interface WallObject extends BaseObject {
  type: 'wall';
  polyline_m: Vec2[];
  height_m: number;
  thickness_m?: number | null;
  baseHeight_m?: number | null;
  openings?: WallOpening[];
}

export interface CeilingObject extends BaseObject {
  type: 'ceiling';
  /** Plan-view outline in world XY. Assumed closed; the first point is not repeated. */
  polygon_m: Vec2[];
  /** Height of the UNDERSIDE above the floor — the surface a flame impinges on. */
  height_m: number;
  thickness_m?: number | null;
}

export interface InstrumentMount {
  type?: InstrumentMountType;
  height_m?: number | null;
}

/**
 * A heat flux gauge. Format 1.1.
 *
 * Directional, and it borrows the camera frame to say so: the sensing face looks
 * down local -Z, so `rotation_quat` is its outward normal and `aimTarget_m` records
 * what it was pointed at. One frame, one look-at helper, one aim-mismatch check.
 */
export interface HeatFluxSensorObject extends BaseObject {
  type: 'heatFluxSensor';
  gauge?: {
    kind?: GaugeKind;
    range_kw_m2?: number | null;
    /** Full acceptance angle of the face. 180° is an unrestricted hemisphere. */
    viewAngle_deg?: number | null;
    waterCooled?: boolean | null;
    serial?: string | null;
  };
  mount?: InstrumentMount;
}

/**
 * One thermocouple, or a rake of them on a common support. Format 1.1.
 *
 * A single bead is the one-element case of a tree, so both are this one type and
 * there is no second thing to keep in step.
 */
export interface ThermocoupleObject extends BaseObject {
  type: 'thermocouple';
  /** Bead positions along the object's LOCAL +Z, from its origin. `[0]` is a point TC. */
  beadOffsets_m?: number[];
  thermocouple?: {
    tcType?: TcType;
    beadDiameter_mm?: number | null;
    sheathed?: boolean | null;
    maxTemperature_C?: number | null;
  };
  mount?: InstrumentMount;
}

/**
 * A rectangular solid: the furniture, equipment and blockwork that is neither a wall
 * nor a slab. Format 1.2.
 *
 * Deliberately a box and nothing more. This format targets open bays and simple
 * enclosures, and an obstruction exists so that what stands between a camera or a
 * gauge and the fire is visible in the plan -- not so the room can be modelled.
 */
export interface ObstructionObject extends BaseObject {
  type: 'obstruction';
  /**
   * Extent along the object's LOCAL x, y and z. The origin is the CENTRE OF THE
   * BASE, so the box spans [-x/2, +x/2] and [-y/2, +y/2] and rises from 0 to z.
   *
   * Unlike a wall's `baseHeight_m`, the height above the floor is simply the
   * transform's z: a box has an origin to put it in, a polyline does not. It also
   * makes the rotate gizmo do the obvious thing -- yaw about the box's own axis.
   */
  size_m: Vec3;
}

/** Any type this build does not know. Held so it survives a load/save cycle. */
export interface UnknownObject extends BaseObject {
  [key: string]: unknown;
}

export type PlanObject =
  | CameraObject
  | BurnerObject
  | HoodObject
  | WallObject
  | CeilingObject
  | HeatFluxSensorObject
  | ThermocoupleObject
  | ObstructionObject
  | UnknownObject;

export interface PlanMeta {
  title?: string;
  testId?: string | null;
  author?: string | null;
  organization?: string | null;
  siteName?: string | null;
  created?: string | null;
  modified?: string | null;
  revision?: string | null;
  notes?: string | null;
  /**
   * Where a converted plan came from. Format 1.2 documents it, but it is NOT
   * version-bumping: `meta` is open in every 1.x schema, so a plan imported from FDS
   * that uses no 1.1 or 1.2 features still declares the version its contents need.
   */
  source?: PlanSource | null;
}

export interface PlanSource {
  /** The tool the plan was converted from, e.g. "FDS". */
  tool?: string;
  /** Name of the source file, for the human reading the plan. Not a path to resolve. */
  file?: string | null;
  /** FDS job identifier from `&HEAD`, when the source was an FDS input file. */
  chid?: string | null;
  importedAt?: string | null;
  /**
   * Position of the PLAN origin in the source tool's coordinates, so
   * `source_xyz = plan_xyz + originOffset_m`.
   *
   * This format's origin is the burner centre at floor level and a source file's is
   * arbitrary, so an import always re-origins; keeping the offset is what lets the
   * inspector show the numbers the source file actually contains.
   */
  originOffset_m?: Vec3;
}

export interface PlanDocument {
  format: typeof FORMAT;
  version: string;
  meta?: PlanMeta;
  units: {
    length: 'm';
    angle: 'rad';
    power: 'kW';
    temperature: 'C';
    display?: { length?: LengthUnit; angle?: 'deg' | 'rad' };
  };
  coordinateSystem: {
    convention: 'Z-up-right-handed';
    origin: 'burner-center-floor';
    northAzimuth_rad?: number | null;
  };
  environment?: {
    floorSize_m?: Vec2;
    ceilingHeight_m?: number | null;
    ambientTemperature_C?: number | null;
    notes?: string | null;
  };
  objects: PlanObject[];
}

export type LengthUnit = 'm' | 'cm' | 'mm' | 'ft' | 'in';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  objectId?: string;
}

// -- narrowing helpers ---------------------------------------------------

export const isCamera = (o: PlanObject): o is CameraObject => o.type === 'camera';
export const isBurner = (o: PlanObject): o is BurnerObject => o.type === 'burner';
export const isHood = (o: PlanObject): o is HoodObject => o.type === 'hood';
export const isWall = (o: PlanObject): o is WallObject => o.type === 'wall';
export const isCeiling = (o: PlanObject): o is CeilingObject => o.type === 'ceiling';
export const isHeatFluxSensor = (o: PlanObject): o is HeatFluxSensorObject =>
  o.type === 'heatFluxSensor';
export const isThermocouple = (o: PlanObject): o is ThermocoupleObject =>
  o.type === 'thermocouple';
export const isObstruction = (o: PlanObject): o is ObstructionObject =>
  o.type === 'obstruction';

/** Objects whose orientation means "what it is pointed at", so they get an aim
 *  target, an aim-at-fire button, and the aim-mismatch check. */
export const isAimable = (o: PlanObject): o is CameraObject | HeatFluxSensorObject =>
  o.type === 'camera' || o.type === 'heatFluxSensor';

/**
 * Objects that stand on their own support rather than on the floor.
 *
 * They carry a `mount` block, a palette drop keeps the height they were created
 * with instead of dropping them to the pick point, and `setPosition` keeps the
 * recorded mount height in step with Z. One predicate, so those three cannot
 * disagree about which objects are instruments on stands.
 */
export const isMounted = (
  o: PlanObject,
): o is CameraObject | HeatFluxSensorObject | ThermocoupleObject =>
  o.type === 'camera' || o.type === 'heatFluxSensor' || o.type === 'thermocouple';

export const KNOWN_TYPES = [
  'camera', 'burner', 'hood', 'wall', 'ceiling', 'heatFluxSensor', 'thermocouple',
  'obstruction',
] as const;
export const isKnownType = (t: string): boolean =>
  (KNOWN_TYPES as readonly string[]).includes(t);

/** Object types introduced after format 1.0, and therefore version-bumping. */
const TYPES_1_1: readonly string[] = ['heatFluxSensor', 'thermocouple'];
/** And after 1.1. `meta.source` is deliberately in neither list: `meta` is open in
 *  every 1.x schema, so a plan imported from FDS that holds nothing past 1.0 keeps
 *  declaring 1.0.0. Provenance is not a feature a reader must understand to read
 *  the file correctly. */
const TYPES_1_2: readonly string[] = ['obstruction'];

const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
};

export const maxVersion = (a: string, b: string): string =>
  compareVersions(a, b) >= 0 ? a : b;

/**
 * The lowest format version that can describe this document.
 *
 * A plan that uses nothing beyond 1.0 keeps saying "1.0.0", so it still opens --
 * and still validates -- in a build that predates 1.1. The moment it grows a
 * zoom factor, a radiative fraction or a sensor, it says 1.1.0 and means it.
 * Mirror of `required_version` in python/fireplan/serialize.py.
 */
export function requiredFormatVersion(doc: PlanDocument): string {
  let needed = '1.0.0';
  for (const o of doc.objects ?? []) {
    // The highest tier there is; nothing later in the list can raise it further.
    if (TYPES_1_2.includes(o.type)) return '1.2.0';
    if (TYPES_1_1.includes(o.type)) needed = '1.1.0';
    else if (isCamera(o) && o.camera?.zoomFactor != null) needed = '1.1.0';
    else if (isBurner(o) && o.fire?.radiativeFraction != null) needed = '1.1.0';
  }
  return needed;
}
