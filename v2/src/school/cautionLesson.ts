import { DRIVER_LAYERS, NeuralDriver, ScriptedDriver, Team } from '../ai/drivers';
import { FULL_DAMAGE_PENALTY } from '../ai/es';
import { FormationDriver, PaceCarDriver } from '../ai/formation';
import { trainSupervised, type Example } from '../ai/network';
import type { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { placeOnGrid } from '../sim/grid';
import { Race } from '../sim/race';
import type { RaceControl } from '../sim/raceControl';
import type { Track } from '../sim/track';
import { World, type Controller } from '../sim/world';
import { racingExamples } from './imitation';
import { DrillTrial, type Drill } from './drill';

/**
 * The caution lesson. A drill is a short race in a small field: form up
 * behind the pace car, take the green, race a little, then race control
 * calls a caution for debris; the field forms up again, runs a caution lap,
 * restarts, and races on. The student is one car; the rest of the pack is
 * calm and predictable (each car holds its own lane under green, and paces
 * as the formation script does), so the drill tests the student, not the
 * chaos of a pack. Scored on holding its place and lane under caution, never
 * passing under caution, never touching anyone, and getting going again at
 * the green.
 */

export const DRILL_FIELD = 8;
/** Seconds of green before the debris caution, and after the restart before the drill ends. */
const GREEN_BEFORE = 10;
const GREEN_AFTER = 10;
/** Longest a drill can run (s). */
const DRILL_LIMIT = 320;

/** Score weights: laps per metre of place error, per metre of lane error, per pass under caution, per unit of damage done to others. */
const PLACE_ERROR = 1 / 30;
const LANE_ERROR = 1 / 4;
const PASS_PENALTY = 0.5;
const HARM_PENALTY = 2;

export interface CautionResult {
  fitness: number;
  /** Laps under green. */
  laps: number;
  bestLap: number;
  health: number;
  /** Mean place and lane error while pacing (m). */
  placeError: number;
  laneError: number;
  /** Positions gained under caution. */
  passes: number;
  /** Damage the student did to others (health they lost, by its share of the fault). */
  harm: number;
}

/** A clean drill: no damage done or taken, kept its place, no passes. */
export function cleanCaution(r: CautionResult): boolean {
  return r.health >= 0.95 && r.harm < 0.05 && r.passes === 0 && r.placeError < 15 && r.laneError < 2.5;
}

/** One drill: a world with race control, the student's car in a given grid slot. */
export class CautionDrill implements Drill<CautionResult> {
  readonly world: World;
  readonly race: Race;
  readonly control: RaceControl;
  readonly student: Car;
  private phase: 'start' | 'green' | 'caution' | 'restarted' = 'start';
  private greenAt = NaN;
  private time = 0;
  private placeSum = 0;
  private laneSum = 0;
  private samples = 0;
  private bestIndex = Infinity;
  private passes = 0;
  private greenDist = 0;
  private lastDist = 0;
  private finishedFlag = false;

  /** controllerFor(slot): the controller for each grid slot (the student's slot gets the student's). */
  constructor(track: Track, studentSlot: number, controllerFor: (slot: number) => Controller) {
    this.world = new World(track, { collisions: true, drafting: true });
    for (let k = 0; k < DRILL_FIELD; k++) {
      const car = new Car(k);
      placeOnGrid(car, track, k, true);
      this.world.addCar(car, controllerFor(k));
    }
    this.student = this.world.cars[studentSlot];
    this.race = new Race(this.world, 999, new PaceCarDriver());
    this.control = this.race.control!;
    // Short drills: the restart is coming as soon as the field has formed up.
    this.control.oneToGo = true;
    this.lastDist = this.student.dist;
  }

  get done(): boolean {
    return this.finishedFlag || this.time >= DRILL_LIMIT;
  }

  step(): void {
    if (this.done) return;
    this.race.step();
    this.time += P.DT;
    const ctl = this.control;
    const car = this.student;
    if (ctl.flag === 'green') {
      if (this.phase === 'start') { this.phase = 'green'; this.greenAt = this.time; }
      if (this.phase === 'caution') { this.phase = 'restarted'; this.greenAt = this.time; }
      if (!car.retired) this.greenDist += car.dist - this.lastDist;
      if (this.phase === 'green' && this.time - this.greenAt > GREEN_BEFORE) {
        ctl.debrisCaution(1);
        this.phase = 'caution';
        this.bestIndex = Infinity;
      }
      if (this.phase === 'restarted' && this.time - this.greenAt > GREEN_AFTER) this.finishedFlag = true;
    } else if (!car.retired) {
      const slot = ctl.slotFor(car);
      if (slot) {
        const t = this.world.track;
        let err = t.distanceFrom(car.s, slot.s);
        if (err > t.length / 2) err -= t.length;
        if (err < -150) err += t.length;
        this.placeSum += Math.abs(err);
        this.laneSum += Math.abs(slot.d - car.d);
        this.samples++;
        // Passing under caution: moving up the order while pacing.
        if (slot.index < this.bestIndex) {
          if (Number.isFinite(this.bestIndex)) this.passes += this.bestIndex - slot.index;
          this.bestIndex = slot.index;
        }
      }
    }
    this.lastDist = car.dist;
  }

  result(): CautionResult {
    const car = this.student;
    const harm = car.harmDone;
    const placeError = this.samples ? this.placeSum / this.samples : 999;
    const laneError = this.samples ? this.laneSum / this.samples : 99;
    const laps = this.greenDist / this.world.track.length;
    return {
      fitness: laps - PLACE_ERROR * placeError - LANE_ERROR * laneError - PASS_PENALTY * this.passes
        - FULL_DAMAGE_PENALTY * (1 - car.health) - HARM_PENALTY * harm,
      laps,
      bestLap: car.lapTimes.length ? Math.min(...car.lapTimes) : Infinity,
      health: car.health,
      placeError,
      laneError,
      passes: this.passes,
      harm,
    };
  }
}

/**
 * The pack: each car holds its own lane under green, on its own file's side
 * (even grid slots start inside, odd outside, so nobody cuts across at the
 * green), and paces as the formation script does.
 */
const INSIDE_LANES = [-5, -1.5];
const OUTSIDE_LANES = [5.5, 2];
export const packCar = (slot: number) => {
  const lanes = slot % 2 === 0 ? INSIDE_LANES : OUTSIDE_LANES;
  return new Team(new ScriptedDriver(lanes[Math.floor(slot / 2) % 2], 0.9), new TowerSpotter(), null, false, false);
};

/**
 * One round of the lesson: every candidate (each student and its variations)
 * drives its own drill from the same grid slot. One student's drill is shown.
 */
export class CautionTrial extends DrillTrial<CautionResult> {
  /** candidates: per student, [own, +e1, -e1, ...]; references: each student as it drove before the class. */
  constructor(track: Track, candidates: Float32Array[], perStudent: number, slot: number, show: number, references: Float32Array[] = []) {
    super(candidates.map((g) => new CautionDrill(track, slot, (k) => (k === slot
      ? new Team(new NeuralDriver(g), new TowerSpotter(), null, false, true) // the candidate drives its own caution
      : packCar(k)))), perStudent, show, candidates, references.length ? { track, references } : undefined);
  }
}

/**
 * Records caution lessons for an apprentice (DAgger, as for pit stops): the
 * formation script says what it would do at each moment under caution, from
 * wherever the student is; first the script drives, then the student does
 * under its eye. Moments of the student's original racing under green are
 * kept too, so learning to pace doesn't overwrite how it races.
 */
class CautionApprentice implements Controller {
  private readonly teacher = new FormationDriver();

  constructor(
    private readonly team: Team,
    private readonly student: NeuralDriver,
    private readonly original: NeuralDriver,
    private readonly examples: Example[],
    private readonly rng: Rng,
  ) {}

  decide(car: Car, world: World): void {
    const px = car.inputX, py = car.inputY;
    const pacing = !!world.control?.pacing && car.pit.phase === 'none';
    let label: [number, number] | null = null;
    if (pacing) {
      // The teacher follows every moment (it keeps track as it goes); only a sample is recorded.
      this.teacher.decide(car, world);
      if (this.rng.next() < PACING_SAMPLE) label = [car.inputX, car.inputY];
      car.inputX = px;
      car.inputY = py;
    } else if (this.rng.next() < 0.15) {
      label = [NaN, NaN];
    }
    this.team.decide(car, world);
    const ax = car.inputX, ay = car.inputY;
    if (!label) return;
    car.inputX = px;
    car.inputY = py;
    const x = this.student.inputs(car, world, this.team.radio, this.team.pitInputs, this.team.cautionInputs).slice();
    if (Number.isNaN(label[0])) {
      const out = this.original.net.forward(x);
      label = [out[0], out[1]];
    }
    car.inputX = ax;
    car.inputY = ay;
    const clamp = (v: number) => Math.max(-0.95, Math.min(0.95, v));
    this.examples.push({ x, y: Float32Array.of(clamp(label[0]), clamp(label[1])), mask: Float32Array.of(1, 1) });
  }
}

/** Share of moments under caution recorded (thousands a drill; a sample teaches as much). */
const PACING_SAMPLE = 0.25;

export const CAUTION_APPRENTICE_ROUNDS = 3;

/** How the formation script does in the same drill, driving for this student (its racing, the script's pacing). */
export function scriptBaseline(track: Track, slot: number, weights: Float32Array): CautionResult {
  const drill = new CautionDrill(track, slot, (k) => (k === slot
    ? new Team(new NeuralDriver(weights.slice()), new TowerSpotter(), null, false, false)
    : packCar(k)));
  while (!drill.done) drill.step();
  return drill.result();
}

/** Margin (laps of score) by which a student may trail the script and still pass. */
export const BASELINE_MARGIN = 0.25;

/** Teach a student caution and restart driving by imitating the formation script. Trains its weights in place. */
export function apprenticeCautions(
  weights: Float32Array, tracks: Track[], rng: Rng, rounds = CAUTION_APPRENTICE_ROUNDS,
): { examples: number; loss: number } {
  const examples: Example[] = [];
  const original = new NeuralDriver(weights.slice());
  let loss = NaN;
  for (let round = 0; round < rounds; round++) {
    const studentDrives = round > 0;
    for (const track of tracks) {
      for (const slot of [2, 5]) {
        const drill = new CautionDrill(track, slot, (k) => {
          if (k !== slot) return packCar(k);
          const team = new Team(new NeuralDriver(weights), new TowerSpotter(), null, false, studentDrives);
          return new CautionApprentice(team, new NeuralDriver(weights), original, examples, rng);
        });
        while (!drill.done) drill.step();
      }
    }
    // As many moments of its own original racing, so learning this doesn't overwrite how it races.
    const racing = racingExamples(original.net.weights, tracks, rng, examples.length);
    loss = trainSupervised(DRIVER_LAYERS, weights, examples.concat(racing), round === 0 ? 30 : 12, 0.01, () => rng.next());
  }
  return { examples: examples.length, loss };
}
