/**
 * Car mastery, the first part: a broken car (the second damage model, src/sim/damage.ts: past half health the engine
 * and the aero go, the grip stays). The teacher gets a broken car off the line and along the apron (brokenRoute, the
 * route the student is shown as its line), moving down only with its mirrors clear below (spotter.ts MIRROR) and
 * keeping clear of the pit wall. A learned driver had never seen its own damage (its networks predate the input), so
 * a broken car of theirs stayed on the line at a fraction of the field's speed, and the field ran into it
 * (2026-10-25: nearly all the house drivers' wrecks under the second model).
 *
 * The drills: a pack of individual traffic racers on an oval, racing; the student among them; at a random moment its
 * car breaks (health anywhere from just broken to barely moving), and it has the rest of the drill to get it out of
 * the way. The teacher drives the first round (the student watches); then the student drives (DAgger), its teacher
 * saying at every decision what it would do from where the car is. Broken moments only come from a race's own
 * damage otherwise: 1-6% of a classroom race's, and six rounds of those taught nothing (2026-10-25).
 *
 * A network of its own (the broken-car skill, NeuralDriverExtras.broken) learns it, starting as a copy of the
 * racing one, so it can't cost a driver its racing. It drives only a broken car, so it trains on broken moments
 * alone by default: racing moments (the car on its line) told it the opposite of what a broken car does, from
 * nearly the same inputs.
 */
import { DAMAGE_FROM, DRIVER_LAYERS, NeuralDriver, Team, type DriverLimits } from '../ai/drivers';
import { type Example, trainSupervised } from '../ai/network';
import type { TrackKnowledge } from '../ai/observe';
import { Rng } from '../ai/rng';
import { MIRROR, MIRROR_SIZE, MIRROR_TIME, mirrorView, TowerSpotter } from '../ai/spotter';
import { followLine } from '../ai/lineFollower';
import { brokenRoute } from '../ai/observe';
import { racerStyle, TrafficRacer } from '../ai/trafficRacer';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { compromise, DAMAGE2 } from '../sim/damage';
import { placeOnGrid } from '../sim/grid';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { hashSeed, presetTrack } from '../trackgen';
import { apprenticeTrack, soloDrives, teacherOf } from './ovalApprentice';
import { Recorder } from './recorder';

/** A driver as far as a broken car goes: who it is (its teacher), its skills, its line and its human limits. */
export interface BrokenStudent {
  lineage: number;
  nerve: number;
  talent: number;
  limits?: { latency: number; noise: number };
  knowledge?: TrackKnowledge;
  weights: Float32Array;
  caution?: Float32Array;
  pit?: Float32Array;
  /** The broken-car skill, once it has one. */
  broken: Float32Array | null;
  /** Its tactics (its lane plan racing), if it has them. */
  tactics?: Float32Array;
}

export interface BrokenSkillOptions {
  rounds?: number;
  /** Ovals per round, and drills on each. */
  tracks?: number;
  drills?: number;
  /** Cars in a drill's pack, the student's among them. */
  field?: number;
  epochs?: number;
  maxExamples?: number;
  /** Share of a round's training moments that are racing ones (the rest: broken). Default none. */
  racingShare?: number;
  /**
   * Drills per track where a car ahead of the student breaks (the field's side: going round it), which teach its
   * racing network: their moments, all of them racing in a pack, train it (none by default). Students hit the broken
   * car in a fifth of these drills, their teachers in one in a hundred (2026-10-25). Half its training is solo drives
   * on the round's tracks: on pack moments alone it forgot driving alone (a stable fresh from solo drives on many ovals
   * went back to riding the outside wall of an unseen one, health lost solo 0.14 -> 0.57, 2026-10-26).
   */
  ahead?: number;
  onRound?: (round: number, report: BrokenReport & { loss: number; seconds: number; ahead: BrokenReport; racingLoss: number }) => void;
}

/** How drills went: how many, how many got the car to the apron (and how fast), and what it cost. */
export interface BrokenReport {
  drills: number;
  apron: number;
  /** Median seconds from the break to the apron, over the drills that got there. */
  toApron: number;
  /** Damaging contacts the broken car was in, and health lost by every car in the pack. */
  hits: number;
  harm: number;
  /** Drills where the broken car stood still on the racing surface (STALL_SECONDS or more). */
  stalls: number;
}

/** Seconds of racing before the break (a range), and of the drill after it. */
const SETTLE = [15, 40] as const;
const AFTER = 30;
/** The health a drill breaks the car to: just broken, down to barely moving. */
const HEALTH = [0.02, DAMAGE2.SOUND_ABOVE - 0.01] as const;
/** A car under this speed (m/s) on the racing surface is standing still in the field's way ... */
const STALL_SPEED = 3;
/** ... and this long (s) is a stall. */
const STALL_SECONDS = 3;

interface DrillResult { apronAt: number; hits: number; harm: number; stalled: boolean; out: boolean }

/**
 * The teacher that labels: the student's own traffic racer (teacherOf), reacting to flags at once, racing; broken, a
 * line follower down the route the student sees (brokenRoute, as its track knowledge), holding its lane while its
 * mirrors show a car coming fast below it, and its throttle in proportion (copyable, as the pit maneuver's is). The
 * racer's own way off the line (an offset from the racing line, crossing at its own rate) was hard to copy: students
 * explained under two thirds of its steering, and drifted back up the track out of the corners.
 */
class BrokenTeacher {
  private readonly racer: TrafficRacer;
  private readonly mirror = new Float32Array(MIRROR_SIZE);
  constructor(d: BrokenStudent) {
    const { style, traits } = teacherOf(d);
    this.racer = new TrafficRacer(style, undefined, { ...traits, reaction: 0 });
  }
  takeOver(car: Car, world: World): void { this.racer.takeOver?.(car, world); }
  /** Its lane plan: the racer's (a broken car's moments aren't the racing skill's). */
  get intent(): number { return this.racer.intent; }
  decide(car: Car, world: World): void {
    if (compromise(car) === 0 || world.track.kind === 'road') { this.racer.decide(car, world); return; }
    const route = brokenRoute(world.track);
    const hold = mirrorView(car, world, this.mirror)[MIRROR.LOW] > 1 - TEACHER_CLEAR / MIRROR_TIME;
    followLine(car, world, (s) => (hold ? Math.min(route(s), car.d) : route(s)), () => Infinity, 0.85, false, TEACHER_DRIVE_GAIN);
  }
}
/** A broken car moves down only with nothing arriving below it within this (s) ... */
const TEACHER_CLEAR = 2.5;
/** ... and its throttle is in proportion (1/s; the pit maneuver's teaching gain). */
const TEACHER_DRIVE_GAIN = 4;
const teacher = (d: BrokenStudent) => new BrokenTeacher(d);

/**
 * One drill on a track: the pack racing, the student's car among them breaking to `health` after a while (`breaks`
 * 'own'), or a car one to three places ahead of it ('ahead': the field's side of a broken car, going round it). Who
 * drives the student's car: its teacher (watching), or the student (its broken-car skill once broken). Moments are
 * recorded to `examples` when given. Hits are the student's car's; the apron and stalls, the broken car's.
 */
export function brokenDrill(
  track: Track, d: BrokenStudent, studentDrives: boolean, health: number, seed: number, examples: Example[] | null, field = 12,
  breaks: 'own' | 'ahead' = 'own',
): DrillResult {
  const rng = new Rng(seed);
  const world = new World(track, { collisions: true, drafting: true });
  const slot = 2 + rng.int(field - 2); // somewhere in the pack, never at its head
  let me: Car | null = null;
  for (let k = 0; k < field; k++) {
    const car = new Car(k);
    placeOnGrid(car, track, k, true);
    if (k === slot) {
      const limits: DriverLimits | undefined = d.limits && { ...d.limits, seed: (seed * 7919) >>> 0 };
      const student = new NeuralDriver(d.weights, undefined, d.knowledge, { limits, caution: d.caution, pit: d.pit, broken: d.broken ?? undefined, tactics: d.tactics });
      const team = new Team(student, new TowerSpotter(), null, false, true);
      world.addCar(car, examples
        ? new Recorder(team, student, teacher(d), { kind: studentDrives ? 'student' : 'teacher' }, examples, rng, { latency: d.limits?.latency })
        : studentDrives ? team : new Team(teacher(d), new TowerSpotter(), null, false, true));
      me = car;
      continue;
    }
    const who = new Rng(hashSeed(seed, `pack${k}`));
    const { style, traits } = racerStyle(0.15 + 0.7 * who.next(), who.next(), () => who.next());
    world.addCar(car, new Team(new TrafficRacer(style, undefined, traits), new TowerSpotter(), null, false, true));
  }
  const mine = me!;
  const settle = SETTLE[0] + (SETTLE[1] - SETTLE[0]) * rng.next();
  for (let t = 0; t < settle && !mine.retired; t += P.DT) world.step();
  const order = world.cars.filter((c) => !c.retired).sort((a, b) => b.dist - a.dist);
  const ahead = order[order.indexOf(mine) - 1 - rng.int(3)];
  const car = breaks === 'ahead' && ahead ? ahead : mine; // the car that breaks
  car.health = Math.min(car.health, health);
  const before = world.cars.map((c) => c.health);
  const result: DrillResult = { apronAt: -1, hits: 0, harm: 0, stalled: false, out: false };
  let still = 0;
  for (let t = 0; t < AFTER && !car.retired; t += P.DT) {
    const h = world.cars.map((c) => c.health);
    world.step();
    world.cars.forEach((c, k) => {
      if (h[k] - c.health > 1e-4 && c.lastImpact?.kind === 'car' && (c === mine || c.lastImpact.other === mine.id)) result.hits++;
    });
    const onTrack = car.d <= track.innerEdge(car.trackIdx);
    if (result.apronAt < 0 && !onTrack) result.apronAt = t;
    still = onTrack && car.speed < STALL_SPEED ? still + P.DT : 0;
    if (still >= STALL_SECONDS) result.stalled = true;
  }
  // (The broken car's own health was set by the drill, not lost: only what it lost after counts.)
  result.harm = world.cars.reduce((a, c, k) => a + Math.max(0, before[k] - c.health), 0);
  result.out = mine.retired;
  return result;
}

/** Drills' results, summed. */
function report(results: DrillResult[]): BrokenReport {
  const times = results.filter((r) => r.apronAt >= 0).map((r) => r.apronAt).sort((a, b) => a - b);
  return {
    drills: results.length, apron: times.length, toApron: times.length ? times[times.length >> 1] : NaN,
    hits: results.reduce((a, r) => a + r.hits, 0), harm: results.reduce((a, r) => a + r.harm, 0), stalls: results.filter((r) => r.stalled).length,
  };
}

/** Teach a group their broken-car skill (networks trained in place; a new one starts as a copy of the racing one). */
export function apprenticeBrokenCar(students: BrokenStudent[], seed: number, options: BrokenSkillOptions = {}): void {
  const opts = { rounds: 6, tracks: 2, drills: 4, field: 12, epochs: 6, maxExamples: 40_000, racingShare: 0, ahead: 0, ...options };
  const rng = new Rng(hashSeed(seed, 'broken-car'));
  const broken: Example[][] = students.map(() => []), racing: Example[][] = students.map(() => []);
  const field: Example[][] = students.map(() => []), alone: Example[][] = students.map(() => []);
  // The students as the apprenticeship's solo drives take them (their racing network drives).
  const soloists = students.map((d) => ({ ...d, limits: d.limits ?? { latency: 0.15, noise: 0.05 }, caution: d.caution ?? null }));
  for (const d of students) d.broken ??= d.weights.slice();
  for (let round = 0; round < opts.rounds; round++) {
    const t0 = Date.now();
    const tracks = Array.from({ length: opts.tracks }, (_, k) => apprenticeTrack(round * opts.tracks + k, seed));
    const results: DrillResult[] = [], aheads: DrillResult[] = [];
    if (opts.ahead > 0) for (const track of tracks) soloDrives(track, soloists, round > 0 ? { kind: 'student' } : { kind: 'teacher' }, alone, rng, round, seed);
    students.forEach((d, i) => {
      for (const track of tracks) {
        for (let k = 0; k < opts.ahead; k++) {
          const health = HEALTH[0] + (HEALTH[1] - HEALTH[0]) * rng.next();
          aheads.push(brokenDrill(track, d, round > 0, health, hashSeed(seed, `ahead${round}:${d.lineage}:${track.length}:${k}`), field[i], opts.field, 'ahead'));
        }
        for (let k = 0; k < opts.drills; k++) {
          const health = HEALTH[0] + (HEALTH[1] - HEALTH[0]) * rng.next();
          const recorded: Example[] = [];
          results.push(brokenDrill(track, d, round > 0, health, hashSeed(seed, `broken${round}:${d.lineage}:${track.length}:${k}`), recorded, opts.field));
          for (const e of recorded) (e.x[DAMAGE_FROM] > 0 ? broken[i] : racing[i]).push(e);
        }
      }
    });
    let loss = 0, racingLoss = 0;
    students.forEach((d, i) => {
      const nRacing = Math.min(racing[i].length, Math.round(opts.maxExamples * opts.racingShare));
      const set = [...pick(broken[i], opts.maxExamples - nRacing, rng), ...pick(racing[i], nRacing, rng)];
      loss += trainFinite(d.broken!, set, round === 0 ? 3 * opts.epochs : opts.epochs, rng);
      const half = Math.floor(opts.maxExamples / 2);
      if (field[i].length) racingLoss += trainFinite(d.weights, [...pick(field[i], half, rng), ...pick(alone[i], half, rng)], round === 0 ? 3 * opts.epochs : opts.epochs, rng);
    });
    opts.onRound?.(round, {
      ...report(results), loss: loss / students.length, seconds: (Date.now() - t0) / 1000, ahead: report(aheads), racingLoss: racingLoss / students.length,
    });
  }
}

/**
 * The broken-car licence: on each preset oval, broken just past the limit and broken to a crawl, the student (its
 * broken-car skill) gets its car to the apron within LICENCE_APRON s, in contact with nobody, never standing on the
 * racing surface. Its racing can't have changed (the skill is a network of its own). (`byTeacher`: its teacher drives
 * the same drills, the test's own check.)
 */
export function brokenCarTest(d: BrokenStudent, seed = 1, byTeacher = false): { passed: boolean; report: BrokenReport } {
  const results: DrillResult[] = [];
  for (const name of ['short', 'speedway', 'flat'] as const) {
    for (const health of [0.4, 0.1]) results.push(brokenDrill(presetTrack(name), d, !byTeacher, health, hashSeed(seed, `licence:${d.lineage}:${name}:${health}`), null));
  }
  const passed = results.every((r) => r.apronAt >= 0 && r.apronAt <= LICENCE_APRON && r.hits === 0 && !r.stalled && !r.out);
  return { passed, report: report(results) };
}
export const LICENCE_APRON = 12;

/** Train in place, unless the step leaves any weight non-finite: then the weights are as they were. */
function trainFinite(weights: Float32Array, data: Example[], epochs: number, rng: Rng): number {
  if (!data.length) return NaN;
  const before = weights.slice();
  const loss = trainSupervised(DRIVER_LAYERS, weights, data, epochs, 0.01, () => rng.next());
  if (Number.isFinite(loss) && weights.every(Number.isFinite)) return loss;
  weights.set(before);
  return NaN;
}

/** n of the items (all of them if fewer), drawn at random without replacement. */
function pick<T>(items: T[], n: number, rng: Rng): T[] {
  if (items.length <= n) return items;
  const pool = items.slice();
  for (let i = 0; i < n; i++) {
    const j = i + rng.int(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
