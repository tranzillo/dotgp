import { draftStrength } from '../sim/collisions';
import { PHYSICS as P } from '../sim/constants';
import { EXHAUST } from './exhaust';

/**
 * The draft, drawn: a wall of air round cars running in each other's slipstream.
 *
 * The links are the sim's own (`draftStrength`, collisions.ts): each car takes
 * the draft of the one car ahead that gives it the most, so a train is a chain
 * of links (a tree, where two cars share one car's air). They're worked out
 * here from the cars' track positions, so a recorded session shows them too.
 *
 * Along each link, short streaks flow back down both flanks from the leader to
 * the follower, over a faint band that gives the wall its shape: the air the
 * train pushes aside, round a calm pocket the cars sit in. How many show, and how bright, follows what the link is worth: its
 * strength times how much drag that saves at the follower's speed (drag goes
 * with speed², so a pacing field nose to tail shows nothing). The wall trails
 * off behind the last car, and the car breaking the air at the front of a
 * train gets a bow wave.
 *
 * Streaks flow in wall-clock time, like the exhaust puffs: the same at any sim speed.
 */
export const DRAFT_FX = {
  /** The wall's inner lane, × dot radius out from the train's line: just outside the car's own trail. */
  WALL_INSET: 1.7,
  /** Streak lanes across the wall, each this × dot radius further out; the outer ones fainter. */
  LANES: 3,
  LANE_STEP: 0.42,
  /** How much of a link's worth each lane shows, inner to outer. */
  LANE_WEIGHT: [1, 0.7, 0.42],
  /** Metres between streaks along a lane. */
  SPACING: 2,
  /** The share of streaks that show on any link worth drawing, before its worth adds more. */
  BASE_DENSITY: 0.25,
  /** Streaks wander this much (× dot radius) either side of their lane. */
  JITTER: 0.06,
  /** How fast the streaks flow back past the cars, × the leader's speed (m per real second per m/s). */
  FLOW: 0.45,
  /** Streak length: metres per m/s of the leader's speed, and at least this many CSS px. */
  LENGTH_PER_MS: 0.09,
  MIN_PX: 5,
  /** The wall trails off over this many metres behind the last car. */
  TAIL: 16,
  ALPHA: 0.7,
  /** The band under the streaks: its peak alpha, at the inner lane, fading to nothing either side. */
  BAND_ALPHA: 0.14,
  /** Metres between the band's samples along a link. */
  BAND_STEP: 2,
  BOW_ALPHA: 0.5,
  /** The air's colour: neutral, so a train of mixed liveries shares one wall. */
  COLOR: '#e6f2ff',
};

/** What the draft needs from a car. */
export interface DraftCar {
  id: number;
  x: number;
  y: number;
  s: number;
  d: number;
  speed: number;
  retired: boolean;
  cleared: boolean;
  /** Driving school's practice variations: not in anyone's air. */
  variant?: boolean;
}

export interface DraftLink<C extends DraftCar = DraftCar> {
  follower: C;
  leader: C;
  /** The sim's draft strength, 0..1 (the follower's drag is down DRAFT_MAX × this). */
  strength: number;
  /** What it's worth at the follower's speed, 0..1: what the wall shows. */
  effect: number;
}

/** 0 below racing speed, 1 at full: the share of full-speed drag at this speed (drag goes with speed²). */
export function draftWorth(speed: number): number {
  const v0 = EXHAUST.TRAIL_START_SPEED, v1 = EXHAUST.TRAIL_FULL_SPEED;
  return Math.max(0, Math.min(1, (speed * speed - v0 * v0) / (v1 * v1 - v0 * v0)));
}

/** Each car's draft: the car ahead whose air helps it most (as computeDraft picks it), if any. */
export function draftLinks<C extends DraftCar>(cars: readonly C[], track: { wrapS(s: number): number }): DraftLink<C>[] {
  const out: DraftLink<C>[] = [];
  for (const A of cars) {
    if (A.retired || A.cleared || A.variant) continue;
    let best = 0, leader: C | null = null;
    for (const B of cars) {
      if (B === A || B.retired || B.cleared || B.variant) continue;
      const lateral = Math.abs(B.d - A.d);
      if (lateral > P.DRAFT_WIDTH) continue;
      const strength = draftStrength(track.wrapS(B.s - A.s), lateral);
      if (strength > best) { best = strength; leader = B; }
    }
    if (leader) out.push({ follower: A, leader, strength: best, effect: best * draftWorth(A.speed) });
  }
  return out;
}

/** Per streak in `DraftWall.streaks`' output: s of its front, s of its back, d, lateral offset (× dot radius, signed), alpha. */
export const STREAK_FIELDS = 5;

/** A stable 0..1 from two integers. */
function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Per sample in `DraftWall.bands`' output: s, d (the wall's line there), alpha. A link's samples run leader to tail; NaN between links. */
export const BAND_FIELDS = 3;

/** A leader's wake: how far its air has flowed back (m), and where it was across the track as it did ([flowed, d] pairs, oldest first). */
interface Wake {
  flowed: number;
  path: number[];
}

/** Metres of flow a wake remembers: the longest wall, a draft's length plus the tail, and some. */
const WAKE_KEEP = P.DRAFT_LENGTH + DRAFT_FX.TAIL + 2 * DRAFT_FX.SPACING;
/** A new point on a wake every this many metres of flow. */
const WAKE_STEP = 0.5;

export class DraftWall {
  /**
   * Per leader: its wake. The air flows back from the leader at its own pace
   * (so the streaks keep flowing smoothly as it speeds up and slows), and each
   * bit of it stays on the line the leader was on when it passed: the wall
   * bends after a car that moves up or down the track, rather than swinging
   * with it, and a car that pulls out of line leaves it.
   */
  private wakes = new Map<number, Wake>();
  private readonly seen = new Set<number>();

  /** Move the air on `dt` real seconds (0 to hold it still). */
  advance(links: readonly DraftLink[], dt: number): void {
    this.seen.clear();
    for (const { leader } of links) {
      if (this.seen.has(leader.id)) continue;
      this.seen.add(leader.id);
      let w = this.wakes.get(leader.id);
      if (!w) this.wakes.set(leader.id, (w = { flowed: 0, path: [] }));
      w.flowed += dt * DRAFT_FX.FLOW * leader.speed;
      const p = w.path;
      if (!p.length || w.flowed - p[p.length - 2] >= WAKE_STEP) p.push(w.flowed, leader.d);
      // Forget what's flowed past the end of any wall (keeping one point beyond it to interpolate from).
      let drop = 0;
      while (drop + 2 < p.length && p[drop + 2] < w.flowed - WAKE_KEEP) drop += 2;
      if (drop) p.splice(0, drop);
    }
    for (const id of this.wakes.keys()) if (!this.seen.has(id)) this.wakes.delete(id);
  }

  /** Where the leader was across the track when the air now `back` m behind it passed (its d now, without a wake). */
  private wakeD(leader: DraftCar, back: number): number {
    const w = this.wakes.get(leader.id);
    if (!w || !w.path.length) return leader.d;
    const p = w.path, at = w.flowed - back;
    let i = p.length - 2;
    // Newer than the last point: between it and where the leader is now.
    if (at >= p[i]) return w.flowed > p[i] ? p[i + 1] + (leader.d - p[i + 1]) * ((at - p[i]) / (w.flowed - p[i])) : leader.d;
    while (i > 0 && p[i] > at) i -= 2;
    if (p[i] > at) return p[i + 1]; // older than the wake remembers
    const t = (at - p[i]) / (p[i + 2] - p[i] || 1);
    return p[i + 1] + (p[i + 3] - p[i + 1]) * t;
  }

  /**
   * The wall's streaks into `out` (STREAK_FIELDS numbers each, reused frame to
   * frame), `minLength` m long at least; returns how many.
   */
  streaks(links: readonly DraftLink[], track: { wrapS(s: number): number }, minLength: number, out: number[]): number {
    const F = DRAFT_FX;
    const leads = new Set<number>();
    for (const l of links) if (l.effect > 0) leads.add(l.leader.id);
    let n = 0;
    for (const l of links) {
      if (l.effect <= 0.005) continue;
      const { leader, follower } = l;
      const gap = track.wrapS(leader.s - follower.s);
      // The last car in the train: its wall trails off behind it.
      const end = gap + (leads.has(follower.id) ? 0 : F.TAIL);
      const length = Math.max(minLength, leader.speed * F.LENGTH_PER_MS);
      const shift = (this.wakes.get(leader.id)?.flowed ?? 0) / F.SPACING;
      const cycles = Math.floor(shift), frac = shift - cycles;
      const key = Math.imul(leader.id + 1, 73856093) ^ Math.imul(follower.id + 1, 19349663);
      for (let lane = 0; lane < F.LANES; lane++) {
        const worth = l.effect * F.LANE_WEIGHT[lane];
        // A few at any worth (ramping in from none), more as it rises.
        const density = F.BASE_DENSITY * Math.min(1, worth * 10) + worth * 1.15;
        for (let side = -1; side <= 1; side += 2) {
          const laneKey = key ^ Math.imul(lane * 2 + (side > 0 ? 1 : 0) + 1, 83492791);
          for (let k = 0; ; k++) {
            const x = (k + frac) * F.SPACING; // metres behind the leader
            if (x >= end) break;
            // The streak's own number, fixed as it flows back: which ones show, and their wobble.
            const id = k - cycles;
            const h = hash(laneKey, id);
            // Each fades in rather than popping.
            const shown = Math.min(1, Math.max(0, (density - h) * 6));
            if (shown <= 0) continue;
            // In from the leader, out at the follower (or along the tail).
            const fade = Math.min(1, x / F.SPACING, x <= gap ? (leads.has(follower.id) ? (gap - x) / F.SPACING : 1) : 1 - (x - gap) / F.TAIL);
            if (fade <= 0) continue;
            const at = n * STREAK_FIELDS;
            out[at] = leader.s - x;
            out[at + 1] = leader.s - x - length * (0.7 + 0.6 * hash(laneKey ^ 0x51ed27, id));
            out[at + 2] = this.wakeD(leader, x);
            out[at + 3] = side * (F.WALL_INSET + lane * F.LANE_STEP + (hash(laneKey ^ 0x2f6b1e, id) - 0.5) * 2 * F.JITTER);
            out[at + 4] = F.ALPHA * shown * fade * (0.35 + 0.65 * worth);
            n++;
          }
        }
      }
    }
    return n;
  }

  /**
   * The band under each link's streaks, as samples along the wall's line into
   * `out` (reused; BAND_FIELDS each); returns how many. Its alpha follows the
   * link's worth, fading in at the leader's nose and out along the last car's tail.
   */
  bands(links: readonly DraftLink[], track: { wrapS(s: number): number }, out: number[]): number {
    const F = DRAFT_FX;
    const leads = new Set<number>();
    for (const l of links) if (l.effect > 0) leads.add(l.leader.id);
    let n = 0;
    const put = (s: number, d: number, a: number) => { out[n * 3] = s; out[n * 3 + 1] = d; out[n * 3 + 2] = a; n++; };
    for (const l of links) {
      if (l.effect <= 0.005) continue;
      const { leader, follower } = l;
      const gap = track.wrapS(leader.s - follower.s);
      const end = gap + (leads.has(follower.id) ? 0 : F.TAIL);
      const a = F.BAND_ALPHA * Math.sqrt(l.effect);
      const steps = Math.max(2, Math.ceil(end / F.BAND_STEP));
      for (let k = 0; k <= steps; k++) {
        const x = (end * k) / steps;
        const fade = Math.min(1, x / F.SPACING, x <= gap ? 1 : 1 - (x - gap) / F.TAIL);
        put(leader.s - x, this.wakeD(leader, x), a * Math.max(0, fade));
      }
      put(NaN, NaN, 0);
    }
    return n;
  }
}

/** The cars breaking the air at the front of a train (they lead a link but follow none), and what their train is worth. */
export function draftHeads<C extends DraftCar>(links: readonly DraftLink<C>[]): Array<{ car: C; effect: number }> {
  const following = new Set(links.map((l) => l.follower.id));
  const heads = new Map<number, { car: C; effect: number }>();
  for (const l of links) {
    if (following.has(l.leader.id) || l.effect <= 0) continue;
    const h = heads.get(l.leader.id);
    if (!h) heads.set(l.leader.id, { car: l.leader, effect: l.effect });
    else h.effect = Math.max(h.effect, l.effect);
  }
  return [...heads.values()];
}
