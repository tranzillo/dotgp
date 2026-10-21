import type { Car } from '../sim/car';
import type { Controller, World } from '../sim/world';
import { FormationDriver, type FormationTraits } from './formation';
import { followLine } from './lineFollower';
import { genomeSize, Network, widenNetwork } from './network';
import { PHYSICS as P, PIT_SERVICE } from '../sim/constants';
import { PitAutopilot, pitDecisionS, pitRoute, type CrewChief } from './pitting';
import {
  CAUTION_SIZE, KNOWLEDGE_AHEAD, KNOWLEDGE_SIZE, LOOKAHEAD, OBS_SIZE, observe, observeCaution, observeKnowledge, observePit, observePreview,
  PIT_LOOKAHEAD, PIT_SIZE, PREVIEW_SIZE,
} from './observe';
import { Rng } from './rng';
import { RADIO, RADIO_SIZE, TowerSpotter, type Spotter } from './spotter';
import type { Track } from '../sim/track';

/** Where the preview of the road starts in the driver's inputs (after everything else, so older drivers widen into it). */
export const PREVIEW_FROM = OBS_SIZE + RADIO_SIZE + PIT_SIZE + CAUTION_SIZE;
/** Where track knowledge starts in the driver's inputs (after the preview). */
export const KNOWLEDGE_FROM = PREVIEW_FROM + PREVIEW_SIZE;
/** Driver network: own-car observations + the spotter's radio + a pit stop in progress + a caution + the road ahead -> acceleration request. */
export const DRIVER_LAYERS = [KNOWLEDGE_FROM + KNOWLEDGE_SIZE, 32, 24, 2] as const;
/** Earlier drivers, still loadable via adaptWeights: before track knowledge, before the preview, before caution inputs, before pit inputs, and solo-era (no radio). */
export const PREVIEW_DRIVER_LAYERS = [PREVIEW_FROM + PREVIEW_SIZE, 32, 24, 2] as const;
export const CAUTION_DRIVER_LAYERS = [OBS_SIZE + RADIO_SIZE + PIT_SIZE + CAUTION_SIZE, 32, 24, 2] as const;
export const PIT_DRIVER_LAYERS = [OBS_SIZE + RADIO_SIZE + PIT_SIZE, 32, 24, 2] as const;
export const RADIO_DRIVER_LAYERS = [OBS_SIZE + RADIO_SIZE, 24, 16, 2] as const;
export const LEGACY_DRIVER_LAYERS = [OBS_SIZE, 16, 12, 2] as const;

/** Upgrade saved weights to the current driver network, preserving behaviour (new inputs start ignored). */
export function adaptWeights(w: Float32Array): Float32Array {
  if (w.length === genomeSize(DRIVER_LAYERS)) return w;
  for (const old of [PREVIEW_DRIVER_LAYERS, CAUTION_DRIVER_LAYERS, PIT_DRIVER_LAYERS, RADIO_DRIVER_LAYERS, LEGACY_DRIVER_LAYERS]) {
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

/** How far ahead a driver looks for the next corner's direction (m): its curvature lookahead. */
const CORNER_HORIZON = LOOKAHEAD[LOOKAHEAD.length - 1];

/** Direction of the next corner within the horizon: +1 left, -1 right, 0 none in sight. */
export function nextCornerDirection(track: Track, s: number): number {
  for (let a = 0; a <= CORNER_HORIZON; a += 5) {
    const k = track.curvatureAt(s + a);
    if (Math.abs(k) > 1e-4) return Math.sign(k);
  }
  return 0;
}

/**
 * The same moment seen in mirror image: everything lateral changes sign
 * (heading against the track, lane, sideways speed, the banking's push, the
 * last steering command, curvature ahead, where the known line runs; traffic on the inside and outside
 * swap; lateral offsets of cars, the hazard, the pit route and the caution
 * slot flip). The physics has no handedness, so this is exact.
 */
export function mirrorDriverInputs(x: Float32Array): void {
  for (const i of [1, 3, 4, 6, 10]) x[i] = -x[i];
  for (let j = 0; j < LOOKAHEAD.length; j++) x[11 + j] = -x[11 + j];
  const r = OBS_SIZE;
  const lowProx = x[r + RADIO.LOW_PROX], lowRel = x[r + RADIO.LOW_REL];
  x[r + RADIO.LOW_PROX] = x[r + RADIO.HIGH_PROX];
  x[r + RADIO.LOW_REL] = x[r + RADIO.HIGH_REL];
  x[r + RADIO.HIGH_PROX] = lowProx;
  x[r + RADIO.HIGH_REL] = lowRel;
  for (const i of [RADIO.AHEAD_LANE, RADIO.AHEAD2_LANE, RADIO.BEHIND_LANE, RADIO.HAZARD_LANE]) x[r + i] = -x[r + i];
  const p = OBS_SIZE + RADIO_SIZE;
  for (let j = 2; j < 2 + PIT_LOOKAHEAD.length; j++) x[p + j] = -x[p + j];
  x[p + PIT_SIZE + 3] = -x[p + PIT_SIZE + 3];
  for (let j = 0; j < PREVIEW_SIZE; j++) x[PREVIEW_FROM + j] = -x[PREVIEW_FROM + j];
  for (let j = 0; j < KNOWLEDGE_AHEAD.length; j++) x[KNOWLEDGE_FROM + j] = -x[KNOWLEDGE_FROM + j]; // where the line runs (its speeds have no side)
}

/**
 * Raw-control driver: network outputs the acceleration request in the travel frame.
 *
 * Every corner is driven as a left-hander: when the next corner turns right
 * the driver sees the world in mirror image and its steering is mirrored back.
 * A right-hander is exactly a mirrored left-hander, so on ovals (all left)
 * nothing changes, and an oval run the other way round drives exactly like
 * the original. Between corners the view follows the coming one.
 */
/**
 * A driver's human limits. A real driver sees, then reacts: the car answers what
 * the driver saw a moment ago (a skilled driver's visuomotor delay is ~0.1-0.2 s).
 * And hands aren't exact: the input a driver means isn't quite the input the car
 * gets, the error growing with the size of the input (signal-dependent motor noise)
 * and drifting smoothly rather than jittering. Drivers differ in both, so two
 * drivers in the same spot don't act on the same instant in the same way.
 */
export interface DriverLimits {
  /** Seconds from what the driver sees to the car answering it. */
  latency: number;
  /** The applied input strays from the meant one by about this share of its size (1 sd). */
  noise: number;
  /** Seeds the noise (a driver's own, so a race replays exactly). */
  seed: number;
}
/** How long motor noise takes to drift (s): an Ornstein-Uhlenbeck process with this correlation time. */
const MOTOR_NOISE_TAU = 0.25;

/** The latency and noise between a driver's decision and the car's inputs. */
class Hands {
  private readonly delay: number;
  private readonly queue: Array<[number, number]> = [];
  private readonly rng: Rng;
  private readonly keep: number;
  private readonly fresh: number;
  private nx = 0;
  private ny = 0;

  constructor(private readonly limits: DriverLimits, decisionDt: number) {
    this.delay = Math.max(0, Math.round(limits.latency / decisionDt));
    this.rng = new Rng(limits.seed);
    this.keep = Math.exp(-decisionDt / MOTOR_NOISE_TAU);
    this.fresh = Math.sqrt(1 - this.keep * this.keep);
    this.nx = this.rng.gaussian();
    this.ny = this.rng.gaussian();
  }

  /** The input the car gets now, given what the driver means now. */
  apply(x: number, y: number, car: Car): void {
    this.queue.push([x, y]);
    // Until the first decisions come through, the car keeps what it had.
    const [ax, ay] = this.queue.length > this.delay ? this.queue.shift()! : [car.inputX, car.inputY];
    this.nx = this.keep * this.nx + this.fresh * this.rng.gaussian();
    this.ny = this.keep * this.ny + this.fresh * this.rng.gaussian();
    car.inputX = ax + this.limits.noise * Math.abs(ax) * this.nx;
    car.inputY = ay + this.limits.noise * Math.abs(ay) * this.ny;
  }
}

export class NeuralDriver implements DriverBrain {
  readonly net: Network;
  /** The road-course skill: a second network that drives on road circuits (ovals are the main network's). */
  readonly roadNet: Network | null;
  private readonly input = new Float32Array(DRIVER_LAYERS[0]);
  private readonly obs = new Float32Array(OBS_SIZE);
  private readonly preview = new Float32Array(PREVIEW_SIZE);
  private readonly knowledge = new Float32Array(KNOWLEDGE_SIZE);
  /** The last inputs were mirrored (the coming corner turns right): labels for them must be mirrored too. */
  mirrored = false;

  /** The driver's latency and motor noise, if it has human limits (none: the car gets exactly what it decides, at once). */
  private readonly hands: Hands | null;

  constructor(weights: Float32Array, roadWeights?: Float32Array, limits?: DriverLimits) {
    this.net = new Network(DRIVER_LAYERS, weights);
    this.roadNet = roadWeights ? new Network(DRIVER_LAYERS, roadWeights) : null;
    this.hands = limits && (limits.latency > 0 || limits.noise > 0) ? new Hands(limits, P.CONTROL_EVERY * P.DT) : null;
  }

  /** The network that drives this track: the road-course skill on road layouts (if the driver has one). */
  netFor(track: Track): Network {
    return this.roadNet && track.kind === 'road' ? this.roadNet : this.net;
  }

  /** The network's input for this moment (also what an apprentice is shown), mirrored when the next corner turns right. */
  inputs(car: Car, world: World, radio: Float32Array, pit: Float32Array, caution: Float32Array): Float32Array {
    this.input.set(observe(car, world.track, this.obs), 0);
    this.input.set(radio, OBS_SIZE);
    this.input.set(pit, OBS_SIZE + RADIO_SIZE);
    this.input.set(caution, OBS_SIZE + RADIO_SIZE + PIT_SIZE);
    this.input.set(observePreview(car, world.track, this.preview), PREVIEW_FROM);
    this.input.set(observeKnowledge(car, world.track, this.knowledge), KNOWLEDGE_FROM);
    const dir = nextCornerDirection(world.track, car.s);
    if (dir !== 0) this.mirrored = dir < 0; // nothing in sight: keep the last view
    if (this.mirrored) mirrorDriverInputs(this.input);
    return this.input;
  }

  decide(car: Car, world: World, radio: Float32Array, pit: Float32Array, caution: Float32Array): void {
    const out = this.netFor(world.track).forward(this.inputs(car, world, radio, pit, caution));
    const y = this.mirrored ? -out[1] : out[1];
    if (this.hands) this.hands.apply(out[0], y, car);
    else { car.inputX = out[0]; car.inputY = y; }
  }
}

export function neuralTeam(
  weights: Float32Array, crewChief: CrewChief | null = null, driverPits = false, driverCautions = false, limits?: DriverLimits,
): Team {
  return new Team(new NeuralDriver(weights, undefined, limits), new TowerSpotter(), crewChief, driverPits, driverCautions);
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
