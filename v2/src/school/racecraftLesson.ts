import { bestValidLap, ValidProgress } from '../sim/limits';
import type { TrackKnowledge } from '../ai/observe';
import { NeuralDriver, Team } from '../ai/drivers';
import { COSTS, trackPace } from '../ai/costs';
import { danger, fearScale } from '../ai/fear';
import type { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { DrillTrial, type Drill } from './drill';

/**
 * The racecraft lesson: racing in a pack without wrecking anyone. A drill is
 * a restart: a tight two-wide pack already at speed into turn 1, raced for a
 * short while. The rest of the pack drives as the class drives (the
 * student's own racing and its classmates'), so it's the traffic these
 * drivers make for each other in races. Scored on distance, less a heavy
 * charge for damage taken and for damage done to others (by fault: closing
 * from behind or moving across into someone is on you, being hit isn't).
 */

export const PACK_SIZE = 8;
const DRILL_SECONDS = 40;
/** Restart speed (m/s), row spacing (m), and the two files' lanes. */
const PACK_SPEED = 40;
const ROW_GAP = 10;
const FILE_D = 2.6;

/** Where each car in a drill starts: metres behind the front of the pack, lane, speed, tire life. */
export interface PackSpot { back: number; lane: number; speed: number; tire: number }
/** A drill's pack: where on the track its front starts, and each car's spot (as many cars as spots); how long it runs, if not the drill's own. */
export interface PackLayout { frontS: number; spots: PackSpot[]; seconds?: number }

/** The restart: two-wide rows just before the line, fresh tires. */
export function restartLayout(track: Track): PackLayout {
  return {
    frontS: track.length - 15,
    spots: Array.from({ length: PACK_SIZE }, (_, k) => ({
      back: Math.floor(k / 2) * ROW_GAP, lane: k % 2 === 0 ? -FILE_D : FILE_D, speed: PACK_SPEED, tire: 1,
    })),
  };
}

/**
 * A pack drawn at random: anywhere on the track, a restart (rows, a little
 * ragged) or a pack strung out mid-run (cars nose to tail or side by side,
 * lanes all over, tires part worn), so drivers learn pack manners, not one
 * choreographed start.
 */
export function randomLayout(track: Track, rng: Rng): PackLayout {
  const restart = rng.next() < 0.3;
  const spots: PackSpot[] = [];
  let back = 0;
  for (let k = 0; k < PACK_SIZE; k++) {
    if (restart) {
      spots.push({
        back: Math.floor(k / 2) * ROW_GAP + (rng.next() - 0.5) * 3,
        lane: (k % 2 === 0 ? -FILE_D : FILE_D) + (rng.next() - 0.5),
        speed: 36 + 6 * rng.next(), tire: 1,
      });
    } else {
      if (k > 0) back += rng.next() < 0.35 ? rng.next() * 3 : 6 + 14 * rng.next(); // alongside, or behind
      spots.push({ back, lane: -5 + 10 * rng.next(), speed: 32 + 10 * rng.next(), tire: 0.4 + 0.6 * rng.next() });
    }
  }
  return { frontS: restart ? track.length - 15 : rng.next() * track.length, spots };
}

export interface RacecraftResult {
  fitness: number;
  laps: number;
  bestLap: number;
  health: number;
  /** Damage done to others, by fault. */
  harm: number;
  /** Places gained (lost, if negative) on the pack by the end. */
  gained: number;
  /** Laps driven solo in the same round (the anchor). */
  soloLaps?: number;
  /** Seconds spent in danger of its own making. */
  danger: number;
}

/** A clean drill: no damage done to anyone, hardly any taken. */
export function cleanRacing(r: RacecraftResult): boolean {
  return r.harm < 0.02 && r.health >= 0.95;
}

/** One drill: the student in a grid slot of a pack at speed. */
export class RacecraftDrill implements Drill<RacecraftResult> {
  readonly world: World;
  readonly student: Car;
  private readonly startDist: number;
  private readonly startPlace: number;
  private steps = 0;
  private dangerSeconds = 0;
  private readonly seconds: number;
  /** The track's own pace (m/s): progress converts to seconds at it. */
  private readonly pace: number;
  /** Valid-lap scoring: the student's progress on spoilt laps is thrown away. */
  private readonly progress: ValidProgress | null;

  /**
   * pack(k): the weights the car in slot k drives with (the student's slot is ignored);
   * fear: how much fear and trauma cost this student (fearScale of its nerve).
   */
  constructor(
    track: Track, slot: number, student: Float32Array, pack: (k: number) => Float32Array, layout = restartLayout(track),
    private readonly fear = fearScale(),
    /**
     * Drill length (default the oval drill's 40 s), whether only valid laps count (road circuits), and what each
     * car's driver knows of road circuits (by slot, the student's own included; default the usual).
     */
    opts: { seconds?: number; validLaps?: boolean; pace?: number; knowledge?: (k: number) => TrackKnowledge | undefined } = {},
  ) {
    this.seconds = layout.seconds ?? opts.seconds ?? DRILL_SECONDS;
    this.pace = opts.pace ?? trackPace(track);
    this.world = new World(track, { collisions: true, drafting: true });
    for (let k = 0; k < layout.spots.length; k++) {
      const car = new Car(k);
      const spot = layout.spots[k];
      car.placeOnTrack(track, track.wrapS(layout.frontS - spot.back), spot.lane);
      car.vx = track.tx[car.trackIdx] * spot.speed;
      car.vy = track.ty[car.trackIdx] * spot.speed;
      car.tireLife = spot.tire;
      this.world.addCar(car, new Team(new NeuralDriver(k === slot ? student : pack(k), undefined, opts.knowledge?.(k)), new TowerSpotter(), null));
    }
    this.student = this.world.cars[slot];
    this.progress = opts.validLaps ? new ValidProgress(this.student) : null;
    this.startDist = this.student.dist;
    this.startPlace = this.place();
  }

  /** The student's place in the pack (0: leading). */
  private place(): number {
    return this.world.cars.filter((c) => c !== this.student && c.dist > this.student.dist).length;
  }

  get done(): boolean {
    return this.steps * P.DT >= this.seconds;
  }

  step(): void {
    if (this.done) return;
    this.world.step();
    this.steps++;
    this.progress?.step(this.world.track);
    if (this.steps % P.CONTROL_EVERY === 0) this.dangerSeconds += danger(this.student, this.world) * P.CONTROL_EVERY * P.DT;
  }

  result(): RacecraftResult {
    const car = this.student;
    const progress = car.dist - this.startDist - (this.progress?.thrownAway ?? 0);
    const laps = progress / this.world.track.length;
    // Seconds of race time, priced as race learning prices them (COSTS).
    return {
      fitness: progress / this.pace - COSTS.damage * (1 - car.health) - COSTS.harm * car.harmDone
        - this.fear * (COSTS.fear * this.dangerSeconds + COSTS.trauma * Math.max(0, car.selfTrauma - car.selfInflicted)),
      laps,
      bestLap: bestValidLap(car),
      health: car.health,
      harm: car.harmDone,
      gained: this.startPlace - this.place(),
      danger: this.dangerSeconds,
    };
  }
}

/**
 * One round: every candidate races its own drill from the same slot, in the
 * same pack (the class's current drivers, by slot), so the only difference
 * between a student's variations is the variation. Solo driving is held to
 * the student's own from before the class (DrillTrial's anchor).
 */
export class RacecraftTrial extends DrillTrial<RacecraftResult> {
  /**
   * candidates: per student, [own, +e1, -e1, ...]; classmates: each student's current weights;
   * nerves: each student's nerve (what fear costs it); references: each student as it drove
   * when the class began (default: its current self).
   */
  constructor(
    track: Track, candidates: Float32Array[], perStudent: number, slot: number, classmates: Float32Array[], show: number,
    layout = restartLayout(track), nerves: Array<number | undefined> = [], references: Float32Array[] = [],
  ) {
    const pack = classmates.map((w) => w.slice());
    super(candidates.map((g, i) => {
      const own = Math.floor(i / perStudent);
      // Slots around the student: the student's own racing and its classmates', in turn.
      return new RacecraftDrill(track, slot, g, (k) => pack[(own + k) % pack.length], layout, fearScale(nerves[own]));
    }), perStudent, show, candidates, { track, references: classmates.map((w, l) => references[l] ?? w) });
  }
}
