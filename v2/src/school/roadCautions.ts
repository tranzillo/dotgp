/**
 * Road circuits' cautions for the stable: formation laps and safety cars,
 * learned by each driver's own road caution network (a network of its own,
 * so cautions on circuits can't cost it its oval ones), in classroom races
 * on circuits: the students seated among their personalities' road teachers,
 * under the circuit rules (formation lap, standing start, the safety car),
 * with debris safety cars so every race has a few. As on ovals: the teacher
 * drives the first round (the students watch), then the students drive
 * (DAgger) through their human limits, their teachers saying what they'd do
 * from where the car is; and the caution network keeps racing too (half its
 * examples are racing moments: it takes the wheel the moment the safety car
 * is called, often mid-corner at racing speed).
 */
import { CAUTION_FROM, DRIVER_LAYERS } from '../ai/drivers';
import { type Example, trainSupervised } from '../ai/network';
import { Rng } from '../ai/rng';
import { hashSeed } from '../trackgen';
import { classroomRace } from './classroomRace';
import type { Driving } from './recorder';
import { circuitTrack } from './roadLesson';

export { roadTeacherOf } from './classroomRace';

/** A stable driver as far as road cautions go: who it is, its road skill, and its road caution skill (once it has one). */
export interface RoadCautionStudent {
  lineage: number;
  nerve: number;
  talent: number;
  limits: { latency: number; noise: number };
  /** Its oval skill (the driver's main network) and its road skill. */
  weights: Float32Array;
  road: Float32Array;
  roadCaution: Float32Array | null;
}

export interface RoadCautionOptions {
  rounds?: number;
  /** Cars in each classroom race (students and teachers). */
  field?: number;
  laps?: number;
  /** Debris safety cars per lap (so every race has a few). */
  debris?: number;
  /**
   * Start drills per round: the end of the formation lap, the grid and the lights, then a few seconds of racing.
   * A race has one formation lap, and stopping in the grid box takes precision (overshoot it and the car can't
   * back into it): students given one grid stop a round overshot and parked, or crawled round again.
   */
  starts?: number;
  epochs?: number;
  /** Moments trained on per student per round (a fresh sample of everything recorded so far). */
  maxExamples?: number;
  onRound?: (round: number, report: { track: string; loss: number; pacing: number; out: number; safetyCars: number; seconds: number }) => void;
}

/** Seconds of racing after the lights in a start drill. */
const AFTER_START = 8;

/**
 * Teach a group of stable drivers road cautions (their road caution networks, trained in place; a network starts
 * as a copy of the road skill): each round a classroom race on a new circuit, then training on a sample of the
 * pacing moments recorded so far and, as many again, racing moments.
 */
export function apprenticeRoadCautions(students: RoadCautionStudent[], seed: number, options: RoadCautionOptions = {}): void {
  const opts = { rounds: 8, field: 20, laps: 6, debris: 0.3, starts: 6, epochs: 4, maxExamples: 40_000, ...options };
  const rng = new Rng(hashSeed(seed, 'road-cautions'));
  const examples: Example[][] = students.map(() => []);
  for (const d of students) d.roadCaution ??= d.road.slice();
  for (let round = 0; round < opts.rounds; round++) {
    const t0 = Date.now();
    const track = circuitTrack(hashSeed(seed, `circuit${round}`), round % 2 ? 'gp' : 'club');
    const driving: Driving = round === 0 ? { kind: 'teacher' } : { kind: 'student' };
    const race = { field: opts.field, laps: opts.laps, debris: opts.debris };
    const { out, cautions: safetyCars } = classroomRace(track, students, driving, examples, rng, race, round, seed);
    for (let k = 0; k < opts.starts; k++) {
      const where = circuitTrack(hashSeed(seed, `start${round}:${k}`), k % 2 ? 'gp' : 'club');
      classroomRace(where, students, driving, examples, rng, { ...race, startOnly: AFTER_START }, round * 100 + k + 1, seed);
    }
    const half = Math.floor(opts.maxExamples / 2);
    const pick = (all: Example[], n: number) => (all.length <= n ? all : sample(all, n, rng));
    let loss = 0, pacing = 0;
    students.forEach((d, s) => {
      const caution = examples[s].filter((e) => e.x[CAUTION_FROM] !== 0), racing = examples[s].filter((e) => e.x[CAUTION_FROM] === 0);
      pacing += caution.length;
      if (!caution.length) return;
      loss += trainSupervised(DRIVER_LAYERS, d.roadCaution!, [...pick(caution, half), ...pick(racing, half)],
        round === 0 ? 3 * opts.epochs : opts.epochs, 0.01, () => rng.next());
    });
    opts.onRound?.(round, { track: `${track.length.toFixed(0)} m`, loss: loss / students.length, pacing, out, safetyCars, seconds: (Date.now() - t0) / 1000 });
  }
}

/** n of the items, drawn at random without replacement. */
function sample<T>(items: T[], n: number, rng: Rng): T[] {
  const pool = items.slice();
  for (let i = 0; i < n; i++) {
    const j = i + rng.int(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
