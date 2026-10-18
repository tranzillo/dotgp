import { NeuralDriver, Team, type DriverBrain } from '../ai/drivers';
import { trackPace } from '../ai/costs';
import { LICENSE_HEALTH } from '../ai/es';
import { Trial } from '../ai/evaluate';
import type { PpoLearner, Segment, Step } from '../ai/ppo';
import { Rng } from '../ai/rng';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { ROLLING_START_SPEED } from '../sim/grid';
import { World } from '../sim/world';
import { hashSeed } from '../trackgen';
import { roadCourseTrack, roadDamageSeconds, roadTrainingWheels, roadWalls, straightStart } from './classroom';

/**
 * Road courses learned with a gradient (PPO), from nothing, on the same
 * curriculum as practice: circuits whose corners tighten, training wheels,
 * soft barriers. Every decision earns what the drive's score is made of:
 * progress at the track's pace, less what damage costs, in seconds (summed
 * over a drive, it is the drive's score). No other rewards.
 */

/** A drive ends after a lap's worth (or this long), as a practice drive's scoring does. */
const DRIVE_SECONDS = 150;
/** As in trials: a car that makes less than this much progress in this long has stopped, and its drive is over. */
const STALL_WINDOW = 8;
const STALL_DISTANCE = 10;
const DECISION_SECONDS = P.CONTROL_EVERY * P.DT;

/** Drives the learner's policy with variation, recording each decision. */
class SamplingDriver implements DriverBrain {
  readonly view: NeuralDriver;
  readonly steps: Step[] = [];

  constructor(private readonly learner: PpoLearner, private readonly rng: Rng) {
    this.view = new NeuralDriver(learner.policy.weights);
  }

  decide(car: Car, world: World, radio: Float32Array, pit: Float32Array, caution: Float32Array): void {
    const x = Float32Array.from(this.view.inputs(car, world, radio, pit, caution));
    const a = new Float32Array(2);
    const { logp, v } = this.learner.act(x, this.rng, a);
    car.inputX = a[0];
    car.inputY = this.view.mirrored ? -a[1] : a[1];
    this.steps.push({ x, a, logp, v, r: 0 });
  }
}

interface Drive {
  car: Car;
  team: Team;
  driver: SamplingDriver;
  /** Where the drive started (dist), and its progress at the last stall check. */
  startDist: number;
  checkDist: number;
  decisions: number;
}

export interface DriveStat {
  /** Progress, laps' worth. */
  laps: number;
  seconds: number;
  crashed: boolean;
  stopped: boolean;
  /** Health lost. */
  damage: number;
}

export interface RolloutResult {
  segments: Segment[];
  /** Drives that ended in this rollout (crashed, stopped, or done). */
  drives: DriveStat[];
}

export interface RoadSetting {
  /** The curriculum's tightest corner (m). */
  radius: number;
  /**
   * A car that stops is taken off and a new drive begun, as in trials; by
   * default its drive is cut short there (what it would earn from where it
   * stopped still counts, as for a drive cut short by the rollout's end), not
   * ended: stopping on a circuit loses time, it doesn't end the race. With
   * this, stopping ends the drive, nothing more to earn.
   */
  stallEnds?: boolean;
}

/**
 * One rollout: `cars` learners (ghosts) on each of `worlds` new circuits,
 * for `seconds`. A drive that ends is replaced by a new one from another
 * straight; drives still going at the end are cut short (their value
 * estimate stands in for the rest).
 */
export function roadRollout(
  learner: PpoLearner, setting: RoadSetting, seed: number, worlds: number, cars: number, seconds: number,
): RolloutResult {
  const segments: Segment[] = [];
  const drives: DriveStat[] = [];
  const decisions = Math.round(seconds / DECISION_SECONDS);
  for (let w = 0; w < worlds; w++) {
    const rng = new Rng(hashSeed(seed, `world${w}`));
    const track = roadCourseTrack(hashSeed(seed, `track${w}`), setting.radius);
    const pace = trackPace(track);
    const damageSeconds = roadDamageSeconds(setting.radius);
    const world = new World(track, {
      collisions: false, drafting: false, damageScale: roadWalls(setting.radius), wheels: roadTrainingWheels(setting.radius) ?? null,
    });
    const live: Drive[] = [];
    const begin = (k: number): Drive => {
      const car = new Car(k);
      car.placeOnTrack(track, straightStart(track, rng), 0);
      car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
      car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
      const driver = new SamplingDriver(learner, rng);
      const team = new Team(driver);
      return { car, team, driver, startDist: car.dist, checkDist: car.dist, decisions: 0 };
    };
    for (let k = 0; k < cars; k++) {
      const d = begin(k);
      world.addCar(d.car, d.team);
      live.push(d);
    }
    const dist = new Float64Array(cars), health = new Float64Array(cars);
    for (let t = 0; t < decisions; t++) {
      live.forEach((d, k) => { dist[k] = d.car.dist; health[k] = d.car.health; });
      for (let p = 0; p < P.CONTROL_EVERY; p++) world.step();
      live.forEach((d, k) => {
        const { car } = d;
        const step = d.driver.steps[d.driver.steps.length - 1];
        step.r = (car.dist - dist[k]) / pace - (health[k] - car.health) * damageSeconds;
        d.decisions++;
        let stopped = false;
        if (!car.retired && d.decisions % Math.round(STALL_WINDOW / DECISION_SECONDS) === 0) {
          stopped = car.dist - d.checkDist < STALL_DISTANCE;
          d.checkDist = car.dist;
        }
        const crashed = car.retired;
        const progress = car.dist - d.startDist;
        const done = progress >= track.length || d.decisions * DECISION_SECONDS >= DRIVE_SECONDS;
        if (!crashed && !stopped && !done && t < decisions - 1) return;
        const ended = crashed || stopped || done;
        const bootstrap = crashed || (stopped && setting.stallEnds) ? 0 : learner.estimate(d.driver.view.inputs(car, world, d.team.radio, d.team.pitInputs, d.team.cautionInputs));
        segments.push({ steps: d.driver.steps.splice(0), bootstrap });
        if (!ended) return;
        drives.push({
          laps: progress / track.length, seconds: d.decisions * DECISION_SECONDS, crashed, stopped, damage: 1 - car.health,
        });
        const next = begin(k);
        world.replaceCar(k, next.car);
        world.controllers[k] = next.team;
        live[k] = next;
      });
    }
  }
  return { segments, drives };
}

export interface StageReport {
  laps: number;
  /** Share of drives that were clean: a lap's worth, no crash, health LICENSE_HEALTH or better. */
  clean: number;
  /** Share that ended stopped (not crashed). */
  stopped: number;
}

/** How a policy (its mean: as it races) drives a stage: on new circuits from random straights, with the stage's training wheels or with real physics. */
export function stageReport(weights: Float32Array, radius: number, seed: number, tracks: number, wheels: boolean): StageReport {
  let laps = 0, clean = 0, stopped = 0;
  for (let r = 0; r < tracks; r++) {
    const track = roadCourseTrack(hashSeed(seed, `eval${r}`), radius);
    const t = new Trial(track, [weights], {
      seconds: DRIVE_SECONDS, startS: straightStart(track, new Rng(hashSeed(seed, `start${r}`))), damageScale: roadWalls(radius),
      wheels: wheels ? roadTrainingWheels(radius) : undefined,
    });
    while (!t.done) t.step();
    const x = t.results()[0];
    laps += x.distance / track.length;
    if (t.world.cars[0].retired && !x.retired) stopped++;
    if (!x.retired && x.health >= LICENSE_HEALTH && x.distance >= track.length) clean++;
  }
  return { laps: laps / tracks, clean: clean / tracks, stopped: stopped / tracks };
}
