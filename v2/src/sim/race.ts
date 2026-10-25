import type { Car } from './car';
import { PHYSICS as P } from './constants';
import { RaceControl } from './raceControl';
import { StewardsDesk } from '../rules/desk';
import type { Rulebook } from '../rules/rulebook';
import type { StewardTraits } from '../rules/stewards';
import type { Controller, World } from './world';
import { Rng } from '../ai/rng';

export type RaceState = 'green' | 'checkered' | 'finished';

export interface Standing {
  car: Car;
  position: number;
  laps: number;
  /** Race time for finishers, NaN otherwise. */
  time: number;
  status: 'running' | 'finished' | 'out' | 'pit';
}

/**
 * A race over a set number of laps. With a pace car (race control) the field
 * forms up behind it and the race starts on the green flag; cautions slow the
 * field while wreckers clear the track. The leader completing the distance
 * brings out the checkered flag; everyone else finishes when they next cross
 * the line. Retired cars stay out (no respawns in a race).
 */
export class Race {
  readonly world: World;
  readonly laps: number;
  readonly control: RaceControl | null;
  state: RaceState = 'green';
  /** The green flag has flown (always true without race control). */
  started: boolean;
  private readonly finishOrder: Car[] = [];
  private readonly finishTime = new Map<Car, number>();
  /** Laps completed when each car took the flag (cars keep circulating afterwards). */
  private readonly finishLaps = new Map<Car, number>();
  /** Laps each car had completed when the checkered flag came out. */
  private readonly lapsAtFlag = new Map<Car, number>();
  /** Race clock starts when the leader takes the green at the line. */
  private startTime = NaN;

  /** The stewards, when the race is run to a rulebook (needs race control). */
  readonly stewards: StewardsDesk | null = null;

  /** Pass a pace car controller to run the race under race control (pace laps, cautions); rules: stewards too. */
  constructor(world: World, laps: number, paceCar?: Controller, rules?: { rulebook: Rulebook; stewards?: StewardTraits; seed?: number }) {
    this.world = world;
    this.laps = laps;
    world.raceLaps = laps;
    if (paceCar) {
      this.control = new RaceControl(world);
      world.officials.push({ car: this.control.paceCar, controller: paceCar });
      this.control.safetyCar = rules?.rulebook.neutralise === 'safety-car';
      const start = rules?.rulebook.start;
      if (start?.kind === 'standing') {
        const rng = new Rng((rules?.seed ?? 1) ^ 0x2545f491);
        this.control.formUpStanding(world.cars, start, () => rng.next());
        this.control.onLightsOut = () => this.lightsOut();
      } else {
        this.control.formUp(world.cars);
      }
      this.control.onGreen = (leader) => this.greenFlag(leader);
      this.started = false;
      if (rules) this.stewards = new StewardsDesk(world, this.control, rules.rulebook, rules.stewards, rules.seed);
    } else {
      this.control = null;
      this.started = true;
    }
  }

  /** Green now, from wherever the cars are (no pace laps): for drills that begin mid-race. */
  startGreen(): void {
    this.control?.startGreen();
    this.started = true;
    this.startTime = this.world.time;
  }

  /**
   * A standing start: the clock starts as the lights go out. Each car's first
   * lap starts when it crosses the line (the grid is behind it), and its race
   * time includes the run from its box.
   */
  private lightsOut(): void {
    this.started = true;
    this.startTime = this.world.time;
    for (const car of this.world.cars) {
      car.lapTimes.length = 0;
      car.lapValid.length = 0;
      car.lapStartTime = -1;
    }
  }

  /** Laps before the green don't count: everyone starts lap 1 at the line. */
  private greenFlag(leader: Car): void {
    if (this.started) return; // a restart, not the start
    this.started = true;
    this.startTime = leader.lapStartTime;
    for (const car of this.world.cars) {
      car.lapTimes.length = 0;
      car.lapValid.length = 0;
      if (car !== leader) car.lapStartTime = -1;
    }
  }

  step(): void {
    const world = this.world;
    world.step();
    this.control?.step(P.DT, this.leader());
    this.stewards?.step();
    if (!this.started) return;
    for (const car of world.cars) {
      if (Number.isNaN(this.startTime) && car.lapStartTime >= 0) this.startTime = car.lapStartTime;
      // (A black-flagged car on its way in takes no flag.)
      if (this.finishTime.has(car) || car.retired || car.disqualified) continue;
      const leaderDone = this.state !== 'green';
      if (car.lapsCompleted >= this.laps || (leaderDone && car.lapTimes.length > (this.lapsAtFlag.get(car) ?? car.lapTimes.length))) {
        if (this.state === 'green') this.state = 'checkered';
        this.finishOrder.push(car);
        this.finishTime.set(car, car.lapStartTime - this.startTime);
        this.finishLaps.set(car, car.lapsCompleted);
        car.finished = true;
      }
    }
    if (this.state === 'checkered' && world.cars.every((c) => c.retired || this.finishTime.has(c))) {
      this.state = 'finished';
    }
    if (this.state === 'green') for (const car of world.cars) this.lapsAtFlag.set(car, car.lapTimes.length);
  }

  /** The running leader (on track or pitting, not retired or finished). */
  leader(): Car | null {
    let best: Car | null = null;
    for (const c of this.world.cars) {
      if (c.retired || c.disqualified || this.finishTime.has(c)) continue;
      if (!best || c.dist > best.dist) best = c;
    }
    return best;
  }

  isFinished(car: Car): boolean {
    return this.finishTime.has(car);
  }

  standings(): Standing[] {
    const cars = this.world.cars;
    // Finishers are classified by laps completed, then by the time they took the flag.
    // Time penalties count toward the finishing order on the same lap.
    const raceTime = (c: Car) => this.finishTime.get(c)! + c.timePenalty;
    const finished = [...this.finishOrder]
      .sort((a, b) => this.finishLaps.get(b)! - this.finishLaps.get(a)! || raceTime(a) - raceTime(b))
      .map((car) => ({ car, status: 'finished' as const }));
    const running = cars.filter((c) => !this.finishTime.has(c) && !c.retired && !c.disqualified)
      .sort((a, b) => b.dist - a.dist)
      .map((car) => ({ car, status: car.pit.phase === 'none' ? 'running' as const : 'pit' as const }));
    const out = cars.filter((c) => !this.finishTime.has(c) && (c.retired || c.disqualified))
      .sort((a, b) => b.dist - a.dist)
      .map((car) => ({ car, status: 'out' as const }));
    return [...finished, ...running, ...out].map((e, i) => ({
      car: e.car,
      position: i + 1,
      laps: this.finishLaps.get(e.car) ?? e.car.lapsCompleted,
      time: this.finishTime.has(e.car) ? raceTime(e.car) : NaN,
      status: e.status,
    }));
  }
}
