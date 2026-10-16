import type { Car } from '../sim/car';
import type { Controller, World } from '../sim/world';
import { FormationDriver, type FormationTraits } from './formation';
import { followLine } from './lineFollower';
import { genomeSize, Network, widenNetwork } from './network';
import { PIT_SERVICE } from '../sim/constants';
import { PitAutopilot, pitDecisionS, pitRoute, type CrewChief } from './pitting';
import { CAUTION_SIZE, OBS_SIZE, observe, observeCaution, observePit, PIT_SIZE } from './observe';
import { Rng } from './rng';
import { RADIO_SIZE, TowerSpotter, type Spotter } from './spotter';

/** Driver network: own-car observations + the spotter's radio + a pit stop in progress + a caution -> acceleration request. */
export const DRIVER_LAYERS = [OBS_SIZE + RADIO_SIZE + PIT_SIZE + CAUTION_SIZE, 32, 24, 2] as const;
/** Earlier drivers, still loadable via adaptWeights: before caution inputs, before pit inputs, and solo-era (no radio). */
export const PIT_DRIVER_LAYERS = [OBS_SIZE + RADIO_SIZE + PIT_SIZE, 32, 24, 2] as const;
export const RADIO_DRIVER_LAYERS = [OBS_SIZE + RADIO_SIZE, 24, 16, 2] as const;
export const LEGACY_DRIVER_LAYERS = [OBS_SIZE, 16, 12, 2] as const;

/** Upgrade saved weights to the current driver network, preserving behaviour (new inputs start ignored). */
export function adaptWeights(w: Float32Array): Float32Array {
  if (w.length === genomeSize(DRIVER_LAYERS)) return w;
  for (const old of [PIT_DRIVER_LAYERS, RADIO_DRIVER_LAYERS, LEGACY_DRIVER_LAYERS]) {
    if (w.length === genomeSize(old)) {
      const rng = new Rng(w.length);
      return widenNetwork(old, w, DRIVER_LAYERS, () => rng.next());
    }
  }
  throw new Error(`unrecognised driver genome (${w.length} weights)`);
}

/** The driver's seat of a team: reads its own car, the radio, a pit stop in progress, and a caution. */
export interface DriverBrain {
  decide(car: Car, world: World, radio: Float32Array, pit: Float32Array, caution: Float32Array): void;
}

/**
 * A team in the car: the crew chief runs strategy, the spotter calls the
 * race, the driver drives. During a pit cycle the scripted pit maneuver
 * takes the wheel until the car is back on the back straight.
 */
export class Team implements Controller {
  readonly radio = new Float32Array(RADIO_SIZE);
  readonly pitInputs = new Float32Array(PIT_SIZE);
  readonly cautionInputs = new Float32Array(CAUTION_SIZE);
  readonly autopilot = new PitAutopilot();
  private readonly formation: FormationDriver;
  /** Whether race control had the field pacing at this driver's last look, and when that last changed. */
  private flagPacing: boolean | null = null;
  private flagChangedAt = -Infinity;
  private lastS = NaN;
  /** Who drove the car on the last decision: the learned driver, or a script (pit maneuver, formation). */
  mode: 'driver' | 'pit' | 'formation' = 'driver';

  constructor(
    readonly driver: DriverBrain,
    readonly spotter: Spotter = new TowerSpotter(),
    readonly crewChief: CrewChief | null = null,
    /** The driver drives its own pit stops (it has learned to); otherwise the scripted maneuver does. */
    readonly driverPits = false,
    /** The driver drives its own cautions and restarts (it has learned to); otherwise the formation script does. */
    readonly driverCautions = false,
    /** How this driver drives a caution with the formation script (default: drawn for the car). */
    formationTraits?: FormationTraits,
  ) {
    this.formation = new FormationDriver(formationTraits);
  }

  decide(car: Car, world: World): void {
    const track = world.track;
    const r = track.signedS(car.s);
    if (car.pit.phase === 'none' && (this.crewChief || car.pendingPenalty)) {
      const dp = pitDecisionS(track);
      if (this.lastS < dp && r >= dp && r - this.lastS < 50) {
        // A penalty to serve comes first, under green (stewards' orders); otherwise the chief decides.
        const p = car.pendingPenalty;
        const serve = p && (!world.control || world.control.flag === 'green');
        const call = serve
          ? { tires: false, fuel: 0, repair: false, penalty: p.kind, penaltySeconds: p.seconds }
          : this.crewChief?.decide(car, world) ?? null;
        if (call) {
          car.pit.phase = 'in';
          car.pit.call = call;
          this.autopilot.begin(car);
          world.announce(car, 'crew', serve ? `Serve the ${p.kind === 'stop-go' ? `${p.seconds} s stop-and-go` : 'drive-through'} this lap` : this.crewChief!.lastMessage);
        }
      }
    }
    this.lastS = r;
    this.spotter.call(car, world, this.radio);
    this.observePit(car, world);
    observeCaution(car, world, this.cautionInputs);
    if (!this.driverPits && (car.pit.phase !== 'none' || this.autopilot.aborting)) { this.mode = 'pit'; this.autopilot.decide(car, world, this.spotter); }
    else if (!this.driverCautions && this.inFormation(car, world)) { this.mode = 'formation'; this.formation.decide(car, world); }
    else { this.mode = car.pit.phase === 'none' ? 'driver' : 'pit'; this.driver.decide(car, world, this.radio, this.pitInputs, this.cautionInputs); }
  }

  /**
   * Formation driving, with this driver's own reaction: the caution flag (or
   * the green) takes it a moment to react to, so it keeps doing what it was
   * doing until it has: racing on into a caution, holding station into a green.
   */
  private inFormation(car: Car, world: World): boolean {
    const pacing = !!world.control?.pacing;
    if (this.flagPacing === null) this.flagPacing = pacing; // first look: already reacted
    else if (pacing !== this.flagPacing) {
      this.flagPacing = pacing;
      this.flagChangedAt = world.time;
    }
    if (car.finished || car.pit.phase !== 'none' || !world.control) return false;
    const reacted = world.time - this.flagChangedAt >= this.formation.traitsFor(car).reaction;
    return pacing ? reacted : !reacted;
  }

  /** The pit stop as the driver sees it (zeros when not pitting). */
  observePit(car: Car, world: World): void {
    if (car.pit.phase === 'none') {
      this.pitInputs.fill(0);
      return;
    }
    const route = pitRoute(world.track, car.pit, this.autopilot.fromLane);
    // No traffic in ghost sessions: always clear to merge.
    const clear = car.pit.phase === 'out' && (!world.opts.collisions || this.spotter.clearToMerge(car, world));
    observePit(car, world.track, route, clear, PIT_SERVICE.SPEED_LIMIT, this.pitInputs);
  }
}

/** Raw-control driver: network outputs the acceleration request in the travel frame. */
export class NeuralDriver implements DriverBrain {
  readonly net: Network;
  private readonly input = new Float32Array(OBS_SIZE + RADIO_SIZE + PIT_SIZE + CAUTION_SIZE);
  private readonly obs = new Float32Array(OBS_SIZE);

  constructor(weights: Float32Array) {
    this.net = new Network(DRIVER_LAYERS, weights);
  }

  /** The network's input for this moment (also what an apprentice is shown). */
  inputs(car: Car, world: World, radio: Float32Array, pit: Float32Array, caution: Float32Array): Float32Array {
    this.input.set(observe(car, world.track, this.obs), 0);
    this.input.set(radio, OBS_SIZE);
    this.input.set(pit, OBS_SIZE + RADIO_SIZE);
    this.input.set(caution, OBS_SIZE + RADIO_SIZE + PIT_SIZE);
    return this.input;
  }

  decide(car: Car, world: World, radio: Float32Array, pit: Float32Array, caution: Float32Array): void {
    const out = this.net.forward(this.inputs(car, world, radio, pit, caution));
    car.inputX = out[0];
    car.inputY = out[1];
  }
}

export function neuralTeam(weights: Float32Array, crewChief: CrewChief | null = null, driverPits = false, driverCautions = false): Team {
  return new Team(new NeuralDriver(weights), new TowerSpotter(), crewChief, driverPits, driverCautions);
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
