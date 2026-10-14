import { DRIVER_LAYERS, NeuralDriver, neuralTeam, Team } from '../ai/drivers';
import { FULL_DAMAGE_PENALTY } from '../ai/es';
import { trainSupervised, type Example } from '../ai/network';
import type { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { Car, type PitCall } from '../sim/car';
import { PHYSICS as P, PIT_SERVICE } from '../sim/constants';
import type { Track } from '../sim/track';
import { World, type Controller } from '../sim/world';

/**
 * The pit stop lesson. Every car starts its in-lap with the stop already
 * called and has to do the whole thing itself: down to the apron, onto pit
 * road under the limit, stop on its box, wait out the service, back out
 * through the blend lane and merge. The score is distance covered by the end
 * of the trial, so a quick clean stop that gets back up to speed beats a slow
 * one, and a skipped stop, speeding on pit road or damage cost dearly.
 */

/**
 * How far before the pit entry the in-lap starts (m), and the speed then. On
 * short tracks less: the stop is planned from within half a lap of the line
 * (the pit route, like the crew chief's call, works in that frame).
 */
const START_BEFORE_ENTRY = 450;
const START_SPEED = 45;
/**
 * Laps a skipped stop costs (more than any time a stop could take), less
 * credit for how far through the stop the car got, so practice has a slope
 * to climb before a driver ever completes one: onto pit road, slowing at the
 * box, serviced. Not merging back afterwards costs extra.
 */
const SKIP_PENALTY = 2;
const CREDIT_PIT_ROAD = 0.6;
const CREDIT_AT_BOX = 0.4;
const NO_MERGE_PENALTY = 0.5;
/**
 * Speeding on pit road: what a race would cost (a drive-through, about half a
 * lap) once a car is really over, plus a little per second over.
 */
const SPEEDING_PENALTY = 0.05;
const DRIVE_THROUGH = 0.5;
const SPEEDING_GRACE = 0.3; // s
const CALL: PitCall = { tires: true, fuel: 15, repair: false };

export interface PitTrialResult {
  fitness: number;
  /** Laps of progress over the trial. */
  laps: number;
  bestLap: number;
  health: number;
  /** Stopped on the box and was serviced; then back on track and merged. */
  serviced: boolean;
  completed: boolean;
  /** Seconds over the pit road speed limit. */
  speeding: number;
  /** Got onto pit road, and slowed down at the box (on the in-lap). */
  reachedPitRoad: boolean;
  reachedBox: boolean;
}

/** Start a car on its in-lap with the stop called. */
function inLapStart(track: Track): number {
  return Math.max(track.pit.entryStart - START_BEFORE_ENTRY, -track.length / 2 + 20);
}

function startInLap(car: Car, team: Team, track: Track): void {
  car.placeOnTrack(track, inLapStart(track), 0);
  car.vx = track.tx[car.trackIdx] * START_SPEED;
  car.vy = track.ty[car.trackIdx] * START_SPEED;
  car.pit.phase = 'in';
  car.pit.call = { ...CALL };
  team.autopilot.begin(car);
}

/** One round of the lesson: every candidate does a pit stop at once, as ghosts. */
export class PitTrial {
  readonly world: World;
  readonly track: Track;
  private readonly steps: number;
  private stepIndex = 0;
  private readonly startDist: number[] = [];
  private readonly speeding: number[] = [];
  private readonly serviced: boolean[] = [];
  private readonly completed: boolean[] = [];
  private readonly reachedPitRoad: boolean[] = [];
  private readonly reachedBox: boolean[] = [];

  constructor(track: Track, genomes: Float32Array[], seconds: number) {
    this.track = track;
    this.world = new World(track, { collisions: false, drafting: false });
    genomes.forEach((g, k) => {
      const car = new Car(k);
      const team = neuralTeam(g, null, true); // the driver drives its own stop
      this.world.addCar(car, team);
      startInLap(car, team, track);
      this.startDist.push(car.dist);
      this.speeding.push(0);
      this.serviced.push(false);
      this.completed.push(false);
      this.reachedPitRoad.push(false);
      this.reachedBox.push(false);
    });
    this.steps = Math.round(seconds / P.DT);
  }

  get done(): boolean {
    return this.stepIndex >= this.steps;
  }

  get remaining(): number {
    return Math.max(0, (this.steps - this.stepIndex) * P.DT);
  }

  step(): void {
    if (this.done) return;
    this.world.step();
    this.stepIndex++;
    this.world.cars.forEach((car, k) => {
      if (car.surface === 'pit' && car.speed > PIT_SERVICE.SPEED_LIMIT + 0.5) this.speeding[k] += P.DT;
      if (car.pit.stops > 0) this.serviced[k] = true;
      if (car.pit.phase === 'in' && car.surface === 'pit') {
        this.reachedPitRoad[k] = true;
        if (Math.abs(this.track.signedS(car.s) - car.pit.boxS) < 20 && car.speed < 6) this.reachedBox[k] = true;
      }
      if (this.serviced[k] && car.pit.phase === 'none') this.completed[k] = true;
    });
  }

  results(): PitTrialResult[] {
    return this.world.cars.map((car, k) => {
      const laps = (car.dist - this.startDist[k]) / this.track.length;
      const stop = this.serviced[k] ? SKIP_PENALTY
        : (this.reachedPitRoad[k] ? CREDIT_PIT_ROAD : 0) + (this.reachedBox[k] ? CREDIT_AT_BOX : 0);
      return {
        fitness: laps - FULL_DAMAGE_PENALTY * (1 - car.health) - (SKIP_PENALTY - stop)
          - (this.serviced[k] && !this.completed[k] ? NO_MERGE_PENALTY : 0) - SPEEDING_PENALTY * this.speeding[k]
          - (this.speeding[k] > SPEEDING_GRACE ? DRIVE_THROUGH : 0),
        laps,
        bestLap: car.lapTimes.length ? Math.min(...car.lapTimes) : Infinity,
        health: car.health,
        serviced: this.serviced[k],
        completed: this.completed[k],
        speeding: this.speeding[k],
        reachedPitRoad: this.reachedPitRoad[k],
        reachedBox: this.reachedBox[k],
      };
    });
  }
}

/** A clean stop: serviced, back out and merged, unhurt, and (near enough) never over the limit. */
export function cleanStop(r: PitTrialResult): boolean {
  return r.completed && r.health >= 0.95 && r.speeding < 1;
}

/**
 * Records pit-stop lessons for an apprentice. The scripted pit maneuver is
 * the teacher: at every decision during a stop it says what it would do from
 * here, and that's the answer the student learns. Who actually drives
 * alternates (DAgger): first the teacher, then the student itself, so the
 * student also learns what to do from the spots its own mistakes put it in.
 * Between stops a few moments of the student's original racing are recorded
 * too (as it drove before the lesson), so learning to pit doesn't overwrite
 * how it races.
 */
class Apprentice implements Controller {
  constructor(
    private readonly team: Team,
    private readonly student: NeuralDriver,
    private readonly original: NeuralDriver,
    private readonly examples: Example[],
    private readonly rng: Rng,
  ) {}

  decide(car: Car, world: World): void {
    const px = car.inputX, py = car.inputY;
    const stopping = car.pit.phase !== 'none';
    // The teacher's answer for this moment (its maneuver also tracks the stop as it goes).
    let label: [number, number] | null = null;
    if (stopping) {
      this.team.spotter.call(car, world, this.team.radio);
      this.team.autopilot.decide(car, world, this.team.spotter);
      label = [car.inputX, car.inputY];
      car.inputX = px;
      car.inputY = py;
    } else if (this.rng.next() < 0.15) {
      label = [NaN, NaN]; // filled in from the student's original racing below
    }
    // Whoever drives this run decides (teacher: the team's scripted maneuver; student: itself).
    this.team.decide(car, world);
    const ax = car.inputX, ay = car.inputY;
    if (!label) return;
    // What the student saw at this moment (its last command included).
    car.inputX = px;
    car.inputY = py;
    const x = this.student.inputs(car, world, this.team.radio, this.team.pitInputs).slice();
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

/** Rounds of watching the teacher (the first) and driving under its eye (the rest); a refresher is shorter. */
export const APPRENTICE_ROUNDS = 5;
export const REFRESHER_ROUNDS = 2;

/**
 * Teach a student the scripted pit stop by imitation (DAgger). Trains its
 * weights in place; returns the examples gathered and the final loss.
 */
export function apprenticePitStops(
  weights: Float32Array, tracks: Track[], rng: Rng, rounds = APPRENTICE_ROUNDS,
): { examples: number; loss: number } {
  const examples: Example[] = [];
  const original = new NeuralDriver(weights.slice());
  let loss = NaN;
  for (let round = 0; round < rounds; round++) {
    const studentDrives = round > 0;
    for (const track of tracks) {
      for (const lane of [-3, 2]) {
        const world = new World(track, { collisions: false, drafting: false });
        const student = new NeuralDriver(weights);
        // Teacher rounds: the script drives the stop. Student rounds: the student does.
        const team = new Team(student, new TowerSpotter(), null, studentDrives);
        const car = new Car(0);
        world.addCar(car, new Apprentice(team, new NeuralDriver(weights), original, examples, rng));
        startInLap(car, team, track);
        car.placeOnTrack(track, inLapStart(track), lane);
        car.vx = track.tx[car.trackIdx] * START_SPEED;
        car.vy = track.ty[car.trackIdx] * START_SPEED;
        team.autopilot.begin(car);
        for (let k = 0; k < 75 / P.DT && !car.retired; k++) world.step();
      }
    }
    loss = trainSupervised(DRIVER_LAYERS, weights, examples, round === 0 ? 30 : 12, 0.01, () => rng.next());
  }
  return { examples: examples.length, loss };
}
