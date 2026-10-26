import type { Car } from '../sim/car';
import { G, PHYSICS as P } from '../sim/constants';
import type { World } from '../sim/world';
import { followLoss } from './trafficRacer';
import type { FormationTraits } from './formation';
import { followLine } from './lineFollower';

/**
 * Formation driving a student can copy: the formation script's intent (hold
 * your place in the line, close up to it in your own way, give way to cars
 * that belong ahead, go round wrecks, never into the car ahead) with every
 * jump in it made a slope. The script decides by thresholds: within 40 m of
 * your place or not, ahead of it by a line's spacing or not, a car in your
 * file (2.6 m) or not, a wreck in your lane (4 m) or not. A driver's network
 * is smooth, so near a threshold it learns the average of both sides, and a
 * car slightly out of place (a student's, always) is near one. Here each
 * becomes a weight that grows across a band instead. What race control
 * announces stays discrete (the line formed, told to line up behind a car,
 * waved around): drivers hear those on the radio and see them as inputs.
 *
 * Speeds are reached smoothly too (in proportion, not flat out below them),
 * and the car ahead is given room to stop even if it stops as hard as it can.
 */

/** Smooth step from 0 (x <= a) to 1 (x >= b). */
const ramp = (x: number, a: number, b: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How hard speed is driven toward and braked to its target (1/s): proportional, both ways. */
const DRIVE_GAIN = 6;
/** Braking it plans on for the car ahead (m/s^2), and how far ahead it looks (m). */
const BRAKE = 0.5 * 1.0 * G;
const LOOK = 220;
/** Reaction time in the room kept to the car ahead (s). */
const REACTION = 0.4;

export class SmoothFormation {
  /**
   * gain: how hard speed is driven toward and braked to its target (1/s); default DRIVE_GAIN. grip: the share of its
   * lane's cornering limit it drives at, at most (catching up, pace plus eagerness reaches it in slow corners).
   */
  constructor(private readonly traits: (car: Car) => FormationTraits, private readonly gain = DRIVE_GAIN, private readonly grip = 0.85) {}

  decide(car: Car, world: World): void {
    const ctl = world.control!;
    const t = world.track;
    const tr = this.traits(car);
    const slot = ctl.slotFor(car);
    const pace = ctl.paceSpeedAt(car.s);
    let lane: number;
    let v: number;
    if (!slot || (ctl.flag === 'caution' && !ctl.pickedUp && !ctl.wavedAround(car))) {
      // No line yet: slow to caution pace where you are, closing up to the car ahead in your own way.
      lane = Math.max(-6, Math.min(6, car.d));
      v = pace + tr.eagerness * this.closing(car, world, lane);
    } else {
      // Metres the slot is ahead (+) or behind (-); a slot far behind is reached by going round (but not by a car that
      // got by the pace car: it drops back).
      const err = ctl.slotGap(car)!;
      const base = Math.max(slot.speed, pace);
      // Toward the place: faster when behind it, slower when ahead, saturating at the driver's eagerness.
      v = Math.max(3, base + tr.eagerness * Math.tanh((0.3 * err) / Math.max(1, tr.eagerness)));
      if (slot.speed < base) v = Math.max(3, Math.min(v, slot.speed + tr.eagerness * Math.tanh((0.3 * err) / Math.max(1, tr.eagerness))));
      // Where to be across the track: the slot's lane near it; while catching up, the lane you're in (above the
      // yield lane), blending into the slot's over the last stretch.
      const yieldLane = ctl.yieldLane();
      const near = 1 - ramp(Math.abs(err), 30, 60);
      const catchLane = Math.min(yieldLane - 2 * P.CAR_RADIUS - 0.5, Math.max(-6, car.d));
      lane = near * slot.d + (1 - near) * catchLane;
      // Giving way, low in the yield lane: for being ahead of your place (by more and more of a line's spacing),
      // for a car that belongs ahead coming up behind (as its arrival nears), for race control's call.
      const spacing = ctl.lineSpacing();
      let give = ramp(-err, 0.5 * spacing, 1.5 * spacing);
      for (const other of world.cars) {
        const o = ctl.slotFor(other);
        if (!o || o.index >= slot.index || other.retired) continue;
        const behind = t.distanceFrom(other.s, car.s) - 2 * P.CAR_RADIUS;
        const closing = other.speed - car.speed;
        if (behind <= 0 || behind > t.length / 2 || closing <= 0) continue;
        const need = (closing * closing) / (2 * 4) + tr.followGap + 2 * P.CAR_RADIUS;
        give = Math.max(give, 1 - ramp(behind, need, 2 * need));
      }
      const told = ctl.toLineUpBehind(car);
      if (told) {
        const past = t.distanceFrom(told.s, car.s);
        if (past < t.length / 2) {
          give = 1;
          v = Math.min(v, Math.max(3, told.speed + tr.eagerness * Math.tanh((-0.3 * (past + 2 * P.CAR_RADIUS + tr.followGap)) / Math.max(1, tr.eagerness))));
        }
      }
      lane = (1 - give) * lane + give * yieldLane;
      if (ctl.wavedAround(car)) { lane = -(2 * P.CAR_RADIUS + 0.5); v = slot.speed + tr.eagerness; }
    }
    // On the racing surface, whatever lane that is: "where you are" on a narrow circuit can be its edge or past it, and
    // a car off it is brought back on.
    const inside = P.CAR_RADIUS + 0.5;
    lane = Math.max(t.outerEdge(car.trackIdx) + inside, Math.min(t.innerEdge(car.trackIdx) - inside, lane));
    // Round a wreck ahead, on the side you're already on, pushed out more the nearer it is.
    const wreck = ctl.wreckAhead(car);
    if (wreck) {
      const gap = t.distanceFrom(car.s, wreck.s);
      const side = car.d < (wreck.lo + wreck.hi) / 2 ? -1 : 1;
      const clear = side < 0 ? wreck.lo - 5 : wreck.hi + 5;
      const off = Math.max(0, wreck.lo - lane, lane - wreck.hi);
      const w = (1 - ramp(gap, 60, 200)) * (1 - ramp(off, 3, 6));
      lane = (1 - w) * lane + w * clear;
    }
    v = Math.min(v, this.followCap(car, world, lane, tr));
    followLine(car, world, () => lane, () => v, this.grip, false, this.gain);
  }

  /** How keen to close up to the car ahead (0-1): more the further it is, up to a lap's worth of eagerness. */
  private closing(car: Car, world: World, lane: number): number {
    const ahead = world.control!.carAheadInFile(car, lane);
    if (!ahead) return 0;
    return ramp(world.track.distanceFrom(car.s, ahead.s), 20, 120);
  }

  /**
   * The fastest it may go: able to stop behind every car ahead in its way, even one that stops as hard as it can.
   * A car counts by how much of its width is in the path (heading for `lane`), not in or out of a file: one barely
   * overlapping costs a little speed, one dead ahead all of it. A wreck being steered round isn't in the path.
   */
  private followCap(car: Car, world: World, lane: number, tr: FormationTraits): number {
    const ctl = world.control!;
    const t = world.track;
    const gap = 2 * P.CAR_RADIUS + tr.followGap + followLoss(car.speed, REACTION, BRAKE, BRAKE);
    let cap = Infinity;
    // (Wreckers at work too: bigger, and moving at what they're doing along the track.)
    for (const other of [...world.cars, ...(ctl.paceCarOut ? [ctl.paceCar] : []), ...world.solidVehicles]) {
      if (other === car || other.cleared || other.waiting) continue;
      const ds = t.distanceFrom(car.s, other.s);
      if (ds <= 0 || ds > LOOK) continue;
      // Where this car will be across the road when it gets there: heading for the lane, a few metres a second.
      const reach = ds / Math.max(1, car.speed);
      const there = car.d + Math.max(-3 * reach, Math.min(3 * reach, lane - car.d));
      const touch = P.CAR_RADIUS + other.radius;
      const overlap = 1 - ramp(Math.abs(other.d - there), touch, touch + 1.5);
      if (overlap <= 0) continue;
      const i = other.trackIdx;
      const vOther = other.retired ? 0
        : world.vehicles.includes(other) ? Math.max(0, other.vx * t.tx[i] + other.vy * t.ty[i]) : other.speed;
      const full = Math.sqrt(vOther * vOther + 2 * BRAKE * Math.max(0, ds - gap));
      cap = Math.min(cap, full / overlap);
    }
    return cap;
  }
}
