import { PHYSICS as P, PIT_SERVICE } from '../sim/constants';
import type { Car, PitCall } from '../sim/car';
import { compromise } from '../sim/damage';
import { evalProfile, pitBoxD, pitFastD, type Profile } from '../sim/layout';
import type { Track } from '../sim/track';
import type { World } from '../sim/world';
import { followLine } from './lineFollower';
import type { Spotter } from './spotter';

/**
 * Where crew chiefs make the call each lap: before turn 3, early enough for
 * the car to get down to the apron for the pit entry at turn 4 exit. Earlier
 * where the pit lane swings away across grass (set back, or on a chord):
 * the car has to be slow before the swing, not on pit road (on a road
 * circuit, not so early: the way there has corners, and the car moves over
 * through them from the call on: pitRampFrom).
 */
export function pitDecisionS(track: Track): number {
  // (A long pit lane's: its way in from the call is counted on from there, Track.pitInR.)
  if (track.pitLong) return track.signedS(track.pit.entryStart - LONG_CALL);
  const laid = !!(track.pit.entryRoute && track.pit.exitRoute);
  return Math.max(-track.length / 2 + 10, track.pit.entryStart - (laid ? (track.kind === 'road' ? 500 : 700) : 300));
}

/**
 * Where a car called in starts over to the pit entry (signed s): 280 m
 * before it, holding its lane until then; on a road circuit's laid lane,
 * from the call (a lane held through corners runs off the track); on a long
 * pit lane, from the call too.
 */
function pitRampFrom(track: Track): number {
  const laid = !!(track.pit.entryRoute && track.pit.exitRoute);
  if (track.pitLong) return track.pit.entryStart - LONG_CALL;
  return laid && track.kind === 'road' ? pitDecisionS(track) : track.pit.entryStart - 280;
}

/** A long pit lane's call this far before its entry (m). */
const LONG_CALL = 300;

/** The crew chief: the team's strategist. */
export interface CrewChief {
  /** Called once a lap at the decision point. Return a call to bring the car in. */
  decide(car: Car, world: World): PitCall | null;
  /** Laps the car's fuel lasts, as far as the chief knows (Infinity if it doesn't). */
  fuelLaps?(car: Car): number;
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

  fuelLaps(car: Car): number {
    return this.burnPerLap > 0 ? car.fuel / this.burnPerLap : Infinity;
  }

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
    // (A compromised car, smoking and losing pace under the second damage model, comes in whatever the chief's taste.)
    const damaged = (car.health < t.repairBelow || compromise(car.health) > 0) && newDamage && worthIt && lapsLeft > 5;
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
      reason: needFuel ? 'fuel' : wornTires ? 'tires' : damaged ? 'damage' : 'caution',
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

/**
 * Where the entry route starts: as far in as the paving there allows, up to the wall's clear line (an oval's wide
 * apron: past the wall's line already), and at least the apron's middle (a circuit's entry, off the track's edge).
 */
function pitEntryLane(track: Track, apronLane: number, wallClear: number): number {
  return Math.max(apronLane, Math.min(wallClear, track.pavedInnerD(track.pit.entryStart) - P.CAR_RADIUS - 0.5));
}

export function pitLanes(track: Track): PitLanes {
  const apronLaneAt = (s: number) => track.innerEdgeAt(s) + track.apronWidth / 2;
  const wallClear = track.pit.wallD + track.pit.wallThickness / 2 + P.CAR_RADIUS + 1.2;
  return {
    apronLaneAt,
    wallClear,
    entryLane: pitEntryLane(track, apronLaneAt(track.pit.entryStart), wallClear),
    fastLane: Math.max(pitFastD(track.pit), wallClear),
    boxLane: pitBoxD(track.pit),
  };
}

const ramp = (r: number, r0: number, r1: number, a: number, b: number) =>
  r <= r0 ? a : r >= r1 ? b : a + (b - a) * (r - r0) / (r1 - r0);
/** ...eased at both ends: a long pit lane's way in, followed matching its slope and bend (it's called late: a short oval's). */
const smoothRamp = (r: number, r0: number, r1: number, a: number, b: number) => {
  const t = Math.max(0, Math.min(1, (r - r0) / (r1 - r0)));
  return a + (b - a) * t * t * (3 - 2 * t);
};

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
    const inEnd = pit.wallStart - 50;
    path = {
      laid: false,
      // (Across to the fast lane down the deceleration lane, inside its paving as it flares out.)
      inAt: (r) => (track.pitLong ? smoothRamp : ramp)(r, pit.entryStart, inEnd, lanes.entryLane, lanes.fastLane),
      inEnd,
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
export function pitRoute(track: Track, car: Car, fromLane: number): (s: number) => number {
  const pit = car.pit;
  const lanes = pitLanes(track);
  const path = pitPath(track);
  const { entryStart, exitEnd, wallStart, wallEnd } = track.pit;
  if (pit.phase === 'out') {
    const mergeFrom = Math.max(track.distanceFrom(pit.boxS, track.pit.blendEnd) - PIT_SERVICE.MERGE_ZONE, track.distanceFrom(pit.boxS, exitEnd));
    return (s: number) => {
      const r = track.pitOutAt(car, s);
      const du = track.progressFrom(pit.boxS, s);
      if (du < track.distanceFrom(pit.boxS, wallEnd)) return ramp(r, pit.boxS, pit.boxS + 25, lanes.boxLane, lanes.fastLane) + track.pitOffset(s);
      if (du < track.distanceFrom(pit.boxS, exitEnd)) return r < path.outStart ? lanes.fastLane + track.pitOffset(s) : path.outAt(r, s);
      return ramp(du, mergeFrom, mergeFrom + 90, lanes.apronLaneAt(s), track.innerEdgeAt(s) - 2.5);
    };
  }
  return (s: number) => {
    const r = track.pitInAt(car, s);
    if (r < entryStart) return (track.pitLong ? smoothRamp : ramp)(r, pitRampFrom(track), entryStart, fromLane, path.inAt(entryStart));
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
const ABORT_DISTANCE = 60;
/** ... but not before the car has had this far past the pit entry (m) to move over. */
const ABORT_GRACE = 40;
/** Speed an aborted pit entry backs out at (m/s). */
const ABORT_SPEED = 18;
/** How far up the road a car on its way in looks for traffic slowing into the pit entry (m). */
const WAVE_OFF_LOOK = 200;
/** How far back it looks for cars racing up behind it (m). */
const WAVE_OFF_BEHIND = 80;
/** A car slower than this (m/s) is stopped: a wreck, a spun or stranded car. */
const WAVE_OFF_STOPPED = 5;
/** Laps of fuel a car must have to stay out another lap. */
export const WAVE_OFF_FUEL_LAPS = 1.25;
/**
 * Braking on the racing surface (m/s^2) a driver will do for traffic slowing into the pit entry ahead, with cars
 * racing up behind it, before waving the stop off: a timid driver's, and a fearless one's.
 */
const WAVE_OFF_BRAKE_TIMID = 2.5;
const WAVE_OFF_BRAKE_BOLD = 6.5;

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
  /** The driver's nerve (0 timid, 1 fearless): how much braking for slowing traffic it takes before waving off. */
  nerve = 0.5;
  /** Whether the car can stay out another lap (its fuel); the team sets it from the crew chief's fuel burn. */
  canStayOut: (car: Car) => boolean = () => true;

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

  /**
   * Whether to wave the stop off and come in next time round: still on the racing surface short of the pit entry,
   * the way in ahead blocked by cars slowing into it (or stopped), and following them in would take braking on the
   * racing surface with cars racing up behind, more than this driver's nerve will stand. A stopped car on the way in
   * counts whether or not anyone is behind.
   */
  private waveOff(car: Car, world: World, laneAt: (s: number) => number): boolean {
    const track = world.track;
    const r0 = track.pitInR(car);
    // (A penalty is served when the stewards say, not when it suits.)
    if (r0 > track.pit.entryStart || car.d > track.innerEdgeAt(car.s) + 0.5 || car.pit.call?.penalty || !this.canStayOut(car)) return false;
    const along = (c: Car) => c.vx * track.tx[c.trackIdx] + c.vy * track.ty[c.trackIdx];
    const v = along(car);
    let brake = 0;
    let stopped = false;
    for (const other of world.cars) {
      if (other === car || other.cleared) continue;
      const gap = track.distanceFrom(car.s, other.s);
      if (gap <= 0 || gap > WAVE_OFF_LOOK) continue;
      // On the way in, short of the deceleration lane's end: a car going in itself, or one stopped in our path
      // (racing traffic is the racing's business).
      if (track.pitInAt(car, other.s) > track.pit.entryStart + 40) continue;
      const vOther = other.retired ? 0 : Math.max(0, along(other));
      if (other.pit.phase !== 'in' && !(vOther < WAVE_OFF_STOPPED && Math.abs(other.d - laneAt(other.s)) < 2.6)) continue;
      const closing = v - vOther;
      if (closing <= 0) continue;
      const room = Math.max(0.5, gap - 2 * P.CAR_RADIUS - PIT_GAP);
      brake = Math.max(brake, (closing * closing) / (2 * room));
      if (vOther < WAVE_OFF_STOPPED) stopped = true;
    }
    if (brake === 0) return false;
    const behind = world.cars.some((o) => o !== car && !o.cleared && !o.retired && o.pit.phase === 'none'
      && track.distanceFrom(o.s, car.s) > 0 && track.distanceFrom(o.s, car.s) < WAVE_OFF_BEHIND && along(o) > v - 5);
    const nerve = Math.max(0, Math.min(1, this.nerve));
    return (behind || stopped) && brake > WAVE_OFF_BRAKE_TIMID + (WAVE_OFF_BRAKE_BOLD - WAVE_OFF_BRAKE_TIMID) * nerve;
  }

  decide(car: Car, world: World, spotter: Spotter): void {
    const track = world.track;
    const pit = car.pit;
    // Middle of the apron (wherever the inside edge is there).
    const apronLaneAt = (s: number) => track.innerEdgeAt(s) + track.apronWidth / 2;
    const apronLane = apronLaneAt(track.pit.entryStart);
    // Lines that pass the pit wall's ends must clear them with room to spare.
    const wallClear = track.pit.wallD + track.pit.wallThickness / 2 + P.CAR_RADIUS + 1.2;
    const entryLane = pitEntryLane(track, apronLane, wallClear);
    const fastLane = Math.max(pitFastD(track.pit), wallClear);
    const boxLane = pitBoxD(track.pit);
    const entryStart = track.pit.entryStart;
    const exitEnd = track.pit.exitEnd;
    const path = pitPath(track);
    const entryLaneAt = path.inAt(entryStart);

    if (this.aborting) {
      // Back up onto the racing surface and past the wall's nose, then hand back.
      const r0 = track.pitInR(car);
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
      const r0 = track.pitInR(car);
      // Still on the track side of the wall's line close to its nose: abort and stay out. A car already
      // past the line commits to pit road (turning back across the nose from there is what hits it).
      // (A pit road set back across grass: its lane is still swinging over until just before the nose, so the call
      // waits for the last stretch, where the lane runs straight at the fast lane.)
      // (The route crosses the wall's line on its way to the fast lane, so the call waits for its last stretch.)
      const decideFrom = Math.max(track.pit.wallStart - ABORT_DISTANCE, path.inEnd - 20, entryStart + ABORT_GRACE);
      if (r0 > decideFrom && r0 < track.pit.wallStart && car.d < track.pit.wallD + track.pitOffset(car.s)) {
        pit.phase = 'none';
        pit.call = null;
        this.aborting = true;
        world.announce(car, 'missed-pit', 'Aborted pit entry, not lined up');
        this.decide(car, world, spotter);
        return;
      }
      const lane = (s: number) => {
        const r = track.pitInAt(car, s);
        if (r < entryStart) return (track.pitLong ? smoothRamp : ramp)(r, pitRampFrom(track), entryStart, this.fromLane, path.laid ? entryLaneAt : entryLane);
        // Lined up for pit road well before the wall's nose.
        if (r < track.pit.wallStart) return r > path.inEnd ? fastLane + track.pitOffset(s) : path.inAt(r);
        return ramp(r, pit.boxS - 40, pit.boxS - 8, fastLane, boxLane) + track.pitOffset(s);
      };
      if (this.waveOff(car, world, lane)) {
        // Stay out and come in next time round (the chief calls a stop the car still needs again); the driver has
        // the wheel again.
        pit.phase = 'none';
        pit.call = null;
        world.announce(car, 'crew', 'Waved off the stop: traffic slowing into the pit entry. Box next lap');
        car.inputX = 0;
        car.inputY = 0;
        return;
      }
      // Never faster than lets us stop behind the car ahead (or a car still in our box).
      const follow = this.followLimit(car, world, lane);
      const cap = (s: number) => {
        const r = track.pitInAt(car, s);
        if (r < track.pit.wallStart - 5 || r > track.pit.wallEnd + 5) return Math.min(follow, path.inCap(r));
        // Pit limiter speed, then a stop on the box.
        return Math.min(follow, PIT_SERVICE.SPEED_LIMIT - 1, Math.sqrt(2 * 3 * Math.max(0, pit.boxS - r)));
      };
      // Well under the cornering limit, leaving grip to work down the track.
      followLine(car, world, lane, cap, 0.75, path.laid || track.pitLong, this.driveGain);
    } else if (pit.phase === 'out') {
      // Merge: from the merge zone on, wait on the apron for the spotter's "clear".
      const blend = track.distanceFrom(pit.boxS, track.pit.blendEnd);
      // (The merge zone ends at the blend, but never starts before the exit taper: across from there is the wall.)
      const mergeZone = Math.max(blend - PIT_SERVICE.MERGE_ZONE, track.distanceFrom(pit.boxS, exitEnd));
      const u = track.progressFrom(pit.boxS, car.s);
      if (Number.isNaN(this.mergeFrom) && u > mergeZone
        && (spotter.clearToMerge(car, world) || u > blend + PIT_SERVICE.MERGE_GIVE_UP - 120)) {
        this.mergeFrom = u;
      }
      const mergeFrom = this.mergeFrom;
      const lane = (s: number) => {
        const du = track.progressFrom(pit.boxS, s);
        if (du < mergeZone || Number.isNaN(mergeFrom)) {
          const r = track.pitOutAt(car, s);
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
      const cap = (s: number) => Math.min(follow, track.pitOutAt(car, s) < track.pit.wallEnd ? PIT_SERVICE.SPEED_LIMIT - 1 : path.outCap(track.pitOutAt(car, s)));
      followLine(car, world, lane, cap, 0.9, path.laid, this.driveGain);
    } else {
      car.inputX = 0;
      car.inputY = 0;
    }
  }
}
