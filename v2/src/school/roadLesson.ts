import { DRIVER_LAYERS, NeuralDriver, ScriptedDriver, Team } from '../ai/drivers';
import { trainSupervised, type Example } from '../ai/network';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { ROLLING_START_SPEED } from '../sim/grid';
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

/** Rounds of the apprenticeship (the first with the teacher driving), and per round: circuits, lanes, seconds each. */
export const ROAD_APPRENTICE_ROUNDS = 4;
const CIRCUITS = 6;
const LANES = [-2, 0, 2];
const SECONDS = 120;
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
 * from the line as a race starts, 120 s each: a full lap's distance on every
 * one without crashing (or badly hurting the car).
 */
export function roadLicenseTest(weights: Float32Array, seed: number, minHealth: number): boolean {
  for (let k = 0; k < 3; k++) {
    const track = new Track(generateLayout({ type: 'circuit', seed: hashSeed(seed, `test${k}`), variant: 'club' }));
    const world = new World(track, { collisions: false, drafting: false });
    const car = new Car(0);
    world.addCar(car, new Team(new NeuralDriver(weights), new TowerSpotter(), null));
    car.placeOnTrack(track, track.length - 20, 0);
    car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
    car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
    for (let i = 0; i < SECONDS / P.DT && !car.retired && car.dist < track.length; i++) world.step();
    if (car.retired || car.health < minHealth || car.dist < track.length) return false;
  }
  return true;
}

/** Circuits to learn on: club and GP, at full tightness. */
function apprenticeCircuits(seed: number): Track[] {
  return Array.from({ length: CIRCUITS }, (_, k) => new Track(generateLayout({
    type: 'circuit', seed: hashSeed(seed, `apprentice${k}`), variant: k % 3 === 2 ? 'gp' : 'club',
  })));
}

/** Teach a road-course skill (weights, trained in place) by imitating the scripted line follower on circuits. */
export function apprenticeRoadCourses(weights: Float32Array, seed: number, rounds = ROAD_APPRENTICE_ROUNDS): { examples: number; loss: number } {
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
    loss = trainSupervised(DRIVER_LAYERS, weights, examples, round === 0 ? 30 : 12, 0.01, () => rng.next());
  }
  return { examples: examples.length, loss };
}
