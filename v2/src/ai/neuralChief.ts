import { PHYSICS as P } from '../sim/constants';
import type { Car, PitCall } from '../sim/car';
import type { World } from '../sim/world';
import { genomeSize, Network, type Example } from './network';
import type { CrewChief } from './pitting';
import type { Rng } from './rng';

export const CHIEF_INPUTS = 11;
/** Crew chief network: race situation -> [pit?, tires?, fuel amount, repair?]. */
export const CHIEF_LAYERS = [CHIEF_INPUTS, 10, 4] as const;

/**
 * What a crew chief can measure from the pit box, lap to lap: fuel burn and
 * tire wear per lap, lap times, and laps since the last stop.
 */
export class StintLog {
  burnPerLap = 0;
  wearPerLap = 0;
  bestLap = Infinity;
  lastLap = NaN;
  lapsSinceStop = 0;
  private prevFuel = -1;
  private prevTire = -1;
  private prevLaps = -1;
  private prevStops = 0;

  update(car: Car): void {
    const laps = car.lapsCompleted;
    if (this.prevLaps >= 0 && laps > this.prevLaps) {
      const n = laps - this.prevLaps;
      const stopped = car.pit.stops !== this.prevStops;
      // Laps that included a stop don't tell us about burn or wear.
      if (!stopped && car.fuel < this.prevFuel) {
        const burn = (this.prevFuel - car.fuel) / n;
        this.burnPerLap = this.burnPerLap ? this.burnPerLap * 0.6 + burn * 0.4 : burn;
      }
      if (!stopped && car.tireLife < this.prevTire) {
        const wear = (this.prevTire - car.tireLife) / n;
        this.wearPerLap = this.wearPerLap ? this.wearPerLap * 0.6 + wear * 0.4 : wear;
      }
      this.lapsSinceStop = stopped ? 0 : this.lapsSinceStop + n;
      const t = car.lapTimes[car.lapTimes.length - 1];
      if (t !== undefined && !stopped) {
        this.lastLap = t;
        this.bestLap = Math.min(this.bestLap, t);
      }
    }
    this.prevFuel = car.fuel;
    this.prevTire = car.tireLife;
    this.prevLaps = laps;
    this.prevStops = car.pit.stops;
  }
}

/**
 * The crew chief's view of the race at the decision point, as network inputs.
 * Shared by the learned chief and the apprentice recorder so both see the same thing.
 */
export class ChiefObserver {
  readonly log = new StintLog();
  readonly obs = new Float32Array(CHIEF_INPUTS);
  /** Laps of fuel left at the measured burn (Infinity until a burn is known). */
  fuelLaps = Infinity;

  /** Updates the stint log and fills obs. Returns laps left (200 in open sessions). */
  observe(car: Car, world: World): number {
    const log = this.log;
    log.update(car);
    const lapsLeft = world.raceLaps === null ? 200 : world.raceLaps - car.lapsCompleted;
    const burn = log.burnPerLap || P.FUEL_CAPACITY / 30;
    const fuelLaps = car.fuel / burn;
    this.fuelLaps = log.burnPerLap > 0 ? fuelLaps : Infinity;
    const o = this.obs;
    o[0] = Math.min(lapsLeft, 200) / 50;
    o[1] = Math.min(fuelLaps, 60) / 20;
    o[2] = clamp((fuelLaps - lapsLeft) / 20, -2, 2);
    o[3] = car.tireLife;
    o[4] = Math.min(log.wearPerLap * 20, 2);
    o[5] = car.health;
    o[6] = Math.min(log.lapsSinceStop, 90) / 30;
    o[7] = Number.isFinite(log.bestLap) && Number.isFinite(log.lastLap) ? clamp((log.lastLap / log.bestLap - 1) * 10, -1, 3) : 0;
    o[8] = world.track.length / 2500;
    o[9] = car.fuel / P.FUEL_CAPACITY;
    o[10] = log.burnPerLap > 0 ? 1 : 0;
    return lapsLeft;
  }
}

/** Learned strategist. Decides once a lap at the pit decision point. */
export class NeuralCrewChief implements CrewChief {
  lastMessage = '';
  readonly net: Network;
  private readonly observer = new ChiefObserver();

  constructor(weights: Float32Array) {
    this.net = new Network(CHIEF_LAYERS, weights);
  }

  decide(car: Car, world: World): PitCall | null {
    const obs = this.observer;
    const lapsLeft = obs.observe(car, world);
    if (lapsLeft <= 1) return null;
    const out = this.net.forward(obs.obs);
    // Guardrail, as any real crew: never let the car run dry. If the fuel won't
    // reach the next call and won't reach the finish, the car comes in regardless.
    const burn = obs.log.burnPerLap;
    // Two laps of margin: the call comes half a lap before the box, and burn varies.
    const mustFuel = obs.fuelLaps < 2 && obs.fuelLaps < lapsLeft;
    if (out[0] <= 0 && !mustFuel) return null;

    const tank = P.FUEL_CAPACITY - car.fuel;
    let fuel = ((out[2] + 1) / 2) * tank;
    if (mustFuel) fuel = Math.max(fuel, Math.min(tank, 3 * burn));
    const call: PitCall = {
      tires: out[1] > 0,
      fuel,
      repair: out[3] > 0 && car.health < 0.98,
    };
    const fuelText = call.fuel < 0.5 ? 'no fuel' : call.fuel >= tank - 0.5 ? 'fill it up' : `${Math.round(call.fuel)} kg fuel`;
    this.lastMessage = `Box this lap: ${[call.tires ? 'four tires' : 'no tires', fuelText, call.repair ? 'fix the damage' : ''].filter(Boolean).join(', ')}`;
    return call;
  }
}

/** Fresh crew chief: small random weights, no built-in strategy. */
export function initialChiefWeights(rng: Rng): Float32Array {
  const w = new Float32Array(genomeSize(CHIEF_LAYERS));
  let i = 0;
  for (let l = 1; l < CHIEF_LAYERS.length; l++) {
    const fanIn = CHIEF_LAYERS[l - 1];
    for (let o = 0; o < CHIEF_LAYERS[l]; o++) {
      w[i++] = 0; // bias: neutral, so random chiefs pit at varied moments
      for (let k = 0; k < fanIn; k++) w[i++] = rng.gaussian() / Math.sqrt(fanIn);
    }
  }
  return w;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Wraps a veteran crew chief and records what it decides alongside what the
 * learned chief would see, so an apprentice can be trained to imitate it.
 * Outputs it has no opinion on (tires/fuel when staying out) are masked.
 */
export class ApprenticeRecorder implements CrewChief {
  readonly examples: Example[] = [];
  private readonly observer = new ChiefObserver();

  constructor(private readonly veteran: CrewChief) {}

  get lastMessage(): string {
    return this.veteran.lastMessage;
  }

  decide(car: Car, world: World): PitCall | null {
    const lapsLeft = this.observer.observe(car, world);
    const call = this.veteran.decide(car, world);
    if (lapsLeft <= 1) return call;
    const tank = P.FUEL_CAPACITY - car.fuel;
    const y = new Float32Array(4), mask = new Float32Array(4);
    y[0] = call ? 0.8 : -0.8;
    mask[0] = 1;
    if (call) {
      y[1] = call.tires ? 0.8 : -0.8;
      y[2] = tank > 0.5 ? Math.max(-0.9, Math.min(0.9, (2 * call.fuel) / tank - 1)) : 0;
      y[3] = call.repair ? 0.8 : -0.8;
      mask[1] = 1;
      mask[2] = tank > 0.5 ? 1 : 0;
      mask[3] = car.health < 0.98 ? 1 : 0;
    }
    this.examples.push({ x: this.observer.obs.slice(), y, mask });
    return call;
  }
}
