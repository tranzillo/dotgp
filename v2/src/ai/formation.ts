import { PIT_SERVICE, PHYSICS as P } from '../sim/constants';
import type { Car } from '../sim/car';
import { pullOffS } from '../sim/raceControl';
import type { Controller, World } from '../sim/world';
import { followLine } from './lineFollower';

/**
 * Formation driving under pace laps and cautions: hold the assigned slot in
 * the double-file line, close up tight, never run into the car ahead in the
 * same file, and don't pass. Scripted, like the pit maneuver.
 */
/** Speed above the slot's that a car may use to catch up to the field. */
const CATCH_UP = 18;
/** Gap kept to the car ahead, bumper to bumper (m). */
const FOLLOW_GAP = 6;
/** Braking the following rule plans around (m/s^2): firm but comfortable. */
const COMFORT_DECEL = 4;

export class FormationDriver {
  decide(car: Car, world: World): void {
    const ctl = world.control!;
    const slot = ctl.slotFor(car);
    if (!slot) {
      car.inputX = 0;
      car.inputY = 0;
      return;
    }
    const t = world.track;
    let err = t.distanceFrom(car.s, slot.s); // metres the slot is ahead of us
    if (err > t.length / 2) err -= t.length;
    // A slot far behind (a lapped car ahead of the leader) is reached by going around, not by stopping.
    if (err < -150) err += t.length;
    let v = Math.max(3, Math.min(slot.speed + CATCH_UP, slot.speed + 0.3 * err));
    // Hold your lane while catching up; slide into your file once you're nearly there.
    let lane = Math.abs(err) < 40 ? slot.d : Math.max(-6, Math.min(6, car.d));
    // A wreck in our lane ahead: go around it on the side with more room.
    const wreck = ctl.wreckAhead(car);
    if (wreck && Math.abs(wreck.d - lane) < 4) lane = wreck.d > 0 ? wreck.d - 5 : wreck.d + 5;
    // Never faster than lets us stop comfortably behind whatever is ahead in our lane.
    const ahead = ctl.carAheadInFile(car, lane);
    if (ahead) {
      const gap = t.distanceFrom(car.s, ahead.s) - 2 * P.CAR_RADIUS - FOLLOW_GAP;
      v = Math.min(v, Math.sqrt(Math.max(0, ahead.speed * ahead.speed + 2 * COMFORT_DECEL * gap)));
    }
    followLine(car, world, () => lane, () => v, 0.85);
  }
}

/**
 * The pace car: comes out from the end of pit road, runs the centerline at
 * pace speed, and when it's "one to go" pulls into pit road at turn 4 exit.
 */
export class PaceCarDriver implements Controller {
  decide(car: Car, world: World): void {
    const ctl = world.control;
    if (!ctl || !ctl.paceCarOut) {
      car.inputX = 0;
      car.inputY = 0;
      car.vx = 0;
      car.vy = 0;
      return;
    }
    const t = world.track;
    const r = t.signedS(car.s);
    const wallClear = t.pit.wallD + t.pit.wallThickness / 2 + P.CAR_RADIUS + 1.2;
    const fastLane = Math.max(t.pit.wallD + t.pit.wallThickness / 2 + 3, wallClear);
    const ramp = (x: number, x0: number, x1: number, a: number, b: number) =>
      x <= x0 ? a : x >= x1 ? b : a + (b - a) * (x - x0) / (x1 - x0);
    const pull = pullOffS(t);

    const inner = t.innerEdge(car.trackIdx);
    if (ctl.oneToGo && (car.d > inner + 0.5 || (r > pull - 180 && r < t.pit.wallStart))) {
      // Heading in: down to the apron at turn 4 exit, onto pit road, stop at its start.
      const lane = (s: number) => {
        const x = t.signedS(s);
        if (x < pull) return ramp(x, pull - 180, pull, 0, wallClear);
        return ramp(x, pull, t.pit.wallStart - 50, wallClear, fastLane);
      };
      const cap = (s: number) => {
        const x = t.signedS(s);
        if (x < t.pit.wallStart - 5) return ctl.paceSpeed;
        return Math.min(PIT_SERVICE.SPEED_LIMIT - 1, Math.sqrt(2 * 3 * Math.max(0, t.pit.wallStart + 25 - x)));
      };
      followLine(car, world, lane, cap, 0.75);
      return;
    }
    if (car.d > inner) {
      // Just released from pit road: out through the exit taper and onto the track.
      const lane = (s: number) => ramp(t.signedS(s), t.pit.wallEnd + 15, t.pit.exitEnd, fastLane, 0);
      followLine(car, world, lane, () => ctl.paceSpeed * 1.2, 0.8);
      return;
    }
    followLine(car, world, () => 0, () => ctl.paceSpeed, 0.9);
  }
}
