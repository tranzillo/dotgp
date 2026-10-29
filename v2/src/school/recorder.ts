/**
 * The apprenticeship recorder, one for every skill (oval racing and cautions, road racing and cautions, pit stops):
 * it records (what the student saw, what its teacher would do from here) whoever drives. The teacher drives the first
 * round and the student watches; from then on the student drives through its own human limits and the teacher says
 * at each moment what it would have done from where the car really is (DAgger). Before, each skill had its own copy,
 * and fixes landed in one and not the others (the oval copy never mirrored its steering labels).
 */
import { CAUTION_FROM, DAMAGE_FROM, NeuralDriver, PIT_FROM, TACTIC, Team } from '../ai/drivers';
import type { Example } from '../ai/network';
import { observeCaution } from '../ai/observe';
import { Rng } from '../ai/rng';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import type { Controller, World } from '../sim/world';

/**
 * Who drives a student's car in a round: its teacher (the student watches); its teacher through shaken hands (the
 * student's own latency and a drifting error on top, `sigma` of the inputs' range, so the car ends up off its line
 * and the teacher shows the way back: noise injection); or the student itself (DAgger).
 */
export type Driving = { kind: 'teacher' } | { kind: 'shaken'; sigma: number } | { kind: 'student' };

/** A teacher: a scripted driver, and if it keeps a plan of its own, a way to answer from where the car really is. */
export interface Teacher extends Controller {
  takeOver?(car: Car, world: World): void;
  /** Its lane plan, if it races to one (+1 the +d side, -1 the -d side, 0 holding): what a student's tactics learn. */
  readonly intent?: number;
}

export interface RecorderOptions {
  /**
   * What is taught: 'driving' (default), the teacher's answers off pit road (the team's pit maneuver or pit skill
   * drives the stops, unrecorded); 'stops', the pit maneuver's answers during stops (whoever drives them: the team
   * says, by whether its driver pits).
   */
  skill?: 'driving' | 'stops';
  /** The student's latency (s), for shaken hands. */
  latency?: number;
  /** Share of the moments recorded (moments a few frames apart are nearly the same). Default SAMPLE. */
  sample?: number;
  /**
   * Chance per decision, while the student drives, of a knock: the car's speed cut to a random share of it, so the
   * teacher shows what to do far below the speed the place takes (its own laps never are).
   */
  knock?: number;
  /** More to record with what the student saw, as it saw it (mirrored or not) (experiments: what else would it need to see?). */
  extra?: (car: Car, world: World, mirrored: boolean) => Float32Array;
  /**
   * Where its tactics' moments go (racing under green, sound): what it saw, its own last plan among it, and the plan
   * its teacher made from there (TACTIC: a score of 0.9 for it, -0.9 the others). Its own last plan, not its teacher's:
   * shown its teacher's, the tactics learned to keep the plan they had, and racing, kept their own (2026-10-26: with
   * the teacher passing high on the short oval, the student's plan was to hold two times in three).
   */
  tactics?: Example[];
  /**
   * Where its launches' driving moments go instead (racing, sound, within a lap of the green: the start or a restart,
   * the field coming out of the pacing formation together), to be trained on as a share of their own: they're a few
   * percent of green time, and a random draw all but leaves them out (2026-10-28: students 7-10x the teachers' contact
   * there). Only which moments are kept for training: who drives, and how, is the same as any other moment.
   */
  launches?: Example[];
}

/** Share of the students' decisions recorded, by default. */
const SAMPLE = 0.3;

/** How long a shaken teacher's drifting error takes to change (s). */
const SHAKE_TAU = 0.5;

/** A teacher's hands shaken: its decisions arrive late (the student's latency) and off by a drifting error. */
class ShakenHands {
  private readonly queue: Array<[number, number]> = [];
  private readonly delay: number;
  private readonly keep = Math.exp(-(P.CONTROL_EVERY * P.DT) / SHAKE_TAU);
  private nx = 0;
  private ny = 0;

  constructor(latency: number, private readonly sigma: number, private readonly rng: Rng) {
    this.delay = Math.round(latency / (P.CONTROL_EVERY * P.DT));
  }

  apply(x: number, y: number, car: Car): void {
    this.queue.push([x, y]);
    const [ax, ay] = this.queue.length > this.delay ? this.queue.shift()! : [car.inputX, car.inputY];
    const fresh = Math.sqrt(1 - this.keep * this.keep);
    this.nx = this.keep * this.nx + fresh * this.rng.gaussian();
    this.ny = this.keep * this.ny + fresh * this.rng.gaussian();
    car.inputX = ax + this.sigma * this.nx;
    car.inputY = ay + this.sigma * this.ny;
  }
}

/** Records (what the student saw, what its teacher would do) whoever drives. */
export class Recorder implements Controller {
  private readonly hands: ShakenHands | null;
  private readonly studentDrives: boolean;
  private readonly stops: boolean;
  /** The flag at its last look, and how far the car had gone when the green last flew (m). */
  private flagWas: string | null = null;
  private greenFrom = -Infinity;

  /** `teacher`: the driving skill's teacher (unused for stops: the team's pit maneuver teaches them). */
  constructor(
    readonly team: Team,
    private readonly student: NeuralDriver,
    private readonly teacher: Teacher | null,
    driving: Driving,
    private readonly examples: Example[],
    private readonly rng: Rng,
    private readonly opts: RecorderOptions = {},
  ) {
    this.studentDrives = driving.kind === 'student';
    this.hands = driving.kind === 'shaken' ? new ShakenHands(opts.latency ?? 0, driving.sigma, rng) : null;
    this.stops = opts.skill === 'stops';
    // While it has no tactics of its own, it races to its teacher's plan; recorded, it's shown its teacher's plan.
    if (teacher && 'intent' in teacher) student.intentFrom = () => teacher.intent ?? 0;
  }



  /** Who drove (the team's mode: the driver, the pit maneuver, the formation). */
  get mode(): string { return this.team.mode; }

  decide(car: Car, world: World): void {
    const flag = world.control?.flag ?? null;
    if (flag === 'green' && this.flagWas !== null && this.flagWas !== 'green') this.greenFrom = car.dist;
    this.flagWas = flag;
    if (this.studentDrives && this.opts.knock && this.rng.next() < this.opts.knock) {
      const keep = this.rng.next();
      car.vx *= keep;
      car.vy *= keep;
    }
    const px = car.inputX, py = car.inputY;
    const lastPlan = this.student.intent;
    let label: [number, number] | null = null;
    if (this.stops) {
      // The maneuver's answer from here (it also keeps track of the stop as it goes).
      if (car.pit.phase !== 'none') {
        this.team.spotter.call(car, world, this.team.radio);
        this.team.autopilot.decide(car, world, this.team.spotter);
        label = [car.inputX, car.inputY];
      }
    } else if (this.teacher) {
      // The teacher decides every time (it keeps state: its pass, when it saw the flag), recorded or not, from where
      // the car really is when someone else has been driving it.
      if (this.studentDrives || this.hands) this.teacher.takeOver?.(car, world);
      this.teacher.decide(car, world);
      label = [car.inputX, car.inputY];
    }
    const plan = this.teacher?.intent ?? 0;
    car.inputX = px;
    car.inputY = py;
    // The team always runs (the crew chief calls the stops, its maneuver or pit skill drives them); watching, the
    // teacher drives off pit road.
    this.team.decide(car, world);
    if (!this.stops && label && !this.studentDrives && car.pit.phase === 'none') {
      if (this.hands) this.hands.apply(label[0], label[1], car);
      else { car.inputX = label[0]; car.inputY = label[1]; }
    }
    // A moment of the skill taught: a stop under way, or driving off pit road.
    if (!label || (!this.stops && car.pit.phase !== 'none') || this.rng.next() >= (this.opts.sample ?? SAMPLE)) return;
    // What the student saw at this moment (its last command included).
    const ax = car.inputX, ay = car.inputY;
    car.inputX = px;
    car.inputY = py;
    this.team.spotter.call(car, world, this.team.radio);
    this.team.observePit(car, world);
    observeCaution(car, world, this.team.cautionInputs);
    // What its tactics saw (its own last plan among it) and the plan the teacher made; then shown its teacher's plan,
    // so the driving it's taught is the driving of that plan.
    const hasPlan = this.teacher && 'intent' in this.teacher;
    if (hasPlan && this.opts.tactics) {
      this.student.shownIntent = lastPlan;
      const before = this.student.inputs(car, world, this.team.radio, this.team.pitInputs, this.team.cautionInputs);
      if (before[CAUTION_FROM] === 0 && before[PIT_FROM] === 0 && before[PIT_FROM + 1] === 0 && before[DAMAGE_FROM] === 0) {
        const side = this.student.mirrored ? -plan : plan;
        const y = new Float32Array(3).fill(-0.9);
        y[side > 0 ? TACTIC.LOW : side < 0 ? TACTIC.HIGH : TACTIC.HOLD] = 0.9;
        this.opts.tactics.push({ x: before.slice(), y, mask: Float32Array.of(1, 1, 1) });
      }
    }
    if (hasPlan) this.student.shownIntent = plan;
    const seen = this.student.inputs(car, world, this.team.radio, this.team.pitInputs, this.team.cautionInputs);
    this.student.shownIntent = null;
    let x = seen.slice();
    if (this.opts.extra) {
      const more = this.opts.extra(car, world, this.student.mirrored);
      x = new Float32Array(seen.length + more.length);
      x.set(seen);
      x.set(more, seen.length);
    }
    car.inputX = ax;
    car.inputY = ay;
    // The teacher steers in the world's frame; a student seeing a right-hander sees it mirrored (never on ovals, half
    // the corners on road circuits).
    if (this.student.mirrored) label[1] = -label[1];
    const clamp = (v: number) => Math.max(-0.95, Math.min(0.95, v));
    const launch = this.opts.launches && flag === 'green' && car.dist - this.greenFrom < world.track.length
      && seen[CAUTION_FROM] === 0 && seen[DAMAGE_FROM] === 0;
    (launch ? this.opts.launches! : this.examples).push({ x, y: Float32Array.of(clamp(label[0]), clamp(label[1])), mask: Float32Array.of(1, 1) });
  }
}
