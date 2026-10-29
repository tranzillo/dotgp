import { PIT_SERVICE, PHYSICS as P } from '../sim/constants';
import type { Car } from '../sim/car';
import { pullOffS } from '../sim/raceControl';
import type { Controller, World } from '../sim/world';
import { easingTo, followLine } from './lineFollower';
import { pitPath } from './pitting';
import { pitFastD } from '../sim/layout';
import { Rng } from './rng';

/**
 * Formation driving under pace laps and cautions: hold the assigned slot in
 * the double-file line, close up tight, never run into the car ahead in the
 * same file, and don't pass. Scripted, like the pit maneuver.
 */
/** Share of pace speed the pace car drives at until the leader has caught it. */
const PICKUP_SPEED = 0.5;
/** Speed above the slot's that a car may use to catch up to the field. */
const CATCH_UP = 18;
/** Gap kept to the car ahead, bumper to bumper (m). */
const FOLLOW_GAP = 6;
/** Braking the following rule plans around (m/s^2): firm but comfortable. */
const COMFORT_DECEL = 4;
/**
 * How fast a driver slows to caution pace as the caution comes out (m/s^2): off the throttle and a touch of brake. Asked
 * for pace speed at once, a driver that had reacted braked nearly as hard as it could from racing speed, in front of
 * cars still racing nose to tail (2026-10-28: teachers' short-oval caution hits as the caution formed, 32 m/s into
 * 24, about as much health as the students lost there). Following the car ahead still allows for it stopping hard.
 */
export const CAUTION_SLOWING = 3;

/**
 * A driver's own way of driving a caution: no two drivers react to a flag at
 * the same instant, sit the same distance off the car ahead, or close up with
 * the same urgency. Nerve shifts them (fearless drivers sit closer and push
 * harder to close up), and the rest is individual.
 */
export interface FormationTraits {
  /** Seconds to react to the caution flag, and to the green. */
  reaction: number;
  /** Gap kept to the car ahead, bumper to bumper (m). */
  followGap: number;
  /** Speed above the line's a driver will use to close up (m/s). */
  eagerness: number;
}

export function formationTraits(nerve = 0.5, random: () => number = Math.random): FormationTraits {
  return {
    reaction: 0.3 + 0.7 * random(),
    followGap: FOLLOW_GAP * (1.4 - 0.8 * nerve) * (0.85 + 0.3 * random()),
    eagerness: CATCH_UP * (0.6 + 0.8 * nerve) * (0.85 + 0.3 * random()),
  };
}

export class FormationDriver {
  private traits: FormationTraits | null;

  /**
   * No traits given: drawn for the car the first time it drives (middling nerve). A discipline, if given, caps
   * every speed the formation asks for: a driver bringing its own way of keeping off the car ahead.
   */
  constructor(
    traits?: FormationTraits,
    private readonly discipline?: (car: Car, world: World, lane: number) => number,
    /** Drive toward its speeds smoothly rather than flat out below them (a teacher, so it can be copied): the gain (1/s). */
    private readonly driveGain?: number,
  ) {
    this.traits = traits ?? null;
  }

  traitsFor(car: Car): FormationTraits {
    if (!this.traits) {
      const rng = new Rng(car.id * 7919 + 17);
      this.traits = formationTraits(0.5, () => rng.next());
    }
    return this.traits;
  }

  decide(car: Car, world: World): void {
    const ctl = world.control!;
    const tr = this.traitsFor(car);
    const t = world.track;
    const slot = ctl.slotFor(car);
    const follow = (lane: number, want: number) => {
      const ahead = ctl.carAheadInFile(car, lane);
      if (!ahead) return want;
      const gap = t.distanceFrom(car.s, ahead.s) - 2 * P.CAR_RADIUS - tr.followGap;
      return Math.min(want, Math.sqrt(Math.max(0, ahead.speed * ahead.speed + 2 * COMFORT_DECEL * gap)));
    };
    // No place in line (just after the green, before this driver has reacted to it): hold speed and lane.
    if (!slot) {
      this.drive(car, world, car.d, follow(car.d, car.speed));
      return;
    }
    // The caution is out but the pace car hasn't picked up the leader: no line to join yet. Slow to caution
    // pace and hold your position and lane; close up to the car ahead in your own way.
    if (ctl.flag === 'caution' && !ctl.pickedUp && !ctl.wavedAround(car)) {
      const lane = Math.max(-6, Math.min(6, car.d));
      const ahead = ctl.carAheadInFile(car, lane);
      const want = easingTo(car, ahead ? ctl.paceSpeedAt(car.s) + tr.eagerness : ctl.paceSpeedAt(car.s), CAUTION_SLOWING);
      let holdLane = lane;
      const wreck = ctl.wreckAhead(car);
      if (wreck && holdLane > wreck.lo - 4 && holdLane < wreck.hi + 4) holdLane = car.d < (wreck.lo + wreck.hi) / 2 ? wreck.lo - 5 : wreck.hi + 5;
      this.drive(car, world, holdLane, follow(holdLane, want));
      return;
    }
    // Metres the slot is ahead of us. A slot far behind (a lapped car ahead of the leader) is reached by going
    // around, not by stopping; but a car that got by the pace car drops back behind it.
    const err = ctl.slotGap(car)!;
    // Never below a crawl while the line is moving; a slot standing still (a grid box) is stopped in. Catching up
    // a driver may go the pace for where it is (behind a safety car: quick on a straight while the safety car is in
    // a hairpin) plus its own eagerness; the car ahead still sets the limit.
    const base = Math.max(slot.speed, ctl.paceSpeedAt(car.s));
    let v = Math.max(slot.speed > 0 ? 3 : 0, Math.min(base + tr.eagerness, slot.speed + 0.3 * err));
    // Giving way (ahead of our place by more than the line's spacing): low, in the yield lane, so the cars we
    // must let by go past in the line. Catching up: hold your lane (above the yield lane, which stays free);
    // slide into your place once you're nearly there.
    const yieldLane = ctl.yieldLane();
    // A grid box (a place standing still) is stopped in where it is; there's nobody to give way to. Once the
    // lights are on, a driver holds the car still on the brakes.
    if (slot.speed === 0 && ctl.flag === 'grid') {
      const want = ctl.lights > 0 ? 0 : Math.max(0, Math.min(tr.eagerness, 0.3 * err));
      this.drive(car, world, slot.d, follow(slot.d, want));
      return;
    }
    let lane = err < -ctl.lineSpacing() ? yieldLane
      : Math.abs(err) < 40 ? slot.d : Math.min(yieldLane - 2 * P.CAR_RADIUS - 0.5, Math.max(-6, car.d));
    // A car that belongs ahead of us coming up from behind, catching up to its place: give way, low, before
    // it has to brake for us (within the distance it needs to slow to our speed, plus a car and the gap).
    for (const other of world.cars) {
      const o = ctl.slotFor(other);
      if (!o || o.index >= slot.index || other.retired) continue;
      const gap = t.distanceFrom(other.s, car.s) - 2 * P.CAR_RADIUS; // how far it is behind us
      const closing = other.speed - car.speed;
      if (gap <= 0 || gap > t.length / 2 || closing <= 0) continue;
      if (gap < closing * closing / (2 * COMFORT_DECEL) + tr.followGap + 2 * P.CAR_RADIUS) lane = yieldLane;
    }
    // Told by race control (over the radio) to line up behind a car: let it by, up in the yield lane, until
    // we're behind it.
    const behind = ctl.toLineUpBehind(car);
    if (behind) {
      const past = t.distanceFrom(behind.s, car.s); // how far we're ahead of it
      if (past < t.length / 2) {
        lane = yieldLane;
        v = Math.min(v, Math.max(3, behind.speed + 0.3 * -(past + 2 * P.CAR_RADIUS + tr.followGap)));
      }
    }
    // Waved around: past the pace car high, out of the line's way, and on round to the tail.
    if (ctl.wavedAround(car)) {
      lane = -(2 * P.CAR_RADIUS + 0.5);
      v = slot.speed + tr.eagerness;
    }
    // A wreck in our lane ahead: go around it on the side we're already on, never across in front of it
    // (choosing by where the wreck is flipped sides as a sliding wreck crossed the middle).
    const wreck = ctl.wreckAhead(car);
    if (wreck && lane > wreck.lo - 4 && lane < wreck.hi + 4) lane = car.d < (wreck.lo + wreck.hi) / 2 ? wreck.lo - 5 : wreck.hi + 5;
    // Never faster than lets us stop comfortably behind whatever is ahead in our lane (at our own gap).
    v = follow(lane, v);
    this.drive(car, world, lane, v);
  }

  /** Toward a lane at a speed, no faster than the driver's own discipline allows (if it brings one). */
  private drive(car: Car, world: World, lane: number, v: number): void {
    const want = this.discipline ? Math.min(v, this.discipline(car, world, lane)) : v;
    // Never at the pit wall's nose unless pitting (it stands closer to the edge than a car's width).
    const t = world.track;
    const laneAt = car.pit.phase === 'none' ? (s: number) => Math.min(lane, t.pitWallClear(s)) : () => lane;
    followLine(car, world, laneAt, () => want, 0.85, false, this.driveGain);
  }
}

/**
 * The pace car: comes out from the end of pit road, runs the centerline at
 * pace speed, and when it's "one to go" pulls into pit road at turn 4 exit.
 */
export class PaceCarDriver implements Controller {
  decide(car: Car, world: World): void {
    const ctl = world.control;
    const t = world.track;
    if (!ctl || !ctl.paceCarOut) {
      // Off: on down pit road to its post at the end of it, and parked there until it's wanted.
      const left = ctl && car.surface === 'pit' ? ctl.paceCarToPost(car.s) : 0;
      if (left < 0.5 || (left < 1.5 && car.speed < 0.5)) {
        car.inputX = 0;
        car.inputY = 0;
        car.vx = 0;
        car.vy = 0;
        return;
      }
      followLine(car, world, (s) => ctl!.paceLaneD(s), (s) => Math.min(PIT_SERVICE.SPEED_LIMIT - 1, Math.sqrt(2 * 2.5 * Math.max(0, ctl!.paceCarToPost(s) - 0.5))), 0.75);
      return;
    }
    const r = t.pitInS(car.s);
    const wallClear = t.pit.wallD + t.pit.wallThickness / 2 + P.CAR_RADIUS + 1.2;
    const fastLane = Math.max(pitFastD(t.pit), wallClear);
    const ramp = (x: number, x0: number, x1: number, a: number, b: number) =>
      x <= x0 ? a : x >= x1 ? b : a + (b - a) * (x - x0) / (x1 - x0);
    const pull = pullOffS(t);

    const inner = t.innerEdge(car.trackIdx);
    // An oval has an apron to drop down to before pit road; a circuit's pit lane leaves the track at its entry.
    const apron = t.apronWidth > 0;
    const leaveFrom = apron ? pull - 180 : t.pit.entryStart - 5;
    if (ctl.oneToGo && (car.d > inner + 0.5 || (r > leaveFrom && r < t.pit.wallStart))) {
      // Heading in: (down to the apron at turn 4 exit,) onto pit road, stop at its start.
      const path = pitPath(t);
      const lane = (s: number) => {
        const x = t.pitInS(s);
        // A pit lane laid out across the grass: down to its start, then along it.
        if (path.laid) {
          if (x < t.pit.entryStart) return ramp(x, t.pit.entryStart - 180, t.pit.entryStart, 0, path.inAt(t.pit.entryStart));
          return x < path.inEnd ? path.inAt(x) : fastLane + t.pitOffset(s);
        }
        if (!apron) return ramp(x, t.pit.entryStart, t.pit.wallStart - 20, 0, fastLane);
        if (x < pull) return ramp(x, pull - 180, pull, 0, wallClear);
        return ramp(x, pull, t.pit.wallStart - 50, wallClear, fastLane);
      };
      const cap = (s: number) => {
        const x = t.pitInS(s);
        if (x < t.pit.wallStart - 5) return Math.min(ctl.paceSpeedAt(s), PIT_SERVICE.SPEED_LIMIT * 1.5, pitPath(t).inCap(x));
        return Math.min(PIT_SERVICE.SPEED_LIMIT - 1, Math.sqrt(2 * 3 * Math.max(0, t.pit.wallStart + 25 - x)));
      };
      followLine(car, world, lane, cap, 0.75, path.laid);
      return;
    }
    if (car.d > inner) {
      // Just released from pit road: out through the exit taper and onto the track.
      const path = pitPath(t);
      const lane = (s: number) => {
        const x = t.pitOutS(s);
        if (!path.laid) return ramp(x, t.pit.wallEnd + 15, t.pit.exitEnd, fastLane, 0);
        if (x < path.outStart) return fastLane + t.pitOffset(s);
        return x < t.pit.exitEnd ? path.outAt(x, s) : ramp(x, t.pit.exitEnd, t.pit.exitEnd + 80, path.outAt(t.pit.exitEnd, s), 0);
      };
      followLine(car, world, lane, (s) => Math.min(ctl.paceSpeedAt(s) * 1.2, path.outCap(t.pitOutS(s))), 0.8, path.laid);
      return;
    }
    // Out on track: slowly until it has picked up the leader (the leader catches it), then at pace speed.
    followLine(car, world, () => 0, (s) => (ctl.pickedUp ? ctl.paceSpeedAt(s) : PICKUP_SPEED * ctl.paceSpeedAt(s)), 0.9);
  }
}
