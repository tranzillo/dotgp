/**
 * Pit stops for the stable: each driver's own pit network learns the whole
 * stop (the in-lap from the call, pit road under the limit, the box, out
 * through the blend lane and merging), on ovals and road circuits alike,
 * from the scripted pit maneuver: the teacher for now, as the line follower
 * and the traffic racer are for racing. The maneuver drives the first round
 * (the student watches); then the student drives through its own human
 * limits (DAgger), the maneuver saying at every decision what it would do
 * from where the car is. Only the pit network learns, so stops can't cost a
 * driver its racing.
 */
import { DRIVER_LAYERS, NeuralDriver, Team, type DriverLimits } from '../ai/drivers';
import { type Example, trainSupervised } from '../ai/network';
import type { TrackKnowledge } from '../ai/observe';
import { fastestLine } from '../ai/racingLine';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { Car, type PitState } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import type { Track } from '../sim/track';
import { World, type Controller } from '../sim/world';
import { hashSeed } from '../trackgen';
import { apprenticeTrack } from './ovalApprentice';
import { inLapStart, START_SPEED } from './pitLesson';
import { circuitTrack } from './roadLesson';

/** A driver as far as pit stops go: its skills (the pit skill once it has one), its line and its human limits. */
export interface PitStudent {
  lineage: number;
  limits?: { latency: number; noise: number };
  knowledge?: TrackKnowledge;
  weights: Float32Array;
  road?: Float32Array;
  pit: Float32Array | null;
}

/** Records (what the student saw, what the pit maneuver would do) during the stop, whoever drives. */
class PitRecorder implements Controller {
  constructor(private readonly team: Team, private readonly student: NeuralDriver, private readonly examples: Example[]) {}

  decide(car: Car, world: World): void {
    const px = car.inputX, py = car.inputY;
    const stopping = car.pit.phase !== 'none';
    let label: [number, number] | null = null;
    if (stopping) {
      // The maneuver's answer from here (it also keeps track of the stop as it goes).
      this.team.spotter.call(car, world, this.team.radio);
      this.team.autopilot.decide(car, world, this.team.spotter);
      label = [car.inputX, car.inputY];
      car.inputX = px;
      car.inputY = py;
    }
    // Whoever drives this run decides: the maneuver (watching) or the student's pit skill.
    this.team.decide(car, world);
    if (!label) return;
    const ax = car.inputX, ay = car.inputY;
    car.inputX = px;
    car.inputY = py;
    const x = this.student.inputs(car, world, this.team.radio, this.team.pitInputs, this.team.cautionInputs).slice();
    if (this.student.mirrored) label[1] = -label[1]; // the maneuver steers in the world's frame; the student saw it mirrored
    car.inputX = ax;
    car.inputY = ay;
    const clamp = (v: number) => Math.max(-0.95, Math.min(0.95, v));
    this.examples.push({ x, y: Float32Array.of(clamp(label[0]), clamp(label[1])), mask: Float32Array.of(1, 1) });
  }
}

export interface PitSkillOptions {
  rounds?: number;
  /** Ovals and circuits per round (each driven from two lanes). */
  ovals?: number;
  circuits?: number;
  epochs?: number;
  maxExamples?: number;
  onRound?: (round: number, report: { loss: number; stops: number; completed: number; seconds: number }) => void;
}

/** The pit maneuver's throttle as a teacher (1/s): see PitAutopilot.driveGain. */
const TEACHING_DRIVE_GAIN = 4;

/** Seconds a drill runs: the in-lap, the stop, and out on track. */
const DRILL_SECONDS = 90;

/** One drill: the car on its in-lap with a stop called, the student or the maneuver driving. Returns whether the stop got done. */
function drill(track: Track, d: PitStudent, studentDrives: boolean, lane: number, examples: Example[], seed: number): boolean {
  const world = new World(track, { collisions: false, drafting: false });
  const limits: DriverLimits | undefined = d.limits && { ...d.limits, seed };
  const student = new NeuralDriver(d.weights, d.road, d.knowledge, { limits, pit: d.pit ?? undefined });
  const team = new Team(student, new TowerSpotter(), null, studentDrives);
  const car = new Car(0);
  world.addCar(car, new PitRecorder(team, student, examples));
  const s = inLapStart(track);
  car.placeOnTrack(track, s, lane);
  // On ovals at the in-lap's usual speed; on circuits at what the line takes there.
  const speed = track.kind === 'road' ? Math.min(START_SPEED, speedAt(track, s)) : START_SPEED;
  car.vx = track.tx[car.trackIdx] * speed;
  car.vy = track.ty[car.trackIdx] * speed;
  car.pit.phase = 'in';
  car.pit.call = { tires: true, fuel: 15, repair: false };
  // A teacher's throttle has to be one a student can copy: in proportion, not flat out below its speed.
  team.autopilot.driveGain = TEACHING_DRIVE_GAIN;
  team.autopilot.begin(car);
  let serviced = false;
  const phase = (): PitState['phase'] => car.pit.phase;
  for (let k = 0; k < DRILL_SECONDS / P.DT && !car.retired; k++) {
    world.step();
    if (phase() === 'service') serviced = true;
  }
  return serviced && phase() === 'none' && !car.retired;
}

/** The speed the fastest line takes at a point (85% of grip), for a start that isn't already off the road. */
function speedAt(track: Track, s: number): number {
  const line = fastestLine(track), speed = line.at(0.85).speed, n = speed.length;
  return speed[((Math.round(track.wrapS(s) / line.step) % n) + n) % n];
}

/** Teach a group their pit skill (pit networks trained in place; a new one starts as a copy of the oval skill). */
export function apprenticePitSkill(students: PitStudent[], seed: number, options: PitSkillOptions = {}): void {
  const opts = { rounds: 6, ovals: 2, circuits: 2, epochs: 6, maxExamples: 40_000, ...options };
  const rng = new Rng(hashSeed(seed, 'pit-skill'));
  const examples: Example[][] = students.map(() => []);
  for (const d of students) d.pit ??= d.weights.slice();
  for (let round = 0; round < opts.rounds; round++) {
    const t0 = Date.now();
    const tracks = [
      ...Array.from({ length: opts.ovals }, (_, k) => apprenticeTrack(round * opts.ovals + k, seed)),
      ...Array.from({ length: opts.circuits }, (_, k) => circuitTrack(hashSeed(seed, `pit${round}:${k}`), k % 2 ? 'gp' : 'club')),
    ];
    let stops = 0, completed = 0;
    students.forEach((d, i) => {
      for (const track of tracks) {
        for (const lane of [-2, 2]) {
          stops++;
          if (drill(track, d, round > 0, lane, examples[i], hashSeed(seed, `hands${round}:${d.lineage}:${track.length}:${lane}`))) completed++;
        }
      }
    });
    let loss = 0;
    students.forEach((d, i) => {
      const set = examples[i].length <= opts.maxExamples ? examples[i] : sample(examples[i], opts.maxExamples, rng);
      loss += trainSupervised(DRIVER_LAYERS, d.pit!, set, round === 0 ? 3 * opts.epochs : opts.epochs, 0.01, () => rng.next());
    });
    opts.onRound?.(round, { loss: loss / students.length, stops, completed, seconds: (Date.now() - t0) / 1000 });
  }
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
