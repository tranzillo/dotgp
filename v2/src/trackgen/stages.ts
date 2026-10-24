import type { Centerline } from '../sim/centerline';
import { PHYSICS } from '../sim/constants';
import {
  evalProfile, shiftEdge, type CenterlineSpec, type Decoration, type Edge, type EscapeLane, type Garage, type Marking, type PitLane, type Profile,
  type Road, type RoadNetwork, type RoadNode, type SurfaceRegion, type TrackRect, type Wall,
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
  /** Gap between the racing surface and the wall (at least noseClearance), wall thickness, pit road width. */
  wallGap: number;
  wallThickness: number;
  roadWidth: number;
  stallSpacing: number;
  /** Pit road's travel (fast) lane by the wall, and the boxes beyond it (default: 6 m, and the rest of roadWidth). */
  travelWidth?: number;
  boxDepth?: number;
  /** An oval's crew strip behind an inside pit wall behind the boxes (NASCAR's), this wide; absent: neither. */
  crewWidth?: number;
}

/** An oval's inside pit wall, behind the boxes (the crews go over it). */
export const INNER_PIT_WALL = 0.6;

/**
 * The least gap between the racing surface's edge and the pit wall's face: a car's width and a metre. The track
 * limits let a car's centre run a car's radius past the edge, so a car on the line can't touch the wall's nose.
 */
export function noseClearance(): number {
  return 2 * PHYSICS.CAR_RADIUS + 1;
}

/** Pit lane on the infield side, plus the pavement edge it widens. */
export function pitLane(o: PitLaneOptions): { pit: PitLane; pavedInner: Profile } {
  const apronD = o.innerEdge + o.apronWidth;
  const wallD = o.innerEdge + Math.max(o.wallGap, noseClearance()) + o.wallThickness / 2;
  const face = wallD + o.wallThickness / 2;
  // Across pit road from the wall: the travel lane, then the boxes (cars stop 3.5 m into them, or in their middle).
  const travel = o.travelWidth ?? 6, depth = o.boxDepth ?? o.roadWidth - 6;
  const laneD = face + travel, roadD = laneD + depth;
  // (Behind an inside pit wall, the crews' strip; the pavement runs out to its back.)
  const crewD = o.crewWidth ? roadD + INNER_PIT_WALL + o.crewWidth : undefined;
  const backD = crewD ?? roadD;
  const entryStart = o.wallStart - o.entryLength;
  const exitEnd = o.wallEnd + o.exitTaper;
  // Boxes from 25 m in, spaced along the wall, leaving room to accelerate out of the last.
  const boxes = Math.max(1, Math.floor((o.wallEnd - o.wallStart - 40) / o.stallSpacing));
  const stalls = Array.from({ length: boxes }, (_, k) => o.wallStart + 25 + k * o.stallSpacing);
  return {
    pit: {
      entryStart, wallStart: o.wallStart, wallEnd: o.wallEnd, exitEnd, blendEnd: o.blendEnd,
      wallD, wallThickness: o.wallThickness, roadD, stalls, stallSpacing: o.stallSpacing,
      laneD, fastD: face + travel / 2, boxD: laneD + Math.min(3.5, depth / 2), ...(crewD ? { crewD } : {}),
    },
    pavedInner: {
      keys: [[entryStart, apronD], [o.wallStart, backD], [o.wallEnd, backD], [exitEnd, apronD]],
      ease: 'smooth',
    },
  };
}

/** Half the width of the paved lane into and out of a pit road set back from the track. */
const PIT_LANE_HALF = 5.5;
/** Pit road set back this far (or more) gets its own lanes across the grass (nearer, the gap is paved apron). */
export const SET_BACK_PIT = 6;

export interface PitComplexOptions extends PitLaneOptions {
  /** Grass between pit road and the garage lot (0: the lot is right behind it), and how many lanes cross it. */
  garageSetBack: number;
  garageLanes: number;
  /** How deep the lot is, given where its front is (d). */
  garageDepth: (d0: number) => number;
  /** Pit road on a chord: how much further in the whole pit complex stands at each (signed) s. */
  offset?: (s: number) => number;
}

/**
 * Pit road, its way in and out, the garage, and the roads between them, as
 * one piece. Pit road can stand right against the track (the wall a metre
 * inside the racing surface: the classic oval) or set back across a grass
 * island, reached by paved lanes that leave the apron at the entry and
 * rejoin it at the exit; the cars' and the pace car's pit routes follow
 * those lanes (pit.entryRoute / exitRoute). The garage is right behind pit
 * road or set back too, reached by garage lanes. The road network joins it
 * all: pit entry (from the apron) to pit road, along it (wreckers keep to its
 * inner side, behind the boxes), out to the apron at the exit; and garage
 * lanes or the lot itself off pit road.
 */
export function pitComplex(cl: Centerline, o: PitComplexOptions): {
  pit: PitLane; pavedInner: Profile; garage: Garage; buildings: Decoration[]; surfaces: SurfaceRegion[]; network: RoadNetwork;
  /** Where along pit road the garage is reached from it (signed s): gaps in an inside pit wall. */
  access: number[];
} {
  const base = pitLane(o);
  const L = cl.length;
  const off = o.offset ?? (() => 0);
  const apronD = o.innerEdge + o.apronWidth;
  const apronLane = o.innerEdge + o.apronWidth / 2;
  // (On a chord, 1.5 m further from the wall: pit road curves away from the track and back, and a car following it cuts
  // in a little toward the wall's ends.)
  const fast = base.pit.fastD! + (o.offset ? 1.5 : 0);
  const setBack = Math.max(o.wallGap, noseClearance()) >= SET_BACK_PIT || !!o.offset;
  const inEnd = base.pit.wallStart - 30, outStart = base.pit.wallEnd + 15;
  // The lanes in and out ease from the apron onto pit road's line. On a chord, pit road angles away from the track, so
  // they blend into it (arriving along it, not just at it): sampled.
  const blended = (a: number, b: number, fromLane: (s: number) => number, toLane: (s: number) => number): Profile => {
    const keys: Array<[number, number]> = [];
    for (let s = a; s < b; s += 5) {
      const t = (s - a) / (b - a), w = t * t * (3 - 2 * t);
      keys.push([s, fromLane(s) * (1 - w) + toLane(s) * w]);
    }
    keys.push([b, toLane(b)]);
    return { keys, ease: 'linear' };
  };
  const entryRoute: Profile = o.offset
    ? blended(base.pit.entryStart, inEnd, () => apronLane, (s) => fast + off(s))
    : { keys: [[base.pit.entryStart, apronLane], [inEnd, fast]], ease: 'smooth' };
  const exitRoute: Profile = o.offset
    ? blended(outStart, base.pit.exitEnd, (s) => fast + off(s), () => apronLane)
    : { keys: [[outStart, fast], [base.pit.exitEnd, apronLane]], ease: 'smooth' };
  let offsetProfile: Profile | undefined;
  if (o.offset) {
    const keys: Array<[number, number]> = [];
    for (let s = base.pit.entryStart - 1; s < base.pit.exitEnd + 1; s += 10) keys.push([s, off(s)]);
    keys.push([base.pit.exitEnd + 1, off(base.pit.exitEnd + 1)]);
    offsetProfile = { keys, ease: 'linear' };
  }
  const pit: PitLane = setBack ? { ...base.pit, fastD: fast, entryRoute, exitRoute, ...(offsetProfile ? { offset: offsetProfile } : {}) } : base.pit;
  const { entryStart, wallStart, wallEnd, exitEnd, roadD } = pit;
  /** Where a car on the way in or out is (d), from the entry to the exit. */
  const laneAt = (s: number) => (s < inEnd ? evalProfile(entryRoute, s, L) : s > outStart ? evalProfile(exitRoute, s, L) : fast + off(s));

  // Set back: pavement round the lanes and pit road, grass between them and the apron.
  const surfaces: SurfaceRegion[] = [];
  let pavedInner = base.pavedInner;
  if (setBack) {
    const paved: Array<[number, number]> = [[entryStart - 1, apronD]];
    const island: Array<[number, number]> = [[entryStart - 1, apronD]];
    for (let s = entryStart; s <= exitEnd; s += 10) {
      const onRoad = s >= wallStart && s <= wallEnd;
      paved.push([s, onRoad ? (pit.crewD ?? roadD) + off(s) : Math.max(apronD, laneAt(s) + PIT_LANE_HALF)]);
      const wallFace = pit.wallD + off(s) - pit.wallThickness / 2;
      island.push([s, Math.max(apronD, onRoad ? wallFace : laneAt(s) - PIT_LANE_HALF)]);
    }
    paved.push([exitEnd + 1, apronD]);
    island.push([exitEnd + 1, apronD]);
    pavedInner = { keys: paved, ease: 'linear' };
    surfaces.push({ id: 'pit-island', surface: 'grass', shape: { kind: 'band', range: [entryStart, exitEnd], d0: apronD, d1: { keys: island, ease: 'linear' } }, pattern: 'mowing' });
  }

  // The garage, and lanes to it across the grass when it's set back.
  const s0 = wallStart + 30, s1 = wallEnd - 30;
  // (Behind pit road where it is furthest in, on a chord.)
  let deepest = 0;
  for (let s = s0; s <= s1; s += 5) deepest = Math.max(deepest, off(s));
  const d0 = (pit.crewD ?? roadD) + deepest + o.garageSetBack;
  const { garage, buildings } = garageLot(cl, { s0, s1, d0, depth: o.garageDepth(d0) });
  const laneS = o.garageSetBack > 0
    ? Array.from({ length: Math.max(1, o.garageLanes) }, (_, k) => s0 + ((k + 0.5) * (s1 - s0)) / Math.max(1, o.garageLanes))
    : [];
  laneS.forEach((s, k) => {
    surfaces.push({ id: `garage-lane${k}`, surface: 'road', shape: { kind: 'path', points: [cl.toWorld(s, roadD - 1 + off(s)), cl.toWorld(s, d0 + 2)], width: 8 }, outline: true });
  });

  // The network.
  const service = (s: number) => roadD - 2 + off(s); // pit road's inner side, behind the boxes
  const nodes: RoadNode[] = [];
  const roads: Road[] = [];
  const node = (id: string, kind: RoadNode['kind'], at: [number, number], s?: number) => { nodes.push({ id, kind, at, ...(s !== undefined ? { s } : {}) }); return id; };
  const along = (from: number, to: number, d: (s: number) => number, step: number): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    for (let s = from; s < to; s += step) pts.push(cl.toWorld(s, d(s)));
    pts.push(cl.toWorld(to, d(to)));
    return pts;
  };
  const entryAt = cl.toWorld(entryStart, apronD - 2), exitAt = cl.toWorld(exitEnd, apronD - 2);
  node('pit-entry', 'apron', entryAt, entryStart);
  node('pit-exit', 'apron', exitAt, exitEnd);
  // Stations along pit road's inner side: its start and end, and where the garage is reached from it.
  const garageS = o.garageSetBack > 0 ? laneS : [garage.lot.s0 + 4];
  const stations: Array<{ s: number; id: string }> = [
    { s: wallStart - 10, id: node('pit-road-start', 'junction', cl.toWorld(wallStart - 10, service(wallStart - 10))) },
    ...garageS.map((s, k) => ({ s, id: node(o.garageSetBack > 0 ? `pit-lane${k}` : 'garage-pit', o.garageSetBack > 0 ? 'junction' : 'garage', cl.toWorld(s, service(s))) })),
    { s: wallEnd + 10, id: node('pit-road-end', 'junction', cl.toWorld(wallEnd + 10, service(wallEnd + 10))) },
  ];
  const entryPts = setBack ? along(entryStart, wallStart - 10, laneAt, 15) : [cl.toWorld(entryStart, apronD - 2)];
  roads.push({ id: 'pit-entry', from: 'pit-entry', to: 'pit-road-start', points: [entryAt, ...entryPts.slice(1), cl.toWorld(wallStart - 10, service(wallStart - 10))], width: 2 * PIT_LANE_HALF, grade: 'pit', oneWay: true });
  for (let k = 0; k + 1 < stations.length; k++) {
    const a = stations[k], b = stations[k + 1];
    roads.push({ id: `pit-road${k}`, from: a.id, to: b.id, points: along(a.s, b.s, service, 25), width: o.roadWidth, grade: 'pit' });
  }
  const exitPts = setBack ? along(wallEnd + 10, exitEnd, laneAt, 15) : [cl.toWorld(wallEnd + 10, service(wallEnd + 10))];
  roads.push({ id: 'pit-exit', from: 'pit-road-end', to: 'pit-exit', points: [cl.toWorld(wallEnd + 10, service(wallEnd + 10)), ...exitPts.slice(1), exitAt], width: 2 * PIT_LANE_HALF, grade: 'pit', oneWay: true });
  laneS.forEach((s, k) => {
    const end = node(`garage${k}`, 'garage', cl.toWorld(s, d0 + 2));
    roads.push({ id: `garage-lane${k}`, from: `pit-lane${k}`, to: end, points: [cl.toWorld(s, service(s)), cl.toWorld(s, d0 + 2)], width: 8, grade: 'garage' });
  });
  return { pit, pavedInner, garage, buildings, surfaces, network: { nodes, roads }, access: garageS };
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

/**
 * A road round the edge of the infield instead of across it (the infield
 * holds another track): off the apron, then along the infield at the depth
 * of the garage lot's back row, through the turns, into the lot from its
 * near end. Same contract as an escape lane: first point at the apron, last
 * in the garage.
 */
export function serviceRoad(cl: Centerline, o: EscapeLaneOptions): EscapeLane {
  const d = o.lot.d1 - 2;
  const points: Array<[number, number]> = [
    cl.toWorld(o.leaveS - 60, o.innerEdge + 1),
    cl.toWorld(o.leaveS, o.apronD + 6),
  ];
  // From the leave point on round the lap to the lot's near end, every 25 m.
  const from = o.leaveS + 30 + (d - o.apronD);
  const to = from + cl.distanceFrom(from, o.lot.s0 - 10);
  for (let s = from; s < to; s += 25) points.push(cl.toWorld(s, d));
  points.push(cl.toWorld(o.lot.s0 - 10, d), cl.toWorld(o.lot.s0 + 6, d));
  return { points, width: o.width };
}

// ---------- surfaces, walls, paint ----------

/** A pit lateral position (wallD, roadD, laneD) where it is along pit road: shifted by the offset on a chord. */
function pitEdge(pit: PitLane, d: number): Edge {
  return pit.offset ? shiftEdge(pit.offset, d) : d;
}

/** The pit boxes' lines: one set across pit road, or (on a chord) one per box, each where pit road is there. */
function stallTicks(pit: PitLane, length: number, half: number): Marking[] {
  const at = [...pit.stalls.map((s) => s - half), pit.stalls[pit.stalls.length - 1] + half];
  const offset = pit.offset;
  if (!offset) return [{ kind: 'ticks', s: at, d0: pit.laneD, d1: pit.roadD - 1, style: 'stall' }];
  return at.map((s): Marking => {
    const shift = evalProfile(offset, s, length);
    return { kind: 'ticks', s: [s], d0: pit.laneD + shift, d1: pit.roadD - 1 + shift, style: 'stall' };
  });
}

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
    { id: 'pit-road', surface: 'pit', shape: { kind: 'band', range: [pit.wallStart, pit.wallEnd], d0: pitEdge(pit, pit.wallD), d1: pitEdge(pit, pit.roadD) } },
    // (An oval's crews' strip behind its inside pit wall.)
    ...(pit.crewD !== undefined
      ? [{ id: 'pit-crew', surface: 'apron', shape: { kind: 'band', range: [pit.wallStart, pit.wallEnd], d0: pitEdge(pit, pit.roadD), d1: pitEdge(pit, pit.crewD) } } satisfies SurfaceRegion]
      : []),
  ];
}

/**
 * An oval's inside pit wall, behind the boxes (where it has a crew strip):
 * pit road's length, with gaps (10 m) where the garage is reached from it.
 */
export function innerPitWalls(pit: PitLane, access: number[]): Wall[] {
  if (pit.crewD === undefined) return [];
  const GAP = 10;
  const cuts = access.filter((s) => s > pit.wallStart + GAP && s < pit.wallEnd - GAP).sort((a, b) => a - b);
  const walls: Wall[] = [];
  let from = pit.wallStart;
  for (const s of [...cuts, pit.wallEnd + GAP / 2]) {
    const to = s - GAP / 2;
    if (to - from > 5) {
      walls.push({ id: `pit-inner-wall${walls.length}`, range: [from, to], d: pitEdge(pit, pit.roadD + INNER_PIT_WALL / 2), thickness: INNER_PIT_WALL, faces: 'both', caps: true });
    }
    from = s + GAP / 2;
  }
  return walls;
}

/** SAFER barrier round the outside, and the pit wall with attenuators on its ends. */
export function standardWalls(edgeOut: Edge, pit: PitLane, outerThickness = 0.8): Wall[] {
  return [
    // Its face is the outside edge of the racing surface, wherever that is.
    { id: 'outer', range: null, d: shiftEdge(edgeOut, -outerThickness / 2), thickness: outerThickness, faces: 'in', caps: false },
    {
      id: 'pit-wall', range: [pit.wallStart, pit.wallEnd],
      d: pitEdge(pit, pit.wallD), thickness: pit.wallThickness, faces: 'both', caps: true, attenuators: true,
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
    { kind: 'line', range: [pit.wallStart, pit.wallEnd], d: pitEdge(pit, pit.laneD), style: 'lane' },
    ...stallTicks(pit, length, half),
    { kind: 'ticks', s: [0], d0: startLine[0], d1: startLine[1], style: 'start' },
  ];
}
