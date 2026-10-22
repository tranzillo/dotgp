import { DRIVER_LAYERS, NeuralDriver, PREVIEW_FROM, ScriptedDriver, Team } from '../ai/drivers';
import { inputWeightMask, trainSupervised, type Example } from '../ai/network';
import { DEFAULT_KNOWLEDGE, OBS_SIZE, PREVIEW_SIZE, type TrackKnowledge } from '../ai/observe';
import { initialWeights } from '../ai/es';
import { FUEL_RANGE, TIRE_RANGE } from '../ai/evaluate';
import { fastestLine, RacingLineDriver } from '../ai/racingLine';
import { DEFAULT_STYLE, TrafficRacer } from '../ai/trafficRacer';
import { roadcraftLayout } from './roadcraftLesson';
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
    private readonly teacher: Controller,
    private readonly studentDrives: boolean,
    private readonly examples: Example[],
    private readonly rng: Rng,
    /** Chance per decision, while the student drives, of a knock: the car's speed cut to a random share of it. */
    private readonly knock = 0,
    private readonly extra?: ApprenticeOptions['extra'],
  ) {}

  decide(car: Car, world: World): void {
    if (this.studentDrives && this.knock && this.rng.next() < this.knock) {
      const keep = this.rng.next();
      car.vx *= keep;
      car.vy *= keep;
    }
    const px = car.inputX, py = car.inputY;
    let label: [number, number] | null = null;
    if (this.rng.next() < SAMPLE) {
      // A teacher with a plan of its own (the traffic racer's offset from its line) answers from where the car really
      // is when the student has been driving, not from where its plan would have put it.
      if (this.studentDrives && this.teacher instanceof TrafficRacer) this.teacher.takeOver(car, world);
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
    const seen = this.student.inputs(car, world, this.team.radio, this.team.pitInputs, this.team.cautionInputs);
    let x = seen.slice();
    if (this.extra) {
      const more = this.extra(car, world, this.student.mirrored);
      x = new Float32Array(seen.length + more.length);
      x.set(seen);
      x.set(more, seen.length);
    }
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
export function roadLicenseTest(weights: Float32Array, seed: number, minHealth: number, knowledge?: TrackKnowledge): boolean {
  for (let k = 0; k < 3; k++) {
    const track = circuitTrack(hashSeed(seed, `test${k}`), 'club');
    const world = new World(track, { collisions: false, drafting: false });
    const car = new Car(0);
    world.addCar(car, new Team(new NeuralDriver(weights, undefined, knowledge), new TowerSpotter(), null));
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
  /**
   * Who teaches (plain data: apprenticeships run on worker threads). Default
   * the line follower, holding the lane it starts in; 'line': a racer on the
   * circuit's fastest line at a share of the tyres' grip, kept a margin inside
   * the track limits (default the line's usual). From each start lane it
   * makes its way onto the line, so the student sees recoveries too.
   */
  teacher?: { kind: 'follower' } | { kind: 'line' | 'traffic'; grip: number; margin?: number; room?: number };
  /**
   * Pack drills per circuit per round (default none): circuit racecraft's
   * drills (12 cars, contact and drafting), the student in a random slot
   * among cars the teacher drives, the teacher saying what it would do in
   * the student's place. Teaches racing in traffic (with the 'traffic'
   * teacher: following, leaving room, keeping inside the limits).
   */
  packs?: number;
  /** Drives start on tyres anywhere from worn to new and any fuel load (race learning's ranges), not fresh and full. */
  wear?: boolean;
  /** Given everything recorded (what the student saw, what the teacher would do), at the end (experiments; not across threads). */
  onExamples?: (examples: Example[]) => void;
  /** More to record with what the student saw, as it saw it (mirrored or not) (experiments: what else would it need to see?). */
  extra?: (car: Car, world: World, mirrored: boolean) => Float32Array;
  /**
   * Knocks per minute while the student drives: its speed cut to a random
   * share of it, so the teacher shows what to do far below the speed the
   * place takes (its own laps never are). Default none.
   */
  knocks?: number;
}

/** What a student of a teacher knows of a circuit: its teacher's line (the default for the line follower, which has none). */
export function knowledgeOf(teacher: ApprenticeOptions['teacher']): TrackKnowledge {
  return teacher && teacher.kind !== 'follower' ? { grip: teacher.grip, margin: teacher.margin ?? DEFAULT_KNOWLEDGE.margin } : DEFAULT_KNOWLEDGE;
}

/** The teacher of a drive that starts in a lane. */
function teacherFor(teacher: ApprenticeOptions['teacher'], lane: number): Controller {
  if (teacher?.kind === 'traffic') {
    return new TrafficRacer({
      ...DEFAULT_STYLE, grip: teacher.grip, margin: teacher.margin ?? DEFAULT_STYLE.margin, room: teacher.room ?? DEFAULT_STYLE.room, pass: Infinity,
    });
  }
  return teacher?.kind === 'line'
    ? new RacingLineDriver(teacher.grip, (track) => fastestLine(track, teacher.margin)) : new ScriptedDriver(lane, 0.9);
}

/** Teach a road-course skill (weights, trained in place) by imitating a scripted teacher on circuits (opts.teacher). */
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
        const student = new NeuralDriver(weights, undefined, knowledgeOf(opts.teacher));
        const team = new Team(student, new TowerSpotter(), null);
        const car = new Car(0);
        if (opts.wear) worn(car, rng);
        world.addCar(car, new RoadApprentice(team, student, teacherFor(opts.teacher, lane), studentDrives, examples, rng,
          (opts.knocks ?? 0) * P.CONTROL_EVERY * P.DT / 60, opts.extra));
        car.placeOnTrack(track, track.length - 20, lane);
        car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
        car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
        for (let k = 0; k < SECONDS / P.DT && !car.retired; k++) world.step();
      }
      for (let p = 0; p < (opts.packs ?? 0); p++) {
        const layout = roadcraftLayout(track, packStart(track, rng), rng);
        const world = new World(track, { collisions: true, drafting: true });
        const slot = rng.int(layout.spots.length);
        layout.spots.forEach((spot, k) => {
          const car = new Car(k);
          car.placeOnTrack(track, track.wrapS(layout.frontS - spot.back), spot.lane);
          car.vx = track.tx[car.trackIdx] * spot.speed;
          car.vy = track.ty[car.trackIdx] * spot.speed;
          car.tireLife = spot.tire;
          if (opts.wear) worn(car, rng);
          if (k !== slot) { world.addCar(car, teacherFor(opts.teacher, 0)); return; }
          const student = new NeuralDriver(weights, undefined, knowledgeOf(opts.teacher));
          const team = new Team(student, new TowerSpotter(), null);
          world.addCar(car, new RoadApprentice(team, student, teacherFor(opts.teacher, 0), studentDrives, examples, rng,
            (opts.knocks ?? 0) * P.CONTROL_EVERY * P.DT / 60, opts.extra));
        });
        for (let k = 0; k < (layout.seconds ?? PACK_SECONDS) / P.DT && !world.cars[slot].retired; k++) world.step();
      }
    }
    let set = round === 0 || examples.length <= maxExamples ? examples : sample(examples, maxExamples, rng);
    // (The student itself learns from what it sees: any extra recorded is for the experiment.)
    if (opts.extra) set = set.map((e) => ({ ...e, x: e.x.subarray(0, DRIVER_LAYERS[0]) }));
    loss = trainSupervised(DRIVER_LAYERS, weights, set, round === 0 ? 30 : epochs, 0.01, () => rng.next());
  }
  opts.onExamples?.(examples);
  return { examples: examples.length, loss };
}

/** Tyres and fuel as a stint leaves them: anywhere in race learning's ranges. */
function worn(car: Car, rng: Rng): void {
  car.tireLife = TIRE_RANGE[0] + rng.next() * (TIRE_RANGE[1] - TIRE_RANGE[0]);
  car.fuel = FUEL_RANGE[0] + rng.next() * (FUEL_RANGE[1] - FUEL_RANGE[0]);
}

/** Seconds of a pack drill in the apprenticeship (unless its layout says). */
const PACK_SECONDS = 50;

/** A start on a random straight (80 m of it ahead), for a pack drill (as circuit racecraft starts them). */
function packStart(track: Track, rng: Rng): number {
  const starts: number[] = [];
  for (let s = 0; s < track.length; s += 10) {
    let straight = true;
    for (let a = -10; a <= 80 && straight; a += 5) straight = Math.abs(track.curvatureAt(s + a)) < 1e-4;
    if (straight) starts.push(s);
  }
  return starts.length ? starts[rng.int(starts.length)] : track.length - 20;
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
