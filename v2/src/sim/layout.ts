/**
 * TrackLayout: everything that describes a track, as plain serialisable data.
 *
 * This is the contract between track generation (src/trackgen) and the
 * simulation. The generator writes layouts; the runtime Track (track.ts)
 * reads them; physics, drivers, race control and the renderer only ever see
 * features of the layout, never the parameters that produced it. A new kind
 * of track is a new generator, not a change to the sim.
 *
 * Coordinates: world metres, y up. Track frame (s, d): s = distance along the
 * centerline from the start/finish line, d = lateral offset, positive to the
 * LEFT of travel. "Signed s" means s relative to the line, in (-L/2, L/2].
 * Ranges ([s0, s1], signed, s1 > s0) may run past L/2 to wrap round the lap;
 * a null range means the whole lap.
 */

export const LAYOUT_VERSION = 1;

export type Surface = 'track' | 'apron' | 'pit' | 'garage' | 'road' | 'grass';

/** [s0, s1] in signed s (s1 > s0, may exceed L/2 to wrap), or null for the whole lap. */
export type SRange = [number, number] | null;

/**
 * A value that varies along the lap: keyframes [signed s, value], sorted by s,
 * interpolated between neighbours (wrapping round the lap past the last key).
 * 'smooth' eases each segment (zero slope at the keys); 'linear' doesn't.
 */
export interface Profile {
  keys: Array<[number, number]>;
  ease: 'linear' | 'smooth';
}

/** A lateral position that is either constant or varies along the lap. */
export type Edge = number | Profile;

/** A rectangle in track coordinates (only a true rectangle on straights). */
export interface TrackRect {
  s0: number;
  s1: number;
  d0: number;
  d1: number;
}

// ---------- centerline ----------

/**
 * Centerline as a curvature profile: sections of [length, curvature at start,
 * curvature at end], curvature varying linearly within each (straights,
 * clothoid easements, arcs). Integrated into a closed loop starting at the
 * start/finish line. Future kinds (e.g. a spline through control points for
 * road courses) join this union.
 */
export interface CurvatureCenterline {
  kind: 'curvature';
  sections: Array<[number, number, number]>;
}
export type CenterlineSpec = CurvatureCenterline;

// ---------- cross-section ----------

export interface CrossSection {
  /**
   * Inside and outside edges of the racing surface (d: inside > outside).
   * Constant, or varying along the lap: a track can widen through the turns,
   * narrow into a chicane, or widen on one side only.
   */
  edgeIn: Edge;
  edgeOut: Edge;
  /** Paved strip inside the racing surface where nothing wider (pit road) is laid (m). */
  apronWidth: number;
  /** Inner edge of the pavement: apron, widened into pit road where there is one. */
  pavedInner: Edge;
  /** Banking (rad) at the inside and outside edge of the racing surface; linear across it. */
  bankInner: Profile;
  bankOuter: Profile;
  /** Banking (rad) inside the racing surface: apron, pit road, infield. */
  bankInfield: Profile;
}

// ---------- surfaces ----------

/**
 * Where a surface is. A band spans d0 < d <= d1 over an s range; openOut /
 * openIn extend it beyond d0 (toward the outside) or beyond d1 (toward the
 * infield) for physics, while the edge still bounds what is drawn. A rect is
 * a TrackRect; a path is a world-space polyline with a width (roads).
 */
export type SurfaceShape =
  | { kind: 'band'; range: SRange; d0: Edge; d1: Edge; openOut?: boolean; openIn?: boolean }
  | { kind: 'rect'; rect: TrackRect }
  | { kind: 'path'; points: Array<[number, number]>; width: number };

export interface SurfaceRegion {
  id: string;
  surface: Surface;
  shape: SurfaceShape;
  /** Draw a quiet edge line round it. */
  outline?: boolean;
  /** Visual treatment, e.g. mowing stripes on grass. */
  pattern?: 'mowing';
}

// ---------- barriers ----------

/**
 * A barrier along the track, centred on d (which can follow a profile, e.g.
 * the outside edge of a track that widens in the turns). 'in' walls keep cars
 * on their +d side (the outer wall), 'out' walls on their -d side, 'both' are
 * solid either way (the pit wall). Capped walls have solid ends a car can hit
 * nose-first.
 */
export interface Wall {
  id: string;
  range: SRange;
  d: Edge;
  thickness: number;
  faces: 'in' | 'out' | 'both';
  caps: boolean;
  /** Visual style: attenuators on the caps. */
  attenuators?: boolean;
}

// ---------- pit lane ----------

/**
 * Pit lane along a straight, on the infield side. All s are signed.
 *   entryStart  paved taper leaves the apron
 *   wallStart   pit wall (and pit road proper) begins
 *   wallEnd     pit wall ends
 *   exitEnd     taper back down to the apron is complete
 *   blendEnd    end of the blend line: cars must stay below it until here
 */
export interface PitLane {
  entryStart: number;
  wallStart: number;
  wallEnd: number;
  exitEnd: number;
  blendEnd: number;
  /** Centre of the pit wall, and its thickness. */
  wallD: number;
  wallThickness: number;
  /** Inner edge of pit road. */
  roadD: number;
  /** Signed s of each pit box, in order along pit road. */
  stalls: number[];
  stallSpacing: number;
  /** Line between the pit wall's fast lane and the boxes. */
  laneD: number;
}

// ---------- infield ----------

export interface Garage {
  lot: TrackRect;
  /** World positions where retired cars are parked, in fill order. */
  parking: Array<[number, number]>;
}

/** A road from the racing surface into the infield (exit for cars in trouble, tow route). */
export interface EscapeLane {
  /** World-space polyline: first point on the track side, last at the garage. */
  points: Array<[number, number]>;
  width: number;
}

export interface Infield {
  garage: Garage;
  escapeLanes: EscapeLane[];
}

// ---------- paint and decoration ----------

export type LineStyle = 'edge' | 'blend' | 'entry' | 'lane' | 'stall' | 'start';

export type Marking =
  /** A line along the track at lateral position d over an s range. */
  | { kind: 'line'; range: SRange; d: Edge; style: LineStyle }
  /** Short lines across the track at each s, from d0 to d1 (pit stalls, start/finish). */
  | { kind: 'ticks'; s: number[]; d0: number; d1: number; style: LineStyle };

/** Purely visual dressing. Add a kind here and a painter in the renderer. */
export type Decoration =
  | { kind: 'building'; rect: TrackRect };

// ---------- the layout ----------

export interface TrackLayout {
  version: number;
  /** Stable identity (preset name, or type + seed). */
  id: string;
  name: string;
  /** Generator that made it, the seed, and the parameters it chose. */
  type: string;
  seed: number;
  params: Record<string, unknown>;
  centerline: CenterlineSpec;
  crossSection: CrossSection;
  /** Surface regions, bottom to top: later regions win where they overlap. */
  surfaces: SurfaceRegion[];
  /** Surface anywhere no region covers. */
  ground: Surface;
  walls: Wall[];
  pit: PitLane;
  infield: Infield;
  markings: Marking[];
  decor: Decoration[];
  /** Generator notes, e.g. validation warnings it accepted. */
  notes: string[];
}

// ---------- evaluation helpers ----------

export function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Value of a profile at signed s r, on a lap of length L. */
export function evalProfile(p: Profile, r: number, L: number): number {
  const k = p.keys;
  if (k.length === 1) return k[0][1];
  // Find the segment containing r, wrapping from the last key round to the first.
  let i = k.length - 1;
  for (let j = 0; j < k.length; j++) {
    if (k[j][0] > r) { i = j - 1; break; }
  }
  let a: [number, number], b: [number, number];
  if (i < 0) { a = [k[k.length - 1][0] - L, k[k.length - 1][1]]; b = k[0]; }
  else if (i === k.length - 1) { a = k[i]; b = [k[0][0] + L, k[0][1]]; }
  else { a = k[i]; b = k[i + 1]; }
  if (a[1] === b[1]) return a[1];
  const t = (r - a[0]) / (b[0] - a[0]);
  return a[1] + (b[1] - a[1]) * (p.ease === 'smooth' ? smoothstep(t) : t);
}

export function evalEdge(e: Edge, r: number, L: number): number {
  return typeof e === 'number' ? e : evalProfile(e, r, L);
}

/** A constant profile. */
export const flat = (value: number): Profile => ({ keys: [[0, value]], ease: 'linear' });

/** An edge moved sideways by a constant. */
export function shiftEdge(e: Edge, by: number): Edge {
  return typeof e === 'number' ? e + by : { ...e, keys: e.keys.map(([s, v]) => [s, v + by]) };
}
