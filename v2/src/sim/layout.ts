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

/**
 * What a car drives on. Ovals: track, apron, pit, garage, road, grass. Road
 * circuits add kerbs (the painted strips at the edge, a little bumpy),
 * asphalt run-off beyond the track limits, and gravel traps.
 */
export type Surface = 'track' | 'apron' | 'pit' | 'garage' | 'road' | 'grass' | 'kerb' | 'runoff' | 'gravel';

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
  | { kind: 'path'; points: Array<[number, number]>; width: number }
  /** World-space area: rings even-odd, so a ring inside another is a hole (an infield's pavement and its grass islands). */
  | { kind: 'polygon'; rings: Array<Array<[number, number]>> };

export interface SurfaceRegion {
  id: string;
  surface: Surface;
  shape: SurfaceShape;
  /** Draw a quiet edge line round it. */
  outline?: boolean;
  /**
   * Visual treatment: mowing stripes on grass, painted stripes on paved
   * run-off, a plain white tapering end on a kerb.
   */
  pattern?: 'mowing' | 'painted' | 'kerbEnd';
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

export interface Barrier {
  id: string;
  points: Array<[number, number]>;
  thickness: number;
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
  /**
   * The way in and out as lateral positions along the lap (keys in signed
   * s): from the entry to pit road's fast lane, and from the fast lane past
   * the wall's end back to the apron. Where pit road is set back from the
   * track these follow the paved lanes across the grass between; cars, the
   * pace car and drivers' pit routes all follow them. Default (both absent):
   * straight runs from the apron to the fast lane and back (ai/pitting.ts).
   */
  entryRoute?: Profile;
  exitRoute?: Profile;
  /**
   * How much further in the whole pit complex (wall, road, lanes, boxes)
   * stands at each s than wallD, roadD and laneD say: pit road on a straight
   * chord across a bent front stretch (a tri-oval's, as at Daytona) curves
   * away from the centerline and back. Default 0 everywhere.
   */
  offset?: Profile;
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
  /** Every road off the racing surface, as a graph (default: pit road and the escape lanes; see sim/roads.ts). */
  network?: RoadNetwork;
  /** Road courses on this oval (trackgen/roval.ts). */
  rovals?: RovalSpec[];
}

/**
 * A road course on an oval: the oval from `join` round to `leave` (signed s
 * on the oval's lap), then its own course through the infield (curvature
 * sections from the oval at `leave` back onto it at `join`), laid out as a
 * circuit (trackgen/roval.ts).
 */
export interface RovalSpec {
  id: string;
  name: string;
  join: number;
  leave: number;
  sections: Array<[number, number, number]>;
  width: number;
  /** Grass between the track edge and the barrier on its straights (m). */
  verge: number;
  character: string;
  /** Per corner of its own course, in order: what its run-off is, an apex barrier, no run-off. */
  corners: Array<{ runoff: 'gravel' | 'runoff'; apexWall: boolean; bare: boolean }>;
  /**
   * Where it pits: on the oval's pit road (its part of the oval takes in the
   * front stretch), or a pit lane of its own on one of its straights (`at`
   * metres into its course, the straight's middle, `main` long).
   */
  pit: 'oval' | { at: number; main: number };
}

// ---------- road network ----------

/**
 * What a road is for. escape: off the oval for cars in trouble and the
 * wreckers; service: the infield's own roads; pit: pit road and its entry and
 * exit; garage: into and round the garage lots; course: wide and smooth
 * enough to race a road course on (it can serve as any of the others too).
 */
export type RoadGrade = 'escape' | 'service' | 'pit' | 'garage' | 'course';

/**
 * Where roads meet. apron: where a road leaves (or joins) the oval, at track
 * position s (signed); garage: in a garage lot, where a towed car is taken;
 * junction: anywhere else.
 */
export interface RoadNode {
  id: string;
  kind: 'apron' | 'junction' | 'garage';
  at: [number, number];
  s?: number;
}

export interface Road {
  id: string;
  from: string;
  to: string;
  /** World polyline from `from`'s position to `to`'s, ends included. */
  points: Array<[number, number]>;
  width: number;
  grade: RoadGrade;
  /** Only from `from` to `to` (pit road's entry and exit, say). */
  oneWay?: boolean;
}

/**
 * The infield's roads as a graph: escape roads, pit road, service roads, the
 * garage lanes, and (later) course roads that double as road-course sections.
 * Wreckers find their way to the garage along it; the pace car and road
 * layouts will too. World positions, in the layout's frame.
 */
export interface RoadNetwork {
  nodes: RoadNode[];
  roads: Road[];
  /**
   * Paved areas vehicles drive across directly (an infield's pavement, its
   * holes the grass): any two nodes on the same one are joined, straight
   * across, where that line stays on it.
   */
  areas?: Array<{ id: string; rings: Array<Array<[number, number]>> }>;
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
  | { kind: 'building'; rect: TrackRect }
  /** A parking lot's painted bays: two rows, lines across every `spacing` metres along it, an aisle between. */
  | { kind: 'bays'; rect: TrackRect; spacing: number };

// ---------- the layout ----------

/**
 * What kind of racing a layout is for. A series races on some kinds (see
 * rules/series.ts), and drivers bring their road-course skill to road layouts.
 */
export type LayoutKind = 'superspeedway' | 'speedway' | 'short-oval' | 'dirt-oval' | 'road';

/**
 * Where a track sits in its venue: the centerline (integrated, then centred
 * on the origin) turned by `angle` (rad) about the origin and moved by
 * (x, y). Every world position in the layout is in this placed frame.
 */
export interface Placement {
  x: number;
  y: number;
  angle: number;
}

export interface TrackLayout {
  version: number;
  /** Stable identity (preset name, or type + seed). */
  id: string;
  name: string;
  /** Generator that made it, the seed, and the parameters it chose. */
  type: string;
  seed: number;
  params: Record<string, unknown>;
  /** What kind of racing it's for (default: from its type, size class or length; see layoutKind). */
  kind?: LayoutKind;
  /** Where it sits in its venue's frame (default: centred on the origin, unturned). */
  placement?: Placement;
  /**
   * The venue's other tracks, in the same frame: scenery for this one. Their
   * surfaces can be driven on (flat: their banking isn't modelled here) and
   * their walls are solid, but nothing about them is raced. They have no
   * neighbours of their own.
   */
  neighbours?: TrackLayout[];
  centerline: CenterlineSpec;
  crossSection: CrossSection;
  /** Surface regions, bottom to top: later regions win where they overlap. */
  surfaces: SurfaceRegion[];
  /** Surface anywhere no region covers. */
  ground: Surface;
  walls: Wall[];
  /**
   * Barriers laid in the world rather than along the track: a polyline,
   * solid from both sides. A road layout closes the oval's lanes it doesn't
   * use with these (a concrete wall across the track).
   */
  barriers?: Barrier[];
  pit: PitLane;
  infield: Infield;
  markings: Marking[];
  decor: Decoration[];
  /** Generator notes, e.g. validation warnings it accepted. */
  notes: string[];
}

/**
 * A layout's kind: as it says, or a road course for a circuit, and for an
 * oval its size class (or, for a preset, its length: short ovals under
 * 1.3 km, superspeedways over 3.3 km).
 */
export function layoutKind(layout: TrackLayout): LayoutKind {
  if (layout.kind) return layout.kind;
  if (layout.type === 'circuit') return 'road';
  const variant = layout.params.variant;
  if (variant === 'superspeedway') return 'superspeedway';
  if (variant === 'short') return 'short-oval';
  if (variant) return 'speedway';
  const length = layout.centerline.sections.reduce((a, s) => a + s[0], 0);
  return length < 1300 ? 'short-oval' : length > 3300 ? 'superspeedway' : 'speedway';
}

// ---------- evaluation helpers ----------

export function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Value of a profile at signed s r, on a lap of length L (an s outside (-L/2, L/2] is wrapped onto it). */
export function evalProfile(p: Profile, r: number, L: number): number {
  const k = p.keys;
  if (k.length === 1) return k[0][1];
  if (r > L / 2 || r <= -L / 2) {
    r = ((r % L) + L) % L;
    if (r > L / 2) r -= L;
  }
  // Find the segment containing r (the last key at or before it), wrapping from the last key round to the first:
  // a scan for a few keys, a binary search for many (road circuits' barriers).
  let i = k.length - 1;
  if (k.length <= 16) {
    for (let j = 0; j < k.length; j++) {
      if (k[j][0] > r) { i = j - 1; break; }
    }
  } else {
    let lo = 0, hi = k.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (k[mid][0] > r) hi = mid; else lo = mid + 1;
    }
    i = lo - 1;
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
/**
 * Where pit road's fast lane runs, from the wall's centre: 3 m off its face,
 * and 1.5 m more on a chord (pit road curving away from the track and back,
 * where a car following it cuts in a little toward the wall's ends).
 */
export function fastLaneGap(wallThickness: number, chord: boolean): number {
  return wallThickness / 2 + 3 + (chord ? 1.5 : 0);
}

export function shiftEdge(e: Edge, by: number): Edge {
  return typeof e === 'number' ? e + by : { ...e, keys: e.keys.map(([s, v]) => [s, v + by]) };
}
