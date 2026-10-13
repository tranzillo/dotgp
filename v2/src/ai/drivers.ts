import type { Car } from '../sim/car';
import type { Controller, World } from '../sim/world';
import { FormationDriver } from './formation';
import { followLine } from './lineFollower';
import { genomeSize, Network, widenNetwork } from './network';
import { PitAutopilot, pitDecisionS, type CrewChief } from './pitting';
import { OBS_SIZE, observe } from './observe';
import { Rng } from './rng';
import { RADIO_SIZE, TowerSpotter, type Spotter } from './spotter';

/** Driver network: own-car observations + the spotter's radio -> acceleration request. */
export const DRIVER_LAYERS = [OBS_SIZE + RADIO_SIZE, 24, 16, 2] as const;
/** Solo-era drivers (no radio), still loadable via adaptWeights. */
export const LEGACY_DRIVER_LAYERS = [OBS_SIZE, 16, 12, 2] as const;

/** Upgrade saved weights to the current driver network, preserving behaviour. */
export function adaptWeights(w: Float32Array): Float32Array {
  if (w.length === genomeSize(DRIVER_LAYERS)) return w;
  if (w.length === genomeSize(LEGACY_DRIVER_LAYERS)) {
    const rng = new Rng(w.length);
    return widenNetwork(LEGACY_DRIVER_LAYERS, w, DRIVER_LAYERS, () => rng.next());
  }
  throw new Error(`unrecognised driver genome (${w.length} weights)`);
}

/** The driver's seat of a team: reads its own car plus the radio. */
export interface DriverBrain {
  decide(car: Car, world: World, radio: Float32Array): void;
}

/**
 * A team in the car: the crew chief runs strategy, the spotter calls the
 * race, the driver drives. During a pit cycle the scripted pit maneuver
 * takes the wheel until the car is back on the back straight.
 */
export class Team implements Controller {
  readonly radio = new Float32Array(RADIO_SIZE);
  private readonly autopilot = new PitAutopilot();
  private readonly formation = new FormationDriver();
  private lastS = NaN;

  constructor(
    readonly driver: DriverBrain,
    readonly spotter: Spotter = new TowerSpotter(),
    readonly crewChief: CrewChief | null = null,
  ) {}

  decide(car: Car, world: World): void {
    const track = world.track;
    const r = track.signedS(car.s);
    if (this.crewChief && car.pit.phase === 'none') {
      const dp = pitDecisionS(track);
      if (this.lastS < dp && r >= dp && r - this.lastS < 50) {
        const call = this.crewChief.decide(car, world);
        if (call) {
          car.pit.phase = 'in';
          car.pit.call = call;
          this.autopilot.begin(car);
          world.announce(car, 'crew', this.crewChief.lastMessage);
        }
      }
    }
    this.lastS = r;
    this.spotter.call(car, world, this.radio);
    if (car.pit.phase !== 'none') this.autopilot.decide(car, world, this.spotter);
    else if (world.control?.pacing && !car.finished) this.formation.decide(car, world);
    else this.driver.decide(car, world, this.radio);
  }
}

/** Raw-control driver: network outputs the acceleration request in the travel frame. */
export class NeuralDriver implements DriverBrain {
  readonly net: Network;
  private readonly input = new Float32Array(OBS_SIZE + RADIO_SIZE);
  private readonly obs = new Float32Array(OBS_SIZE);

  constructor(weights: Float32Array) {
    this.net = new Network(DRIVER_LAYERS, weights);
  }

  decide(car: Car, world: World, radio: Float32Array): void {
    this.input.set(observe(car, world.track, this.obs), 0);
    this.input.set(radio, OBS_SIZE);
    const out = this.net.forward(this.input);
    car.inputX = out[0];
    car.inputY = out[1];
  }
}

export function neuralTeam(weights: Float32Array, crewChief: CrewChief | null = null): Team {
  return new Team(new NeuralDriver(weights), new TowerSpotter(), crewChief);
}

/**
 * Hand-written baseline. Not a racer: it exists to prove the physics is
 * lappable and to give evolved drivers something to beat.
 */
export class ScriptedDriver implements Controller, DriverBrain {
  constructor(
    private readonly lane = 0,
    /** Fraction of the theoretical corner speed to target. */
    private readonly margin = 0.95,
  ) {}

  decide(car: Car, world: World): void {
    followLine(car, world, () => this.lane, () => Infinity, this.margin);
  }
}
