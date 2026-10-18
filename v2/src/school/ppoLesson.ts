import { NeuralDriver, Team, type DriverBrain } from '../ai/drivers';
import { COSTS, trackPace } from '../ai/costs';
import { danger, fearScale } from '../ai/fear';
import { TowerSpotter } from '../ai/spotter';
import { LICENSE_HEALTH } from '../ai/es';
import { Trial } from '../ai/evaluate';
import type { PpoLearner, Segment, Step } from '../ai/ppo';
import { Rng } from '../ai/rng';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { ROLLING_START_SPEED } from '../sim/grid';
import { ValidProgress } from '../sim/limits';
import { World } from '../sim/world';
import { hashSeed } from '../trackgen';
import { ROADCRAFT_SECONDS, roadcraftLayout, situationLayout, situationsOn } from './roadcraftLesson';
import { ROAD_FULL_RADIUS, roadCourseTrack, roadDamageSeconds, roadTrainingWheels, roadWalls, straightStart } from './classroom';

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
  valid: ValidProgress;
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
  /**
   * Only valid laps count, as in practice at full tightness: going past the
   * track limits takes back the lap's progress so far, and what it makes
   * before the line, at the moment it does.
   */
  validLaps?: boolean;
  /**
   * This share of drives start at the top of the approach to one of the
   * circuit's chicanes, at the reference lap's speed there (as a chicane drill
   * places its pack); the circuits are ones that have a chicane. The rest
   * start on a random straight.
   */
  chicanes?: number;
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
    let track = roadCourseTrack(hashSeed(seed, `track${w}`), setting.radius);
    for (let k = 1; setting.chicanes && k < 40 && !situationsOn(track, 'chicane').length; k++) {
      track = roadCourseTrack(hashSeed(seed, `track${w}-chicane${k}`), setting.radius);
    }
    const features = setting.chicanes ? situationsOn(track, 'chicane') : [];
    const pace = trackPace(track);
    const damageSeconds = roadDamageSeconds(setting.radius);
    const world = new World(track, {
      collisions: false, drafting: false, damageScale: roadWalls(setting.radius), wheels: roadTrainingWheels(setting.radius) ?? null,
    });
    const live: Drive[] = [];
    const begin = (k: number): Drive => {
      const car = new Car(k);
      if (features.length && rng.next() < setting.chicanes!) {
        const pack = situationLayout(track, features[rng.int(features.length)], 'chicane', rng, 1);
        const spot = pack.spots[0];
        car.placeOnTrack(track, track.wrapS(pack.frontS - spot.back), spot.lane);
        car.vx = track.tx[car.trackIdx] * spot.speed;
        car.vy = track.ty[car.trackIdx] * spot.speed;
      } else {
        car.placeOnTrack(track, straightStart(track, rng), 0);
        car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
        car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
      }
      const driver = new SamplingDriver(learner, rng);
      const team = new Team(driver);
      return { car, team, driver, valid: new ValidProgress(car), startDist: car.dist, checkDist: car.dist, decisions: 0 };
    };
    for (let k = 0; k < cars; k++) {
      const d = begin(k);
      world.addCar(d.car, d.team);
      live.push(d);
    }
    const dist = new Float64Array(cars), health = new Float64Array(cars), thrown = new Float64Array(cars);
    for (let t = 0; t < decisions; t++) {
      live.forEach((d, k) => { dist[k] = d.car.dist; health[k] = d.car.health; thrown[k] = d.valid.thrownAway; });
      for (let p = 0; p < P.CONTROL_EVERY; p++) {
        world.step();
        for (const d of live) d.valid.step(track);
      }
      live.forEach((d, k) => {
        const { car } = d;
        const step = d.driver.steps[d.driver.steps.length - 1];
        step.r = (car.dist - dist[k]) / pace - (health[k] - car.health) * damageSeconds;
        if (setting.validLaps) step.r -= (d.valid.thrownAway - thrown[k]) / pace;
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

/**
 * Circuit racecraft as a rollout: circuit racecraft's drills (launches, packs
 * on straights, braking zones and chicanes, 12 cars, contact and drafting) on
 * new club and GP circuits at full tightness. Every other car is the learner
 * (driving with variation, learning from what it does); the rest are its
 * classmates as they race (`classmates`, in turn), so it races others, not
 * only itself. Each decision earns what a drill scores, in seconds: valid
 * progress at the track's pace, less damage, the damage it does by its share
 * of the fault (harm), and, by the driver's nerve, fear (seconds of an
 * imminent hit that could hurt it) and trauma.
 */
export function packRollout(
  learner: PpoLearner, seed: number, worlds: number, classmates: Float32Array[], nerve?: number, situations?: number,
): RolloutResult {
  const segments: Segment[] = [];
  const drives: DriveStat[] = [];
  const fear = fearScale(nerve);
  for (let w = 0; w < worlds; w++) {
    const rng = new Rng(hashSeed(seed, `pack${w}`));
    const track = roadCourseTrack(hashSeed(seed, `packtrack${w}`), ROAD_FULL_RADIUS, w % 2 ? 'gp' : 'club');
    const pace = trackPace(track);
    const layout = roadcraftLayout(track, straightStart(track, rng), rng, situations);
    const world = new World(track, { collisions: true, drafting: true });
    const learners: Array<{ car: Car; team: Team; driver: SamplingDriver; valid: ValidProgress; startDist: number }> = [];
    layout.spots.forEach((spot, k) => {
      const car = new Car(k);
      car.placeOnTrack(track, track.wrapS(layout.frontS - spot.back), spot.lane);
      car.vx = track.tx[car.trackIdx] * spot.speed;
      car.vy = track.ty[car.trackIdx] * spot.speed;
      car.tireLife = spot.tire;
      if (k % 2 === 0) {
        const driver = new SamplingDriver(learner, rng);
        const team = new Team(driver, new TowerSpotter(), null);
        world.addCar(car, team);
        learners.push({ car, team, driver, valid: new ValidProgress(car), startDist: car.dist });
      } else {
        world.addCar(car, new Team(new NeuralDriver(classmates[(k >> 1) % classmates.length]), new TowerSpotter(), null));
      }
    });
    const decisions = Math.round((layout.seconds ?? ROADCRAFT_SECONDS) / DECISION_SECONDS);
    const n = learners.length;
    const before = { dist: new Float64Array(n), thrown: new Float64Array(n), health: new Float64Array(n), harm: new Float64Array(n), trauma: new Float64Array(n) };
    const live = learners.map(() => true);
    const seen = learners.map(() => 0);
    for (let t = 0; t < decisions; t++) {
      learners.forEach((d, k) => {
        before.dist[k] = d.car.dist; before.thrown[k] = d.valid.thrownAway; before.health[k] = d.car.health;
        before.harm[k] = d.car.harmDone; before.trauma[k] = Math.max(0, d.car.selfTrauma - d.car.selfInflicted);
      });
      for (let p = 0; p < P.CONTROL_EVERY; p++) {
        world.step();
        for (const d of learners) d.valid.step(track);
      }
      learners.forEach((d, k) => {
        if (!live[k]) return;
        const { car } = d;
        // Only a decision made in this interval earns it (a car not driving, e.g. waiting, made none).
        if (d.driver.steps.length === seen[k]) return;
        seen[k] = d.driver.steps.length;
        const step = d.driver.steps[seen[k] - 1];
        const trauma = Math.max(0, car.selfTrauma - car.selfInflicted);
        step.r = (car.dist - before.dist[k] - (d.valid.thrownAway - before.thrown[k])) / pace
          - COSTS.damage * (before.health[k] - car.health) - COSTS.harm * (car.harmDone - before.harm[k])
          - fear * (COSTS.fear * danger(car, world) * DECISION_SECONDS + COSTS.trauma * (trauma - before.trauma[k]));
        const crashed = car.retired;
        if (!crashed && t < decisions - 1) return;
        live[k] = false;
        seen[k] = 0;
        const bootstrap = crashed ? 0 : learner.estimate(d.driver.view.inputs(car, world, d.team.radio, d.team.pitInputs, d.team.cautionInputs));
        segments.push({ steps: d.driver.steps.splice(0), bootstrap });
        drives.push({ laps: (car.dist - d.startDist) / track.length, seconds: (t + 1) * DECISION_SECONDS, crashed, stopped: false, damage: 1 - car.health });
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
