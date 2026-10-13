import { adaptWeights } from '../ai/drivers';
import {
  adamStep, centeredRanks, DEFAULT_ES, FULL_DAMAGE_PENALTY, LICENSE_HEALTH, rookieDamagePenalty, rookieDamageScale,
} from '../ai/es';
import { Trial, type TrialResult } from '../ai/evaluate';
import { genomeSize } from '../ai/network';
import { Rng } from '../ai/rng';
import { DRIVER_LAYERS } from '../ai/drivers';
import { StrokeCollector } from '../render/marks';
import type { TrackLayout } from '../sim/layout';
import { Track } from '../sim/track';
import { generateLayout, hashSeed } from '../trackgen';
import type { CarView, RadioLine, SessionSnapshot } from '../events/session';

/**
 * Driving school: a class of drivers taking a lesson, round after round, on
 * a track you can watch. Each round every student drives as a ghost
 * alongside slightly varied copies of itself (evolution strategies); when the
 * round ends each student moves toward the copies that did better. Same
 * training as headless practice, one visible track per round.
 */

export type LessonId = 'rookie' | 'variety';

export interface Lesson {
  id: LessonId;
  name: string;
  description: string;
  /** Who it's for. */
  forLicensed: boolean;
  /** Seconds per round, antithetic pairs per student, learning rate. */
  seconds: number;
  pairs: number;
  learningRate: number;
}

export const LESSONS: Record<LessonId, Lesson> = {
  rookie: {
    id: 'rookie', name: 'Rookie school', forLicensed: false, seconds: 80, pairs: 16, learningRate: 0.03,
    description: 'Learn to drive: solo laps with soft walls that harden over the first lessons. A license comes with clean laps on every preset track at full walls.',
  },
  variety: {
    id: 'variety', name: 'Track variety', forLicensed: true, seconds: 60, pairs: 8, learningRate: 0.01,
    description: 'A new generated oval every round, so drivers learn to handle tracks they have never seen.',
  },
};

export interface StudentSpec {
  /** Identifies the student's cars in snapshots (index in the class). */
  key: number;
  id: string;
  name: string;
  weights: Float32Array;
  rounds: number;
  licensed: boolean;
}

export interface ClassSpec {
  lesson: LessonId;
  students: StudentSpec[];
  /** The preset tracks (rookie school rotates through them and tests the license on them). */
  presets: TrackLayout[];
  seed: number;
}

/** One student's round. */
export interface RoundReport {
  key: number;
  id: string;
  weights: Float32Array;
  rounds: number;
  licensed: boolean;
  graduated: boolean;
  track: string;
  /** The student's own drive this round (not a variation). */
  fitness: number;
  laps: number;
  bestLap: number | null;
  health: number;
  /** Wall damage scale (1 = full). */
  walls: number;
  /** Variations that beat the student this round. */
  beaten: number;
  /** Tracks passed toward the license (rookie school). */
  passed: string[];
}

export interface SchoolView {
  lesson: LessonId;
  round: number;
  track: string;
  remaining: number;
  walls: number;
  students: Array<{ key: number; id: string; name: string; rounds: number; licensed: boolean; passed: string[]; last: RoundSummary | null }>;
}

/** A round's result without the weights (what the viewer shows). */
export type RoundSummary = Omit<RoundReport, 'weights'>;

interface Student extends StudentSpec {
  m: Float32Array;
  v: Float32Array;
  adamSteps: number;
  passed: Set<string>;
  last: RoundSummary | null;
}

export class Classroom {
  readonly lesson: Lesson;
  readonly students: Student[];
  round = 0;
  track!: Track;
  trial!: Trial;
  walls = 1;
  private readonly presets: Track[];
  private readonly rng: Rng;
  private readonly seed: number;
  private noise: Float32Array[][] = [];
  private reports: RoundReport[] = [];
  private radio: RadioLine[] = [];
  private timeOffset = 0;
  /** True when the track changed this round (the viewer needs the new layout). */
  trackChanged = true;
  readonly strokes = new StrokeCollector();
  collectStrokes = false;

  constructor(spec: ClassSpec) {
    this.lesson = LESSONS[spec.lesson];
    this.presets = spec.presets.map((l) => new Track(l));
    this.seed = spec.seed;
    this.rng = new Rng(spec.seed);
    const size = genomeSize(DRIVER_LAYERS);
    this.students = spec.students.map((s) => ({
      ...s, weights: adaptWeights(s.weights).slice(), m: new Float32Array(size), v: new Float32Array(size), adamSteps: 0,
      passed: new Set<string>(), last: null,
    }));
    this.startRound();
  }

  /** Rookie school ends when everyone holds a license; other lessons run until stopped. */
  get finished(): boolean {
    return this.lesson.id === 'rookie' && this.students.every((s) => s.licensed);
  }

  /** Total simulated time across rounds. */
  get time(): number {
    return this.timeOffset + this.trial.world.time;
  }

  step(): void {
    if (this.finished) return;
    this.trial.step();
    if (this.collectStrokes) {
      // Only each student's own car marks the track; the variations would paint it black.
      const per = 1 + 2 * this.lesson.pairs;
      this.strokes.collect(this.trial.world.cars.filter((c) => c.id % per === 0));
    }
    if (this.trial.done) {
      this.finishRound();
      if (!this.finished) this.startRound();
    }
  }

  takeReports(): RoundReport[] {
    const out = this.reports;
    this.reports = [];
    return out;
  }

  takeRadio(): RadioLine[] {
    const out = this.radio;
    this.radio = [];
    return out;
  }

  private startRound(): void {
    const lesson = this.lesson;
    const prevTrack = this.track;
    if (lesson.id === 'rookie') {
      this.track = this.presets[this.round % this.presets.length];
      // One world, so one wall softness: the class's average experience sets it.
      const lessons = this.students.reduce((a, s) => a + s.rounds, 0) / this.students.length;
      this.walls = rookieDamageScale(lessons, DEFAULT_ES.curriculumRounds);
    } else {
      this.track = new Track(generateLayout({ type: 'oval', seed: hashSeed(this.seed, `round${this.round}`) }));
      this.walls = 1;
    }
    this.trackChanged = this.track !== prevTrack;
    const size = genomeSize(DRIVER_LAYERS);
    const sigma = DEFAULT_ES.sigma;
    const candidates: Float32Array[] = [];
    this.noise = [];
    for (const s of this.students) {
      candidates.push(s.weights);
      const eps: Float32Array[] = [];
      for (let p = 0; p < lesson.pairs; p++) {
        const e = new Float32Array(size);
        for (let i = 0; i < size; i++) e[i] = this.rng.gaussian();
        eps.push(e);
        const plus = new Float32Array(size), minus = new Float32Array(size);
        for (let i = 0; i < size; i++) {
          plus[i] = s.weights[i] + sigma * e[i];
          minus[i] = s.weights[i] - sigma * e[i];
        }
        candidates.push(plus, minus);
      }
      this.noise.push(eps);
    }
    const lessons = this.students.reduce((a, s) => a + s.rounds, 0) / this.students.length;
    this.trial = new Trial(this.track, candidates, {
      seconds: lesson.seconds,
      damageScale: this.walls,
      damagePenaltyLaps: lesson.id === 'rookie' ? rookieDamagePenalty(lessons, DEFAULT_ES.curriculumRounds) : FULL_DAMAGE_PENALTY,
    });
    this.strokes.reset();
  }

  private finishRound(): void {
    const results = this.trial.results();
    const per = 1 + 2 * this.lesson.pairs;
    const sigma = DEFAULT_ES.sigma;
    const size = genomeSize(DRIVER_LAYERS);
    this.students.forEach((s, l) => {
      const base = l * per;
      const own: TrialResult = results[base];
      const fits = Array.from({ length: 2 * this.lesson.pairs }, (_, k) => results[base + 1 + k].fitness);
      const ranks = centeredRanks(fits);
      const grad = new Float32Array(size);
      for (let p = 0; p < this.lesson.pairs; p++) {
        const w = ranks[2 * p] - ranks[2 * p + 1];
        const e = this.noise[l][p];
        for (let i = 0; i < size; i++) grad[i] += w * e[i];
      }
      s.rounds++;
      adamStep(s, grad, 1 / (2 * this.lesson.pairs * sigma), this.lesson.learningRate, DEFAULT_ES.weightDecay);

      // The license test: a clean lap at full walls on each preset track.
      let graduated = false;
      if (!s.licensed && this.lesson.id === 'rookie' && this.walls >= 1 && own.laps >= 1 && own.health >= LICENSE_HEALTH) {
        if (!s.passed.has(this.track.name)) {
          s.passed.add(this.track.name);
          this.say(`${s.name} passed the ${this.track.name} test (${s.passed.size} of ${this.presets.length})`);
        }
        if (s.passed.size === this.presets.length) {
          s.licensed = true;
          graduated = true;
          this.say(`${s.name} earned a license after ${s.rounds} lessons`);
        }
      }
      const report: RoundReport = {
        key: s.key, id: s.id, weights: s.weights.slice(), rounds: s.rounds, licensed: s.licensed, graduated,
        track: this.track.name, fitness: own.fitness, laps: own.laps,
        bestLap: Number.isFinite(own.bestLap) ? own.bestLap : null, health: own.health, walls: this.walls,
        beaten: fits.filter((f) => f > own.fitness).length, passed: [...s.passed],
      };
      // The report's weights are handed to the page (transferred, not copied), so the view keeps a copy without them.
      const { weights: _w, ...summary } = report;
      s.last = summary;
      this.reports.push(report);
    });
    this.timeOffset += this.trial.world.time;
    this.round++;
  }

  private say(text: string): void {
    this.radio.push({ time: this.time, key: null, text });
  }

  /** What the viewer draws: every student's car solid, its variations faint. */
  snapshot(): SessionSnapshot & { school: SchoolView } {
    const per = 1 + 2 * this.lesson.pairs;
    const cars: CarView[] = this.trial.world.cars.map((car) => {
      const student = this.students[Math.floor(car.id / per)];
      return {
        id: car.id, key: student.key, variant: car.id % per !== 0,
        x: car.x, y: car.y, s: car.s, d: car.d, dist: car.dist, speed: car.speed, color: car.color,
        retired: car.retired, cleared: car.cleared, towed: car.towed, parked: car.parked, finished: false,
        inputX: car.inputX, inputY: car.inputY, frameX: car.frameX, frameY: car.frameY, trackIdx: car.trackIdx,
        tireLon: car.tireLon, tireLat: car.tireLat, tireUse: car.tireUse, capacity: car.capacity,
        bank: car.bank, bankAcc: car.bankAcc, normalAcc: car.normalAcc,
        surface: car.surface, groove: car.groove, skid: car.skid,
        tireLife: car.tireLife, fuel: car.fuel, health: car.health,
        pitPhase: car.pit.phase, pitTimer: car.pit.timer, stops: car.pit.stops,
        laps: car.lapsCompleted, bestLap: car.lapTimes.length ? Math.min(...car.lapTimes) : null,
      };
    });
    // Students first (by distance), then their variations.
    const order = [...cars].sort((a, b) => Number(a.variant) - Number(b.variant) || b.dist - a.dist).map((c) => c.id);
    return {
      time: this.time, cars, order, standings: null, race: null, technique: [],
      school: {
        lesson: this.lesson.id, round: this.round, track: this.track.name, remaining: this.trial.remaining, walls: this.walls,
        students: this.students.map((s) => ({
          key: s.key, id: s.id, name: s.name, rounds: s.rounds, licensed: s.licensed, passed: [...s.passed], last: s.last,
        })),
      },
    };
  }
}
