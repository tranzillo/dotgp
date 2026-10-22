import { Rng } from '../ai/rng';
import { Centerline } from '../sim/centerline';
import {
  evalEdge, evalProfile, LAYOUT_VERSION, layoutKind,
  type Barrier, type Decoration, type Marking, type Profile, type RovalSpec, type SurfaceRegion, type TrackLayout, type Wall,
} from '../sim/layout';
import { G, PHYSICS as P } from '../sim/constants';
import { Track } from '../sim/track';
import {
  CHARACTERS, CIRCUIT_PIT, dressCourse, geometrySamples, markChicanes, pitZone,
  type Bound, type CornerAt, type Course, type PitZone,
} from './circuit';
import { integrate, ovalPose, poseSection, sliceSections, type Pose } from './course';
import { placeLayout } from './geometry';
import { garageLot, pitLane, standardMarkings } from './stages';
import { hazardWalls } from './walls';

/**
 * Road courses on an oval, generated as circuits are (trackgen/circuit.ts):
 * an organic polygon of corners, each fitted from the circuit vocabulary,
 * eased in and out, joined by straights, then laid out with a circuit's
 * cross-section (widening, run-off, kerbs, barriers kept smooth and clear).
 * Part of the lap is the oval's own: a straight, a banked turn, or both. The
 * rest winds through the infield, leaving the oval where that part ends and
 * rejoining it where it begins.
 *
 * The polygon is laid round a centre in the infield, in angle order (so it
 * never crosses itself), from where the course leaves the oval round to where
 * it rejoins. Its points sit at random shares of the room in each direction,
 * a few pushed out (peninsulas: hairpins) or pulled in (dents: right-handers),
 * as a circuit's sit round its ellipse.
 */

export interface RovalSite {
  /** The oval's centerline (placed). */
  cl: Centerline;
  /** Inner edge of the oval's pavement (apron, pit road) at s. */
  pavedInner: (s: number) => number;
  /** Its turns (not front-stretch bends), each from where it starts to where it ends (signed s). */
  turns: Array<[number, number]>;
  /** Where nothing of the course may come within m of (the garage, for now). */
  keepOut: (x: number, y: number, m: number) => boolean;
  /**
   * What of the oval's pit lane a course's part of the oval must take in (signed s): its wall, or all of it where its
   * lanes are laid across the infield (they can't be cut short).
   */
  pitRange: [number, number];
  /** The racing surface's banking at s (radians): what speed the field carries where a course leaves or rejoins it. */
  bankAt?: (s: number) => number;
  rng: Rng;
  /**
   * Builds the inner oval the courses share road with (unplaced): a flat short oval with this front straight, turn
   * radius and width, its pit lane on its front straight. Null if it can't be laid out.
   */
  buildInner?: (straight: number, radius: number, width: number) => TrackLayout | null;
}

const pickIn = (rng: Rng, [a, b]: [number, number]) => a + rng.next() * (b - a);
/** Over its first and last this many metres, a course eases from the oval's banking and width to its own. */
const RAMP = 35;

/** Every turn of the oval, from its curvature: stretches turning more than 50 degrees (front-stretch bends turn less). */
export function ovalTurns(cl: Centerline): Array<[number, number]> {
  const L = cl.length, step = 5;
  const out: Array<[number, number]> = [];
  let start: number | null = null, turned = 0;
  for (let s = 0; s <= L; s += step) {
    const k = Math.abs(cl.curvatureAt(s));
    if (k > 1e-4 && s < L) {
      if (start === null) { start = s; turned = 0; }
      turned += k * step;
    } else if (start !== null) {
      if (turned > (50 * Math.PI) / 180) out.push([cl.signedS(start), cl.signedS(start) + (s - start)]);
      start = null;
    }
  }
  return out;
}

/**
 * Where a course turns in off an oval and where it comes back on: a turn's
 * entry (a little before it, off the end of the straight) and a later turn's
 * exit (a little after it), the oval between them skipped. What it keeps must
 * take in the front stretch, with the start line and pit road. Null if no
 * pair of them does.
 */
function cut(site: RovalSite): { join: number; leave: number } | null {
  const { cl, turns, rng } = site;
  const [p0, p1] = site.pitRange;
  const pairs: Array<{ join: number; leave: number }> = [];
  turns.forEach(([a, a1]) => {
    turns.forEach(([b0, b]) => {
      // (A few tries at where: just before the turn it turns in at, or a little way into it, and likewise just after
      // the turn it comes back at; clear of pit road, whose lanes can reach a way round the turns either side.)
      for (let t = 0; t < 6; t++) {
        const leave = a + (t < 3 ? -pickIn(rng, [8, 150]) : pickIn(rng, [0.05, 0.35]) * (a1 - a));
        const join = b - (t < 3 ? -pickIn(rng, [8, 150]) : pickIn(rng, [0.05, 0.35]) * (b - b0));
        // Skipping one turn's entry round to another's exit: at least the one turn, never the whole lap.
        const skipped = cl.distanceFrom(leave, join), kept = cl.distanceFrom(join, leave);
        if (skipped < 150 || kept < 150) continue;
        const along = (s: number) => cl.distanceFrom(join, s);
        if (!(along(p0 - 15) < kept && along(p1 + 15) < kept && along(0) < kept && along(p0 - 15) < along(p1 + 15))) continue;
        // (Skipping an end or so, as Iowa does, more often than all but the front stretch.)
        const weight = skipped > 0.15 * cl.length && skipped < 0.5 * cl.length ? 3 : 1;
        for (let w = 0; w < weight; w++) pairs.push({ join: cl.signedS(join), leave: cl.signedS(leave) });
        break;
      }
    });
  });
  return pairs.length ? pairs[rng.int(pairs.length)] : null;
}

/**
 * The venue's road courses, interlinked as Iowa's are: a road network of the
 * speedway, an inner oval in one half of its infield, and roads between them
 * (from a turn's entry on one to a turn's exit on the other), and round the
 * outside of the inner oval's ends; every way round that network that keeps
 * a front stretch (the speedway's, or the inner oval's) is a layout. So the
 * layouts share road with each other as Iowa's road course and its short
 * course do, each a cross-section of the same network, and the more roads,
 * the more layouts. Null if no network with a layout fitted in the tries;
 * otherwise the best of a few (filling the infield, with most layouts).
 */
export function generateRoval(site: RovalSite, opts: { tries?: number } = {}): { inner: TrackLayout | null; rovals: RovalSpec[] } | null {
  let best: { inner: TrackLayout | null; rovals: RovalSpec[]; score: number } | null = null;
  for (let attempt = 0, found = 0; attempt < (opts.tries ?? 60) && found < 5; attempt++) {
    const made = tryNetwork(site);
    if (!made) continue;
    found++;
    if (!best || made.score > best.score) best = made;
  }
  return best && { inner: best.inner, rovals: best.rovals };
}

type Sec = [number, number, number];
const reversed = (secs: Sec[]): Sec[] => [...secs].reverse().map(([l, k0, k1]) => [l, -k1, -k0] as Sec);

/**
 * A way of the network: the speedway (0, one way only: its banking, its pit
 * road) and the inner oval (1), each closed; and the roads (2 on), each from
 * where it starts on one way to where it finishes on another (or the same).
 */
interface Way {
  sections: Sec[];
  length: number;
  /** A ring's track (none for a road). */
  track?: Centerline;
  /** A ring's speed at s: what the field carries there (m/s). */
  speed?: (s: number) => number;
  /** Where a road starts. */
  start: Pose;
  oneWay: boolean;
  /** A ring's pit lane (what a layout cut from it must keep). */
  pit?: [number, number];
  /** A road's points off the tracks (for keeping the others clear of it). */
  points: Array<[number, number]>;
  /** A road's straights long enough for another road to peel off or onto. */
  straights: Array<[number, number]>;
}
/** Where a road starts (end 0) or finishes (end 1): on way `way` at `at`, heading t times that way's own way there. */
interface Junction { road: number; end: 0 | 1; way: number; at: number; t: 1 | -1 }
/** A stretch of a way a layout runs: from s0 to s1, its own way (d 1) or back. */
interface Run { way: number; s0: number; s1: number; d: 1 | -1 }

function wayPose(w: Way, s: number, d: 1 | -1): Pose {
  let p: Pose;
  if (w.track) {
    const q = ovalPose(w.track, s);
    p = { ...q, k: Math.abs(q.k) < 1e-6 ? 0 : q.k };
  } else {
    const e = integrate(sliceSections(w.sections, 0, s), w.start.x, w.start.y, w.start.h).end;
    let acc = 0, k = 0;
    for (const [len, k0, k1] of w.sections) {
      if (s <= acc + len) { k = k0 + ((k1 - k0) * (s - acc)) / len; break; }
      acc += len;
    }
    p = { x: e.x, y: e.y, h: e.h, k };
  }
  return d > 0 ? p : { x: p.x, y: p.y, h: p.h + Math.PI, k: -p.k };
}

/** How far a ring runs straight from s, going d times its own way (up to 400 m; a road's: as far as you like). */
function straightRoom(w: Way, s: number, d: 1 | -1): number {
  if (!w.track) return Infinity;
  let x = 0;
  while (x < 400 && Math.abs(w.track.curvatureAt(s + d * x)) < 1e-4) x += 5;
  return x;
}

/** A way's sections from s0 to s1, travelling its own way (d 1) or back (round a ring's start if need be). */
function wayRun(w: Way, s0: number, s1: number, d: 1 | -1): Sec[] {
  let fwd: Sec[];
  if (w.track) {
    const t = w.track, L = t.length;
    const [a, b] = d > 0 ? [s0, s1] : [s1, s0];
    const a0 = t.wrapS(a), len = t.distanceFrom(a, b);
    fwd = a0 + len <= L
      ? sliceSections(w.sections, a0, a0 + len)
      : [...sliceSections(w.sections, a0, L), ...sliceSections(w.sections, 0, a0 + len - L)];
  } else {
    fwd = sliceSections(w.sections, Math.min(s0, s1), Math.max(s0, s1));
  }
  return d > 0 ? fwd : reversed(fwd);
}

/** How far along a way from s, going d, x is (Infinity if a road runs out first). */
function ahead(w: Way, s: number, d: 1 | -1, x: number): number {
  if (w.track) return d > 0 ? w.track.distanceFrom(s, x) : w.track.distanceFrom(x, s);
  const len = d > 0 ? x - s : s - x;
  return len >= 0 ? len : Infinity;
}

/** The straights of a road at least `min` long, as [from, to] along it. */
function straightsOf(sections: Sec[], min: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let acc = 0;
  for (const [len, k0, k1] of sections) {
    if (k0 === 0 && k1 === 0 && len >= min) out.push([acc, acc + len]);
    acc += len;
  }
  return out;
}

/** Names for the layouts, longest first: the speedway's road courses, then the inner oval's. */
const NAMES = { speedway: ['Grand Prix', 'National', 'Club', 'Sprint', 'Classic'], inner: ['Short course', 'Infield', 'Kart'] };
const MAX_LAYOUTS = 7;
/** A layout of a venue with others shares more than this of its lap with one of them. */
const LINKED = 0.3;

/** The share of lap a's points (every 10 m or so) on lap b's road: within 3 m of b's line (b taken every metre). */
export function sharedShare(a: Array<[number, number]>, b: Array<[number, number]>): number {
  const g = new PointGrid(10);
  for (let i = 0; i < b.length; i++) {
    const [x0, y0] = b[i], [x1, y1] = b[(i + 1) % b.length];
    const m = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    if (m > 30) { g.add(x0, y0); continue; } // (a lap's seam: not a road)
    for (let k = 0; k < m; k++) g.add(x0 + ((x1 - x0) * k) / m, y0 + ((y1 - y0) * k) / m);
  }
  return a.filter(([x, y]) => g.near(x, y, 3)).length / a.length;
}

/** How much road two laps share, as a share of the shorter. */
export function linkShare(a: Array<[number, number]>, b: Array<[number, number]>): number {
  return Math.max(sharedShare(a, b), sharedShare(b, a));
}

function tryNetwork(site: RovalSite): { inner: TrackLayout | null; rovals: RovalSpec[]; score: number } | null {
  const { cl, rng } = site;
  if (!site.buildInner) return null;
  const width = Math.round(pickIn(rng, [11, 14]) * 2) / 2;
  const verge = Math.round(pickIn(rng, [3, 6]));
  const scale = Math.min(1.2, Math.max(0.45, cl.length / 4000));
  const onInfield = infieldTest(site);

  // ---- the inner oval, in one half of the infield, along it or across it (if one fits: not in a small infield) ----
  const R = Math.max(52, pickIn(rng, [45, 75]) * scale), S = Math.max(150, pickIn(rng, [200, 360]) * scale);
  const built = site.buildInner(S, R, width);
  const inner = built && placeInner(site, built, R, onInfield);
  const it = inner ? new Track({ ...inner, neighbours: undefined }) : null;
  let innerReach = 0;
  for (let s = 0; it && s < it.length; s += 10) innerReach = Math.max(innerReach, -it.outerEdgeAt(s));
  const offInner = it ? remembered(cl.extent, (x, y, m) => {
    const r = it.near(x, y, innerReach + m + 2);
    return !r || r.d < it.outerEdgeAt(r.s) - m;
  }) : () => true;
  /** Free of both tracks. */
  const ground = (x: number, y: number, m: number) => onInfield(x, y, m) && offInner(x, y, m);
  const ring = (track: Centerline, sections: Sec[], oneWay: boolean, pit: [number, number], bankAt: (s: number) => number): Way => ({
    sections, length: track.length, track, speed: ringSpeeds(track, bankAt), start: ovalPose(track, 0), oneWay, pit, points: [], straights: [],
  });
  const banked = site.bankAt ?? (() => 0), flatRing = () => 0;
  // (Without an inner oval, the speedway stands in for it as way 1, which nothing meets.)
  const ways: Way[] = [
    ring(cl, cl.spec.sections as Sec[], true, site.pitRange, banked),
    it && inner
      ? ring(it, inner.centerline.sections as Sec[], false, [inner.pit.entryStart, inner.pit.exitEnd], flatRing)
      : ring(cl, cl.spec.sections as Sec[], true, site.pitRange, banked),
  ];
  const junctions: Junction[] = [];

  // ---- the roads, each clear of the others (where they're off the tracks) ----
  // (Stretches of road kept well apart: two roads, or two legs of one, a field's width between them, not a verge's.)
  const apart = width + 30;
  const taken = new PointGrid(20);
  const roadsClear = (x: number, y: number, m: number) => !taken.near(x, y, apart + m);
  const free = (x: number, y: number, m: number) => ground(x, y, m) && roadsClear(x, y, 0);
  type Spot = { way: number; at: number; t: 1 | -1 };
  const add = (sections: Sec[], a: Spot, b: Spot) => {
    const start = wayPose(ways[a.way], a.at, a.t);
    const points = integrate(sections, start.x, start.y, start.h, 4).points.filter(([x, y]) => ground(x, y, 0));
    const r = ways.length;
    ways.push({ sections, length: sections.reduce((acc, sec) => acc + sec[0], 0), start, oneWay: false, points, straights: straightsOf(sections, 240) });
    junctions.push({ road: r, end: 0, ...a }, { road: r, end: 1, ...b });
    for (const [x, y] of points) taken.add(x, y);
  };
  /**
   * A road clear of the tracks but where it meets them, and of the other roads but near where it meets one (it runs
   * on it a way before it peels off).
   */
  const fits = (sections: Sec[] | null, a: Spot, b: Spot): sections is Sec[] => {
    if (!sections) return false;
    const from = wayPose(ways[a.way], a.at, a.t), to = wayPose(ways[b.way], b.at, b.t);
    if (!clearPiece(sections, from, ground, width)) return false;
    const near = (x: number, y: number, p: Pose, spot: Spot) => spot.way > 1 && Math.hypot(x - p.x, y - p.y) < 120;
    return integrate(sections, from.x, from.y, from.h, 4).points
      .every(([x, y]) => !ground(x, y, 0) || near(x, y, from, a) || near(x, y, to, b) || roadsClear(x, y, 0));
  };
  /** Takes the last road laid up again. */
  const undo = () => {
    const r = ways.length - 1;
    ways.pop();
    junctions.splice(junctions.findIndex((j) => j.road === r), 2);
    taken.rebuild(ways.flatMap((w) => w.points));
  };
  /** Lays a road between two spots if it fits (a few tries). */
  const lay = (a: Spot, b: Spot, tries: number) => {
    const from = wayPose(ways[a.way], a.at, a.t), to = wayPose(ways[b.way], b.at, b.t);
    const speeds: [number | undefined, number | undefined] = [ways[a.way].speed?.(a.at), ways[b.way].speed?.(b.at)];
    const rooms: [number, number] = [straightRoom(ways[a.way], a.at, a.t), straightRoom(ways[b.way], b.at, -b.t as 1 | -1)];
    for (let t = 0; t < tries; t++) {
      const road = connect(from, to, free, rng, width, scale, cl.extent, speeds, rooms);
      if (fits(road, a, b)) { add(road, a, b); return true; }
    }
    return false;
  };
  // Where roads meet a way, kept well apart (each runs on it a way before it peels off), and off a road's own ends.
  const spaced = (way: number, at: number) => {
    const w = ways[way];
    const gap = (x: number) => (w.track ? Math.min(w.track.distanceFrom(x, at), w.track.distanceFrom(at, x)) : Math.abs(x - at));
    const room = way === 0 ? 150 : way === 1 ? 90 : 130;
    if (!w.track && (at < 150 || at > w.length - 150)) return false;
    return junctions.every((j) => j.way !== way || gap(j.at) > room);
  };

  // The inner oval's turns (its own way), and where roads meet it by them: just before a turn or just after it, nearer
  // for a loop round that turn's outside, further for a road from elsewhere (outside the loop).
  const iTurns = it ? ovalTurns(it) : [];
  if (it && iTurns.length !== 2) return null;
  const loops = iTurns.map(() => rng.next() < 0.75);
  const before = (k: number, near: boolean) => it!.signedS(iTurns[k][0] - pickIn(rng, near ? [10, 25] : loops[k] ? [95, 125] : [10, 40]));
  const after = (k: number, near: boolean) => it!.signedS(iTurns[k][1] + pickIn(rng, near ? [10, 25] : loops[k] ? [95, 125] : [10, 40]));
  /** Off the inner oval at a turn's entry (going its own way round, or the other), or on at a turn's exit. */
  const innerSpot = (off: boolean, d: 1 | -1, k: number): Spot => ({ way: 1, at: off === d > 0 ? before(k, false) : after(k, false), t: d });

  // ---- loops round the outside of the inner oval's ends ----
  iTurns.forEach((_, k) => {
    if (!loops[k]) return;
    for (let t = 0; t < 8; t++) {
      const a: Spot = { way: 1, at: before(k, true), t: 1 }, b: Spot = { way: 1, at: after(k, true), t: 1 };
      const from = wayPose(ways[1], a.at, 1), to = wayPose(ways[1], b.at, 1);
      const loop = around(it!, from, to, free, rng, width, scale);
      if (fits(loop, a, b)) { add(loop, a, b); return; }
    }
    loops[k] = false;
  });

  // ---- the Grand Prix's roads: off the speedway at a turn's entry onto the inner oval at a turn's exit (its own way
  // round, or the other), along a straight or round a turn too, and off at a turn's entry back to the speedway ----
  // (Without an inner oval, one road across the infield from the turn-in to the turn back on.)
  const sc = cut(site);
  if (!sc) return null;
  if (it) {
    const d: 1 | -1 = rng.next() < 0.5 ? 1 : -1;
    // (On after a turn, off before the next or the one after that: a straight, or a straight, a turn and a straight.)
    const k0 = rng.int(2), k1 = rng.next() < 0.5 ? 1 - k0 : k0;
    const onI = innerSpot(false, d, k0), offI = innerSpot(true, d, k1);
    if (!spaced(1, onI.at) || !spaced(1, offI.at)) return null;
    if (Math.min(it.distanceFrom(onI.at, offI.at), it.distanceFrom(offI.at, onI.at)) < 90) return null;
    const into: [Spot, Spot] = [{ way: 0, at: sc.leave, t: 1 }, onI];
    const onto: [Spot, Spot] = [offI, { way: 0, at: sc.join, t: 1 }];
    for (const [a, b] of rng.next() < 0.5 ? [into, onto] : [onto, into]) {
      if (!lay(a, b, 6)) return null;
    }
  } else if (!lay({ way: 0, at: sc.leave, t: 1 }, { way: 0, at: sc.join, t: 1 }, 8)) return null;

  // ---- a road or two more between the tracks: off the speedway at another turn's entry, or back on at another's
  // exit ----
  for (let extra = 0, wanted = it ? rng.int(3) : 0; extra < wanted; extra++) {
    for (let t = 0; t < 10; t++) {
      const off = rng.next() < 0.5;
      const s0 = extraJunction(site, sc, off);
      if (s0 === null || !spaced(0, s0)) continue;
      const spot = innerSpot(!off, rng.next() < 0.5 ? 1 : -1, rng.int(2));
      if (!spaced(1, spot.at)) continue;
      const sw: Spot = { way: 0, at: s0, t: 1 };
      if (off ? lay(sw, spot, 1) : lay(spot, sw, 1)) break;
    }
  }

  // ---- shortcuts: off a road's straight onto another's (or onto the inner oval by a turn), or off the inner oval ----
  /**
   * Somewhere a road can peel off (off) or onto: partway along a road's long straight, either way; by an inner turn;
   * or by another of the speedway's turns.
   */
  const spotOn = (off: boolean): Spot | null => {
    const way = rng.next() < 0.25 ? 0 : 1 + rng.int(ways.length - 1);
    if (way === 0) {
      const s0 = extraJunction(site, sc, off);
      return s0 === null ? null : { way: 0, at: s0, t: 1 };
    }
    if (way === 1) return it ? innerSpot(off, rng.next() < 0.5 ? 1 : -1, rng.int(2)) : null;
    const st = ways[way].straights;
    if (!st.length) return null;
    const [u0, u1] = st[rng.int(st.length)];
    if (u1 - u0 < 240) return null;
    const at = pickIn(rng, [u0 + 110, u1 - 110]);
    const p = wayPose(ways[way], at, 1);
    return ground(p.x, p.y, width) ? { way, at, t: rng.next() < 0.5 ? 1 : -1 } : null;
  };
  for (let k = 0, wanted = 1 + rng.int(3); k < wanted; k++) {
    for (let t = 0; t < 12; t++) {
      const a = spotOn(true), b = spotOn(false);
      if (!a || !b || (a.way < 2 && b.way < 2) || !spaced(a.way, a.at) || !spaced(b.way, b.at)) continue;
      if (a.way === b.way && Math.abs(a.at - b.at) < 200) continue;
      if (lay(a, b, 1)) {
        // (Not a little detour: a shortcut long enough to make a layout of its own.)
        if (ways[ways.length - 1].length < 400) { undo(); continue; }
        break;
      }
    }
  }

  // ---- the layouts: every way round the network over a front stretch ----
  const made: Array<{ spec: Omit<RovalSpec, 'id' | 'name'>; length: number; key: string; lap: Array<[number, number]> }> = [];
  for (const host of [0, 1]) {
    for (const route of routes(ways, junctions, host)) {
      const spec = layoutOf(route, ways, width, verge);
      if (spec) made.push(spec);
    }
  }
  // Each different enough from the others kept: a layout that runs nearly all its lap on one kept already's road (and
  // it on its), a little detour either way, is no other layout. (The longest first; the more different, the better.)
  const similar = (p: (typeof made)[number], q: (typeof made)[number]) => {
    const on = (a: Array<[number, number]>, b: Array<[number, number]>) => {
      const g = new PointGrid(20);
      for (const [x, y] of b) g.add(x, y);
      return a.filter(([x, y]) => g.near(x, y, 9)).length / a.length;
    };
    return on(p.lap, q.lap) > 0.88 && on(q.lap, p.lap) > 0.88;
  };
  const distinct: typeof made = [];
  for (const m of [...made].sort((p, q) => q.length - p.length)) if (!distinct.some((k) => similar(k, m))) distinct.push(m);
  const byHost = (inner: boolean) => distinct.filter((m) => (m.spec.host === 'inner') === inner);
  const speedway = byHost(false), short = byHost(true);
  if (!speedway.length) return null;
  const keep = [...speedway.slice(0, NAMES.speedway.length), ...short.slice(0, NAMES.inner.length)].slice(0, MAX_LAYOUTS);
  // The layouts are cross-sections of one network: each shares a good part of the shorter lap with another (a short
  // course mostly on the Grand Prix's road is a small part of the Grand Prix's lap, as Iowa's are). One that shares
  // little with any is another venue's, not this one's: left out, the least linked first, until the rest are linked
  // (or one is left).
  const linkOf = (i: number) => Math.max(0, ...keep.map((m, j) => (j === i ? 0 : linkShare(keep[i].lap, m.lap))));
  while (keep.length > 1) {
    const links = keep.map((_, i) => linkOf(i));
    const worst = links.indexOf(Math.min(...links));
    if (links[worst] > LINKED) break;
    keep.splice(worst, 1);
  }
  if (!keep.some((m) => m.spec.host !== 'inner')) return null;
  const named = { speedway: 0, inner: 0 };
  const rovals: RovalSpec[] = keep.map((m, i) => {
    const kind = m.spec.host === 'inner' ? 'inner' : 'speedway';
    return { id: `roval-${i}`, name: NAMES[kind][named[kind]++], ...m.spec };
  });

  // How much of the infield the network spreads over (the hull of its roads and the inner oval).
  const pts: Array<[number, number]> = ways.flatMap((w) => w.points);
  for (let s = 0; it && s < it.length; s += 10) pts.push(it.toWorld(s, 0));
  const field: Array<[number, number]> = [];
  for (let s = 0; s < cl.length; s += 10) field.push(cl.toWorld(s, site.pavedInner(s)));
  const cover = polygonArea(hull(pts)) / polygonArea(field);
  // (More layouts first; then spread, up to a good share of the infield.)
  return { inner, rovals, score: Math.min(cover, 0.55) + 0.25 * rovals.length };
}

/**
 * A test of free ground at (x, y) with margin m, remembered on a 2 m grid
 * (asked at the cell's middle, a little stricter): roads are laid by trying
 * many shapes, asking the same of the same ground over and over.
 */
function remembered(
  area: { minX: number; maxX: number; minY: number; maxY: number }, test: (x: number, y: number, m: number) => boolean,
): (x: number, y: number, m: number) => boolean {
  const x0 = area.minX - 100, y0 = area.minY - 100;
  const nx = Math.ceil((area.maxX + 100 - x0) / 2), ny = Math.ceil((area.maxY + 100 - y0) / 2);
  // (Per margin, a cell each: 0 not asked yet, 1 free, 2 not.)
  const byMargin: Uint8Array[] = [];
  return (x, y, m) => {
    const ix = Math.floor((x - x0) / 2), iy = Math.floor((y - y0) / 2), mi = Math.min(63, Math.max(0, Math.ceil(m)));
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return test(x, y, m);
    const cells = byMargin[mi] ?? (byMargin[mi] = new Uint8Array(nx * ny));
    const k = iy * nx + ix;
    if (!cells[k]) cells[k] = test(x0 + ix * 2 + 1, y0 + iy * 2 + 1, mi + 1.5) ? 1 : 2;
    return cells[k] === 1;
  };
}

const infieldTests = new WeakMap<RovalSite, (x: number, y: number, m: number) => boolean>();
/** The speedway's infield: past its pavement, off its garage (with margin m). */
function infieldTest(site: RovalSite): (x: number, y: number, m: number) => boolean {
  let test = infieldTests.get(site);
  if (!test) {
    const paved = widestPavement(site);
    test = remembered(site.cl.extent, (x, y, m) => {
      const q = site.cl.near(x, y, paved + m + 1);
      return (!q || q.d > site.pavedInner(q.s) + m) && !site.keepOut(x, y, m);
    });
    infieldTests.set(site, test);
  }
  return test;
}

/**
 * The inner oval placed in one half of the speedway's infield (towards one
 * end or the other), along the front stretch or across it, room all round it
 * for roads. Null if it didn't fit in a few tries.
 */
function placeInner(site: RovalSite, built: TrackLayout, R: number, onInfield: (x: number, y: number, m: number) => boolean): TrackLayout | null {
  const { cl, rng } = site;
  const edge: Array<[number, number]> = [];
  for (let s = 0; s < cl.length; s += 10) edge.push(cl.toWorld(s, site.pavedInner(s)));
  const cx = edge.reduce((a, p) => a + p[0], 0) / edge.length, cy = edge.reduce((a, p) => a + p[1], 0) / edge.length;
  const h0 = ovalPose(cl, 0).h, ux = Math.cos(h0), uy = Math.sin(h0);
  const along = edge.map(([x, y]) => (x - cx) * ux + (y - cy) * uy), across = edge.map(([x, y]) => -(x - cx) * uy + (y - cy) * ux);
  const [qx, qy] = new Centerline(built.centerline).toWorld(0, 0);
  for (let t = 0; t < 20; t++) {
    const side = rng.next() < 0.5 ? 1 : -1;
    const u = side * pickIn(rng, [0.15, 0.6]) * (side > 0 ? Math.max(...along) : -Math.min(...along));
    const v = pickIn(rng, [-0.3, 0.3]) * (Math.max(...across) - Math.min(...across)) / 2;
    const centre = [cx + u * ux - v * uy, cy + u * uy + v * ux];
    const angle = h0 + (rng.next() < 0.5 ? 0 : Math.PI / 2) + (rng.next() < 0.5 ? 0 : Math.PI) + pickIn(rng, [-0.2, 0.2]);
    // (Its own centre is left of its start line by R.)
    const c = Math.cos(angle), sn = Math.sin(angle);
    const inner = placeLayout(built, { x: centre[0] - (c * qx - sn * (qy + R)), y: centre[1] - (sn * qx + c * (qy + R)), angle });
    const it = new Track({ ...inner, neighbours: undefined });
    let ok = true;
    for (let s = 0; s < it.length && ok; s += 6) ok = onInfield(...it.toWorld(s, it.outerEdgeAt(s) - 2), 30);
    if (ok) return inner;
  }
  return null;
}

/**
 * Another place a road can leave the speedway (off: at a turn's entry) or
 * rejoin it (at a turn's exit), so that its part from the course's join to it
 * (or from it to the course's leave) still takes in the front stretch and pit
 * road. Null if there isn't one.
 */
function extraJunction(site: RovalSite, sc: { join: number; leave: number }, off: boolean): number | null {
  const { cl, turns, rng } = site;
  const [p0, p1] = site.pitRange;
  const options: number[] = [];
  for (const [a, b] of turns) {
    const s = off ? a - pickIn(rng, [8, 150]) : b + pickIn(rng, [8, 150]);
    const join = off ? sc.join : s, leave = off ? s : sc.leave;
    const kept = cl.distanceFrom(join, leave);
    const along = (x: number) => cl.distanceFrom(join, x);
    if (kept < 150 || cl.length - kept < 150) continue;
    if (along(p0 - 15) < kept && along(p1 + 15) < kept && along(0) < kept && along(p0 - 15) < along(p1 + 15)) options.push(cl.signedS(s));
  }
  return options.length ? options[rng.int(options.length)] : null;
}

/**
 * Every way round the network from a ring's start line (host: the speedway,
 * or the inner oval) back to it: along a way, at each junction ahead on it
 * either on past it or off onto the road that meets it there (heading the way
 * that road runs off), and at the end of a road onto the way it meets; no
 * stretch of a way twice, no one-way ring backwards. A layout cut from the
 * speedway is on it once only (once it's back, it runs on to the line); one
 * cut from the inner oval never touches the speedway. Each route starts with
 * its host's stretch (from where it comes back on round to where it first
 * leaves).
 */
function routes(ways: Way[], junctions: Junction[], host: number): Run[][] {
  const out: Run[][] = [];
  const hosted = ways.map((_, w) => junctions.filter((j) => j.way === w));
  const endOf = (road: number, end: 0 | 1) => junctions.find((j) => j.road === road && j.end === end)!;
  const span = (r: Run) => {
    const w = ways[r.way];
    if (w.track) return { a: w.track.wrapS(r.d > 0 ? r.s0 : r.s1), len: ahead(w, r.s0, r.d, r.s1), L: w.track.length };
    return { a: Math.min(r.s0, r.s1), len: Math.abs(r.s1 - r.s0), L: Infinity };
  };
  // (Two stretches overlap if either starts inside the other; meeting end to end is fine.)
  const overlaps = (p: Run, q: Run) => {
    if (p.way !== q.way) return false;
    const x = span(p), y = span(q);
    const inside = (s: number, r: typeof x) => {
      const off = Number.isFinite(r.L) ? (((s - r.a) % r.L) + r.L) % r.L : s - r.a;
      return off >= 0 && off < r.len - 4;
    };
    return inside(y.a + 2, x) || inside(x.a + 2, y);
  };
  const go = (w: number, s: number, d: 1 | -1, runs: Run[]) => {
    if (out.length >= 300 || runs.length > 24) return;
    const back = runs.length > 0 && w === host;
    type Option = { dist: number; kind: 'close' | 'end' | 'off'; j?: Junction };
    const options: Option[] = [];
    if (back && d > 0) options.push({ dist: ahead(ways[w], s, 1, 0), kind: 'close' });
    if (!(back && host === 0)) {
      for (const j of hosted[w]) {
        const dist = ahead(ways[w], s, d, j.at);
        if (dist > 10 && Number.isFinite(dist)) options.push({ dist, kind: 'off', j });
      }
    }
    if (!ways[w].track) options.push({ dist: d > 0 ? ways[w].length - s : s, kind: 'end', j: endOf(w, d > 0 ? 1 : 0) });
    options.sort((p, q) => p.dist - q.dist);
    for (const o of options) {
      const s1 = o.kind === 'close' ? 0 : o.kind === 'end' ? (d > 0 ? ways[w].length : 0) : o.j!.at;
      const run: Run = { way: w, s0: s, s1, d };
      if (runs.some((r) => overlaps(r, run))) break;
      if (o.kind === 'close') {
        const hostRun: Run = { way: host, s0: s, s1: runs[0].s1, d: 1 };
        const rest = runs.slice(1);
        if (!rest.some((r) => overlaps(r, hostRun))) out.push([hostRun, ...rest]);
        break;
      }
      if (o.kind === 'end') {
        // (Onto the way the road meets: heading t times its own way, or against it, coming back down the road.)
        const j = o.j!, nd = (d * j.t) as 1 | -1;
        if (!(ways[j.way].oneWay && nd < 0) && !(j.way === 0 && host !== 0)) go(j.way, j.at, nd, [...runs, run]);
        break;
      }
      const j = o.j!, e: 1 | -1 = j.end === 0 ? 1 : -1;
      if (e * j.t === d) go(j.road, j.end === 0 ? 0 : ways[j.road].length, e, [...runs, run]);
    }
  };
  go(host, 0, 1, []);
  return out;
}

/**
 * A way round the network as a road course: cut from its host ring (the
 * speedway, or the inner oval) over its front stretch and pit lane, the rest
 * of the lap the course's own sections, closed exactly. Null if it doesn't
 * keep the front stretch.
 */
function layoutOf(route: Run[], ways: Way[], width: number, verge: number): { spec: Omit<RovalSpec, 'id' | 'name'>; length: number; key: string; lap: Array<[number, number]> } | null {
  const host = route[0], ring = ways[host.way], track = ring.track!;
  const [p0, p1] = ring.pit!;
  const kept = track.distanceFrom(host.s0, host.s1), along = (x: number) => track.distanceFrom(host.s0, x);
  // (A margin past the speedway's pit lane; the inner oval's is taken in to its tapers' ends, which is enough.)
  const m = host.way === 0 ? 10 : 1;
  if (!(along(p0 - m) < kept && along(p1 + m) < kept && along(0) < kept && along(p0 - m) < along(p1 + m))) return null;
  const sections = route.slice(1).flatMap((r) => wayRun(ways[r.way], r.s0, r.s1, r.d));
  const { out, back } = cutPoses(track, host.s0, host.s1);
  const closed = closeLap(sections, out, back);
  if (!closed) return null;
  return {
    spec: {
      ...(host.way === 1 ? { host: 'inner' as const } : {}),
      join: track.signedS(host.s0), leave: track.signedS(host.s1), sections: closed, width, verge,
      character: host.way === 1 ? 'short' : 'gp', corners: cornersFor(closed), pit: 'oval',
    },
    length: kept + closed.reduce((a, s) => a + s[0], 0),
    key: route.map((r) => `${r.way}${r.d > 0 ? '+' : '-'}`).join(''),
    lap: [
      ...Array.from({ length: Math.ceil(kept / 10) }, (_, i) => track.toWorld(host.s0 + i * 10, 0)),
      ...integrate(closed, out.x, out.y, out.h, 10).points,
    ],
  };
}

/**
 * Sections run from one pose made to land exactly on another, by the smallest
 * change to their straights (the network's pieces meet where the tracks'
 * sampled poses put them, a little off where integrating a lap does). Null if
 * it's off by more than a little.
 */
function closeLap(sections: Sec[], from: Pose, to: Pose): Sec[] | null {
  const secs = sections.map((s) => [...s] as Sec);
  const straights = secs.map((s, i) => (s[1] === 0 && s[2] === 0 && s[0] > 2 ? i : -1)).filter((i) => i >= 0);
  for (let iter = 0; iter < 5; iter++) {
    const { end } = integrate(secs, from.x, from.y, from.h);
    const r = [to.x - end.x, to.y - end.y];
    if (Math.hypot(r[0], r[1]) < 0.02) break;
    if (Math.hypot(r[0], r[1]) > 6) return null;
    const heads: number[] = [];
    let hh = from.h;
    secs.forEach((s) => { heads.push(hh); hh += (s[0] * (s[1] + s[2])) / 2; });
    let a = 0, b = 0, c = 0;
    for (const i of straights) {
      const ux = Math.cos(heads[i]), uy = Math.sin(heads[i]), w = secs[i][0];
      a += w * ux * ux; b += w * ux * uy; c += w * uy * uy;
    }
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-9) return null;
    const lx = (c * r[0] - b * r[1]) / det, ly = (a * r[1] - b * r[0]) / det;
    for (const i of straights) secs[i][0] += secs[i][0] * (Math.cos(heads[i]) * lx + Math.sin(heads[i]) * ly);
    if (straights.some((i) => secs[i][0] < 1)) return null;
  }
  const { end } = integrate(secs, from.x, from.y, from.h);
  const dh = Math.atan2(Math.sin(end.h - to.h), Math.cos(end.h - to.h));
  return Math.hypot(to.x - end.x, to.y - end.y) < 0.1 && Math.abs(dh) < 0.02 ? secs : null;
}

/**
 * A road from one pose to another across open ground, laid as circuits are
 * where the ground allows: off the first track at a slant (not square to it),
 * routed through the open infield (keeping to the middle of open ground, not
 * skirting what bounds it) by way of a point or two in its emptiest parts, so
 * it spreads out as a circuit does, and onto the second track at a slant; the
 * route's bends then corners from the circuit vocabulary, eased in and out,
 * those that barely turn left out. Null if it didn't fit in a few tries.
 */
function connect(
  from: Pose, to: Pose, free: (x: number, y: number, m: number) => boolean, rng: Rng, width: number, scale: number,
  area: { minX: number; maxX: number; minY: number; maxY: number },
  speeds: [number | undefined, number | undefined] = [undefined, undefined],
  rooms: [number, number] = [Infinity, Infinity],
): Sec[] | null {
  const names = Object.keys(CHARACTERS);
  const ch = CHARACTERS[names[rng.int(names.length)]];
  const margin = width / 2 + 6, CELL = 6;
  const x0 = area.minX, y0 = area.minY;
  const nx = Math.ceil((area.maxX - x0) / CELL) + 1, ny = Math.ceil((area.maxY - y0) / CELL) + 1, N = nx * ny;
  const cellOf = (x: number, y: number) => {
    const i = Math.round((x - x0) / CELL), j = Math.round((y - y0) / CELL);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  };
  const at = (c: number): [number, number] => [x0 + (c % nx) * CELL, y0 + Math.floor(c / nx) * CELL];
  // Open ground, and how far each cell is from the edge of it (in cells).
  const open = new Uint8Array(N);
  for (let c = 0; c < N; c++) open[c] = free(...at(c), margin) ? 1 : 0;
  const clear = new Int16Array(N).fill(-1);
  let frontier: number[] = [];
  for (let c = 0; c < N; c++) if (!open[c]) { clear[c] = 0; frontier.push(c); }
  for (let dist = 1; frontier.length; dist++) {
    const next: number[] = [];
    for (const c of frontier) {
      const i = c % nx, j = Math.floor(c / nx);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const k = b * nx + a;
        if (clear[k] < 0) { clear[k] = dist; next.push(k); }
      }
    }
    frontier = next;
  }
  for (let t = 0; t < 6; t++) {
    // Off a track (or onto one) where the field is quick: a bend designed for a speed, a share of what it carries
    // there, its radius what the tyres hold at that speed. A sweep: fast, at a shallow angle, no hard braking; or a
    // bend at a more moderate speed, braked for on the track, at a steeper angle. (Nothing designed off a road.)
    const ends = speeds.map((v, i) => {
      if (v === undefined) return null;
      const sweep = rng.next() < 0.4;
      const design = v * pickIn(rng, sweep ? [0.4, 0.55] : [0.22, 0.38]);
      // (Leaving or joining partway round a turn, it turns tighter than the turn does.)
      const k = Math.abs((i ? to : from).k);
      let radius = Math.min((design * design) / (P.TIRE_MU * G), k > 1e-6 ? 0.8 / k : Infinity);
      let slant = (pickIn(rng, sweep ? [12, 30] : [25, 55]) * Math.PI) / 180;
      // On a straight, the bend's run-in fits before the track turns (or, after it, its run-out once the track has
      // straightened): shallower if it must, and failing that slower.
      if (k <= 1e-6) {
        const fit = rooms[i] - 15;
        // (Right at a turn, no straight to lay a bend on: off as any road is.)
        if (fit < 10) return null;
        if (radius * Math.tan(slant / 2) > fit) slant = Math.max((12 * Math.PI) / 180, 2 * Math.atan(fit / radius));
        if (radius * Math.tan(slant / 2) > fit) radius = fit / Math.tan(slant / 2);
      }
      return { radius, slant, lead: radius * Math.tan(slant / 2) + 15 };
    });
    // (On a straight, a lead along it to the bend: at least as long as the bend's run-in, and no further than the
    // track runs straight.)
    const lead = (p: Pose, i: 0 | 1) => {
      if (Math.abs(p.k) > 1e-6) return 0;
      const want = Math.max(pickIn(rng, [45, 90]), ends[i]?.lead ?? 0);
      return ends[i] ? Math.min(want, Math.max(ends[i]!.lead, rooms[i])) : want;
    };
    const leads: [number, number] = [lead(from, 0), lead(to, 1)];
    const eA: [number, number] = [from.x + leads[0] * Math.cos(from.h), from.y + leads[0] * Math.sin(from.h)];
    const eB: [number, number] = [to.x - leads[1] * Math.cos(to.h), to.y - leads[1] * Math.sin(to.h)];
    // Off a track and onto one at a slant, to whichever side is open.
    const slant = (p: Pose, e: [number, number], dir: 1 | -1, end: (typeof ends)[number]): [number, number] | null => {
      const first = rng.next() < 0.5 ? 1 : -1;
      // (Far enough on for the bend to run out before the next.)
      const out = end ? end.radius * Math.tan(end.slant / 2) + 30 : 0;
      for (let k = 0; k < 8; k++) {
        const side = k % 2 ? -first : first;
        // (At a shallow slant, on far enough to be clear of the track's pavement: the road runs on beside it a while.)
        const clearOf = end ? Math.min(400, 60 / Math.sin(Math.max(end.slant, 0.1))) : 0;
        const far = Math.max(out, clearOf, pickIn(rng, [60, 120]) * Math.max(0.7, scale));
        // (Partway round a turn, off it at more than the turn itself bends over that far, or it's still on it.)
        const own = end ? Math.max(end.slant, Math.abs(p.k) > 1e-6 ? (far * Math.abs(p.k)) / 2 + (15 * Math.PI) / 180 : 0) : 0;
        const a = p.h + side * (end ? own : (pickIn(rng, [25, 60]) * Math.PI) / 180);
        const q: [number, number] = [e[0] + dir * far * Math.cos(a), e[1] + dir * far * Math.sin(a)];
        const c = cellOf(...q);
        if (c >= 0 && clear[c] >= 2) return q;
      }
      return null;
    };
    const pA = slant(from, eA, 1, ends[0]), pB = slant(to, eB, -1, ends[1]);
    if (!pA || !pB) continue;
    // A point or two on the way, in open ground well away from everything (the emptiest the likeliest), in order.
    const vias: Array<[number, number]> = [];
    const wanted = rng.int(3);
    for (let k = 0, tries = 0; k < wanted && tries < 400; tries++) {
      const c = rng.int(N);
      if (clear[c] < 6 || rng.next() > clear[c] / 25) continue;
      vias.push(at(c));
      k++;
    }
    const ux = pB[0] - pA[0], uy = pB[1] - pA[1];
    vias.sort((p, q) => ((p[0] - pA[0]) * ux + (p[1] - pA[1]) * uy) - ((q[0] - pA[0]) * ux + (q[1] - pA[1]) * uy));
    // Routed leg by leg, each kept off the legs before it.
    const stops = [pA, ...vias, pB];
    const blocked = new Uint8Array(N);
    const keepOff = Math.ceil((width + 20) / CELL);
    const path: Array<[number, number]> = [];
    let ok = true;
    for (let leg = 0; leg + 1 < stops.length && ok; leg++) {
      const a = cellOf(...stops[leg]), b = cellOf(...stops[leg + 1]);
      const cells = a >= 0 && b >= 0 ? route(a, b, nx, ny, (c) => open[c] === 1 && !blocked[c], clear) : null;
      if (!cells) { ok = false; break; }
      const pts = cells.map(at);
      path.push(...(leg ? pts.slice(1) : pts));
      // (Off the way so far, but round the stop the next leg sets off from.)
      for (const c of cells) {
        const i = c % nx, j = Math.floor(c / nx);
        for (let dj = -keepOff; dj <= keepOff; dj++) for (let di = -keepOff; di <= keepOff; di++) {
          const p = i + di, q = j + dj;
          if (p >= 0 && q >= 0 && p < nx && q < ny && di * di + dj * dj <= keepOff * keepOff) blocked[q * nx + p] = 1;
        }
      }
      const bi = b % nx, bj = Math.floor(b / nx);
      for (let dj = -keepOff - 2; dj <= keepOff + 2; dj++) for (let di = -keepOff - 2; di <= keepOff + 2; di++) {
        const p = bi + di, q = bj + dj;
        if (p >= 0 && q >= 0 && p < nx && q < ny) blocked[q * nx + p] = 0;
      }
    }
    if (!ok) continue;
    // Its bends: the route simplified, none crowding another, none barely turning.
    let pts = simplify(path, pickIn(rng, [10, 22]));
    pts = [pA, ...pts.slice(1, -1), pB];
    const roomy = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 50;
    pts = pts.filter((p, i) => i === 0 || i === pts.length - 1 || (roomy(p, pts[i - 1]) && roomy(p, pB)));
    pts = withoutKinks(from, to, pts);
    const floors: Array<number | undefined> = [ends[0]?.radius, ...pts.map(() => undefined), ends[1]?.radius];
    const sections = poseSection(from, to, pts, leads, rng, width, { radiusScale: ch.radius, minStraight: 12, floors });
    if (sections && paced(sections, speeds)) return sections;
  }
  return null;
}

/** Top speed: where the engine's power is all spent against drag. */
const TOP_SPEED = Math.cbrt((2 * P.ENGINE_POWER) / (P.AIR_DENSITY * P.CDA));
const drag = (v: number) => (0.5 * P.AIR_DENSITY * P.CDA * v * v) / P.DRY_MASS;
/** Full braking at v (tyres and drag), and full drive (engine, less drag). */
const braking = (v: number) => P.TIRE_MU * G + drag(v);
const drive = (v: number) => Math.min(P.MAX_DRIVE_ACCEL, P.ENGINE_POWER / (P.DRY_MASS * Math.max(v, 1))) - drag(v);

/**
 * The speed the field carries round a ring (on its centerline, with its
 * banking), every 2 m: as fast as the tyres hold each turn, flat out from the
 * slowest point, braking for what comes. As racingLine's profile is, less the
 * friction ellipse: what a junction there takes in or hands back.
 */
export function ringSpeeds(track: Centerline, bankAt: (s: number) => number): (s: number) => number {
  const n = Math.max(8, Math.ceil(track.length / 2)), ds = track.length / n, mu = P.TIRE_MU;
  const v = new Float64Array(n);
  let slowest = 0;
  for (let k = 0; k < n; k++) {
    const th = bankAt(track.signedS(k * ds)), c = Math.cos(th), sn = Math.sin(th);
    const cap = (G * (sn + mu * c)) / Math.max(0.05, c - mu * sn);
    const kap = Math.abs(track.curvatureAt(k * ds));
    v[k] = kap > 1e-6 ? Math.min(TOP_SPEED, Math.sqrt(cap / kap)) : TOP_SPEED;
    if (v[k] < v[slowest]) slowest = k;
  }
  for (let j = 1; j < n; j++) {
    const k = (slowest + j - 1) % n, nx = (slowest + j) % n;
    v[nx] = Math.min(v[nx], Math.sqrt(v[k] * v[k] + 2 * drive(v[k]) * ds));
  }
  for (let j = 1; j < n; j++) {
    const k = (slowest - j + n) % n, nx = (k + 1) % n;
    v[k] = Math.min(v[k], Math.sqrt(v[nx] * v[nx] + 2 * braking(v[nx]) * ds));
  }
  return (s) => v[Math.round(track.wrapS(s) / ds) % n];
}

/**
 * A road off a track at speed (in, m/s) and onto one (out), paced as a
 * junction should be: its first bend is never braked through for something
 * after it (there is room past it to brake for the next corner), and its last
 * is reached at its own speed (room before it to accelerate out of the corner
 * before). Flat road, the tyres' grip, full braking and drive.
 */
function paced(sections: Sec[], [vIn, vOut]: [number | undefined, number | undefined]): boolean {
  if (vIn === undefined && vOut === undefined) return true;
  const du = 2, mu = P.TIRE_MU;
  const kap: number[] = [];
  for (const [len, k0, k1] of sections) {
    const m = Math.max(1, Math.round(len / du));
    for (let i = 0; i < m; i++) kap.push(Math.abs(k0 + ((k1 - k0) * (i + 0.5)) / m));
  }
  const n = kap.length;
  const vmax = kap.map((k) => (k > 1e-6 ? Math.sqrt((mu * G) / k) : TOP_SPEED));
  // (The first and last bends: the runs of curving road in from either end, in order along the road.)
  const bend = (from: number, dir: 1 | -1) => {
    let i = from;
    while (i >= 0 && i < n && kap[i] <= 1e-6) i += dir;
    const out: number[] = [];
    while (i >= 0 && i < n && kap[i] > 1e-6) { out.push(i); i += dir; }
    return dir > 0 ? out : out.reverse();
  };
  /** A bend's apex (its tightest point) and what comes after it. */
  const apexOn = (run: number[]) => {
    let at = 0;
    run.forEach((i, j) => { if (kap[i] > kap[run[at]]) at = j; });
    return { apex: run[at], exit: run.slice(at) };
  };
  if (vIn !== undefined) {
    const back = new Float64Array(n);
    back[n - 1] = vmax[n - 1];
    for (let i = n - 2; i >= 0; i--) back[i] = Math.min(vmax[i], Math.sqrt(back[i + 1] ** 2 + 2 * braking(back[i + 1]) * du));
    // (Its apex at its own speed, and out of it no braking below that for what comes next.)
    const run = bend(0, 1);
    if (run.length) {
      const { apex, exit } = apexOn(run);
      const v = 0.97 * Math.min(vmax[apex], vIn);
      if (exit.some((i) => back[i] < v)) return false;
    }
  }
  if (vOut !== undefined) {
    const fwd = new Float64Array(n);
    fwd[0] = Math.min(vmax[0], vIn ?? TOP_SPEED);
    for (let i = 1; i < n; i++) fwd[i] = Math.min(vmax[i], Math.sqrt(fwd[i - 1] ** 2 + 2 * Math.max(0, drive(fwd[i - 1])) * du));
    // (Its apex reached at its own speed.)
    const run = bend(n - 1, -1);
    if (run.length) {
      const { apex } = apexOn(run);
      if (fwd[apex] < 0.97 * Math.min(vmax[apex], vOut)) return false;
    }
  }
  return true;
}

/** A cheapest way between two cells (8 ways round), dearer near the edge of open ground (cells < 10 clear). */
function route(a: number, b: number, nx: number, ny: number, open: (c: number) => boolean, clear: Int16Array): number[] | null {
  const N = nx * ny;
  const cost = new Float64Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const bx = b % nx, by = Math.floor(b / nx);
  const h = (c: number) => Math.hypot((c % nx) - bx, Math.floor(c / nx) - by);
  const heap: Array<[number, number]> = [];
  const push = (f: number, c: number) => {
    heap.push([f, c]);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  cost[a] = 0;
  push(h(a), a);
  while (heap.length) {
    const [, c] = pop();
    if (done[c]) continue;
    done[c] = 1;
    if (c === b) break;
    const i = c % nx, j = Math.floor(c / nx);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const p = i + di, q = j + dj;
      if (p < 0 || q < 0 || p >= nx || q >= ny) continue;
      const k = q * nx + p;
      if (done[k] || (k !== b && !open(k))) continue;
      const step = Math.hypot(di, dj) * (1 + 3 * Math.max(0, 1 - clear[k] / 10));
      if (cost[c] + step < cost[k]) { cost[k] = cost[c] + step; came[k] = c; push(cost[k] + h(k), k); }
    }
  }
  if (!done[b]) return null;
  const out: number[] = [];
  for (let c = b; c >= 0; c = came[c]) out.unshift(c);
  return out;
}

/** A polyline with the points that lie within tol of the line between their neighbours left out (Douglas-Peucker). */
function simplify(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let worst = 0, at = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - ax) * (by - ay) - (pts[i][1] - ay) * (bx - ax)) / len;
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

/** Points bucketed in square cells, to ask quickly whether any is near. */
class PointGrid {
  private cells = new Map<number, Array<[number, number]>>();
  constructor(private size: number) {}
  private key(i: number, j: number) { return (i + 8192) * 16384 + (j + 8192); }
  add(x: number, y: number): void {
    const key = this.key(Math.floor(x / this.size), Math.floor(y / this.size));
    const cell = this.cells.get(key);
    if (cell) cell.push([x, y]); else this.cells.set(key, [[x, y]]);
  }
  rebuild(points: Array<[number, number]>): void {
    this.cells.clear();
    for (const [x, y] of points) this.add(x, y);
  }
  near(x: number, y: number, r: number): boolean {
    const i0 = Math.floor((x - r) / this.size), i1 = Math.floor((x + r) / this.size);
    const j0 = Math.floor((y - r) / this.size), j1 = Math.floor((y + r) / this.size);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const cell = this.cells.get(this.key(i, j));
      if (cell) for (const [u, v] of cell) if ((x - u) ** 2 + (y - v) ** 2 < r * r) return true;
    }
    return false;
  }
}

/** Convex hull of points (monotone chain). */
function hull(pts: Array<[number, number]>): Array<[number, number]> {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function polygonArea(pts: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/**
 * Where a course cut from a track between `join` and `leave` (signed s) leaves
 * and rejoins it, as poses: rejoining at the track's own pose there, leaving
 * at the end of its kept part integrated from that (as the layout's lap is),
 * so the lap closes exactly.
 */
function cutPoses(track: Centerline, join: number, leave: number): { out: Pose; back: Pose } {
  const back = ovalPose(track, join);
  const sections = track.spec.sections;
  const j0 = track.wrapS(join), part = track.distanceFrom(join, leave), L = track.length;
  const kept = j0 + part <= L
    ? sliceSections(sections, j0, j0 + part)
    : [...sliceSections(sections, j0, L), ...sliceSections(sections, 0, j0 + part - L)];
  const end = integrate(kept, back.x, back.y, back.h).end;
  return { out: { x: end.x, y: end.y, h: end.h, k: track.curvatureAt(leave) }, back };
}

/** Run-off settings for a course's corners (an open infield: gravel where there is any). */
function cornersFor(sections: Array<[number, number, number]>): RovalSpec['corners'] {
  return cornersOf(sections, 0, 1, 1).map(() => ({ runoff: 'gravel' as const, apexWall: false, bare: false }));
}

/**
 * A loop round the outside of the end of a track (from pose `from`, before
 * its turn, round to `to`, after it): points round the turn's centre, out
 * from it by a distance that wanders (now and then much further out), so the
 * loop follows the track's shape there, bigger and less regular, as a
 * course's own way round the end of an inner oval does. Each point a corner
 * from the circuit vocabulary; corners that barely turn left out. Null if it
 * doesn't fit.
 */
function around(
  track: Track, from: Pose, to: Pose, free: (x: number, y: number, m: number) => boolean, rng: Rng, width: number, scale: number,
): Sec[] | null {
  const names = Object.keys(CHARACTERS);
  const ch = CHARACTERS[names[rng.int(names.length)]];
  const leave = track.project(from.x, from.y).s, join = track.project(to.x, to.y).s;
  const span = track.distanceFrom(leave, join);
  // (Enough corners to round the end, not so few it comes out an arrowhead; out a steady way, now and then further.)
  const m = Math.max(4, Math.min(9, Math.round(span / pickIn(rng, [45, 80]))));
  const base = pickIn(rng, [40, 110]) * scale;
  const out = Array.from({ length: m }, () => Math.max(30, base * (1 + ch.roughness * rng.gaussian())));
  if (rng.next() < 0.5) out[1 + rng.int(m - 2)] *= pickIn(rng, [1.3, 1.6]);
  // Round the centre of the turn it skips, in order, from where it leaves to where it rejoins.
  let ox = 0, oy = 0, w = 0, rTurn = 0;
  for (let s = leave; s <= leave + span; s += 2) {
    const k = track.curvatureAt(s);
    if (k < 1e-4) continue;
    const [x, y] = track.toWorld(s, 0), [nx, ny] = track.toWorld(s, 1);
    ox += x + (nx - x) / k; oy += y + (ny - y) / k; rTurn += 1 / k; w++;
  }
  if (!w) return null;
  ox /= w; oy /= w; rTurn /= w;
  const a0 = Math.atan2(from.y - oy, from.x - ox);
  let sweep = Math.atan2(to.y - oy, to.x - ox) - a0;
  while (sweep <= 0) sweep += 2 * Math.PI;
  let pts: Array<[number, number]> = [];
  for (let k = 0; k < m; k++) {
    const a = a0 + (sweep * (k + 0.5 + 0.3 * (rng.next() - 0.5))) / m;
    // (Out as far as wanted, or as far as the ground allows.)
    let r = rTurn + out[k];
    while (r > rTurn + 25 && !free(ox + r * Math.cos(a), oy + r * Math.sin(a), width / 2 + 6)) r -= 5;
    if (r <= rTurn + 25) return null;
    pts.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]);
  }
  const leads: [number, number] = [pickIn(rng, [25, 45]), pickIn(rng, [25, 45])];
  pts = withoutKinks(from, to, pts);
  return poseSection(from, to, pts, leads, rng, width, { radiusScale: ch.radius, minStraight: 10 });
}

/** Points that would make corners turning less than 28 degrees left out, until none do (a kink is no corner). */
function withoutKinks(from: Pose, to: Pose, pts: Array<[number, number]>): Array<[number, number]> {
  const MIN = (28 * Math.PI) / 180;
  const out = [...pts];
  for (let guard = 0; guard < 20; guard++) {
    const verts: Array<[number, number]> = [[from.x, from.y], ...out, [to.x, to.y]];
    let worst = -1, least = MIN;
    for (let i = 1; i + 1 < verts.length; i++) {
      const h0 = Math.atan2(verts[i][1] - verts[i - 1][1], verts[i][0] - verts[i - 1][0]);
      const h1 = Math.atan2(verts[i + 1][1] - verts[i][1], verts[i + 1][0] - verts[i][0]);
      const turn = Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)));
      if (turn < least) { least = turn; worst = i - 1; }
    }
    if (worst < 0) break;
    out.splice(worst, 1);
  }
  return out;
}

/** A piece on free ground (but near its ends, where it meets a track) and clear of itself beyond a corner's own legs. */
function clearPiece(sections: Array<[number, number, number]>, from: Pose, free: (x: number, y: number, m: number) => boolean, width: number): boolean {
  const way = integrate(sections, from.x, from.y, from.h, 4).points;
  // (Free of the tracks once it's off them: at each end it runs on one before it peels off, but not far.)
  const m = width / 2 + 3;
  let i0 = 0, i1 = way.length - 1;
  while (i0 < way.length && !free(way[i0][0], way[i0][1], m)) i0++;
  while (i1 > i0 && !free(way[i1][0], way[i1][1], m)) i1--;
  if (i0 * 4 > 200 || (way.length - 1 - i1) * 4 > 200) return false;
  for (let i = i0; i <= i1; i++) if (!free(way[i][0], way[i][1], m)) return false;
  const apart = width + 30, near = Math.ceil(100 / 4);
  for (let i = 0; i < way.length; i++) {
    for (let j = i + near; j < way.length; j++) {
      if (Math.hypot(way[i][0] - way[j][0], way[i][1] - way[j][1]) < apart) return false;
    }
  }
  return true;
}

const widest = new WeakMap<RovalSite, number>();
/** How far in the oval's pavement reaches at most. */
function widestPavement(site: RovalSite): number {
  let w = widest.get(site);
  if (w === undefined) {
    w = 0;
    for (let s = 0; s < site.cl.length; s += 5) w = Math.max(w, site.pavedInner(s));
    widest.set(site, w);
  }
  return w;
}

/**
 * A course's corners from its curvature: each run of curving sections between
 * straights, the first starting `at` metres round the lap (L long), with the
 * straights before its first corner and after its last (what the corners ask
 * of the cross-section depends on them: a corner off a long straight is
 * braked into).
 */
function cornersOf(sections: Array<[number, number, number]>, at: number, before: number, after: number, L = Infinity): CornerAt[] {
  const out: CornerAt[] = [];
  const signed = (x: number) => {
    if (!Number.isFinite(L)) return x;
    const r = ((x % L) + L) % L;
    return r > L / 2 ? r - L : r;
  };
  let s = 0, run = before, i = 0;
  while (i < sections.length) {
    const [len, k0, k1] = sections[i];
    if (k0 === 0 && k1 === 0) { s += len; run += len; i++; continue; }
    // A corner: every curving section until the next straight.
    let j = i, angle = 0, kmax = 0, total = 0;
    while (j < sections.length && !(sections[j][1] === 0 && sections[j][2] === 0)) {
      const [l, a, b] = sections[j];
      angle += (l * (a + b)) / 2;
      kmax = Math.max(kmax, Math.abs(a), Math.abs(b));
      total += l;
      j++;
    }
    const first = sections[i], last = sections[j - 1];
    const easeIn = Math.abs(first[1]) < Math.abs(first[2]) ? first[0] : 0;
    const easeOut = Math.abs(last[2]) < Math.abs(last[1]) ? last[0] : 0;
    const s0 = signed(at + s);
    out.push({
      s0, a0: s0 + easeIn, a1: s0 + total - easeOut, s1: s0 + total,
      spec: { angle, radius: 1 / Math.max(kmax, 1e-6), ease: Math.max(easeIn, easeOut) },
      runoff: 'gravel', apexWall: false, bare: false, before: run, after: 0, chicane: -1, turn: Math.abs(angle),
    });
    s += total;
    run = 0;
    i = j;
  }
  out.forEach((c, k) => { c.after = k + 1 < out.length ? out[k + 1].before : run + after; });
  markChicanes(out);
  return out;
}

/**
 * A road course as a layout of its own (kind road): the oval's part of the
 * lap with its banking, edges and pit road (when it pits there), and its own
 * course laid out as a circuit is, bounded by the oval's pavement. The oval
 * (and whatever is in its infield) comes along as scenery; barriers close
 * the oval where the course leaves and rejoins it.
 */
export function compileRoval(oval: TrackLayout, spec: RovalSpec): TrackLayout {
  // (The same spec compiles the same: validation and the venue's layouts both ask, and it takes a while.)
  const known = compiled.get(spec);
  if (known) return known;
  const layout = compile(oval, spec);
  compiled.set(spec, layout);
  return layout;
}

const compiled = new WeakMap<RovalSpec, TrackLayout>();

function compile(venue: TrackLayout, spec: RovalSpec): TrackLayout {
  // (The track it is cut from: the speedway, or the inner oval in its infield.)
  const oval = spec.host === 'inner' ? venue.neighbours?.find((n) => n.id.endsWith('/inner')) : venue;
  if (!oval) throw new Error(`roval ${spec.id}: no inner oval to lay it on`);
  const ovalTrack = new Track({ ...oval, neighbours: undefined });
  const Lo = ovalTrack.length;
  const cs = oval.crossSection;
  const part = ovalTrack.distanceFrom(spec.join, spec.leave);
  const own = spec.sections.reduce((a, sec) => a + sec[0], 0);
  const Lr = part + own;
  // The lap from where the course joins the oval: the oval's part, then the course (u: metres from there).
  const j0 = ovalTrack.wrapS(spec.join);
  const ovalSecs = j0 + part <= Lo
    ? sliceSections(oval.centerline.sections, j0, j0 + part)
    : [...sliceSections(oval.centerline.sections, j0, Lo), ...sliceSections(oval.centerline.sections, 0, j0 + part - Lo)];
  const full = [...ovalSecs, ...spec.sections];
  // The start line: the oval's (pitting on its pit road), or the middle of the straight with the pit lane.
  const u0 = spec.pit === 'oval' ? ovalTrack.distanceFrom(spec.join, 0) : part + spec.pit.at;
  const sections = [...sliceSections(full, u0, Lr), ...sliceSections(full, 0, u0)];
  const centerline = { kind: 'curvature' as const, sections };
  const joinPose = ovalPose(ovalTrack, spec.join);
  const start = integrate(sliceSections(full, 0, u0), joinPose.x, joinPose.y, joinPose.h).end;
  const [qx, qy] = new Centerline(centerline).toWorld(0, 0);
  const angle = start.h;
  const placement = { x: start.x - (Math.cos(angle) * qx - Math.sin(angle) * qy), y: start.y - (Math.sin(angle) * qx + Math.cos(angle) * qy), angle };
  const cl = new Centerline(centerline, placement);
  const L = cl.length;
  const signed = (x: number) => { const r = ((x % L) + L) % L; return r > L / 2 ? r - L : r; };
  const sOf = (u: number) => signed(u - u0);
  const uOf = (s: number) => (((s + u0) % L) + L) % L;
  const onOval = (u: number) => u < part;
  /** The oval's s at a point on its part. */
  const ovalS = (u: number) => ovalTrack.signedS(spec.join + u);
  const half = spec.width / 2;
  const courseStart = sOf(part);
  const courseRange: [number, number] = [courseStart, courseStart + own];

  // ---- the pit lane ----
  let pit = oval.pit, pitPaved: Profile | null = null, garage = oval.infield.garage, buildings: Decoration[] = oval.decor.filter((d) => d.kind === 'building');
  if (spec.pit === 'oval') {
    // Its pit lane's tapers in and out kept to its part of the oval (they may run on round turns it skips).
    // (Measured along its part of the oval from where it rejoins: past that part either end, cut back to it.)
    const along = (x: number) => ovalTrack.distanceFrom(spec.join, x);
    const wall = along(pit.wallStart);
    pit = {
      ...pit,
      entryStart: along(pit.entryStart) > wall || along(pit.entryStart) < 15 ? ovalTrack.signedS(spec.join + 15) : pit.entryStart,
      exitEnd: along(pit.exitEnd) > part - 15 ? ovalTrack.signedS(spec.join + part - 15) : pit.exitEnd,
      blendEnd: along(pit.blendEnd) > part - 5 ? ovalTrack.signedS(spec.join + part - 5) : pit.blendEnd,
    };
  }
  let zone: PitZone;
  if (spec.pit === 'oval') {
    // (Nothing of the course's cross-section is the pit lane's: it is on the oval.)
    zone = { entryStart: sOf(part / 2), blendEnd: sOf(part / 2), gap: () => 0 };
  } else {
    const main = spec.pit.main;
    const wallStart = -main / 2 + CIRCUIT_PIT.ENTRY_LENGTH + CIRCUIT_PIT.START_MARGIN;
    const wallEnd = main / 2 - CIRCUIT_PIT.EXIT_TAPER - CIRCUIT_PIT.END_MARGIN;
    ({ pit, pavedInner: pitPaved } = pitLane({
      innerEdge: half, apronWidth: 0, wallStart, wallEnd, blendEnd: wallEnd + CIRCUIT_PIT.EXIT_TAPER + 10,
      entryLength: CIRCUIT_PIT.ENTRY_LENGTH, exitTaper: CIRCUIT_PIT.EXIT_TAPER,
      wallGap: CIRCUIT_PIT.WALL_GAP, wallThickness: CIRCUIT_PIT.WALL_THICKNESS, roadWidth: CIRCUIT_PIT.ROAD_WIDTH,
      stallSpacing: CIRCUIT_PIT.STALL_SPACING,
    }));
    ({ garage, buildings } = garageLot(cl, { s0: pit.wallStart + 20, s1: pit.wallEnd - 20, d0: pit.roadD, depth: CIRCUIT_PIT.GARAGE_DEPTH }));
    zone = pitZone(pit, pitPaved, garage.lot, half, L);
  }

  // ---- what bounds the course: the oval's pavement (and beyond it), the oval's garage ----
  const n = geometrySamples(L), step = L / n;
  const bound: Bound = { left: new Float64Array(n).fill(Infinity), right: new Float64Array(n).fill(Infinity) };
  const lot = oval.infield.garage.lot;
  let paved = lot.d1 + 3;
  for (let s = 0; s < Lo; s += 5) paved = Math.max(paved, ovalTrack.pavedInnerD(s) + 1);
  /** How far a point is from the oval's pavement (and, with a pit lane of its own, the oval's garage): 0 on it. */
  const REACH = 60;
  const gapAt = (x: number, y: number) => {
    const q = ovalTrack.near(x, y, paved + REACH);
    if (!q) return REACH;
    let g = q.d - ovalTrack.pavedInnerD(q.s) - 1;
    if (spec.pit !== 'oval' && ovalTrack.inRange(q.s, [lot.s0, lot.s1])) g = Math.min(g, q.d - lot.d1 - 3);
    return Math.max(0, g);
  };
  for (let k = 0; k < n; k++) {
    const s = k * step;
    if (onOval(uOf(s))) continue;
    for (const [side, arr] of [[1, bound.left], [-1, bound.right]] as const) {
      // (Out to REACH m, in steps as long as the clear ground ahead: an open infield's course asks no more of it.)
      let t = 0;
      while (t < REACH) {
        const g = gapAt(...cl.toWorld(s, side * t));
        if (g < 1) break;
        t += Math.max(1.5, g);
      }
      arr[k] = t >= REACH ? Infinity : t;
    }
  }

  // ---- the course's cross-section: an open infield ----
  // Flat, mown ground all round: no barriers along the course and no run-off fields, but kerbs at the corners and a
  // little gravel round the outside of a hairpin at the end of a long leg. (Walls only where a car running off would
  // reach something: the venue lays those, trackgen/walls.ts.)
  const corners = cornersOf(spec.sections, courseStart, part, part, L).map((c, i) => {
    const trap = c.turn > (120 * Math.PI) / 180 && c.before > 150;
    return { ...c, ...(spec.corners[i] ?? {}), runoff: 'gravel' as const, depthScale: trap ? 0.35 : 0, trap };
  });
  const course: Course = { width: spec.width, verge: spec.verge, corners };
  const dressed = dressCourse(course, cl, zone, { spec: centerline, bound, range: courseRange, walls: [null, null] });
  const ownWalls: Wall[] = [];
  // (Of the circuit dressing: kerbs, and the gravel round those hairpins; no verges, no other run-off.)
  const keepSurface = (id: string) => id.startsWith('kerb') || corners.some((c, i) => c.trap && new RegExp(`^runoff${i}[lr]`).test(id));
  // None of it on an oval's pavement (the speedway's or the inner oval's): where the course is still on a track it
  // leaves or is coming back onto, that track is the oval's, unmarked. A kerb goes whole (with its tapered ends) or
  // not at all.
  const ovals = [venue, ...(venue.neighbours ?? []).filter((nb) => layoutKind(nb) !== 'road')].map((o) => new Track({ ...o, neighbours: undefined }));
  const onOvalPavement = (x: number, y: number) => ovals.some((t) => {
    const q = t.near(x, y, t.reach);
    return !!q && q.d > t.outerEdgeAt(q.s) - 0.5 && q.d < t.pavedInnerD(q.s) + 0.5;
  });
  const group = (id: string) => id.replace(/-(in|out)$/, '');
  const offPavement = new Map<string, boolean>();
  for (const r of dressed.surfaces) {
    if (!keepSurface(r.id) || r.shape.kind !== 'band' || !r.shape.range) continue;
    const { range: [a, b], d0, d1 } = r.shape;
    let clear = true;
    for (let s = a; s <= b && clear; s += 2) {
      for (const d of [evalEdge(d0, s, L), evalEdge(d1, s, L)]) if (onOvalPavement(...cl.toWorld(s, d))) clear = false;
    }
    offPavement.set(group(r.id), (offPavement.get(group(r.id)) ?? true) && clear);
  }
  const dressedSurfaces = dressed.surfaces.filter((r) => keepSurface(r.id) && offPavement.get(group(r.id)) !== false);

  // ---- profiles round the lap: the oval's on its part, the course's on its own, easing between over RAMP m ----
  const profile = (onOvalAt: (os: number) => number, onCourse: (s: number) => number): Profile => {
    const keys: Array<[number, number]> = [];
    for (let u = 0; u < Lr; u += onOval(u) ? 10 : 2.5) {
      const s = sOf(u);
      if (onOval(u)) { keys.push([s, onOvalAt(ovalS(u))]); continue; }
      const mine = onCourse(s);
      const into = Math.max(0, 1 - (u - part) / RAMP), outOf = Math.max(0, 1 - (Lr - u) / RAMP);
      keys.push([s, mine + (onOvalAt(spec.leave) - mine) * into + (onOvalAt(spec.join) - mine) * outOf]);
    }
    keys.sort((a, b) => a[0] - b[0]);
    return { keys: keys.filter((k, i) => i === 0 || k[0] - keys[i - 1][0] > 1e-6), ease: 'linear' };
  };
  const edgeIn = profile((os) => evalEdge(cs.edgeIn, os, Lo), (s) => evalProfile(dressed.edgeIn, s, L));
  const edgeOut = profile((os) => evalEdge(cs.edgeOut, os, Lo), (s) => evalProfile(dressed.edgeOut, s, L));
  const pavedInner = profile(
    (os) => evalEdge(cs.pavedInner, os, Lo),
    (s) => Math.max(evalProfile(dressed.edgeIn, s, L), pitPaved ? evalProfile(pitPaved, s, L) : 0),
  );
  // (Its apron on the oval: the oval's own, not as far as pit road, which is the oval's to draw.)
  const apronEdge = profile((os) => evalEdge(cs.edgeIn, os, Lo) + cs.apronWidth, (s) => evalProfile(dressed.edgeIn, s, L));
  const bankInner = profile((os) => evalProfile(cs.bankInner, os, Lo), () => 0);
  const bankOuter = profile((os) => evalProfile(cs.bankOuter, os, Lo), () => 0);
  const bankInfield = profile((os) => evalProfile(cs.bankInfield, os, Lo), () => 0);

  // ---- closures: across the oval just past where the course leaves it and just before it rejoins ----
  const barriers: Barrier[] = [];
  const apronAt = (os: number) => ovalTrack.pavedInnerD(os);
  const across = (os: number, upTo: number, id: string) => {
    barriers.push({ id, thickness: 1, points: [ovalTrack.toWorld(os, ovalTrack.outerEdgeAt(os) + 0.6), ovalTrack.toWorld(os, upTo)] });
  };
  {
    const leavePose = ovalPose(ovalTrack, spec.leave);
    const pts = integrate(spec.sections, leavePose.x, leavePose.y, leavePose.h, 2).points;
    const proj = pts.map(([x, y]) => ovalTrack.near(x, y, paved + 20));
    // (Off it to the inside, or to the outside: a short course's loop round an inner oval's end.)
    const clearAt = (p: { s: number; d: number } | null) => !p || p.d > apronAt(p.s) + 6 || p.d < ovalTrack.outerEdgeAt(p.s) - 6;
    // (Wherever it parts from it and meets it again: a course may come back to it and leave it again on the way.)
    const off = proj.map(clearAt);
    if (!off.some(Boolean)) throw new Error(`roval ${spec.id}: never leaves the oval`);
    off.forEach((o, i) => {
      // (Placed by the last point on it before it parts, and the first after it meets it again.)
      if (o && i > 0 && !off[i - 1]) across(proj[i - 1]!.s + 15, apronAt(proj[i - 1]!.s + 15) - 0.5, `${spec.id}-out${i}`);
      if (o && i + 1 < off.length && !off[i + 1]) across(proj[i + 1]!.s - 15, apronAt(proj[i + 1]!.s - 15) - 0.5, `${spec.id}-in${i}`);
    });
  }

  // ---- surfaces, walls, markings ----
  const ovalRange: [number, number] = [sOf(0), sOf(0) + part];
  const surfaces: SurfaceRegion[] = [
    ...dressedSurfaces,
    { id: 'apron', surface: 'apron', shape: { kind: 'band', range: ovalRange, d0: edgeIn, d1: apronEdge } },
  ];
  const walls: Wall[] = [...ownWalls];
  let markings: Marking[];
  if (spec.pit === 'oval') {
    const keep = new Set(['pit-road', 'pit-island', 'garage']);
    surfaces.push(
      { id: 'racing', surface: 'track', shape: { kind: 'band', range: null, d0: edgeOut, d1: edgeIn } },
      ...oval.surfaces.filter((s) => keep.has(s.id)),
    );
    walls.push(...oval.walls.filter((w) => w.id === 'pit-wall'));
    markings = standardMarkings(L, edgeIn, [-evalEdge(edgeIn, 0, L), evalEdge(edgeIn, 0, L)], pavedInner, pit);
  } else {
    surfaces.push(
      { id: 'pit-approach', surface: 'apron', shape: { kind: 'band', range: [pit.entryStart, pit.exitEnd], d0: half, d1: pavedInner } },
      { id: 'garage', surface: 'garage', shape: { kind: 'rect', rect: garage.lot }, outline: true },
      { id: 'racing', surface: 'track', shape: { kind: 'band', range: null, d0: edgeOut, d1: edgeIn } },
      { id: 'pit-road', surface: 'pit', shape: { kind: 'band', range: [pit.wallStart, pit.wallEnd], d0: pit.wallD, d1: pit.roadD } },
    );
    walls.push({ id: 'pit-wall', range: [pit.wallStart, pit.wallEnd], d: pit.wallD, thickness: pit.wallThickness, faces: 'both', caps: true, attenuators: true });
    const halfStall = pit.stallSpacing / 2;
    markings = [
      { kind: 'line', range: null, d: edgeOut, style: 'edge' },
      { kind: 'line', range: [pit.blendEnd, L + pit.entryStart], d: edgeIn, style: 'edge' },
      { kind: 'line', range: [pit.entryStart, pit.wallStart], d: half, style: 'entry' },
      { kind: 'line', range: [pit.wallEnd, pit.blendEnd], d: half, style: 'blend' },
      { kind: 'line', range: [pit.wallStart, pit.wallEnd], d: pit.laneD, style: 'lane' },
      { kind: 'ticks', s: [...pit.stalls.map((s) => s - halfStall), pit.stalls[pit.stalls.length - 1] + halfStall], d0: pit.laneD, d1: pit.roadD - 1, style: 'stall' },
      { kind: 'ticks', s: [0], d0: -half, d1: half, style: 'start' },
    ];
  }

  // The oval's road network, but a way off the oval only where the course runs on it. On a pit lane of its own,
  // none: pit road and the garage are the course's.
  const network = spec.pit === 'oval' && oval.infield.network ? {
    nodes: oval.infield.network.nodes.map((nd) => {
      if (nd.kind !== 'apron' || nd.s === undefined) return nd;
      const u = ovalTrack.distanceFrom(spec.join, nd.s);
      if (u > part) return { ...nd, kind: 'junction' as const, s: undefined };
      return { ...nd, s: sOf(u) };
    }),
    roads: oval.infield.network.roads,
  } : undefined;

  return {
    version: LAYOUT_VERSION,
    id: `${venue.id}/${spec.id}`,
    name: spec.name,
    type: 'roval',
    kind: 'road',
    seed: venue.seed,
    params: { variant: venue.params.variant, oval: venue.id, roval: spec.id, character: spec.character },
    placement,
    centerline,
    crossSection: { edgeIn, edgeOut, apronWidth: 0, pavedInner, bankInner, bankOuter, bankInfield },
    surfaces,
    ground: 'grass',
    walls,
    barriers,
    pit,
    infield: { garage, escapeLanes: [], ...(network ? { network } : {}) },
    markings,
    decor: buildings,
    neighbours: [{ ...venue, neighbours: undefined }, ...(venue.neighbours ?? [])],
    notes: [],
  };
}

/** Every road course of an oval. */
export function rovalLayouts(oval: TrackLayout): TrackLayout[] {
  return venueRoadLayouts(oval);
}

/**
 * A venue's layouts, each with all the others as scenery (their pavement
 * down, their lines painted) and barriers across another's road just past
 * where it parts from its own and just before it meets it again (where a
 * road course leaves the track it is cut from, its own closures already do
 * that). The ovals first (the speedway, its inner oval), then the road
 * courses.
 */
export function venueWithCourses(oval: TrackLayout): TrackLayout[] {
  const tracks = [{ ...oval, neighbours: undefined }, ...(oval.neighbours ?? [])];
  const courses = (oval.infield.rovals ?? []).map((spec) => compileRoval(oval, spec));
  const all = [...tracks, ...courses];
  if (all.length < 2) return [oval];
  const host = (l: TrackLayout) => (oval.infield.rovals ?? []).find((sp) => l.id.endsWith(`/${sp.id}`))?.host === 'inner'
    ? tracks.find((t) => t.id.endsWith('/inner'))?.id : (courses.includes(l) ? oval.id : undefined);
  const lines = all.map((l) => {
    const t = new Track({ ...l, neighbours: undefined });
    const pts: Array<[number, number]> = [];
    for (let s = 0; s < t.length; s += 2) pts.push(t.toWorld(s, 0));
    const grid = new PointGrid(20);
    for (const [x, y] of pts) grid.add(x, y);
    return { t, pts, grid };
  });
  // Every layout's walls are solid whichever is raced (from either side): none may stand on another's racing surface
  // or apron. Where one would, it stops short (padded), and goes on past. (Not a course's pit wall on the oval it pits
  // from: it is that oval's own.)
  const onSurface = (k: number, x: number, y: number) => {
    const t = lines[k].t;
    const q = t.near(x, y, t.reach);
    return !!q && q.d > t.outerEdgeAt(q.s) + 0.5 && q.d < t.innerEdgeAt(q.s) + all[k].crossSection.apronWidth - 0.5;
  };
  // (And the walls each needs where cars running off another would reach it.)
  const guards = hazardWalls(all, lines.map((l) => l.t));
  const walled = all.map((layout, i) => {
    const t = lines[i].t;
    const walls: Wall[] = [];
    for (const w of [...layout.walls, ...guards[i]]) {
      const others = all.map((_, j) => j).filter((j) => j !== i && !(w.id === 'pit-wall' && host(layout) === all[j].id));
      const [a, b] = w.range ?? [0, t.length];
      const step = 1, n = Math.max(1, Math.ceil((b - a) / step));
      const blocked = Array.from({ length: n + 1 }, (_, k) => {
        const s = a + ((b - a) * k) / n;
        const [x, y] = t.toWorld(s, typeof w.d === 'number' ? w.d : t.edgeAt(w.d, s));
        return others.some((j) => onSurface(j, x, y));
      });
      if (!blocked.some(Boolean)) { walls.push(w); continue; }
      // The stretches clear of the others, each its own wall with padded ends (none shorter than a few metres).
      for (let k = 0, piece = 0; k <= n;) {
        if (blocked[k]) { k++; continue; }
        let e = k;
        while (e + 1 <= n && !blocked[e + 1]) e++;
        const s0 = a + ((b - a) * k) / n, s1 = a + ((b - a) * e) / n;
        // (A guard cut down to a stub protects nothing: none.)
        if (s1 - s0 > (w.id.startsWith('guard') ? 20 : 4)) walls.push({ ...w, id: `${w.id}~${piece++}`, range: [s0, s1], caps: true, attenuators: true });
        k = e + 1;
      }
    }
    return { ...layout, walls };
  });
  return walled.map((layout, i) => {
    const closures: Barrier[] = [];
    all.forEach((other, j) => {
      if (j === i || host(layout) === other.id || host(other) === layout.id) return;
      const theirs = lines[j].pts, t = lines[j].t, mine = lines[i].grid;
      // Where theirs parts from mine, and where it's clear of my road altogether (where roads fork they overlap a
      // while: the closure goes where it's clear).
      const apart = theirs.map(([x, y]) => !mine.near(x, y, 8));
      if (apart.every(Boolean)) return;
      const clear = theirs.map(([x, y]) => !mine.near(x, y, 20));
      const n = theirs.length;
      const wrap = (k: number) => ((k % n) + n) % n;
      const barrierAt = (k: number): Array<[number, number]> => {
        const s = wrap(k) * 2;
        return [t.toWorld(s, t.outerEdgeAt(s) - 0.5), t.toWorld(s, t.innerEdgeAt(s) + 0.5)];
      };
      // (Nowhere on my road: every point along it clear of my racing surface.)
      const me = lines[i].t;
      const offMine = ([[ax, ay], [bx, by]]: Array<[number, number]>) => {
        for (let f = 0; f <= 1.001; f += 0.05) {
          const q = me.near(ax + (bx - ax) * f, ay + (by - ay) * f, me.reach);
          if (q && q.d > me.outerEdgeAt(q.s) - 1 && q.d < me.innerEdgeAt(q.s) + 1) return false;
        }
        return true;
      };
      // At least 12 m into the stretch it doesn't share, and clear of mine (where they part at a shallow angle, a
      // long way on). If it never is, none: an open road beats a barrier across mine.
      const close = (k: number, dir: 1 | -1, id: string) => {
        for (let at = k + dir * (dir > 0 ? 6 : 7); Math.abs(at - k) < 200; at += dir) {
          if (!clear[wrap(at)]) continue;
          const pts = barrierAt(at);
          if (offMine(pts)) { closures.push({ id, thickness: 1, points: pts }); return; }
        }
      };
      for (let k = 0; k < n; k++) {
        const prev = apart[(k - 1 + n) % n];
        if (apart[k] && !prev) close(k, 1, `${other.id}-closed-${k}`);
        if (!apart[k] && prev) close(k, -1, `${other.id}-closed-${k}`);
      }
    });
    return {
      ...layout,
      barriers: [...(layout.barriers ?? []), ...closures],
      neighbours: walled.filter((_, j) => j !== i).map((l) => ({ ...l, neighbours: undefined, barriers: undefined })),
    };
  });
}

/** The venue's road courses, laid out as its layouts (scenery and closures included). */
function venueRoadLayouts(oval: TrackLayout): TrackLayout[] {
  return venueWithCourses(oval).filter((l) => l.kind === 'road');
}

