import { NeuralDriver, Team } from '../ai/drivers';
import { FULL_DAMAGE_PENALTY } from '../ai/es';
import { danger, fearScale } from '../ai/fear';
import { Trial } from '../ai/evaluate';
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
/** A drill's pack: where on the track its front starts, and each car's spot. */
export interface PackLayout { frontS: number; spots: PackSpot[] }

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
/**
 * Laps of score per unit of damage taken, and done to others. Heavier than
 * practice's: in a race a wreck costs far more than the distance it loses
 * (often the race), and cheap contact made faster but dirtier drivers win.
 */
const DAMAGE_PENALTY = 8;
const HARM_PENALTY = 8;
/**
 * Fear and trauma, for a driver of middling nerve (scaled by fearScale):
 * laps of score per second spent in danger of its own making (about a
 * second of lap time per second, as in race learning), and per unit of
 * trauma beyond the damage itself. Crashes are rare enough in a 40 s drill
 * that scoring them alone is mostly luck; danger is there every drill.
 */
const FEAR_LAPS = 0.03;
const TRAUMA_LAPS = 8;

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

  /**
   * pack(k): the weights the car in slot k drives with (the student's slot is ignored);
   * fear: how much fear and trauma cost this student (fearScale of its nerve).
   */
  constructor(
    track: Track, slot: number, student: Float32Array, pack: (k: number) => Float32Array, layout = restartLayout(track),
    private readonly fear = fearScale(),
  ) {
    this.world = new World(track, { collisions: true, drafting: true });
    for (let k = 0; k < PACK_SIZE; k++) {
      const car = new Car(k);
      const spot = layout.spots[k];
      car.placeOnTrack(track, track.wrapS(layout.frontS - spot.back), spot.lane);
      car.vx = track.tx[car.trackIdx] * spot.speed;
      car.vy = track.ty[car.trackIdx] * spot.speed;
      car.tireLife = spot.tire;
      this.world.addCar(car, new Team(new NeuralDriver(k === slot ? student : pack(k)), new TowerSpotter(), null));
    }
    this.student = this.world.cars[slot];
    this.startDist = this.student.dist;
    this.startPlace = this.place();
  }

  /** The student's place in the pack (0: leading). */
  private place(): number {
    return this.world.cars.filter((c) => c !== this.student && c.dist > this.student.dist).length;
  }

  get done(): boolean {
    return this.steps * P.DT >= DRILL_SECONDS;
  }

  step(): void {
    if (this.done) return;
    this.world.step();
    this.steps++;
    if (this.steps % P.CONTROL_EVERY === 0) this.dangerSeconds += danger(this.student, this.world) * P.CONTROL_EVERY * P.DT;
  }

  result(): RacecraftResult {
    const car = this.student;
    const laps = (car.dist - this.startDist) / this.world.track.length;
    return {
      fitness: laps - DAMAGE_PENALTY * (1 - car.health) - HARM_PENALTY * car.harmDone
        - this.fear * (FEAR_LAPS * this.dangerSeconds + TRAUMA_LAPS * Math.max(0, car.selfTrauma - car.selfInflicted)),
      laps,
      bestLap: car.lapTimes.length ? Math.min(...car.lapTimes) : Infinity,
      health: car.health,
      harm: car.harmDone,
      gained: this.startPlace - this.place(),
      danger: this.dangerSeconds,
    };
  }
}

/** Seconds of solo laps every candidate also drives, as in practice. */
const SOLO_SECONDS = 60;
/** Laps of score per solo lap lost against the student's own (losing pace costs double). */
const SOLO_PACE = 2;

/**
 * One round: every candidate races its own drill from the same slot, in the
 * same pack (the class's current drivers, by slot), so the only difference
 * between a student's variations is the variation. Every candidate also
 * drives solo laps (ghosts, as in practice), and a variation that drives
 * them worse than the student does now is charged the difference: the drill
 * alone only measures packs, and variations that drove cleaner there while
 * losing their way round the track on their own won out (in races: more
 * wrecks, not fewer). Going faster solo earns nothing here, so the lesson
 * teaches clean racing rather than speed (a faster pack hits harder).
 */
export class RacecraftTrial extends DrillTrial<RacecraftResult> {
  private readonly solo: Trial;
  private readonly perStudent: number;
  private readonly candidates: number;

  /**
   * candidates: per student, [own, +e1, -e1, ...]; classmates: each student's current weights;
   * nerves: each student's nerve (what fear costs it); references: each student as it drove
   * when the class began (its solo pace is held to that; default: its current self).
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
    }), perStudent, show);
    this.perStudent = perStudent;
    this.candidates = candidates.length;
    // The references drive the same solo laps, after the candidates.
    const refs = classmates.map((w, l) => references[l] ?? w);
    this.solo = new Trial(track, [...candidates, ...refs], { seconds: SOLO_SECONDS, damagePenaltyLaps: FULL_DAMAGE_PENALTY });
  }

  override get done(): boolean {
    return super.done && this.solo.done;
  }

  override step(): void {
    super.step();
    this.solo.step();
  }

  /**
   * The drill's result, less any solo driving lost against the student as it
   * drove when the class began: pace (laps) and cleanliness (damage) each on
   * their own. Compared as one score, a much slower variation that avoided a
   * scrape looked no worse; compared with the student's current self, small
   * losses slipped through round after round. Either way drivers drifted
   * slow, and one slow car in a 24-car field gets rear-ended all race.
   */
  override results(): RacecraftResult[] {
    const solo = this.solo.results();
    return super.results().map((r, i) => {
      const own = solo[this.candidates + Math.floor(i / this.perStudent)], mine = solo[i];
      const lostPace = Math.max(0, own.laps - mine.laps);
      const extraDamage = Math.max(0, own.health - mine.health);
      return { ...r, fitness: r.fitness - SOLO_PACE * lostPace - FULL_DAMAGE_PENALTY * extraDamage, soloLaps: mine.laps };
    });
  }
}
