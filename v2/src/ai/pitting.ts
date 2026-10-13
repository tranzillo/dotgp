import { PHYSICS as P, PIT_SERVICE } from '../sim/constants';
import type { Car, PitCall } from '../sim/car';
import type { Track } from '../sim/track';
import type { World } from '../sim/world';
import { followLine } from './lineFollower';
import type { Spotter } from './spotter';

/**
 * Where crew chiefs make the call each lap: before turn 3, early enough for
 * the car to get down to the apron for the pit entry at turn 4 exit.
 */
export function pitDecisionS(track: Track): number {
  return Math.max(-track.length / 2 + 10, track.pit.entryStart - 300);
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
}

export function randomTraits(random: () => number): CrewChiefTraits {
  return {
    fuelMarginLaps: 0.6 + random() * 1.8,
    tireLimit: 0.25 + random() * 0.2,
    repairBelow: 0.55 + random() * 0.3,
    minLapsForTires: 4 + Math.floor(random() * 8),
  };
}

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
  /** Health after the last repair: only call for repairs again if there is new damage. */
  private repairedTo = -1;

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
    const newDamage = this.repairedTo < 0 || car.health < this.repairedTo - 0.05;
    const damaged = car.health < t.repairBelow && newDamage && lapsLeft > 5;
    if (!needFuel && !wornTires && !damaged) return null;

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
    if (call.repair) this.repairedTo = 1 - (1 - car.health) * (1 - PIT_SERVICE.REPAIR_FRACTION);
    this.lastMessage = `Box this lap: ${parts.join(', ')}`;
    return call;
  }
}

/**
 * Scripted pit maneuver: down to the apron for the entry at turn 4 exit, pit
 * road at the speed limit, stop in the box, then out through the blend lane
 * and back on track on the back straight. The world runs the stop itself.
 */
export class PitAutopilot {
  private fromLane = 0;
  /** Distance from the box (m) where the merge began, once the spotter cleared it. */
  private mergeFrom = NaN;

  begin(car: Car): void {
    this.fromLane = car.d;
    this.mergeFrom = NaN;
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
    const fastLane = Math.max(track.pit.wallD + track.pit.wallThickness / 2 + 3, wallClear);
    const boxLane = track.pit.wallD + track.pit.wallThickness / 2 + 9.5;
    const entryStart = track.pit.entryStart;
    const exitEnd = track.pit.exitEnd;
    const ramp = (r: number, r0: number, r1: number, a: number, b: number) =>
      r <= r0 ? a : r >= r1 ? b : a + (b - a) * (r - r0) / (r1 - r0);

    if (pit.phase === 'in') {
      const r0 = track.signedS(car.s);
      // Not lined up for pit road as the wall's nose approaches: abort and stay out.
      if (r0 > track.pit.wallStart - 40 && r0 < track.pit.wallStart && car.d < wallClear - 0.8) {
        pit.phase = 'none';
        pit.call = null;
        world.announce(car, 'missed-pit', 'Aborted pit entry, not lined up');
        car.inputX = 0;
        car.inputY = 0;
        return;
      }
      const lane = (s: number) => {
        const r = track.signedS(s);
        if (r < entryStart) return ramp(r, entryStart - 280, entryStart, this.fromLane, entryLane);
        // Lined up for pit road well before the wall's nose.
        if (r < track.pit.wallStart) return ramp(r, entryStart, track.pit.wallStart - 50, entryLane, fastLane);
        return ramp(r, pit.boxS - 40, pit.boxS - 8, fastLane, boxLane);
      };
      const cap = (s: number) => {
        const r = track.signedS(s);
        if (r < track.pit.wallStart - 5 || r > track.pit.wallEnd + 5) return Infinity;
        // Pit limiter speed, then a stop on the box.
        return Math.min(PIT_SERVICE.SPEED_LIMIT - 1, Math.sqrt(2 * 3 * Math.max(0, pit.boxS - r)));
      };
      // Well under the cornering limit, leaving grip to work down the track.
      followLine(car, world, lane, cap, 0.75);
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
          if (du < track.distanceFrom(pit.boxS, track.pit.wallEnd)) return ramp(r, pit.boxS, pit.boxS + 25, boxLane, fastLane);
          // Clear of the wall's end before cutting across to the apron.
          if (du < track.distanceFrom(pit.boxS, exitEnd)) return ramp(r, track.pit.wallEnd + 15, exitEnd, fastLane, apronLaneAt(s));
          return apronLaneAt(s);
        }
        return ramp(du, mergeFrom, mergeFrom + 90, apronLaneAt(s), track.innerEdgeAt(s) - 2.5);
      };
      const cap = (s: number) => (track.signedS(s) < track.pit.wallEnd ? PIT_SERVICE.SPEED_LIMIT - 1 : Infinity);
      followLine(car, world, lane, cap, 0.9);
    } else {
      car.inputX = 0;
      car.inputY = 0;
    }
  }
}
