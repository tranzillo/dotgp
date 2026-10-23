import { PHYSICS as P } from '../sim/constants';
import type { Car } from '../sim/car';
import type { World } from '../sim/world';

/**
 * The radio: the fixed contract between a spotter and a driver. Any spotter
 * can work with any driver because the meaning of each channel never changes.
 * All values are roughly in [-1, 1]; a proximity of 0 means "nothing there".
 *
 * "Low" is the inside of the track (+d), "high" the outside (-d).
 */
export const RADIO = {
  LOW_PROX: 0, //       car alongside on the inside: 1 = door to door
  LOW_REL: 1, //        ...its position: +1 = at our front bumper, -1 = at our rear
  HIGH_PROX: 2, //      car alongside on the outside
  HIGH_REL: 3,
  AHEAD_PROX: 4, //     nearest car ahead in our lane: 1 = touching, 0 = none within range
  AHEAD_CLOSING: 5, //  how fast we are catching it (+ = closing)
  AHEAD_LANE: 6, //     its lateral offset from us (+ = lower)
  AHEAD2_PROX: 7, //    next car ahead in any lane
  AHEAD2_CLOSING: 8,
  AHEAD2_LANE: 9,
  BEHIND_PROX: 10, //   nearest car behind
  BEHIND_CLOSING: 11, // how fast it is catching us (+ = closing)
  BEHIND_LANE: 12,
  HAZARD_PROX: 13, //   wrecked or crawling car anywhere ahead within HAZARD_RANGE
  HAZARD_LANE: 14, //   where on the track it is (+1 = bottom, -1 = top)
  DRAFT: 15, //         slipstream strength we are in
} as const;
export const RADIO_SIZE = 16;

/** Longitudinal overlap window (m). (Asked each time: the car's size can be an experiment's.) */
const alongsideDs = () => 4 * P.CAR_RADIUS + 1.5;
const ALONGSIDE_DD = 6; // lateral window (m)
const SAME_LANE_DD = 3.5;
const AHEAD_RANGE = 120;
const BEHIND_RANGE = 80;
const HAZARD_RANGE = 800;
const HAZARD_SPEED = 25; // m/s: anything slower than this on track is a hazard
const CLOSING_SCALE = 20; // m/s

/** A spotter watches the race and fills the radio for its driver. */
export interface Spotter {
  call(car: Car, world: World, radio: Float32Array): void;
  /** Is it safe for this car to merge from the apron onto the racing surface? */
  clearToMerge(car: Car, world: World): boolean;
}

/** A car arriving within this many seconds blocks a merge. */
const MERGE_TIME_GAP = 2.5;

/**
 * Sits in the tower with perfect knowledge of every car. This one is
 * scripted; spotter skill (what to prioritise, how early to call it) can
 * become learned later without changing the radio contract.
 */
/**
 * How far out a spotter makes each call. The radio's scale never changes
 * (that is the contract); a less skilled spotter just calls things later.
 */
export interface SpotterSkill {
  aheadRange: number; //  <= AHEAD_RANGE
  behindRange: number; // <= BEHIND_RANGE
  hazardRange: number; // <= HAZARD_RANGE
}

export const PERFECT_SPOTTER: SpotterSkill = { aheadRange: AHEAD_RANGE, behindRange: BEHIND_RANGE, hazardRange: HAZARD_RANGE };

export function randomSpotterSkill(random: () => number): SpotterSkill {
  return {
    aheadRange: AHEAD_RANGE * (0.55 + random() * 0.45),
    behindRange: BEHIND_RANGE * (0.5 + random() * 0.5),
    hazardRange: HAZARD_RANGE * (0.35 + random() * 0.65),
  };
}

export class TowerSpotter implements Spotter {
  constructor(readonly skill: SpotterSkill = PERFECT_SPOTTER) {}

  call(car: Car, world: World, radio: Float32Array): void {
    const { aheadRange, behindRange, hazardRange } = this.skill;
    radio.fill(0);
    // Ghost sessions have no real traffic to call.
    if (!world.opts.collisions) return;
    const track = world.track;
    const L = track.length;
    const r2 = 2 * P.CAR_RADIUS;
    const myAlong = alongSpeed(car, world);

    let ahead: Car | null = null, aheadGap = Infinity;
    let ahead2: Car | null = null, ahead2Gap = Infinity;
    let behind: Car | null = null, behindGap = Infinity;
    let hazardGap = Infinity, hazardD = 0;

    for (const other of world.cars) {
      if (other === car || other.cleared) continue;
      // Cars behind the pit wall aren't traffic.
      if (other.surface === 'pit' && car.surface !== 'pit') continue;
      let ds = other.s - car.s;
      if (ds > L / 2) ds -= L;
      else if (ds < -L / 2) ds += L;
      const dd = other.d - car.d;

      // Alongside: overlapping longitudinally, in an adjacent lane.
      if (Math.abs(ds) < alongsideDs() && Math.abs(dd) < ALONGSIDE_DD) {
        const prox = 1 - clamp01((Math.abs(dd) - r2) / (ALONGSIDE_DD - r2));
        const rel = clamp(ds / (2 * r2), -1, 1);
        if (dd >= 0 && prox > radio[RADIO.LOW_PROX]) {
          radio[RADIO.LOW_PROX] = prox;
          radio[RADIO.LOW_REL] = rel;
        } else if (dd < 0 && prox > radio[RADIO.HIGH_PROX]) {
          radio[RADIO.HIGH_PROX] = prox;
          radio[RADIO.HIGH_REL] = rel;
        }
      }

      // The tower sees the whole lap: wrecks and crawling cars anywhere ahead.
      const gapAhead = track.wrapS(other.s - car.s);
      // Slow because they're pitting isn't a hazard; slow on the racing surface is. (Speed last: it's a square root.)
      const pitting = other.pit.phase !== 'none' && !other.retired;
      if (gapAhead > alongsideDs() && gapAhead < hazardGap && !pitting && (other.retired || other.speed < HAZARD_SPEED)) {
        hazardGap = gapAhead;
        hazardD = other.d;
      }

      if (ds > 0) {
        if (Math.abs(dd) < SAME_LANE_DD && ds < aheadGap) { aheadGap = ds; ahead = other; }
        if (ds < ahead2Gap) { ahead2Gap = ds; ahead2 = other; }
      } else if (-ds < behindGap) {
        behindGap = -ds;
        behind = other;
      }
    }

    if (ahead && aheadGap < aheadRange) {
      radio[RADIO.AHEAD_PROX] = 1 - aheadGap / AHEAD_RANGE;
      radio[RADIO.AHEAD_CLOSING] = clamp((myAlong - alongSpeed(ahead, world)) / CLOSING_SCALE, -1, 1);
      radio[RADIO.AHEAD_LANE] = clamp((ahead.d - car.d) / track.halfWidth, -1, 1);
    }
    // The "second" car ahead skips the one already called in our lane.
    if (ahead2 === ahead) {
      ahead2 = null;
      ahead2Gap = Infinity;
      for (const other of world.cars) {
        if (other === car || other === ahead || other.cleared) continue;
        if (other.surface === 'pit' && car.surface !== 'pit') continue;
        let ds = other.s - car.s;
        if (ds > L / 2) ds -= L;
        else if (ds < -L / 2) ds += L;
        if (ds > 0 && ds < ahead2Gap) { ahead2Gap = ds; ahead2 = other; }
      }
    }
    if (ahead2 && ahead2Gap < aheadRange) {
      radio[RADIO.AHEAD2_PROX] = 1 - ahead2Gap / AHEAD_RANGE;
      radio[RADIO.AHEAD2_CLOSING] = clamp((myAlong - alongSpeed(ahead2, world)) / CLOSING_SCALE, -1, 1);
      radio[RADIO.AHEAD2_LANE] = clamp((ahead2.d - car.d) / track.halfWidth, -1, 1);
    }
    if (behind && behindGap < behindRange) {
      radio[RADIO.BEHIND_PROX] = 1 - behindGap / BEHIND_RANGE;
      radio[RADIO.BEHIND_CLOSING] = clamp((alongSpeed(behind, world) - myAlong) / CLOSING_SCALE, -1, 1);
      radio[RADIO.BEHIND_LANE] = clamp((behind.d - car.d) / track.halfWidth, -1, 1);
    }
    if (hazardGap < hazardRange) {
      radio[RADIO.HAZARD_PROX] = 1 - hazardGap / HAZARD_RANGE;
      radio[RADIO.HAZARD_LANE] = clamp(hazardD / track.halfWidth, -1.5, 1.5);
    }
    radio[RADIO.DRAFT] = clamp01((1 - car.draftFactor) / P.DRAFT_MAX);
  }

  /**
   * Merge call for a car on the apron: clear if nobody on the lower part of
   * the racing surface is alongside, or closing from behind fast enough to
   * arrive within the time gap. A spotter only sees as far back as its skill
   * allows, so a green spotter can wave a car into trouble.
   */
  clearToMerge(car: Car, world: World): boolean {
    const track = world.track;
    const L = track.length;
    const myAlong = alongSpeed(car, world);
    for (const other of world.cars) {
      if (other === car || other.retired || other.cleared || other.pit.phase !== 'none') continue;
      if (other.d < track.innerEdge(other.trackIdx) - 8) continue; // up high, well clear of the merge
      let ds = other.s - car.s;
      if (ds > L / 2) ds -= L;
      else if (ds < -L / 2) ds += L;
      if (Math.abs(ds) < alongsideDs() + 2) return false;
      if (ds < 0 && -ds < this.skill.behindRange) {
        const closing = alongSpeed(other, world) - myAlong;
        if (closing > 0 && -ds / closing < MERGE_TIME_GAP) return false;
      }
    }
    return true;
  }
}

/** Translate the radio into words for the broadcast feed. */
export function describeRadio(radio: Float32Array, prev: Float32Array): string[] {
  const calls: string[] = [];
  const on = (i: number, thr: number) => radio[i] > thr && prev[i] <= thr;
  const off = (i: number, thr: number) => radio[i] <= thr && prev[i] > thr;
  if (on(RADIO.LOW_PROX, 0.3)) calls.push('Car low');
  if (on(RADIO.HIGH_PROX, 0.3)) calls.push('Car high');
  const wasNear = prev[RADIO.LOW_PROX] > 0.3 || prev[RADIO.HIGH_PROX] > 0.3;
  const isNear = radio[RADIO.LOW_PROX] > 0.3 || radio[RADIO.HIGH_PROX] > 0.3;
  if (wasNear && !isNear && (off(RADIO.LOW_PROX, 0.3) || off(RADIO.HIGH_PROX, 0.3))) calls.push('Clear');
  if (on(RADIO.HAZARD_PROX, 0.01)) {
    const lane = radio[RADIO.HAZARD_LANE];
    const where = lane > 0.35 ? 'low' : lane < -0.35 ? 'high' : 'middle';
    calls.push(`Wreck ahead, ${Math.round((1 - radio[RADIO.HAZARD_PROX]) * HAZARD_RANGE)} m, ${where}`);
  }
  if (radio[RADIO.BEHIND_PROX] > 0.5 && radio[RADIO.BEHIND_CLOSING] > 0.25 && !(prev[RADIO.BEHIND_PROX] > 0.5 && prev[RADIO.BEHIND_CLOSING] > 0.25)) {
    calls.push('Closing fast behind');
  }
  if (on(RADIO.DRAFT, 0.5)) calls.push('In the draft');
  return calls;
}

function alongSpeed(car: Car, world: World): number {
  const i = car.trackIdx;
  return car.vx * world.track.tx[i] + car.vy * world.track.ty[i];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number) => clamp(x, 0, 1);
