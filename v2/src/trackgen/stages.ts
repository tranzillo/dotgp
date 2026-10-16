import type { Centerline } from '../sim/centerline';
import {
  shiftEdge, type CenterlineSpec, type Decoration, type Edge, type EscapeLane, type Garage, type Marking, type PitLane, type Profile,
  type SurfaceRegion, type TrackRect, type Wall,
} from '../sim/layout';

/**
 * Shared building blocks for track types. Each stage takes explicit options
 * (where to put things, how big) and returns plain layout data; the track
 * type decides placement and composes them. New features (grandstands,
 * crossover tunnels, care centre, more escape lanes) are new stages here.
 */

// ---------- centerline analysis ----------

/** Straights (zero-curvature runs) of a curvature centerline, as signed ranges in lap order from the line. */
export function straightsOf(spec: CenterlineSpec): Array<[number, number]> {
  const L = spec.sections.reduce((a, s) => a + s[0], 0);
  const runs: Array<[number, number]> = [];
  let acc = 0;
  for (const [len, k0, k1] of spec.sections) {
    if (k0 === 0 && k1 === 0) {
      const last = runs[runs.length - 1];
      if (last && Math.abs(last[1] - acc) < 1e-9) last[1] = acc + len;
      else runs.push([acc, acc + len]);
    }
    acc += len;
  }
  // A straight running through the line (end of the lap + start) is one straight.
  if (runs.length > 1 && runs[0][0] === 0 && Math.abs(runs[runs.length - 1][1] - L) < 1e-9) {
    const tail = runs.pop()!;
    runs[0] = [tail[0] - L, runs[0][1]];
  }
  return runs.map(([a, b]) => (a >= L / 2 ? [a - L, b - L] : [a, b]));
}

/** Section boundaries of a curvature centerline as signed s, with the curvature there. */
function curvatureKeys(spec: CenterlineSpec): Array<[number, number]> {
  const L = spec.sections.reduce((a, s) => a + s[0], 0);
  const signed = (s: number) => (s > L / 2 ? s - L : s);
  const keys = new Map<number, number>();
  let acc = 0;
  for (const [len, k0, k1] of spec.sections) {
    if (!keys.has(signed(acc))) keys.set(signed(acc), k0);
    // A section running from one turn direction into the other (an S): its zero crossing is a key, so
    // values that follow one direction only (widening on the outside) stay exact.
    if (k0 * k1 < 0) keys.set(signed(acc + (len * k0) / (k0 - k1)), 0);
    acc += len;
    keys.set(signed(acc), k1);
  }
  return [...keys].sort((p, q) => p[0] - q[0]);
}

// ---------- cross-section ----------

/**
 * A value that follows curvature: `straight` on the straights, `corner` in
 * the tightest corner, in between through transitions (so clothoid easements
 * change it progressively). Banking, and track width, can both be laid out this way.
 */
export function byCurvature(spec: CenterlineSpec, straight: number, corner: number): Profile {
  const keys = curvatureKeys(spec);
  const kMax = Math.max(...spec.sections.map((s) => Math.max(Math.abs(s[1]), Math.abs(s[2]))));
  return {
    keys: keys.map(([s, k]) => [s, straight + (corner - straight) * (kMax > 0 ? k / kMax : 0)]),
    ease: 'linear',
  };
}

/** Like byCurvature, but only through turns one way: left (+1) or right (-1); zero elsewhere. */
function byTurnsOneWay(spec: CenterlineSpec, way: 1 | -1, straight: number, corner: number): Profile {
  const keys = curvatureKeys(spec);
  const kMax = Math.max(...spec.sections.map((s) => Math.max(Math.abs(s[1]), Math.abs(s[2]))));
  return {
    keys: keys.map(([s, k]) => [s, straight + (corner - straight) * (kMax > 0 ? Math.max(0, way * k) / kMax : 0)]),
    ease: 'linear',
  };
}

/**
 * Racing surface edges for a track of a given width on the straights that
 * widens through the corners, on the outside of each turn (the way ovals
 * usually do): the right edge in left turns, the left edge in right turns.
 * Without widening (or without turns that way) an edge is a plain constant.
 */
export function edgesByCurvature(spec: CenterlineSpec, width: number, cornerWidening: number): { edgeIn: Edge; edgeOut: Edge } {
  const half = width / 2;
  const turns = (way: 1 | -1) => spec.sections.some((s) => way * s[1] > 0 || way * s[2] > 0);
  return {
    edgeIn: cornerWidening > 0 && turns(-1) ? byTurnsOneWay(spec, -1, half, half + cornerWidening) : half,
    edgeOut: cornerWidening > 0 && turns(1) ? byTurnsOneWay(spec, 1, -half, -half - cornerWidening) : -half,
  };
}

export interface CurvatureBanking {
  /** Banking on straights. */
  straight: number;
  /** Banking in the tightest corner at the inside and outside edge of the racing surface. */
  inner: number;
  outer: number;
}

/**
 * Banking that follows curvature: straights get the straight banking, the
 * tightest corner the full corner banking, and the transitions follow the
 * curvature between them (so clothoid easements bank progressively). The
 * paved infield (apron, pit road) is much flatter than the racing surface.
 */
export function bankingByCurvature(spec: CenterlineSpec, b: CurvatureBanking): {
  bankInner: Profile; bankOuter: Profile; bankInfield: Profile;
} {
  const at = (straight: number, corner: number) => byCurvature(spec, straight, corner);
  return {
    bankInner: at(b.straight, b.inner),
    bankOuter: at(b.straight, b.outer),
    bankInfield: at(b.straight * 0.5, b.inner * 0.4),
  };
}

// ---------- pit lane ----------

export interface PitLaneOptions {
  /** Inside edge of the racing surface along the pit straight. */
  innerEdge: number;
  apronWidth: number;
  /** Where the wall (pit road proper) runs, and where the blend line ends (signed s). */
  wallStart: number;
  wallEnd: number;
  blendEnd: number;
  /** Paved taper from the apron to pit road before the wall, and back down after it. */
  entryLength: number;
  exitTaper: number;
  /** Gap between the racing surface and the wall, wall thickness, pit road width. */
  wallGap: number;
  wallThickness: number;
  roadWidth: number;
  stallSpacing: number;
}

/** Pit lane on the infield side, plus the pavement edge it widens. */
export function pitLane(o: PitLaneOptions): { pit: PitLane; pavedInner: Profile } {
  const apronD = o.innerEdge + o.apronWidth;
  const wallD = o.innerEdge + o.wallGap + o.wallThickness / 2;
  const roadD = wallD + o.wallThickness / 2 + o.roadWidth;
  const entryStart = o.wallStart - o.entryLength;
  const exitEnd = o.wallEnd + o.exitTaper;
  // Boxes from 25 m in, spaced along the wall, leaving room to accelerate out of the last.
  const boxes = Math.max(1, Math.floor((o.wallEnd - o.wallStart - 40) / o.stallSpacing));
  const stalls = Array.from({ length: boxes }, (_, k) => o.wallStart + 25 + k * o.stallSpacing);
  return {
    pit: {
      entryStart, wallStart: o.wallStart, wallEnd: o.wallEnd, exitEnd, blendEnd: o.blendEnd,
      wallD, wallThickness: o.wallThickness, roadD, stalls, stallSpacing: o.stallSpacing,
      laneD: wallD + o.wallThickness / 2 + 6,
    },
    pavedInner: {
      keys: [[entryStart, apronD], [o.wallStart, roadD], [o.wallEnd, roadD], [exitEnd, apronD]],
      ease: 'smooth',
    },
  };
}

// ---------- infield ----------

export interface GarageOptions {
  /** The lot runs behind pit road between these signed s, from pit road's inner edge... */
  s0: number;
  s1: number;
  d0: number;
  /** ...this deep into the infield. */
  depth: number;
}

/**
 * Garage lot behind pit road: rows of garage buildings with lanes between
 * them, and parking along the back of the lot for retired cars.
 */
export function garageLot(cl: Centerline, o: GarageOptions): { garage: Garage; buildings: Decoration[] } {
  const lot: TrackRect = { s0: o.s0, s1: o.s1, d0: o.d0, d1: o.d0 + o.depth };
  const buildings: Decoration[] = [];
  const rows = o.depth >= 36 ? [[8, 16], [o.depth - 14, o.depth - 6]] : [[o.depth * 0.35, o.depth * 0.75]];
  for (const [a, b] of rows) {
    for (let s0 = lot.s0 + 10; s0 + 24 <= lot.s1 - 10; s0 += 32) {
      buildings.push({ kind: 'building', rect: { s0, s1: s0 + 24, d0: o.d0 + a, d1: o.d0 + b } });
    }
  }
  // Parking rows from the back of the lot forward, stopping short of the buildings.
  const frontOfBuildings = Math.max(...rows.map(([, b]) => o.d0 + b));
  const parking: Array<[number, number]> = [];
  for (let row = 0; row < 4; row++) {
    const d = lot.d1 - 3 - row * 4;
    if (row > 0 && d < frontOfBuildings + 2) break;
    for (let col = 0; col < 12; col++) parking.push(cl.toWorld(lot.s0 + 8 + col * 6, d));
  }
  return { garage: { lot, parking }, buildings };
}

export interface EscapeLaneOptions {
  /** Signed s where the lane leaves the apron. */
  leaveS: number;
  /** Inside edge of the racing surface and of the apron where the lane leaves. */
  innerEdge: number;
  apronD: number;
  /** The garage lot it leads to. */
  lot: TrackRect;
  width: number;
}

/** A road off the apron, angling into the infield and across to the garage's near corner. */
export function escapeLane(cl: Centerline, o: EscapeLaneOptions): EscapeLane {
  return {
    points: [
      cl.toWorld(o.leaveS - 60, o.innerEdge + 1),
      cl.toWorld(o.leaveS, o.apronD + 6),
      cl.toWorld(o.leaveS + 30, o.apronD + 30),
      cl.toWorld(o.lot.s0 + 6, o.lot.d1 - 2),
    ],
    width: o.width,
  };
}

// ---------- surfaces, walls, paint ----------

/**
 * The standard surface stack for a paved track with an infield, bottom to
 * top: mown grass inside the pavement, roads and garage lot, apron, racing
 * surface (which extends outward for physics: nothing gets past the wall),
 * pit road behind the wall.
 */
export function standardSurfaces(
  edgeIn: Edge, edgeOut: Edge, pavedInner: Profile, pit: PitLane, garage: Garage, roads: EscapeLane[],
): SurfaceRegion[] {
  return [
    { id: 'infield', surface: 'grass', shape: { kind: 'band', range: null, d0: pavedInner, d1: pavedInner, openIn: true }, pattern: 'mowing' },
    ...roads.map((r, i): SurfaceRegion => ({ id: `escape${i}`, surface: 'road', shape: { kind: 'path', points: r.points, width: r.width }, outline: true })),
    { id: 'garage', surface: 'garage', shape: { kind: 'rect', rect: garage.lot }, outline: true },
    { id: 'apron', surface: 'apron', shape: { kind: 'band', range: null, d0: edgeIn, d1: pavedInner } },
    { id: 'racing', surface: 'track', shape: { kind: 'band', range: null, d0: edgeOut, d1: edgeIn, openOut: true } },
    { id: 'pit-road', surface: 'pit', shape: { kind: 'band', range: [pit.wallStart, pit.wallEnd], d0: pit.wallD, d1: pit.roadD } },
  ];
}

/** SAFER barrier round the outside, and the pit wall with attenuators on its ends. */
export function standardWalls(edgeOut: Edge, pit: PitLane, outerThickness = 0.8): Wall[] {
  return [
    // Its face is the outside edge of the racing surface, wherever that is.
    { id: 'outer', range: null, d: shiftEdge(edgeOut, -outerThickness / 2), thickness: outerThickness, faces: 'in', caps: false },
    {
      id: 'pit-wall', range: [pit.wallStart, pit.wallEnd],
      d: pit.wallD, thickness: pit.wallThickness, faces: 'both', caps: true, attenuators: true,
    },
  ];
}

/**
 * Paint: pavement edges, the pit entry (dashed) and blend line (solid) along
 * the inside of the racing surface, pit road's lane line and stall boxes, and
 * the start/finish line.
 */
export function standardMarkings(length: number, edgeIn: Edge, startLine: [number, number], pavedInner: Profile, pit: PitLane): Marking[] {
  const half = pit.stallSpacing / 2;
  return [
    { kind: 'line', range: null, d: pavedInner, style: 'edge' },
    { kind: 'line', range: [pit.blendEnd, length + pit.wallEnd], d: edgeIn, style: 'edge' },
    { kind: 'line', range: [pit.wallEnd, pit.blendEnd], d: edgeIn, style: 'blend' },
    { kind: 'line', range: [pit.entryStart, pit.wallStart], d: edgeIn, style: 'entry' },
    { kind: 'line', range: [pit.wallStart, pit.wallEnd], d: pit.laneD, style: 'lane' },
    { kind: 'ticks', s: [...pit.stalls.map((s) => s - half), pit.stalls[pit.stalls.length - 1] + half], d0: pit.laneD, d1: pit.roadD - 1, style: 'stall' },
    { kind: 'ticks', s: [0], d0: startLine[0], d1: startLine[1], style: 'start' },
  ];
}
