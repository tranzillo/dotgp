import type { Rng } from '../ai/rng';
import type { Centerline } from '../sim/centerline';
import type { Decoration, EscapeLane, PitLane, Road, RoadNode, RovalSpec, SurfaceRegion, TrackLayout, TrackRect } from '../sim/layout';
import { Track } from '../sim/track';
import { buildLayout } from './generator';
import { generateRoval } from './roval';
import { shapedOval } from './oval';
import { CLEARANCE, densify, occupies, placeLayout } from './geometry';

/**
 * The infield of a generated oval, laid out round its pit road and garage:
 * a service road round the infield, escape roads off the apron to it, roads
 * across the infield, parking lots, and sometimes a smaller oval in the
 * middle (its own pit road and garage; the venue then has two layouts).
 * Everything joins the road network, so wreckers find their way to the
 * garage from any escape road.
 *
 * The plan (counts, offsets, the inner oval's size) is in the track's
 * parameters; where each piece goes is drawn from the build's own random
 * stream, so a seed always gives the same infield. Later, course roads (wide
 * and smooth enough to race a road course on) come first and these services
 * fit round them; inner ovals are one level deep (an inner oval has no inner
 * oval of its own).
 */
export interface InfieldPlan {
  /** Escape roads off the apron to the service road. */
  escapes: number;
  /** The service road: how far inside the pavement's edge on the straights (m), and how much further in the turns (factor). */
  ringOffset: number;
  ringTurnFactor: number;
  /** Roads across the infield between two points of the service road (none round an inner oval). */
  crossLinks: number;
  /** Parking lots off the service road. */
  lots: number;
  /** A smaller oval in the infield, if one fits (shrunk until it does, or left out). */
  inner: InnerOvalPlan | null;
  /** A skidpad: a big paved circle off the service road (as at Iowa and Pikes Peak). */
  skidpad: boolean;
  /** A road course through the infield (trackgen/roval.ts). */
  course: boolean;
}

export interface InnerOvalPlan {
  straightLength: number;
  turnRadius: number;
  width: number;
  bankInner: number;
  bankOuter: number;
}

type Range = [number, number];
const deg = (x: number) => (x * Math.PI) / 180;

/** How often each size class has an inner oval, and how many escape roads it gets. */
const BY_CLASS: Record<string, { inner: number; skidpad: number; course: number; escapes: [number, number] }> = {
  short: { inner: 0, skidpad: 0, course: 0.3, escapes: [2, 3] },
  intermediate: { inner: 0.25, skidpad: 0.25, course: 0.75, escapes: [2, 4] },
  speedway: { inner: 0.4, skidpad: 0.35, course: 0.85, escapes: [3, 5] },
  superspeedway: { inner: 0.5, skidpad: 0.35, course: 0.85, escapes: [3, 5] },
};

export function sampleInfield(rng: Rng, variant: string): InfieldPlan {
  const pick = ([a, b]: Range) => a + rng.next() * (b - a);
  const round = (x: number, step: number) => Math.round(x / step) * step;
  const c = BY_CLASS[variant] ?? BY_CLASS.intermediate;
  const inner = rng.next() < c.inner;
  const bank = pick([8, 26]);
  return {
    escapes: c.escapes[0] + rng.int(c.escapes[1] - c.escapes[0] + 1),
    ringOffset: round(pick([12, 35]), 1),
    ringTurnFactor: round(pick([0.8, 2.2]), 0.1),
    crossLinks: rng.int(3),
    lots: rng.int(4),
    inner: inner ? {
      straightLength: round(pick([100, 240]), 10), turnRadius: round(pick([45, 85]), 5), width: round(pick([12, 15]), 0.5),
      bankInner: deg(bank), bankOuter: deg(bank + pick([2, 5])),
    } : null,
    skidpad: rng.next() < c.skidpad,
    course: rng.next() < c.course,
  };
}

/** What the oval builder knows that the infield needs. All s are signed. */
export interface InfieldSite {
  cl: Centerline;
  innerEdge: number;
  apronD: number;
  /** Inner edge of the pavement (apron, pit road and its lanes) at s. */
  pavedInner: (s: number) => number;
  pit: PitLane;
  lot: TrackRect;
  /** The turns (not front-stretch bends): where each starts and ends. */
  turns: Array<[number, number]>;
  rng: Rng;
  /** The outer track's id and seed (for the inner oval's). */
  id: string;
  seed: number;
}

export interface Infield {
  surfaces: SurfaceRegion[];
  decor: Decoration[];
  nodes: RoadNode[];
  roads: Road[];
  escapeLanes: EscapeLane[];
  /** The inner oval's layout (in this track's frame), if one went in. */
  inner: TrackLayout | null;
  /** Road courses through the infield. */
  rovals: RovalSpec[];
  /** Why it couldn't be laid out (the generator tries another seed). */
  problems: string[];
}

const SERVICE_WIDTH = 8;
const ESCAPE_WIDTH = 9;
const LANE_WIDTH = 7;
/** Grass kept between the service road and the infield's middle (the far side's ground). */
const ROOM_MARGIN = 14;
const STEP = 10;

export function buildInfield(plan: InfieldPlan, site: InfieldSite): Infield {
  const { cl, pit, lot, rng } = site;
  const L = cl.length;
  const signed = (s: number) => cl.signedS(s);
  const pick = ([a, b]: Range) => a + rng.next() * (b - a);
  const problems: string[] = [];

  // ---- a road course, first. Where one goes in, the infield is its: the services (placeholders, to be redone) come
  // later, round it ----
  if (plan.course) {
    // The garage, and room enough round it that it stays the front stretch's: nothing of a course nearer its back
    // edge than the front stretch is (as the layouts' validation asks).
    const back: Array<[number, number]> = [];
    for (let s = lot.s0; s <= lot.s1 + 1e-6; s += Math.max(5, (lot.s1 - lot.s0) / 12)) back.push(cl.toWorld(s, lot.d1));
    const keepOut = (x: number, y: number, m: number) => {
      const q = cl.near(x, y, lot.d1 + 20 + m);
      if (q && cl.inRange(q.s, [lot.s0 - 20 - m, lot.s1 + 20 + m]) && q.d < lot.d1 + 20 + m) return true;
      const r = lot.d1 + 4 + m;
      return back.some(([u, v]) => Math.abs(x - u) < r && Math.abs(y - v) < r && Math.hypot(x - u, y - v) < r);
    };
    // First the inner oval (in one half of the infield), then the courses that share its road and the oval's.
    const made = generateRoval({
      cl, pavedInner: site.pavedInner, turns: site.turns, keepOut,
      pitRange: pit.entryRoute ? [pit.entryStart, pit.exitEnd] : [pit.wallStart, pit.wallEnd], rng,
      buildInner: (straight, radius, width) => courseInner(site, straight, radius, width),
    });
    if (made) return { surfaces: [], decor: [], nodes: [], roads: [], escapeLanes: [], inner: made.inner, rovals: made.rovals, problems };
  }
  const nodes: RoadNode[] = [];
  const roads: Road[] = [];
  const surfaces: SurfaceRegion[] = [];
  const decor: Decoration[] = [];
  const escapeLanes: EscapeLane[] = [];

  // ---- room: how far in from the centerline the infield is still this side's, every STEP m ----
  const n = Math.ceil(L / STEP);
  const at = (s: number) => Math.round(cl.wrapS(s) / STEP) % n;
  const room = new Float64Array(n);
  for (let k = 0; k < n; k++) room[k] = roomAt(cl, k * STEP, site.apronD);

  // ---- the service road: an offset from the pavement, further in through the turns, behind the garage lot ----
  const turnShare = (s: number) => Math.abs(cl.turn[cl.indexAt(s)]);
  const lotZone = [lot.s0 - 10, lot.s1 + 10] as const;
  const ramp = 60;
  /** Where the road wants to be at s: off the pavement's edge, further in through the turns, behind the garage lot (behindLot). */
  const ringD = (s: number, offset: number, behindLot: boolean) => {
    const r = signed(s);
    const base = site.pavedInner(r) + offset * (1 + (plan.ringTurnFactor - 1) * turnShare(s));
    if (!behindLot) return base;
    // Round the back of the garage lot, easing out to it and back.
    const into = r < lotZone[0] ? (r - (lotZone[0] - ramp)) / ramp : r > lotZone[1] ? ((lotZone[1] + ramp) - r) / ramp : 1;
    const t = Math.min(1, Math.max(0, into));
    return Math.max(base, base + (lot.d1 + 12 - base) * t * t * (3 - 2 * t));
  };
  /**
   * The road along the lap, every STEP m: where it wants to be, smoothed (a running maximum, never nearer the track
   * than it wants, then a running mean over half that, so it doesn't follow every taper of the pavement's edge in and
   * out), and held back from the infield's middle where the infield narrows (it hugs tighter there).
   */
  const profile = (offset: number, behindLot: boolean) => {
    const raw = Float64Array.from({ length: n }, (_, k) => ringD(k * STEP, offset, behindLot));
    const W = 8; // samples either side (80 m)
    const peak = raw.map((_, k) => { let m = -Infinity; for (let j = -W; j <= W; j++) m = Math.max(m, raw[(k + j + n) % n]); return m; });
    return peak.map((_, k) => {
      let a = 0;
      for (let j = -W / 2; j <= W / 2; j++) a += peak[(k + j + n) % n];
      return Math.min(a / (W + 1), room[k] - ROOM_MARGIN);
    });
  };
  const offset = plan.ringOffset;
  // Behind the garage (a full ring) if there's room for that, otherwise it stops at the lot's ends (a C).
  let ring = profile(offset, true);
  let full = true;
  for (let r = lotZone[0]; r <= lotZone[1] && full; r += STEP) if (ring[at(r)] < lot.d1 + 8) full = false;
  if (!full) ring = profile(offset, false);
  const inGap = (s: number) => !full && cl.inRange(s, [lotZone[0] - 15, lotZone[1] + 15]);
  // It needs some grass between it and the pavement everywhere it runs.
  for (let k = 0; k < n; k++) {
    if (!inGap(k * STEP) && ring[k] < site.pavedInner(signed(k * STEP)) + 6) { problems.push('no room for a service road round the infield'); break; }
  }
  const d = (s: number) => {
    const f = cl.wrapS(s) / STEP, k = Math.floor(f) % n, t = f - Math.floor(f);
    return ring[k] + (ring[(k + 1) % n] - ring[k]) * t;
  };
  // The road's extent along the lap: all of it, or from past the lot's turn-1 end round to before its other end.
  const ringFrom = full ? 0 : lotZone[1] + 15;
  const ringLength = full ? L : cl.distanceFrom(lotZone[1] + 15, lotZone[0] - 15);
  const onRing = (s: number) => full || cl.distanceFrom(ringFrom, s) <= ringLength;

  // Junctions on the road, by distance along it from ringFrom; roads between them come at the end.
  const junctions: Array<{ u: number; id: string }> = [];
  const junction = (s: number, id: string) => {
    const u = cl.distanceFrom(ringFrom, s);
    nodes.push({ id, kind: 'junction', at: cl.toWorld(s, d(s)) });
    junctions.push({ u, id });
    return id;
  };
  const ringPoint = (s: number): [number, number] => cl.toWorld(s, d(s));

  // ---- the garage: off the road behind the lot, or at the lot's two ends ----
  if (full) {
    const s = (lot.s0 + lot.s1) / 2;
    const j = junction(s, 'ring-garage');
    nodes.push({ id: 'garage-back', kind: 'garage', at: cl.toWorld(s, lot.d1 - 2) });
    roads.push({ id: 'garage-back', from: j, to: 'garage-back', points: [ringPoint(s), cl.toWorld(s, lot.d1 - 2)], width: LANE_WIDTH, grade: 'garage' });
  } else {
    const mid = (lot.d0 + lot.d1) / 2;
    for (const [end, sRing, sLot] of [['a', lotZone[1] + 15, lot.s1 - 2], ['b', lotZone[0] - 15, lot.s0 + 2]] as const) {
      const j = junction(sRing, `ring-end-${end}`);
      nodes.push({ id: `garage-${end}`, kind: 'garage', at: cl.toWorld(sLot, mid) });
      roads.push({ id: `garage-${end}`, from: j, to: `garage-${end}`, points: [ringPoint(sRing), cl.toWorld(sLot, mid)], width: LANE_WIDTH, grade: 'garage' });
    }
  }

  // (No road course here: nothing for the services to keep clear of.)
  const coursePts: Array<[number, number]> = [];
  const courseZones: Array<[number, number]> = [];
  const nearCourse = ([x, y]: [number, number], gap: number) => coursePts.some(([u, v]) => Math.hypot(x - u, y - v) < gap);

  // ---- escape roads: off the apron before and after the turns, away from pit road, onto the service road ----
  const candidates: number[] = [];
  site.turns.forEach(([a, b], k) => {
    candidates.push(a - pick([50, 150]), b + pick([20, 60]));
    // And along a long straight to the next turn.
    const next = site.turns[(k + 1) % site.turns.length][0];
    const straight = cl.distanceFrom(b, next);
    if (straight > 320) candidates.push(b + straight * pick([0.35, 0.65]));
  });
  const pitZone = [pit.entryStart - 40, pit.exitEnd + 20];
  const usable = candidates
    .filter((s) => { const r = signed(s); return !(r > pitZone[0] && r < pitZone[1]); })
    .filter((s) => !courseZones.some(([a, b]) => cl.inRange(s, [a, b])))
    .sort(() => rng.next() - 0.5);
  const chosen: number[] = [];
  for (const s of usable) {
    if (chosen.length >= plan.escapes) break;
    if (chosen.some((o) => Math.abs(signed(o - s)) < Math.min(200, L / 8))) continue;
    // Where it meets the service road: angled forward, as far along as it goes in.
    const join = s + 40 + 1.2 * (d(s + 40) - site.apronD);
    if (!onRing(join) || !onRing(s)) continue;
    if (densify([cl.toWorld(s + 40, site.apronD + 3), ringPoint(join)], 5).some((p) => nearCourse(p, 20))) continue;
    chosen.push(s);
  }
  // At least one (with pit road, a second way off): short tracks rarely have room for more beside pit road.
  if (!chosen.length) problems.push('no room for an escape road');
  chosen.sort((a, b) => signed(a) - signed(b)).forEach((s, k) => {
    const join = s + 40 + 1.2 * (d(s + 40) - site.apronD);
    const points: Array<[number, number]> = [
      cl.toWorld(s, site.innerEdge + 1),
      cl.toWorld(s + 40, site.apronD + 3),
      ringPoint(join),
    ];
    const id = `escape${k}`;
    nodes.push({ id, kind: 'apron', at: points[0], s: signed(s) });
    const j = junction(join, `ring-escape${k}`);
    roads.push({ id, from: id, to: j, points, width: ESCAPE_WIDTH, grade: 'escape' });
    escapeLanes.push({ points, width: ESCAPE_WIDTH });
  });

  // ---- the inner oval, inside the service road ----
  const ringPts: Array<[number, number]> = [];
  for (let u = 0; u <= ringLength; u += STEP) ringPts.push(ringPoint(ringFrom + u));
  let inner: TrackLayout | null = null;
  if (plan.inner && !problems.length) inner = fitInner(plan.inner, site, [...ringPts, ...coursePts], d);
  const innerTrack = inner ? new Track(inner) : null;

  // ---- roads across the infield (not through an inner oval, nor the garage) ----
  const links: Array<Array<[number, number]>> = [];
  if (!inner) {
    for (let k = 0, tries = 0; k < plan.crossLinks && tries < 30; tries++) {
      const a = rng.next() * L;
      const b = a + L / 2 + (rng.next() - 0.5) * L * 0.2;
      if (!onRing(a) || !onRing(b) || chosen.some((s) => Math.abs(signed(s - a)) < 40 || Math.abs(signed(s - b)) < 40)) continue;
      const pts = densify([ringPoint(a), ringPoint(b)], 20);
      const clear = pts.slice(2, -2).every(([x, y]) => {
        const q = cl.near(x, y, lot.d1 + 40);
        return !q || !(cl.inRange(q.s, [lot.s0 - 20, lot.s1 + 20]) && q.d < lot.d1 + 15);
      }) && links.every((o) => !crosses(o, pts));
      if (!clear) continue;
      const ja = junction(a, `ring-link${k}a`), jb = junction(b, `ring-link${k}b`);
      roads.push({ id: `link${k}`, from: ja, to: jb, points: pts, width: SERVICE_WIDTH, grade: 'service' });
      links.push(pts);
      k++;
    }
  }

  // ---- parking lots off the service road, where there's room left ----
  const lots: TrackRect[] = [];
  for (let k = 0, tries = 0; k < plan.lots && tries < 40; tries++) {
    // Bigger lots at bigger tracks.
    const size = Math.min(2.5, Math.max(0.7, L / 2500));
    const length = pick([60, 140]) * size;
    const s0 = rng.next() * L;
    const s1 = s0 + length;
    if (!onRing(s0) || !onRing(s1)) continue;
    const r0 = signed(s0);
    if (cl.inRange(s0, [lot.s0 - 80, lot.s1 + 80]) || cl.inRange(s1, [lot.s0 - 80, lot.s1 + 80])) continue;
    let d0 = 0;
    for (let s = s0; s <= s1; s += 5) d0 = Math.max(d0, d(s) + 10);
    const rect: TrackRect = { s0: r0, s1: r0 + length, d0, d1: d0 + pick([25, 45]) * Math.max(1, size * 0.8) };
    const corners: Array<[number, number]> = [];
    for (let s = rect.s0; s <= rect.s1; s += 10) corners.push(cl.toWorld(s, rect.d1 + 8));
    const ok = [...Array(Math.ceil(length / STEP) + 1).keys()].every((i) => rect.d1 + 10 <= room[at(rect.s0 + i * STEP)])
      && lots.every((o) => !cl.inRange(rect.s0, [o.s0 - 30, o.s1 + 30]) && !cl.inRange(rect.s1, [o.s0 - 30, o.s1 + 30]))
      && links.every((pts) => pts.every(([x, y]) => { const q = cl.near(x, y, rect.d1 + 30); return !q || !(cl.inRange(q.s, [rect.s0 - 15, rect.s1 + 15]) && q.d > rect.d0 - 15); }))
      && (!innerTrack || !corners.some(([x, y]) => occupies(innerTrack, x, y, 10)))
      && !corners.some((p) => nearCourse(p, 20)) && !nearCourse(cl.toWorld((rect.s0 + rect.s1) / 2, (rect.d0 + rect.d1) / 2), 30);
    if (!ok) continue;
    lots.push(rect);
    const sm = (rect.s0 + rect.s1) / 2;
    const j = junction(sm, `ring-lot${k}`);
    nodes.push({ id: `lot${k}`, kind: 'junction', at: cl.toWorld(sm, rect.d0 + 2) });
    roads.push({ id: `lot-lane${k}`, from: j, to: `lot${k}`, points: [ringPoint(sm), cl.toWorld(sm, rect.d0 + 2)], width: LANE_WIDTH, grade: 'service' });
    surfaces.push({ id: `lot${k}`, surface: 'garage', shape: { kind: 'rect', rect }, outline: true });
    decor.push({ kind: 'bays', rect, spacing: 3 });
    k++;
  }

  // ---- a skidpad: a big paved circle off the service road, clear of everything else ----
  if (plan.skidpad) {
    const size = Math.min(1.6, Math.max(0.8, L / 2500));
    for (let tries = 0; tries < 60; tries++) {
      const r = pick([28, 45]) * size;
      const s = rng.next() * L;
      if (!onRing(s) || cl.inRange(s, [lot.s0 - 80, lot.s1 + 80])) continue;
      const dc = d(s) + 14 + r;
      if (dc + r + 12 > room[at(s)]) continue;
      const [x, y] = cl.toWorld(s, dc);
      const rim = Array.from({ length: 24 }, (_, i): [number, number] => [x + (r + 10) * Math.cos(i * Math.PI / 12), y + (r + 10) * Math.sin(i * Math.PI / 12)]);
      const inLot = ([px, py]: [number, number]) => lots.some((rect) => {
        const q = cl.near(px, py, rect.d1 + 20);
        return !!q && cl.inRange(q.s, [rect.s0, rect.s1]) && q.d > rect.d0 && q.d < rect.d1;
      });
      const clear = !rim.some(inLot)
        && links.every((pts) => pts.every(([px, py]) => Math.hypot(px - x, py - y) > r + 12))
        && (!innerTrack || !rim.some(([px, py]) => occupies(innerTrack, px, py, 8)))
        && !rim.some((p) => nearCourse(p, 14)) && !nearCourse([x, y], r + 14);
      if (!clear) continue;
      const j = junction(s, 'ring-skidpad');
      nodes.push({ id: 'skidpad', kind: 'junction', at: cl.toWorld(s, dc - r) });
      roads.push({ id: 'skidpad-lane', from: j, to: 'skidpad', points: [ringPoint(s), cl.toWorld(s, dc - r)], width: LANE_WIDTH, grade: 'service' });
      // A disc: a road of no length, as wide as the circle.
      surfaces.push({ id: 'skidpad', surface: 'road', shape: { kind: 'path', points: [[x, y], [x + 0.01, y]], width: 2 * r } });
      break;
    }
  }

  // ---- the service road itself, junction to junction ----
  junctions.sort((a, b) => a.u - b.u);
  const pts = (u0: number, u1: number) => {
    const out: Array<[number, number]> = [];
    for (let u = u0; u < u1; u += 15) out.push(ringPoint(ringFrom + u));
    out.push(ringPoint(ringFrom + u1));
    return out;
  };
  const span = full ? junctions.length : junctions.length - 1;
  for (let k = 0; k < span; k++) {
    const a = junctions[k], b = junctions[(k + 1) % junctions.length];
    const u1 = b.u > a.u ? b.u : b.u + L;
    roads.push({ id: `ring${k}`, from: a.id, to: b.id, points: pts(a.u, u1), width: SERVICE_WIDTH, grade: 'service' });
  }
  // Drawn as roads (the network's polylines are the surfaces).
  // Course roads are racing surface (and drawn over the service roads they cross).
  for (const road of [...roads.filter((r) => r.grade !== 'course'), ...roads.filter((r) => r.grade === 'course')]) {
    surfaces.push({
      id: `road-${road.id}`, surface: road.grade === 'course' ? 'track' : 'road',
      shape: { kind: 'path', points: road.points, width: road.width }, outline: true,
    });
  }
  return { surfaces, decor, nodes, roads, escapeLanes, inner, rovals: [], problems };
}

/**
 * How far in from the centerline at s the infield is still this side's: the
 * deepest d whose point is nearer this part of the centerline than any other
 * (beyond it, the far side's).
 */
function roomAt(cl: Centerline, s: number, from: number): number {
  const staysPut = (dd: number) => {
    const [x, y] = cl.toWorld(s, dd);
    const q = cl.near(x, y, dd + 2);
    return !!q && Math.abs(cl.signedS(q.s - s)) < 2 && Math.abs(q.d - dd) < 0.5;
  };
  let lo = from, hi = from + 50;
  while (staysPut(hi) && hi < 3000) { lo = hi; hi *= 1.6; }
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (staysPut(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/** Do two polylines cross (or come within 10 m)? */
function crosses(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  return a.some(([x, y]) => b.some(([u, v]) => Math.hypot(x - u, y - v) < 10));
}

/**
 * The inner oval the road courses share road with (as at Iowa), unplaced: a
 * flat short oval with no walls, this front straight, turn radius and width;
 * a short pit lane on its front straight, clear of both turns (courses turn in
 * and out round them). Its pit lane and garage are placeholders. Null if it
 * can't be laid out.
 */
function courseInner(site: InfieldSite, straight: number, radius: number, width: number): TrackLayout | null {
  try {
    const built = buildLayout('oval', {
      ...shapedOval({
        straightLength: straight, turnRadius: radius, easementLength: Math.round(radius * 0.35), width, apronWidth: 4,
        bankInner: 0, bankOuter: 0, bankStraight: 0,
        name: 2 * (straight + Math.PI * radius) < 800 ? 'Bullring' : 'Short track',
      }),
      pits: { gap: 1, entryLength: 15, exitLength: 15, blend: 0, startInset: 45, endInset: 40, stallSpacing: 11, garageSetBack: 0, garageLanes: 1 },
    }, site.seed);
    // (Open, as the infield is: its pit wall only.)
    return { ...built, id: `${site.id}/inner`, walls: built.walls.filter((w) => w.id === 'pit-wall') };
  } catch {
    return null;
  }
}

/**
 * A classic short oval inside the service road's loop: as large as planned,
 * or shrunk until it fits, keeping CLEARANCE of grass from the service road,
 * the garage and everything else. Where it goes varies, as at real tracks: the
 * middle of the infield, out in either end (turned across it, like Las
 * Vegas's Legends oval), or toward the front or the back (Pocono's sits by
 * the front stretch). Places are tried in a random order at each size, so
 * the largest that fits anywhere wins. None if even the smallest doesn't.
 */
function fitInner(plan: InnerOvalPlan, site: InfieldSite, ringPts: Array<[number, number]>, ringD: (s: number) => number): TrackLayout | null {
  const { cl, rng } = site;
  const cx = ringPts.reduce((a, p) => a + p[0], 0) / ringPts.length;
  const cy = ringPts.reduce((a, p) => a + p[1], 0) / ringPts.length;
  const xs = ringPts.map((p) => p[0]), ys = ringPts.map((p) => p[1]);
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  const places: Array<{ x: number; y: number; angle: number }> = [
    { x: cx, y: cy, angle: 0 },
    { x: cx - 0.28 * spanX, y: cy, angle: Math.PI / 2 },
    { x: cx + 0.28 * spanX, y: cy, angle: Math.PI / 2 },
    { x: cx - 0.22 * spanX, y: cy, angle: 0 },
    { x: cx + 0.22 * spanX, y: cy, angle: 0 },
    { x: cx, y: cy + 0.15 * spanY, angle: 0 },
    { x: cx, y: cy - 0.12 * spanY, angle: 0 },
  ].sort(() => rng.next() - 0.5);
  const lotPts: Array<[number, number]> = [];
  for (let s = site.lot.s0; s <= site.lot.s1; s += 10) lotPts.push(cl.toWorld(s, site.lot.d1));
  for (const scale of [1, 0.85, 0.7, 0.58, 0.48]) {
    const R = Math.max(35, plan.turnRadius * scale), S = Math.max(60, plan.straightLength * scale);
    let built: TrackLayout;
    try {
      built = buildLayout('oval', {
        straightLength: S, turnRadius: R, easementLength: Math.round(R * 0.35), width: plan.width, apronWidth: 5,
        bankInner: plan.bankInner, bankOuter: plan.bankOuter, bankStraight: plan.bankInner * 0.3,
        name: 2 * (S + Math.PI * R) < 800 ? 'Bullring' : 'Short track', // (the lap, roughly)
      }, site.seed);
    } catch {
      continue; // too small to lay out its own garage at this size
    }
    for (const place of places) {
      const layout = placeLayout({ ...built, id: `${site.id}/inner` }, place);
      const t = new Track(layout);
      // Its outer wall inside the service road with CLEARANCE to spare...
      let inside = true;
      for (let s = 0; s < t.length && inside; s += 10) {
        const [x, y] = t.toWorld(s, t.outerEdgeAt(s) - 1);
        const q = cl.project(x, y);
        inside = q.d > ringD(q.s) + CLEARANCE;
      }
      // ...and nothing of the outer infield on it.
      if (inside && ![...ringPts, ...lotPts].some(([x, y]) => occupies(t, x, y, CLEARANCE))) return layout;
    }
  }
  return null;
}
