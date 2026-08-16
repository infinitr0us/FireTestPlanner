/**
 * TypeScript mirror of schema/fire-test-plan-1.0.0.schema.json.
 *
 * The schema is normative; this file exists so the editor gets completion and
 * type errors. When they disagree, the schema wins.
 */

export const FORMAT = 'fire-test-plan';
export const FORMAT_VERSION = '1.0.0';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Unit quaternion, XYZW (Three.js ordering). */
export type Quat = [number, number, number, number];

export type Modality = 'RGB' | 'LWIR' | 'MWIR' | 'SWIR' | 'NIR' | 'other';
export type IntrinsicsSource = 'nominal' | 'datasheet' | 'calibrated';
export type FootprintShape = 'circle' | 'square' | 'rectangle';
export type MountType = 'tripod' | 'pole' | 'ceiling' | 'wall' | 'handheld' | 'other';

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
  focalLength_mm: number;
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
  /** Reserved for the post-test record. Must be null in format 1.0. */
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
  fire?: { fuel?: string | null; hrr_kw?: number | null; hrrCurve?: null };
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

export const KNOWN_TYPES = ['camera', 'burner', 'hood', 'wall', 'ceiling'] as const;
export const isKnownType = (t: string): boolean =>
  (KNOWN_TYPES as readonly string[]).includes(t);
