import type { Rng } from '../ai/rng';
import { Centerline } from '../sim/centerline';
import {
  evalEdge, evalProfile, LAYOUT_VERSION,
  type Barrier, type Decoration, type Marking, type Profile, type RovalSpec, type SurfaceRegion, type TrackLayout, type Wall,
} from '../sim/layout';
import { Track } from '../sim/track';
import {
  CIRCUIT_PIT, dressCourse, geometrySamples, markChicanes, pitZone,
  type Bound, type CornerAt, type Course, type PitZone,
} from './circuit';
import { headingAt, integrate, ovalPose, poseSection, sliceSections, type Pose } from './course';
import { garageLot, pitLane, standardMarkings } from './stages';

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
  /** Where nothing of the course may go (the garage, for now). */
  keepOut: (x: number, y: number) => boolean;
  /** The oval's pit lane, from where it leaves the track to where it rejoins (signed s): no junctions there. */
  pitRange: [number, number];
  rng: Rng;
}

export type PortionKind = 'end' | 'straight' | 'turn' | 'both';

const pickIn = (rng: Rng, [a, b]: [number, number]) => a + rng.next() * (b - a);
/** A pit lane of its own needs a straight this long (entry, a few boxes, exit). */
const PIT_STRAIGHT = 340;
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
 * The oval's part of a road course: a straight (from the turn before it,
 * maybe partway round, into the next), a turn (from its approach to its exit,
 * or partway into it and out), or a straight and the turn after it. Signed s
 * where the course joins the oval and where it leaves; null if a junction
 * would be on pit road.
 */
function portion(site: RovalSite, kind: PortionKind): { join: number; leave: number } | null {
  const { cl, turns, rng } = site;
  const n = turns.length;
  const i = rng.int(n);
  const [a, b] = turns[i];
  const prev = turns[(i - 1 + n) % n], next = turns[(i + 1) % n];
  const before = cl.distanceFrom(prev[1], a), after = cl.distanceFrom(b, next[0]);
  // Where on a turn a junction can be: partway round (the course leaves the banking mid-turn), or at its end.
  const inTurn = ([p, q]: [number, number], [f0, f1]: [number, number]) => p + (q - p) * pickIn(rng, [f0, f1]);
  let join: number, leave: number;
  if (kind === 'end') {
    // All the oval but one end, as at Daytona and Kansas: off partway into it and back on down the straight after it,
    // or off down the straight before it and back on partway round it.
    if (rng.next() < 0.5) {
      leave = inTurn([a, b], [0.1, 0.45]);
      join = b + after * pickIn(rng, [0.1, 0.5]);
    } else {
      leave = a - before * pickIn(rng, [0.1, 0.5]);
      join = inTurn([a, b], [0.55, 0.9]);
    }
  } else if (kind === 'turn') {
    join = rng.next() < 0.6 ? a - before * pickIn(rng, [0.1, 0.6]) : inTurn([a, b], [0.1, 0.35]);
    leave = rng.next() < 0.6 ? b + after * pickIn(rng, [0.1, 0.6]) : inTurn([a, b], [0.65, 0.9]);
  } else if (kind === 'straight') {
    // The straight after turn i.
    join = rng.next() < 0.5 ? b + after * pickIn(rng, [0, 0.15]) : inTurn([a, b], [0.5, 0.9]);
    leave = rng.next() < 0.5 ? next[0] - after * pickIn(rng, [0, 0.15]) : inTurn(next, [0.1, 0.5]);
  } else {
    // The straight before turn i, then the turn.
    join = rng.next() < 0.5 ? a - before * pickIn(rng, [0.7, 1]) : inTurn(prev, [0.5, 0.9]);
    leave = rng.next() < 0.6 ? b + after * pickIn(rng, [0.1, 0.6]) : inTurn([a, b], [0.65, 0.9]);
  }
  if (cl.distanceFrom(join, leave) < 150) return null;
  const [p0, p1] = site.pitRange;
  if ([join, leave].some((s) => cl.inRange(s, [p0 - 60, p1 + 30]))) return null;
  return { join: cl.signedS(join), leave: cl.signedS(leave) };
}

/**
 * A road course on this oval, or null if none fitted in the tries: the oval's
 * part (of the kind asked for, or any), the polygon round the infield, fitted.
 */
export function generateRoval(site: RovalSite, opts: { id: string; name: string; kind?: PortionKind; tries?: number }): RovalSpec | null {
  const { rng } = site;
  for (let attempt = 0; attempt < (opts.tries ?? 200); attempt++) {
    const kind = opts.kind ?? (['end', 'end', 'end', 'turn', 'straight', 'both'] as const)[rng.int(6)];
    const shape = tryRoval(site, kind);
    if (shape) return { id: opts.id, name: opts.name, ...shape };
  }
  return null;
}

function tryRoval(site: RovalSite, kind: PortionKind): Omit<RovalSpec, 'id' | 'name'> | null {
  const { cl, rng } = site;
  const part = portion(site, kind);
  if (!part) return null;
  const { join, leave } = part;
  const width = Math.round(pickIn(rng, [11, 14]) * 2) / 2;
  const half = width / 2;
  const verge = Math.round(pickIn(rng, [3, 6]));
  const paved = widestPavement(site);
  // Clear of the oval's pavement (and the garage) by this much at least, centerline to edge of the way.
  const margin = half + 6;
  const free = (x: number, y: number, m = margin) => {
    const q = cl.near(x, y, paved + m + 1);
    return (!q || q.d > site.pavedInner(q.s) + m) && !site.keepOut(x, y);
  };

  // ---- off the oval and round it: a slip road onto a run that follows the oval at one offset (concentric with its
  // turns, as Daytona's and Kansas's courses follow theirs), to where the oval runs square to the front stretch ----
  const h0 = headingAt(cl, 0);
  // (Quarter turns from the front stretch's heading, unwrapped: where it passes a whole number, the oval runs square.)
  const quarter = (s: number) => {
    const r = (headingAt(cl, s) - h0) / (Math.PI / 2);
    return r - 4 * Math.floor(r / 4);
  };
  /** Where the oval next (dir 1) or last (dir -1) runs square, at least `min` round from s (null if not within `max`). */
  const square = (s: number, dir: 1 | -1, min: number, max: number) => {
    let prev = quarter(s + dir * min);
    if (Math.abs(prev - Math.round(prev)) < 0.005) return s + dir * min;
    for (let t = min + 2; t <= max; t += 2) {
      const q = quarter(s + dir * t);
      // (A whole number crossed, or sat on: a straight square to the front stretch.)
      if (Math.floor(q) !== Math.floor(prev) && Math.abs(q - prev) < 2 || Math.abs(q - Math.round(q)) < 0.005) return s + dir * t;
      prev = q;
    }
    return null;
  };
  const turnRadius = (s0: number, s1: number) => {
    let k = 0;
    for (let s = Math.min(s0, s1); s <= Math.max(s0, s1); s += 5) k = Math.max(k, Math.abs(cl.curvatureAt(s)));
    return k > 1e-6 ? 1 / k : Infinity;
  };
  const span = cl.distanceFrom(leave, join);
  const hug = (from: number, dir: 1 | -1) => {
    // The offset: past the pavement along it, no more than half the turn's radius (deeper, a turn's offset folds).
    const to = square(from, dir, 80, Math.min(0.6 * span, 900));
    if (to === null) return null;
    const lo = Math.min(from, to), hi = Math.max(from, to);
    let need = 0;
    for (let s = lo; s <= hi; s += 5) need = Math.max(need, site.pavedInner(s) + margin);
    const deepest = 0.5 * turnRadius(lo, hi);
    if (deepest < need + 15) return null;
    const o = need + pickIn(rng, [15, Math.min(110, deepest - need)]);
    const e = Math.max(50, (o - site.pavedInner(from)) / Math.tan((pickIn(rng, [35, 80]) * Math.PI) / 180));
    const slip = from + dir * e;
    if ((to - slip) * dir < 20) return null;
    for (let s = Math.min(slip, to); s <= Math.max(slip, to); s += 10) if (!free(...cl.toWorld(s, o))) return null;
    return { slip, to, o };
  };
  const outHug = hug(leave, 1), inHug = hug(join, -1);
  // (The two in order round, with room between: the walk goes from one to the other.)
  if (outHug && inHug && cl.distanceFrom(leave, outHug.to) + 40 > cl.distanceFrom(leave, inHug.to)) return null;
  if (!outHug || !inHug) return null;

  // ---- between: legs square to the front stretch (along it and across it), corners square, hairpins where two legs
  // run back side by side 40 to 90 m apart ----
  const [ox, oy] = cl.toWorld(0, 0);
  const ux = Math.cos(h0), uy = Math.sin(h0);
  const world = (u: number, v: number): [number, number] => [ox + u * ux - v * uy, oy + u * uy + v * ux];
  const local = ([x, y]: [number, number]): [number, number] => [(x - ox) * ux + (y - oy) * uy, -(x - ox) * uy + (y - oy) * ux];
  const dirOf = (h: number) => (((Math.round((h - h0) / (Math.PI / 2)) % 4) + 4) % 4);
  const step = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const a = local(cl.toWorld(outHug.to, outHug.o)), b = local(cl.toWorld(inHug.to, inHug.o));
  const dirA = dirOf(headingAt(cl, outHug.to)), dirB = dirOf(headingAt(cl, inHug.to));
  // The walk: legs, long (along the infield) or short (a hairpin's link, between two turns the same way), then back to b
  // arriving the way it goes on. Many tried; of the ones that fit (clear of the oval, the garage and themselves, legs
  // side by side a hairpin apart at least), one with plenty going on.
  const along = (d: number, x: number, y: number) => step[d][0] * x + step[d][1] * y;
  const segFree = (p0: [number, number], p1: [number, number]) => {
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    for (let t = 0; t <= len; t += 8) if (!free(...world(p0[0] + ((p1[0] - p0[0]) * t) / len, p0[1] + ((p1[1] - p0[1]) * t) / len))) return false;
    return true;
  };
  /** Distance between two axis-aligned segments. */
  const segGap = ([a0, a1]: [number, number][], [b0, b1]: [number, number][]) => {
    const lo = (p: number, q: number) => Math.min(p, q), hi = (p: number, q: number) => Math.max(p, q);
    const gx = Math.max(0, lo(b0[0], b1[0]) - hi(a0[0], a1[0]), lo(a0[0], a1[0]) - hi(b0[0], b1[0]));
    const gy = Math.max(0, lo(b0[1], b1[1]) - hi(a0[1], a1[1]), lo(a0[1], a1[1]) - hi(b0[1], b1[1]));
    return Math.hypot(gx, gy);
  };
  // (Legs scaled to the infield: an intermediate's is half a superspeedway's.)
  const scale = Math.min(1.2, Math.max(0.45, cl.length / 4000));
  const longLeg: [number, number] = [100, Math.max(160, 420 * scale)], longEnough = Math.max(120, 200 * scale);
  const plain = rng.next() < 0.15;
  const tryWalk = (): { corners: Array<[number, number]>; score: number } | null => {
    const legs: Array<{ dir: number; len: number }> = [];
    let p: [number, number] = [a[0], a[1]], dir = dirA, turn = rng.next() < 0.5 ? 1 : 3;
    const n = 1 + rng.int(kind === 'end' ? 6 : 8);
    for (let i = 0; i < n; i++) {
      const short = i > 0 && legs[i - 1].len > 90 && rng.next() < 0.45;
      const len = i === 0 ? pickIn(rng, [20, 220 * scale]) : short ? pickIn(rng, [40, 90]) : pickIn(rng, longLeg);
      legs.push({ dir, len });
      p = [p[0] + step[dir][0] * len, p[1] + step[dir][1] * len];
      // (After a hairpin's link, the same way again; otherwise either way.)
      if (!short) turn = rng.next() < 0.5 ? 1 : 3;
      dir = (dir + turn) % 4;
    }
    const last = legs[legs.length - 1];
    const [dx, dy] = [b[0] - p[0], b[1] - p[1]];
    if ((last.dir + dirB) % 2 === 1) {
      const x = along(last.dir, dx, dy), z = along(dirB, dx, dy);
      if (last.len + x < 40 || z < 20) return null;
      last.len += x;
      legs.push({ dir: dirB, len: z });
    } else {
      const side = (last.dir + 1) % 4;
      const y = along(side, dx, dy);
      const z = pickIn(rng, [20, 160]);
      const x = along(last.dir, dx, dy) - (last.dir === dirB ? z : -z);
      if (last.len + x < 40 || Math.abs(y) < 40) return null;
      last.len += x;
      legs.push({ dir: y > 0 ? side : (side + 2) % 4, len: Math.abs(y) }, { dir: dirB, len: z });
    }
    if (legs.some((l, i) => l.len < (i === 0 || i === legs.length - 1 ? 20 : 40))) return null;
    if (legs.some((l, i) => i > 0 && i + 1 < legs.length && l.len < longEnough + 20 && legs[i - 1].dir === legs[i + 1].dir)) return null;
    const long = legs.filter((l) => l.len >= longEnough).length;
    if (!long) return null;
    // (A plain box round the infield now and then, as Las Vegas's; mostly more to it than that.)
    if (legs.length < 5 && !plain) return null;
    const path: Array<[number, number]> = [[a[0], a[1]]];
    for (const leg of legs) {
      const q = path[path.length - 1];
      path.push([q[0] + step[leg.dir][0] * leg.len, q[1] + step[leg.dir][1] * leg.len]);
    }
    // (Cheapest first: the walk against itself, then against the ground it's on.)
    const segs = path.slice(0, -1).map((q, i) => [q, path[i + 1]] as [number, number][]);
    for (let i = 0; i < segs.length; i++) for (let j = i + 2; j < segs.length; j++) if (segGap(segs[i], segs[j]) < 38) return null;
    for (let i = 0; i + 1 < path.length; i++) if (!segFree(path[i], path[i + 1])) return null;
    // (Corners, hairpins and length, up to a point: a course with things to do, not a maze.)
    const hairpins = legs.filter((l, i) => i > 0 && i + 1 < legs.length && l.len <= 90 && legs[i - 1].dir === (legs[i + 1].dir + 2) % 4).length;
    const total = legs.reduce((acc, l) => acc + l.len, 0);
    // (Not a staircase: a short leg between two going the same way, one turn each way, steps down, which no one builds.)
    return { corners: path.slice(1, -1), score: legs.length + 3 * hairpins + 1.5 * long + Math.min(total, 2500) / 500 + rng.next() * 2 };
  };
  let best: { corners: Array<[number, number]>; score: number } | null = null;
  for (let w = 0; w < 80; w++) {
    const walk = tryWalk();
    if (walk && (!best || walk.score > best.score)) best = walk;
  }
  if (!best) return null;
  const corners = best.corners;

  // ---- the whole course's corners ----
  const wps: Array<[number, number]> = [];
  const radii: Array<number | undefined> = [];
  const add = (at: [number, number], r: number | undefined) => { wps.push(at); radii.push(r); };
  add(cl.toWorld(outHug.slip, outHug.o), pickIn(rng, [18, 35]));
  for (const v of followTurns(cl, outHug.slip, outHug.to, outHug.o)) add(v.at, v.radius);
  for (const c of corners) add(world(c[0], c[1]), pickIn(rng, [18, 45]));
  for (const v of followTurns(cl, inHug.to, inHug.slip, inHug.o)) add(v.at, v.radius);
  add(cl.toWorld(inHug.slip, inHug.o), pickIn(rng, [18, 35]));
  const out = ovalPose(cl, leave), back = ovalPose(cl, join);
  const lead = (pose: Pose) => (Math.abs(pose.k) > 1e-6 ? 0 : pickIn(rng, [20, 50]));
  const sections = poseSection(out, back, wps, [lead(out), lead(back)], rng, width, { minStraight: 6, radii });
  if (!sections) return null;

  // Clear of the oval (but where it leaves and rejoins), and of itself: legs side by side at least a hairpin apart.
  const way = integrate(sections, out.x, out.y, out.h, 4).points;
  const ends = Math.ceil(100 / 4);
  for (let i = ends; i < way.length - ends; i++) if (!free(way[i][0], way[i][1], half + 3)) return null;
  const apart = width + 16, near = Math.ceil(100 / 4);
  for (let i = 0; i < way.length; i++) {
    for (let j = i + near; j < way.length; j++) {
      if (Math.hypot(way[i][0] - way[j][0], way[i][1] - way[j][1]) < apart) return null;
    }
  }

  const pit = pitFor(site, join, leave, sections);
  if (!pit) return null;
  const spec = cornersOf(sections, 0, 1, 1).map(() => ({ runoff: 'gravel' as const, apexWall: false, bare: false }));
  return { join, leave, sections, width, verge, character: kind, corners: spec, pit };
}

/**
 * A run at offset d from s0 to s1 (either way) where it follows one of the
 * oval's turns: corners where the turn turns (at most 80 degrees each, at the
 * crossing of the run's tangents either side), each concentric with the turn
 * (the run's radius there: the turn's, less d).
 */
function followTurns(cl: Centerline, s0: number, s1: number, d: number): Array<{ at: [number, number]; radius: number }> {
  const lo = Math.min(s0, s1), hi = Math.max(s0, s1), step = 2;
  // How much it turns in all, then corners each taking an equal share of that (80 degrees at most).
  const hLo = headingAt(cl, lo), hHi = headingAt(cl, hi);
  let total = 0;
  for (let s = lo; s < hi; s += step) total += cl.curvatureAt(s + step / 2) * Math.min(step, hi - s);
  if (Math.abs(total) < (4 * Math.PI) / 180) return [];
  const pieces = Math.ceil(Math.abs(total) / ((80 * Math.PI) / 180));
  const stations = [lo];
  let turned = 0;
  for (let s = lo; s < hi && stations.length < pieces; s += step) {
    turned += cl.curvatureAt(s + step / 2) * Math.min(step, hi - s);
    if (Math.abs(turned) >= (Math.abs(total) * stations.length) / pieces) stations.push(s + step);
  }
  stations.push(hi);
  // (Not right at either end: a square corner there needs a straight run into it. The first and last lines are the
  // run's own at its ends, so its corners still meet them.)
  const keep = Math.min(45, (hi - lo) / 4);
  for (let i = 1; i + 1 < stations.length; i++) stations[i] = Math.min(hi - keep, Math.max(lo + keep, stations[i]));
  const out: Array<{ at: [number, number]; radius: number }> = [];
  for (let i = 0; i + 1 < stations.length; i++) {
    const a = stations[i], b = stations[i + 1];
    const ha = i === 0 ? hLo : headingAt(cl, a), hb = i + 2 === stations.length ? hHi : headingAt(cl, b);
    const dh = Math.atan2(Math.sin(hb - ha), Math.cos(hb - ha));
    if (Math.abs(dh) < (2 * Math.PI) / 180) continue;
    const [ax, ay] = cl.toWorld(a, d), [bx, by] = cl.toWorld(b, d);
    // Where the tangents cross: A + t (cos ha, sin ha) = B + u (cos hb, sin hb).
    const det = Math.cos(ha) * -Math.sin(hb) - Math.sin(ha) * -Math.cos(hb);
    const t = ((bx - ax) * -Math.sin(hb) - (by - ay) * -Math.cos(hb)) / det;
    let along = 0;
    for (let s = a; s < b; s += 1) along += Math.max(0.05, 1 - cl.curvatureAt(s) * d);
    out.push({ at: [ax + t * Math.cos(ha), ay + t * Math.sin(ha)], radius: along / Math.abs(dh) });
  }
  return s1 >= s0 ? out : out.reverse();
}

/**
 * Where a course pits: on the oval's pit road if its part of the oval takes
 * that in (and the start line), else on a straight of its own long enough for
 * a pit lane. Null if neither.
 */
function pitFor(site: RovalSite, join: number, leave: number, sections: Array<[number, number, number]>): RovalSpec['pit'] | null {
  const { cl } = site;
  const [p0, p1] = site.pitRange;
  const span = cl.distanceFrom(join, leave);
  const along = (s: number) => cl.distanceFrom(join, s);
  if (along(p0 - 10) < span && along(p1 + 10) < span && along(0) < span && along(p0 - 10) < along(p1 + 10)) return 'oval';
  let acc = 0, best = 0, pit: RovalSpec['pit'] | null = null;
  for (const [len, k0, k1] of sections) {
    if (k0 === 0 && k1 === 0 && len >= PIT_STRAIGHT && len > best) { best = len; pit = { at: acc + len / 2, main: len }; }
    acc += len;
  }
  return pit;
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
  // Flat, mown ground all round: no barriers along the course and no run-off fields, but kerbs at the corners; tyre
  // walls (and a little gravel) round the outside of a hairpin at the end of a long leg; concrete where the course runs
  // close by the oval (or into the garage's way).
  const corners = cornersOf(spec.sections, courseStart, part, part, L).map((c, i) => {
    const tyres = c.turn > (120 * Math.PI) / 180 && c.before > 150;
    return { ...c, ...(spec.corners[i] ?? {}), runoff: 'gravel' as const, depthScale: tyres ? 0.35 : 0, tyres };
  });
  const course: Course = { width: spec.width, verge: spec.verge, corners };
  const dressed = dressCourse(course, cl, zone, { spec: centerline, bound, range: courseRange, walls: [null, null] });
  const ownWalls: Wall[] = [];
  const kOf = (u: number) => Math.round((((sOf(u) % L) + L) % L) / step) % n;
  ([[bound.left, 0, 1], [bound.right, 1, -1]] as const).forEach(([arr, j, sign]) => {
    // Concrete: wherever the oval's pavement (or the garage) is near, past the junctions where the course meets it.
    const near = (u: number) => u > part + 60 && u < Lr - 60 && arr[kOf(u)] < half + 15;
    let from: number | null = null;
    for (let u = part; u <= Lr; u += step) {
      const on = u < Lr && near(u);
      if (on && from === null) from = u;
      if (!on && from !== null) {
        if (u - from > 20) {
          const a = sOf(from) - 10;
          ownWalls.push({ id: `concrete-${j ? 'right' : 'left'}${ownWalls.length}`, range: [a, a + (u - from) + 20], d: sign > 0 ? dressed.wallLines[0] : dressed.wallLines[1], thickness: 0.8, faces: sign > 0 ? 'out' : 'in', caps: true });
        }
        from = null;
      }
    }
  });
  corners.forEach((c, i) => {
    if (!c.tyres) return;
    const outside = c.spec.angle > 0 ? 1 : 0; // (a left-hander's outside is on the right)
    ownWalls.push({
      id: `tyres${i}`, range: [c.s0 - 10, c.s1 + 15], d: dressed.wallLines[outside], thickness: 1.2,
      faces: outside ? 'in' : 'out', caps: true,
    });
  });
  // (Of the circuit dressing: kerbs, and the gravel round the hairpins with tyre walls; no verges, no other run-off.)
  const keepSurface = (id: string) => id.startsWith('kerb') || corners.some((c, i) => c.tyres && new RegExp(`^runoff${i}[lr]`).test(id));
  const dressedSurfaces = dressed.surfaces.filter((r) => keepSurface(r.id));

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
    const proj = pts.map(([x, y]) => ovalTrack.project(x, y));
    const clearAt = (p: { s: number; d: number }) => p.d > apronAt(p.s) + 6;
    const first = proj.findIndex(clearAt);
    let last = proj.length - 1;
    while (last > 0 && !clearAt(proj[last])) last--;
    if (first < 0 || last <= first) throw new Error(`roval ${spec.id}: never leaves the oval`);
    across(proj[first].s + 15, apronAt(proj[first].s + 15) - 0.5, `${spec.id}-out`);
    across(proj[last].s - 15, apronAt(proj[last].s - 15) - 0.5, `${spec.id}-in`);
  }

  // ---- surfaces, walls, markings ----
  const ovalRange: [number, number] = [sOf(0), sOf(0) + part];
  const surfaces: SurfaceRegion[] = [
    ...dressedSurfaces,
    { id: 'apron', surface: 'apron', shape: { kind: 'band', range: ovalRange, d0: edgeIn, d1: pavedInner } },
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
    id: `${oval.id}/${spec.id}`,
    name: spec.name,
    type: 'roval',
    kind: 'road',
    seed: oval.seed,
    params: { variant: oval.params.variant, oval: oval.id, roval: spec.id, character: spec.character },
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
    neighbours: [{ ...oval, neighbours: undefined }, ...(oval.neighbours ?? [])],
    notes: [],
  };
}

/** Every road course of an oval. */
export function rovalLayouts(oval: TrackLayout): TrackLayout[] {
  return (oval.infield.rovals ?? []).map((spec) => compileRoval(oval, spec));
}
