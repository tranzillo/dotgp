import { DRIVER_LAYERS, NeuralDriver, PREVIEW_FROM, ScriptedDriver, Team } from '../ai/drivers';
import { inputWeightMask, trainSupervised, type Example } from '../ai/network';
import { OBS_SIZE, PREVIEW_SIZE } from '../ai/observe';
import { initialWeights } from '../ai/es';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { ROLLING_START_SPEED } from '../sim/grid';
import { pastTrackLimits } from '../sim/limits';
import { Track } from '../sim/track';
import { World, type Controller } from '../sim/world';
import { generateLayout, hashSeed } from '../trackgen';

/**
 * Road courses, first lesson: copy the teacher. The scripted line follower
 * laps road circuits cleanly (it brakes for every corner from what the
 * curvature ahead allows), so a student's road-course skill starts by
 * imitating it, the way the Cautions lesson starts from the formation script:
 * the teacher drives first and the student's view of each moment is recorded
 * with the teacher's answer; then the student drives and the teacher says
 * what it would have done (so the student learns to recover from its own
 * mistakes, not only the teacher's clean line). Practice (evolution
 * strategies) takes over from there to beat the teacher.
 */

/**
 * The weights road-course practice trains: all but the first layer's from the
 * radio, pit and caution inputs. Those are zero in solo practice, so their
 * gradient is pure noise (and Adam takes full-size steps on noise); left
 * alone they keep the oval driving's answers for when traffic arrives. (The
 * preview of the road, after them, trains.)
 */
export const ROAD_WEIGHTS = inputWeightMask(DRIVER_LAYERS, OBS_SIZE, PREVIEW_FROM).map((v) => 1 - v);

/** Rounds of the apprenticeship (the first with the teacher driving), and per round: circuits, lanes, seconds each. */
export const ROAD_APPRENTICE_ROUNDS = 12;
const CIRCUITS = 6;
const LANES = [-2, 0, 2];
const SECONDS = 120;
/**
 * Passes over everything recorded, per round after the first. 4 drives as
 * well as 12 did after a class (lab, 2026-10-17: three seeds, solo on held-out
 * club and GP circuits) at a third of the training.
 */
export const ROAD_APPRENTICE_EPOCHS = 4;
/** Share of the decisions recorded. */
const SAMPLE = 0.3;

/** Records (what the student saw, what the teacher would do) as either drives. */
class RoadApprentice implements Controller {
  constructor(
    private readonly team: Team,
    private readonly student: NeuralDriver,
    private readonly teacher: ScriptedDriver,
    private readonly studentDrives: boolean,
    private readonly examples: Example[],
    private readonly rng: Rng,
  ) {}

  decide(car: Car, world: World): void {
    const px = car.inputX, py = car.inputY;
    let label: [number, number] | null = null;
    if (this.rng.next() < SAMPLE) {
      this.teacher.decide(car, world);
      label = [car.inputX, car.inputY];
      car.inputX = px;
      car.inputY = py;
    }
    if (this.studentDrives) this.team.decide(car, world);
    else this.teacher.decide(car, world);
    if (!label) return;
    const ax = car.inputX, ay = car.inputY;
    // What the student saw at this moment (its last command included).
    car.inputX = px;
    car.inputY = py;
    this.team.spotter.call(car, world, this.team.radio);
    const x = this.student.inputs(car, world, this.team.radio, this.team.pitInputs, this.team.cautionInputs).slice();
    if (this.student.mirrored) label[1] = -label[1]; // the teacher steers in the world's frame; the student saw it mirrored
    car.inputX = ax;
    car.inputY = ay;
    const clamp = (v: number) => Math.max(-0.95, Math.min(0.95, v));
    this.examples.push({ x, y: Float32Array.of(clamp(label[0]), clamp(label[1])), mask: Float32Array.of(1, 1) });
  }
}

/**
 * The road-course license test: three new club circuits at full tightness,
 * from the line as a race starts, 120 s each: a valid lap on every one (a full
 * lap's distance within the track limits, without crashing or badly hurting
 * the car).
 */
export function roadLicenseTest(weights: Float32Array, seed: number, minHealth: number): boolean {
  for (let k = 0; k < 3; k++) {
    const track = circuitTrack(hashSeed(seed, `test${k}`), 'club');
    const world = new World(track, { collisions: false, drafting: false });
    const car = new Car(0);
    world.addCar(car, new Team(new NeuralDriver(weights), new TowerSpotter(), null));
    car.placeOnTrack(track, track.length - 20, 0);
    car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
    car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
    let valid = true;
    for (let i = 0; i < SECONDS / P.DT && !car.retired && car.dist < track.length && valid; i++) {
      world.step();
      valid = !pastTrackLimits(car, track);
    }
    if (!valid || car.retired || car.health < minHealth || car.dist < track.length) return false;
  }
  return true;
}

/**
 * A brand-new road-course skill, owing nothing to oval driving: a new
 * driver's random wiring (initialWeights: the gas instinct, no radio yet),
 * and random attention to the preview of the road too (seeing the road ahead
 * is a newcomer's first sense here, as its own car is).
 */
export function initialRoadWeights(rng: Rng): Float32Array {
  const w = initialWeights(rng);
  const nIn = DRIVER_LAYERS[0];
  const scale = 1 / Math.sqrt(OBS_SIZE);
  for (let o = 0; o < DRIVER_LAYERS[1]; o++) {
    for (let k = PREVIEW_FROM; k < PREVIEW_FROM + PREVIEW_SIZE; k++) w[o * (nIn + 1) + 1 + k] = rng.gaussian() * scale;
  }
  return w;
}

/** A circuit from a seed (the next seed, if one can't be laid out: a lesson mustn't die on a generator's bad day). */
export function circuitTrack(seed: number, variant: 'club' | 'gp'): Track {
  for (let k = 0; ; k++) {
    try {
      return new Track(generateLayout({ type: 'circuit', seed: k === 0 ? seed : hashSeed(seed, `retry${k}`), variant }));
    } catch (e) {
      if (k >= 5) throw e;
    }
  }
}

/** Circuits to learn on: club and GP, at full tightness. */
function apprenticeCircuits(seed: number): Track[] {
  return Array.from({ length: CIRCUITS }, (_, k) => circuitTrack(hashSeed(seed, `apprentice${k}`), k % 3 === 2 ? 'gp' : 'club'));
}

export interface ApprenticeOptions {
  rounds?: number;
  /**
   * Moments trained on per round after the first: a fresh random sample of
   * everything recorded so far, so training stops growing with the rounds.
   * Default: all of them (each round's training is longer than the last).
   */
  maxExamples?: number;
  /** Passes over each round's training set after the first (default ROAD_APPRENTICE_EPOCHS). */
  epochs?: number;
}

/** Teach a road-course skill (weights, trained in place) by imitating the scripted line follower on circuits. */
export function apprenticeRoadCourses(weights: Float32Array, seed: number, opts: ApprenticeOptions = {}): { examples: number; loss: number } {
  const { rounds = ROAD_APPRENTICE_ROUNDS, maxExamples = Infinity, epochs = ROAD_APPRENTICE_EPOCHS } = opts;
  const rng = new Rng(seed);
  const tracks = apprenticeCircuits(seed);
  const examples: Example[] = [];
  let loss = NaN;
  for (let round = 0; round < rounds; round++) {
    const studentDrives = round > 0;
    for (const track of tracks) {
      for (const lane of LANES) {
        const world = new World(track, { collisions: false, drafting: false });
        const student = new NeuralDriver(weights);
        const team = new Team(student, new TowerSpotter(), null);
        const car = new Car(0);
        world.addCar(car, new RoadApprentice(team, student, new ScriptedDriver(lane, 0.9), studentDrives, examples, rng));
        car.placeOnTrack(track, track.length - 20, lane);
        car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
        car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
        for (let k = 0; k < SECONDS / P.DT && !car.retired; k++) world.step();
      }
    }
    const set = round === 0 || examples.length <= maxExamples ? examples : sample(examples, maxExamples, rng);
    loss = trainSupervised(DRIVER_LAYERS, weights, set, round === 0 ? 30 : epochs, 0.01, () => rng.next());
  }
  return { examples: examples.length, loss };
}

/** n of the items, drawn at random without replacement. */
function sample<T>(items: T[], n: number, rng: Rng): T[] {
  const pool = items.slice();
  for (let i = 0; i < n; i++) {
    const j = i + rng.int(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
