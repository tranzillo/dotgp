import { PHYSICS as P, PIT_SERVICE } from '../sim/constants';
import type { Car, PitCall, PitState } from '../sim/car';
import { evalProfile, fastLaneGap, type Profile } from '../sim/layout';
import type { Track } from '../sim/track';
import type { World } from '../sim/world';
import { followLine } from './lineFollower';
import type { Spotter } from './spotter';

/**
 * Where crew chiefs make the call each lap: before turn 3, early enough for
 * the car to get down to the apron for the pit entry at turn 4 exit. Earlier
 * where the pit lane swings away across grass (set back, or on a chord):
 * the car has to be slow before the swing, not on pit road.
 */
export function pitDecisionS(track: Track): number {
  const laid = !!(track.pit.entryRoute && track.pit.exitRoute);
  return Math.max(-track.length / 2 + 10, track.pit.entryStart - (laid ? 700 : 300));
}

/** The crew chief: the team's strategist. */
export interface CrewChief {
  /** Called once a lap at the decision point. Return a call to bring the car in. */
  decide(car: Car, world: World): PitCall | null;
  /** Short radio line describing the last call. */
  readonly lastMessage: string;
}

export interface CrewChiefTraits {
  /** Laps of fuel kept in reserve before calling the car in. */
  fuelMarginLaps: number;
  /** Tire life the chief won't run below: comes in before it, and takes tires if the next run would. */
  tireLimit: number;
  /** Health below which repairs are worth the extra time. */
  repairBelow: number;
  /** Don't bother with tires if the race ends within this many laps. */
  minLapsForTires: number;
  /**
   * Under caution, take a stop that's coming anyway once this share of a tank
   * is gone (it only costs places then, not a lap); undefined: never.
   */
  cautionStop?: number;
  /** ... and only if it doesn't add a stop to the race (filling up now still gets the car to the end on no more stops). */
  cautionSavesStop?: boolean;
}

export function randomTraits(random: () => number): CrewChiefTraits {
  return {
    fuelMarginLaps: 0.6 + random() * 1.8,
    tireLimit: 0.25 + random() * 0.2,
    repairBelow: 0.55 + random() * 0.3,
    minLapsForTires: 4 + Math.floor(random() * 8),
  };
}

/** Health lost since the last repair before another is worth calling. */
const REPAIR_AGAIN = 0.15;
/** Smallest health a repair must give back to be worth its time. */
const MIN_REPAIR_GAIN = 0.12;

/**
 * Scripted strategist with personality. It learns the car's fuel burn and
 * tire wear as the race goes, pits when fuel, tires or damage demand it, only
 * changes tires that won't last the next run (tires cost time; fuel hides
 * inside a tire change), and only fuels as much as it needs to reach the
 * finish (shorter stops late in the race).
 */
export class StrategistCrewChief implements CrewChief {
  lastMessage = '';
  private burnPerLap = 0;
  private wearPerLap = 0;
  private lastFuel = -1;
  private lastTire = -1;
  private lastLap = -1;
  /**
   * Health measured after the last repair (at the first call after the
   * stop): only call for repairs again if the car has been hurt clearly more
   * since. Measured, not predicted: cars often take more damage on the way in.
   */
  private repairedTo = -1;
  private awaitingRepair = false;
  private stopsSeen = 0;

  constructor(readonly traits: CrewChiefTraits) {}

  decide(car: Car, world: World): PitCall | null {
    // Learn the fuel burn from lap to lap (skip laps that included a stop).
    if (this.lastLap >= 0 && car.lapsCompleted > this.lastLap && car.fuel < this.lastFuel) {
      const burn = (this.lastFuel - car.fuel) / (car.lapsCompleted - this.lastLap);
      this.burnPerLap = this.burnPerLap ? this.burnPerLap * 0.6 + burn * 0.4 : burn;
    }
    if (this.lastLap >= 0 && car.lapsCompleted > this.lastLap && car.tireLife < this.lastTire) {
      const wear = (this.lastTire - car.tireLife) / (car.lapsCompleted - this.lastLap);
      this.wearPerLap = this.wearPerLap ? this.wearPerLap * 0.6 + wear * 0.4 : wear;
    }
    this.lastFuel = car.fuel;
    this.lastTire = car.tireLife;
    this.lastLap = car.lapsCompleted;

    const t = this.traits;
    const lapsLeft = world.raceLaps === null ? Infinity : world.raceLaps - car.lapsCompleted;
    if (lapsLeft <= 1) return null;

    const burn = this.burnPerLap || P.FUEL_CAPACITY / 30;
    const fuelLaps = car.fuel / burn;
    const needFuel = this.burnPerLap > 0 && fuelLaps < Math.min(lapsLeft, 1 + t.fuelMarginLaps);
    // Come in before the tires go past the limit (a lap from now is the next chance to call it).
    const wornTires = car.tireLife - 1.5 * this.wearPerLap < t.tireLimit && lapsLeft > t.minLapsForTires;
    if (this.awaitingRepair && car.pit.stops > this.stopsSeen) {
      this.repairedTo = car.health;
      this.awaitingRepair = false;
    }
    this.stopsSeen = car.pit.stops;
    const newDamage = this.repairedTo < 0 || car.health < this.repairedTo - REPAIR_AGAIN;
    // Worth the time only if the repair gives back a fair amount (it restores a share of what's missing).
    const worthIt = (1 - car.health) * PIT_SERVICE.REPAIR_FRACTION >= MIN_REPAIR_GAIN;
    const damaged = car.health < t.repairBelow && newDamage && worthIt && lapsLeft > 5;
    // A caution: the stop the car needs before the finish anyway is cheap now.
    const fullRun = P.FUEL_CAPACITY / burn;
    // Stops still to make: staying out (run this tank dry first), or filling up now (this stop, then full runs).
    const stopsStaying = Math.max(0, Math.ceil((lapsLeft - fuelLaps + t.fuelMarginLaps) / fullRun));
    const stopsPitting = 1 + Math.max(0, Math.ceil((lapsLeft - fullRun + t.fuelMarginLaps) / fullRun));
    const cautionStop = t.cautionStop !== undefined && world.control?.flag === 'caution' && this.burnPerLap > 0
      && fuelLaps < lapsLeft && car.fuel < P.FUEL_CAPACITY * (1 - t.cautionStop) && lapsLeft > 3
      && (!t.cautionSavesStop || stopsPitting <= stopsStaying);
    if (!needFuel && !wornTires && !damaged && !cautionStop) return null;

    const tank = P.FUEL_CAPACITY - car.fuel;
    const fuelToFinish = Number.isFinite(lapsLeft) ? (lapsLeft + t.fuelMarginLaps) * burn - car.fuel : tank;
    // Tires only if these won't last until the next stop (a full run on the fuel we're adding, or the finish).
    const fuel = Math.max(0, Math.min(tank, fuelToFinish));
    const nextRun = Math.min(lapsLeft, (car.fuel + fuel) / burn - t.fuelMarginLaps);
    const lastTheRun = car.tireLife - nextRun * this.wearPerLap >= t.tireLimit;
    const call: PitCall = {
      tires: wornTires || (!lastTheRun && lapsLeft > t.minLapsForTires),
      fuel,
      repair: damaged,
    };
    const parts = [call.tires ? 'four tires' : 'no tires', call.fuel > 0.5 ? (call.fuel >= tank - 0.5 ? 'fill it up' : 'fuel to the end') : '',
      call.repair ? 'fix the damage' : ''].filter(Boolean);
    if (call.repair) this.awaitingRepair = true;
    this.lastMessage = `Box this lap: ${parts.join(', ')}`;
    return call;
  }
}

/**
 * The crew chief in qualifying: nothing to plan, it brings the car in once
 * the session says it's done (its laps run, or the checkered flag taken), the
 * next time round at the usual point.
 */
export class RunChief implements CrewChief {
  readonly lastMessage = "That's the run, bring it in";

  constructor(private readonly done: (car: Car) => boolean) {}

  decide(car: Car): PitCall | null {
    return this.done(car) ? { tires: false, fuel: 0, repair: false } : null;
  }
}

/**
 * Scripted pit maneuver: down to the apron for the entry at turn 4 exit, pit
 * road at the speed limit, stop in the box, then out through the blend lane
 * and back on track on the back straight. The world runs the stop itself.
 */
/** The lanes a pit stop uses (lateral positions, d). */
export interface PitLanes {
  /** Middle of the apron at s. */
  apronLaneAt: (s: number) => number;
  /** Lines that pass the pit wall's ends clear them by this much. */
  wallClear: number;
  entryLane: number;
  fastLane: number;
  boxLane: number;
}

export function pitLanes(track: Track): PitLanes {
  const apronLaneAt = (s: number) => track.innerEdgeAt(s) + track.apronWidth / 2;
  const wallClear = track.pit.wallD + track.pit.wallThickness / 2 + P.CAR_RADIUS + 1.2;
  return {
    apronLaneAt,
    wallClear,
    entryLane: Math.max(apronLaneAt(track.pit.entryStart), wallClear),
    fastLane: Math.max(track.pit.wallD + fastLaneGap(track.pit.wallThickness, !!track.pit.offset), wallClear),
    boxLane: track.pit.wallD + track.pit.wallThickness / 2 + 9.5,
  };
}

const ramp = (r: number, r0: number, r1: number, a: number, b: number) =>
  r <= r0 ? a : r >= r1 ? b : a + (b - a) * (r - r0) / (r1 - r0);

/**
 * The pit lane's way in and out, as a lateral position for each s: in, from
 * the entry to pit road's fast lane (reached by inEnd); out, from the fast
 * lane (until outStart) past the wall's end to the apron at the exit. The
 * layout's routes where it has them (pit road set back from the track),
 * otherwise straight runs: the entry lane to the fast lane, 50 m before the
 * wall's nose; the fast lane to the apron from 15 m past its end.
 */
export interface PitPath {
  /** The layout laid the routes out (rather than the straight runs). */
  laid: boolean;
  inAt: (r: number) => number;
  inEnd: number;
  outAt: (r: number, s: number) => number;
  outStart: number;
  /**
   * Speed limits along the way in and out from how sharply the lane bends
   * across the track (a set-back pit road's lanes swing tens of metres over),
   * which the track's own curvature doesn't show. Infinity off the lanes.
   */
  inCap: (r: number) => number;
  outCap: (r: number) => number;
}

/** Sideways acceleration a car on a laid pit lane is held to (m/s^2). */
const LANE_LAT = 3.5;

/** Speed limit along a lane d(r) on [r0, r1] from its sideways bend, sampled every 5 m. */
function laneCap(d: (r: number) => number, r0: number, r1: number): (r: number) => number {
  const step = 5;
  const n = Math.max(1, Math.ceil((r1 - r0) / step));
  const caps = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) {
    const r = r0 + k * step;
    const bend = Math.abs(d(r + step) - 2 * d(r) + d(r - step)) / (step * step);
    caps[k] = bend > 1e-6 ? Math.sqrt(LANE_LAT / bend) : Infinity;
  }
  return (r) => (r < r0 - step || r > r1 + step ? Infinity : caps[Math.max(0, Math.min(n, Math.round((r - r0) / step)))]);
}

const paths = new WeakMap<Track, PitPath>();

export function pitPath(track: Track): PitPath {
  let path = paths.get(track);
  if (path) return path;
  const pit = track.pit;
  const lanes = pitLanes(track);
  if (pit.entryRoute && pit.exitRoute) {
    const along = (p: Profile) => {
      const lo = p.keys[0][0], hi = p.keys[p.keys.length - 1][0];
      return (r: number) => evalProfile(p, Math.min(hi, Math.max(lo, r)), track.length);
    };
    const inAt = along(pit.entryRoute), outAt = along(pit.exitRoute);
    const inEnd = pit.entryRoute.keys[pit.entryRoute.keys.length - 1][0], outStart = pit.exitRoute.keys[0][0];
    path = {
      laid: true,
      inAt, inEnd,
      outAt: (r) => outAt(r), outStart,
      // Through to the wall's ends: on a chord pit road itself still swings away from the track (and back) there.
      inCap: laneCap((r) => (r < inEnd ? inAt(r) : lanes.fastLane + track.pitOffset(r)), pit.entryStart, pit.wallStart + 10),
      outCap: laneCap((r) => (r > outStart ? outAt(r) : lanes.fastLane + track.pitOffset(r)), pit.wallEnd - 10, pit.exitEnd),
    };
  } else {
    path = {
      laid: false,
      inAt: (r) => ramp(r, pit.entryStart, pit.wallStart - 50, lanes.entryLane, lanes.fastLane),
      inEnd: pit.wallStart - 50,
      outAt: (r, s) => ramp(r, pit.wallEnd + 15, pit.exitEnd, lanes.fastLane, lanes.apronLaneAt(s)),
      outStart: pit.wallEnd + 15,
      inCap: () => Infinity,
      outCap: () => Infinity,
    };
  }
  paths.set(track, path);
  return path;
}

/**
 * The painted route through a pit stop, as a lateral position for each s:
 * in (from the lane the call caught the car in, down to the apron, lined up
 * for pit road well before the wall's nose, into the box) or out (from the
 * box to the fast lane, clear of the wall's end, onto the apron, and back onto
 * the racing surface from the merge zone on). The route is the path when the
 * spotter says it's clear to merge; whether it is, is the driver's call.
 */
export function pitRoute(track: Track, pit: PitState, fromLane: number): (s: number) => number {
  const lanes = pitLanes(track);
  const path = pitPath(track);
  const { entryStart, exitEnd, wallStart, wallEnd } = track.pit;
  if (pit.phase === 'out') {
    const mergeFrom = track.distanceFrom(pit.boxS, track.pit.blendEnd) - PIT_SERVICE.MERGE_ZONE;
    return (s: number) => {
      const r = track.signedS(s);
      const du = track.progressFrom(pit.boxS, s);
      if (du < track.distanceFrom(pit.boxS, wallEnd)) return ramp(r, pit.boxS, pit.boxS + 25, lanes.boxLane, lanes.fastLane) + track.pitOffset(s);
      if (du < track.distanceFrom(pit.boxS, exitEnd)) return r < path.outStart ? lanes.fastLane + track.pitOffset(s) : path.outAt(r, s);
      return ramp(du, mergeFrom, mergeFrom + 90, lanes.apronLaneAt(s), track.innerEdgeAt(s) - 2.5);
    };
  }
  return (s: number) => {
    const r = track.signedS(s);
    if (r < entryStart) return ramp(r, entryStart - 280, entryStart, fromLane, path.inAt(entryStart));
    if (r < wallStart) return r > path.inEnd ? lanes.fastLane + track.pitOffset(s) : path.inAt(r);
    return ramp(r, pit.boxS - 40, pit.boxS - 8, lanes.fastLane, lanes.boxLane) + track.pitOffset(s);
  };
}

/** Braking pit-road traffic rules plan around (m/s^2), and the gap kept to the car ahead (m, bumper to bumper). */
const PIT_DECEL = 4;
const PIT_GAP = 3;
/** How long a car waits in its box for the fast lane to clear before going anyway (s). */
const BOX_WAIT_LIMIT = 10;
/** Abort the pit entry if not lined up this far before the wall's nose (m). */
const ABORT_DISTANCE = 140;
/** ... but not before the car has had this far past the pit entry (m) to move over. */
const ABORT_GRACE = 40;
/** Speed an aborted pit entry backs out at (m/s). */
const ABORT_SPEED = 18;

export class PitAutopilot {
  /** The lane the car was in when the crew chief called it in (the route starts from there). */
  fromLane = 0;
  /**
   * Its throttle toward its speed when below it: in proportion (this gain, 1/s), as a teacher has to drive to be
   * copied, or (unset) flat out, as in races. See followLine.
   */
  driveGain?: number;
  /** Distance from the box (m) where the merge began, once the spotter cleared it. */
  private mergeFrom = NaN;
  /** World time the car started waiting in its box for a gap. */
  private waitingSince = NaN;
  /**
   * The pit entry was aborted: the maneuver keeps the wheel until the car is
   * back on the racing surface past the pit wall's nose, rather than letting
   * it coast into the wall end.
   */
  aborting = false;

  begin(car: Car): void {
    this.fromLane = car.d;
    this.mergeFrom = NaN;
    this.waitingSince = NaN;
    this.aborting = false;
  }

  /**
   * The fastest this car may go and still stop behind whatever is ahead on its
   * path (laneAt), within range: cars on pit road, a car being serviced in a
   * shared box, the pace car on its way in.
   */
  private followLimit(car: Car, world: World, laneAt: (s: number) => number, range = 80): number {
    const track = world.track;
    let limit = Infinity;
    const others = [...world.cars, ...world.officials.map((o) => o.car)];
    for (const other of others) {
      if (other === car || other.cleared) continue;
      const gap = track.distanceFrom(car.s, other.s);
      if (gap <= 0 || gap > range) continue;
      // On our path (or right where we are now).
      if (Math.abs(other.d - laneAt(other.s)) > 2.6 && Math.abs(other.d - car.d) > 2.6) continue;
      const along = other.vx * track.tx[other.trackIdx] + other.vy * track.ty[other.trackIdx];
      const room = Math.max(0, gap - 2 * P.CAR_RADIUS - PIT_GAP);
      limit = Math.min(limit, Math.sqrt(Math.max(0, along) ** 2 + 2 * PIT_DECEL * room));
    }
    return limit;
  }

  decide(car: Car, world: World, spotter: Spotter): void {
    const track = world.track;
    const pit = car.pit;
    // Middle of the apron (wherever the inside edge is there).
    const apronLaneAt = (s: number) => track.innerEdgeAt(s) + track.apronWidth / 2;
    const apronLane = apronLaneAt(track.pit.entryStart);
    // Lines that pass the pit wall's ends must clear them with room to spare.
    const wallClear = track.pit.wallD + track.pit.wallThickness / 2 + P.CAR_RADIUS + 1.2;
    const entryLane = Math.max(apronLane, wallClear);
    const fastLane = Math.max(track.pit.wallD + fastLaneGap(track.pit.wallThickness, !!track.pit.offset), wallClear);
    const boxLane = track.pit.wallD + track.pit.wallThickness / 2 + 9.5;
    const entryStart = track.pit.entryStart;
    const exitEnd = track.pit.exitEnd;
    const path = pitPath(track);
    const entryLaneAt = path.inAt(entryStart);

    if (this.aborting) {
      // Back up onto the racing surface and past the wall's nose, then hand back.
      const r0 = track.signedS(car.s);
      if (r0 > track.pit.wallStart + 10 || r0 < track.pit.wallStart - ABORT_DISTANCE - 60) {
        this.aborting = false;
        car.inputX = 0;
        car.inputY = 0;
        return;
      }
      // Slowly enough to be back across before the nose (at racing speed it isn't, and the nose is a car's width
      // from the edge).
      followLine(car, world, (s) => Math.min(track.innerEdgeAt(s) - 2.5, track.pitWallClear(s)), () => ABORT_SPEED, 0.75, false, this.driveGain);
      return;
    }
    if (pit.phase === 'in') {
      const r0 = track.signedS(car.s);
      // Still on the track side of the wall's line close to its nose: abort and stay out. A car already
      // past the line commits to pit road (turning back across the nose from there is what hits it).
      // (A pit road set back across grass: its lane is still swinging over until just before the nose, so the call
      // waits for the last stretch, where the lane runs straight at the fast lane.)
      const decideFrom = path.laid
        ? Math.max(track.pit.wallStart - 60, path.inEnd - 20)
        : Math.max(track.pit.wallStart - ABORT_DISTANCE, entryStart + ABORT_GRACE);
      if (r0 > decideFrom && r0 < track.pit.wallStart && car.d < track.pit.wallD + track.pitOffset(car.s)) {
        pit.phase = 'none';
        pit.call = null;
        this.aborting = true;
        world.announce(car, 'missed-pit', 'Aborted pit entry, not lined up');
        this.decide(car, world, spotter);
        return;
      }
      const lane = (s: number) => {
        const r = track.signedS(s);
        if (r < entryStart) return ramp(r, entryStart - 280, entryStart, this.fromLane, path.laid ? entryLaneAt : entryLane);
        // Lined up for pit road well before the wall's nose.
        if (r < track.pit.wallStart) return r > path.inEnd ? fastLane + track.pitOffset(s) : path.inAt(r);
        return ramp(r, pit.boxS - 40, pit.boxS - 8, fastLane, boxLane) + track.pitOffset(s);
      };
      // Never faster than lets us stop behind the car ahead (or a car still in our box).
      const follow = this.followLimit(car, world, lane);
      const cap = (s: number) => {
        const r = track.signedS(s);
        if (r < track.pit.wallStart - 5 || r > track.pit.wallEnd + 5) return Math.min(follow, path.inCap(r));
        // Pit limiter speed, then a stop on the box.
        return Math.min(follow, PIT_SERVICE.SPEED_LIMIT - 1, Math.sqrt(2 * 3 * Math.max(0, pit.boxS - r)));
      };
      // Well under the cornering limit, leaving grip to work down the track.
      followLine(car, world, lane, cap, 0.75, path.laid, this.driveGain);
    } else if (pit.phase === 'out') {
      // Merge: from the merge zone on, wait on the apron for the spotter's "clear".
      const blend = track.distanceFrom(pit.boxS, track.pit.blendEnd);
      const u = track.progressFrom(pit.boxS, car.s);
      if (Number.isNaN(this.mergeFrom) && u > blend - PIT_SERVICE.MERGE_ZONE
        && (spotter.clearToMerge(car, world) || u > blend + PIT_SERVICE.MERGE_GIVE_UP - 120)) {
        this.mergeFrom = u;
      }
      const mergeFrom = this.mergeFrom;
      const lane = (s: number) => {
        const du = track.progressFrom(pit.boxS, s);
        if (du < blend - PIT_SERVICE.MERGE_ZONE || Number.isNaN(mergeFrom)) {
          const r = track.signedS(s);
          if (du < track.distanceFrom(pit.boxS, track.pit.wallEnd)) return ramp(r, pit.boxS, pit.boxS + 25, boxLane, fastLane) + track.pitOffset(s);
          // Clear of the wall's end before cutting across to the apron.
          if (du < track.distanceFrom(pit.boxS, exitEnd)) return r < path.outStart ? fastLane + track.pitOffset(s) : path.outAt(r, s);
          return apronLaneAt(s);
        }
        return ramp(du, mergeFrom, mergeFrom + 90, apronLaneAt(s), track.innerEdgeAt(s) - 2.5);
      };
      // Leaving the box: wait for a gap in the fast lane behind (cars coming down pit road), within reason.
      let hold = false;
      if (u < 20) {
        if (Number.isNaN(this.waitingSince)) this.waitingSince = world.time;
        const waited = world.time - this.waitingSince;
        hold = waited < BOX_WAIT_LIMIT && world.cars.some((o) => o !== car && !o.cleared && !o.retired
          && o.surface === 'pit' && o.d < boxLane + track.pitOffset(o.s) - 4 && o.speed > 4
          && track.distanceFrom(o.s, car.s) > 0 && track.distanceFrom(o.s, car.s) < 45);
      }
      const follow = hold ? 0 : this.followLimit(car, world, lane);
      const cap = (s: number) => Math.min(follow, track.signedS(s) < track.pit.wallEnd ? PIT_SERVICE.SPEED_LIMIT - 1 : path.outCap(track.signedS(s)));
      followLine(car, world, lane, cap, 0.9, path.laid, this.driveGain);
    } else {
      car.inputX = 0;
      car.inputY = 0;
    }
  }
}
