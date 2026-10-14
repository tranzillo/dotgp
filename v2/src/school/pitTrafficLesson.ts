import { DRIVER_LAYERS, NeuralDriver, Team } from '../ai/drivers';
import { FULL_DAMAGE_PENALTY } from '../ai/es';
import { trainSupervised, type Example } from '../ai/network';
import type { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import type { Track } from '../sim/track';
import { World, type Controller } from '../sim/world';
import { DrillTrial, type Drill } from './drill';
import { Apprentice, inLapStart, START_SPEED, startInLap, StopTracker, type PitTrialResult } from './pitLesson';

/**
 * The pit-road-in-traffic lesson. The stop is called with a race going on:
 * two cars just ahead pit too (the veteran maneuver drives theirs), so pit
 * road has a queue and a car may still be in a box as the student passes,
 * and four cars keep racing around it, two of them closing from behind as it
 * slows. The racers drive as the student itself races, so the traffic is a
 * race's traffic. Scored as the pit stop lesson (distance, with the stop's
 * penalties), plus damage done to others.
 */

/** Seconds a drill runs: time for the stop, the queue and the merge. */
const DRILL_SECONDS = 100;
/** Laps of score per unit of health the rest of the field lost in contact with the student. */
const HARM_PENALTY = 2;

/** The field around the student (m ahead of it at the start, lane). */
const PITTERS: Array<[number, number]> = [[40, 2], [90, -1]];
const RACERS: Array<[number, number]> = [[-60, 3], [-100, -3], [130, 0], [200, -3]];
/** Lanes the student may start its in-lap in (the lesson's drills use the first; the refresher all). */
const STUDENT_LANES = [0, -3, 3];

export interface PitTrafficResult extends PitTrialResult {
  /** Health the rest of the field lost in contact with the student. */
  harm: number;
}

/** A clean stop in traffic: completed, unhurt, nobody else hurt, (near enough) never over the limit. */
export function cleanTrafficStop(r: PitTrafficResult): boolean {
  return r.completed && r.health >= 0.95 && r.harm < 0.05 && r.speeding < 1;
}

/** One drill: the student's car (0) with its stop called, two cars pitting ahead, four racing. */
export class PitTrafficDrill implements Drill<PitTrafficResult> {
  readonly world: World;
  readonly student: Car;
  private readonly stop = new StopTracker();
  private readonly startDist: number;
  private steps = 0;
  private harm = 0;
  private readonly lastHealth: number[];

  /** student: the student's team (drives its own stop or not); racing: weights the racers drive with. */
  constructor(track: Track, student: { team: Team; controller?: Controller }, racing: Float32Array, lane = STUDENT_LANES[0]) {
    this.world = new World(track, { collisions: true, drafting: true });
    this.student = new Car(0);
    this.world.addCar(this.student, student.controller ?? student.team);
    startInLap(this.student, student.team, track, 0, lane);
    for (const [ahead, lane] of PITTERS) {
      const car = new Car(this.world.cars.length);
      const team = new Team(new NeuralDriver(racing), new TowerSpotter(), null, false, false);
      this.world.addCar(car, team);
      startInLap(car, team, track, ahead, lane);
    }
    for (const [ahead, lane] of RACERS) {
      const car = new Car(this.world.cars.length);
      this.world.addCar(car, new Team(new NeuralDriver(racing), new TowerSpotter(), null, false, false));
      car.placeOnTrack(track, inLapStart(track) + ahead, lane);
      car.vx = track.tx[car.trackIdx] * START_SPEED;
      car.vy = track.ty[car.trackIdx] * START_SPEED;
    }
    this.startDist = this.student.dist;
    this.lastHealth = this.world.cars.map((c) => c.health);
  }

  get done(): boolean {
    return this.steps * P.DT >= DRILL_SECONDS;
  }

  step(): void {
    if (this.done) return;
    this.world.step();
    this.steps++;
    const me = this.student;
    this.stop.update(me, this.world.track);
    this.world.cars.forEach((c, k) => {
      if (c !== me && c.health < this.lastHealth[k] && c.lastImpact?.kind === 'car' && c.lastImpact.other === me.id) {
        this.harm += this.lastHealth[k] - c.health;
      }
      this.lastHealth[k] = c.health;
    });
  }

  result(): PitTrafficResult {
    const car = this.student;
    const laps = (car.dist - this.startDist) / this.world.track.length;
    return {
      fitness: laps - FULL_DAMAGE_PENALTY * (1 - car.health) - this.stop.penalty() - HARM_PENALTY * this.harm,
      laps,
      bestLap: car.lapTimes.length ? Math.min(...car.lapTimes) : Infinity,
      health: car.health,
      ...this.stop.marks(),
      harm: this.harm,
    };
  }
}

/** The student driving its own stop. */
const ownStop = (g: Float32Array) => ({ team: new Team(new NeuralDriver(g), new TowerSpotter(), null, true, false) });

/**
 * One round of the lesson: every candidate does its own stop in its own
 * drill; the racers drive as the student did at the start of the round.
 */
export class PitTrafficTrial extends DrillTrial<PitTrafficResult> {
  /** candidates: per student, [own, +e1, -e1, ...]. */
  constructor(track: Track, candidates: Float32Array[], perStudent: number, show: number) {
    super(candidates.map((g, i) => new PitTrafficDrill(track, ownStop(g), candidates[i - (i % perStudent)].slice())),
      perStudent, show);
  }
}

/** How the veteran maneuver does in the same drill, driving this student's car (its racing, the script's stop). */
export function trafficBaseline(track: Track, weights: Float32Array): PitTrafficResult {
  const drill = new PitTrafficDrill(track, { team: new Team(new NeuralDriver(weights.slice()), new TowerSpotter(), null, false, false) },
    weights.slice());
  while (!drill.done) drill.step();
  return drill.result();
}

/** Margin (laps of score) by which a student may trail the script and still pass. */
export const TRAFFIC_BASELINE_MARGIN = 0.15;

export const TRAFFIC_APPRENTICE_ROUNDS = 4;

/**
 * A refresher on the veteran's stop, in traffic this time (DAgger, as for the
 * solo stop: the script drives first, then the student under its eye).
 */
export function apprenticePitTraffic(
  weights: Float32Array, tracks: Track[], rng: Rng, rounds = TRAFFIC_APPRENTICE_ROUNDS,
): { examples: number; loss: number } {
  const examples: Example[] = [];
  const original = new NeuralDriver(weights.slice());
  let loss = NaN;
  for (let round = 0; round < rounds; round++) {
    const studentDrives = round > 0;
    for (const track of tracks) {
      for (const lane of STUDENT_LANES) {
        const team = new Team(new NeuralDriver(weights), new TowerSpotter(), null, studentDrives, false);
        const controller = new Apprentice(team, new NeuralDriver(weights), original, examples, rng);
        const drill = new PitTrafficDrill(track, { team, controller }, original.net.weights.slice(), lane);
        while (!drill.done) drill.step();
      }
    }
    loss = trainSupervised(DRIVER_LAYERS, weights, examples, round === 0 ? 30 : 12, 0.01, () => rng.next());
  }
  return { examples: examples.length, loss };
}
