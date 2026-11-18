import { NeuralDriver, Team } from '../ai/drivers';
import type { Example } from '../ai/network';
import type { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { ROLLING_START_SPEED } from '../sim/grid';
import type { Track } from '../sim/track';
import { World, type Controller } from '../sim/world';

/**
 * Examples of a driver's own racing, for apprenticeships to train on next to
 * the skill they teach. An apprenticeship that only records the skill (a
 * caution, a stop) and a few seconds of green overwrites how the student
 * races: drill after drill, the network learns the new thing and forgets the
 * rest (one class left drivers that couldn't finish a lap). So each round
 * trains on as many moments of the student's original racing, recorded from
 * solo laps on every track.
 */

/** Seconds of solo laps per track and lane the moments are drawn from. */
const SECONDS = 120;
const LANES = [-3, 2];

/** Records (what the driver saw, what it did) at its decisions, with some probability. */
class Recorder implements Controller {
  constructor(
    private readonly team: Team,
    private readonly driver: NeuralDriver,
    private readonly out: Example[],
    private readonly chance: number,
    private readonly rng: Rng,
  ) {}

  decide(car: Car, world: World): void {
    if (this.rng.next() < this.chance) {
      // What it sees now (its last command included), and what it answers.
      const x = this.driver.inputs(car, world, this.team.radio, this.team.pitInputs, this.team.cautionInputs).slice();
      const y = this.driver.net.forward(x);
      const clamp = (v: number) => Math.max(-0.95, Math.min(0.95, v));
      this.out.push({ x, y: Float32Array.of(clamp(y[0]), clamp(y[1])), mask: Float32Array.of(1, 1) });
    }
    this.team.decide(car, world);
  }
}

/** About `count` moments of `weights` racing solo on the tracks. */
export function racingExamples(weights: Float32Array, tracks: Track[], rng: Rng, count: number): Example[] {
  const out: Example[] = [];
  if (count <= 0) return out;
  const decisions = tracks.length * LANES.length * SECONDS / (P.CONTROL_EVERY * P.DT);
  const chance = Math.min(1, count / decisions);
  for (const track of tracks) {
    for (const lane of LANES) {
      const world = new World(track, { collisions: false, drafting: false });
      const driver = new NeuralDriver(weights.slice());
      const team = new Team(driver, new TowerSpotter(), null);
      const car = new Car(0);
      world.addCar(car, new Recorder(team, driver, out, chance, rng));
      car.placeOnTrack(track, track.length - 20, lane);
      car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
      car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
      for (let k = 0; k < SECONDS / P.DT && !car.retired; k++) world.step();
    }
  }
  return out;
}
