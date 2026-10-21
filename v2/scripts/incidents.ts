/**
 * Race benchmark: full races under race control, measuring what we tune.
 *
 *   wrecks   retirements, cautions, and chains (retirements within CHAIN_WINDOW
 *            of the first), labelled by what was happening when each car went out
 *   tires    wear per green lap, laps to the cliff, stops, how often tires were
 *            taken, tire life at the stop, lap time by tire life (green laps only)
 *   fuel     burn per lap and laps per tank
 *   marks    how much of the racing surface the groove and skids have darkened,
 *            using the renderer's own deposit rules (render/marks.ts)
 *
 *   pack     green-flag racing in traffic: passes, time side by side and in the
 *            draft, how spread the field is across the track, and lockstep (how
 *            alike neighbouring cars' control changes are, for the same brain and
 *            for different brains: a field of copies moves as one)
 *
 *   npx tsx scripts/incidents.ts [drivers.json] --tracks speedway,short --seeds 2 --field 24 --pace 4 [--laps N] [--marks 0]
 *     [--seed-start 1] [--json out.json]   (scripts/bench.ts runs many of these in parallel and adds error bars)
 *     tracks: the presets (speedway, short, flat) or generated ovals, oval:<seed>[:<variant>[:<shape>]]
 *     [--mix B.json --swap 0|1]   a mixed field: alternate grid slots from the two files (--swap 1 trades the slots),
 *                                 for head to head (each side's mean finishing place, retirements, damage done)
 *     [--limits lo:hi,lo:hi]   human limits for every car (drawn per car): latency (s) and motor noise ranges, e.g. 0.1:0.2,0.02:0.08;
 *                              without it, a driver with `limits` in its file has its own, and the rest none
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { adaptWeights, neuralTeam, Team } from '../src/ai/drivers';
import { TowerSpotter } from '../src/ai/spotter';
import { DEFAULT_STYLE, racerStyle, type RacerStyle, TrafficRacer } from '../src/ai/trafficRacer';
import { hashSeed } from '../src/trackgen/generator';

/** teacher:styles fields this many individual racers. */
const STYLED_RACERS = 40;
import { PaceCarDriver } from '../src/ai/formation';
import { randomTraits, StrategistCrewChief } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import { GROOVE_DISPLAY_ALPHA, GROOVE_STROKE_ALPHA, GROOVE_WIDTH, grooveChance, skidStroke } from '../src/render/marks';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { placeOnGrid } from '../src/sim/grid';
import { Race } from '../src/sim/race';
import { Track } from '../src/sim/track';
import { FLAT_TRACK, generateLayout, type OvalShape, ovalTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';
import { World } from '../src/sim/world';
import { OVAL_RULES } from '../src/rules/rulebook';

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
}
const driversFile = positional[0] ?? 'public/drivers/default.json';
const specs = { speedway: SPEEDWAY, short: SHORT_TRACK, flat: FLAT_TRACK } as const;
const trackNames = (args.get('tracks') ?? 'speedway,short').split(',');
const seeds = Number(args.get('seeds') ?? 2);
const seedStart = Number(args.get('seed-start') ?? 1);
const jsonOut = args.get('json');
const fieldSize = Number(args.get('field') ?? 24);
const pace = Number(args.get('pace') ?? 4);
const lapsArg = args.get('laps');
const measureMarks = args.get('marks') !== '0';
/** Run the races to the oval rulebook, with stewards. */
const withRules = args.get('rules') === '1';

/** Retirements this close together (s) count as one incident. */
const CHAIN_WINDOW = 12;
/** A retirement this soon after a green flag is a start/restart wreck. */
const RESTART_WINDOW = 20;
const MARK_CELL = 0.5; // m
const TIRE_BANDS = [1, 0.8, 0.6, 0.4, 0.3, 0.2, 0];

/** Drivers; one with a caution license (both pit licenses) drives its own cautions (stops), as in races. */
type Entrant = {
  weights: number[]; cautionLicensed?: boolean; pitLicensed?: boolean; pitTrafficLicensed?: boolean;
  limits?: { latency: number; noise: number };
  /** The caution skill (a network that drives while the field is pacing). */
  caution?: { weights: number[] };
};
const limitRanges = args.get('limits')?.split(',').map((r) => r.split(':').map(Number) as [number, number]);
/**
 * A scripted teacher in place of a drivers file: teacher:traffic[:key=value,...] fields the traffic racer (the oval
 * teacher to be) with its style's keys set (grip, margin, room, pass, insure), so a teacher is benchmarked exactly as
 * the drivers who'll learn from it.
 */
const teacher = driversFile.startsWith('teacher:') ? driversFile.split(':') : null;
const roster: Entrant[] = teacher ? [{ weights: [] }] : JSON.parse(readFileSync(driversFile, 'utf8')).drivers;
const teacherStyle: RacerStyle = {
  ...DEFAULT_STYLE,
  ...Object.fromEntries((teacher?.[2] ?? '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; })),
};
/** A mixed field: the second file's drivers take every other grid slot. */
const mixFile = args.get('mix');
const mixRoster: Entrant[] | null = mixFile ? JSON.parse(readFileSync(mixFile, 'utf8')).drivers : null;
const swap = Number(args.get('swap') ?? 0);

/** Neighbours this close (m) are a pair for lockstep. */
const LOCKSTEP_RANGE = 20;
/** A pair's stretch together counts for lockstep once it has lasted this many decisions (1 s). */
const LOCKSTEP_MIN = 30;
/** Twins are compared at the same spot: bins this long (m), and a car is following another that passed the spot this recently (s). */
const SPOT_BIN = 5;
const SPOT_FOLLOW = 2;

/** A preset by name, or a generated oval: oval:<seed>[:<variant>[:<shape>]]. */
function trackFor(name: string): Track {
  if (name in specs) return ovalTrack(specs[name as keyof typeof specs]);
  const [kind, seedText, variant, shape] = name.split(':');
  if (kind !== 'oval' || !seedText) throw new Error(`unknown track ${name}`);
  return new Track(generateLayout({ type: 'oval', seed: Number(seedText), variant: variant || undefined,
    ...(shape ? { params: { shape: shape as OvalShape } } : {}) }));
}

interface Retirement {
  time: number; context: string; speed: number;
  /** Who was driving: the learned driver or a script. */
  mode: string;
  /** What finished it: a wall, or a car (and that car's driver mode). */
  hit: string;
  /** For cars in a pit cycle: which part of pit road, in or out, and the lane. */
  where: string | null;
  /** Car contact: this car's share of the fault for the last hit. */
  fault: number | null;
}
interface RaceStats {
  track: string;
  seed: number;
  laps: number;
  finished: number;
  cautions: number;
  cautionLaps: number;
  retirements: Retirement[];
  wearPerLap: number[];
  burnPerLap: number[];
  stops: Array<{ tire: number; fuel: number; tires: boolean; service: number; underCaution: boolean }>;
  lapsByTire: Array<[number, number]>;
  slideSteps: number[]; // car-steps with sliding above 0.05 / 0.35 / 0.6
  steps: number;
  /** Damage cars did to each other (by fault), summed. */
  harm: number;
  /** Stewards' decisions (with --rules 1): offence, penalty. */
  penalties: Array<[string, string]>;
  coverage: Array<{ lap: number; groove: number; skid: number; dark10: number; dark25: number }>;
  /** Green-flag racing in traffic. */
  pack: PackStats;
  /** Who drove: car-decisions on track (any flag), and how many of them a script drove (formation, pit maneuver). */
  driving: { samples: number; formation: number; pit: number };
  /** Per car: which file (0 = A, 1 = the mix) and which driver in it, where it finished, whether it retired. */
  entrants: Array<{ side: number; driver: number; place: number; retired: boolean; harm: number; lapTime: number }>;
}

type Sums = { ab: number; aa: number; bb: number; n: number };
interface PackStats {
  /** Car-decisions sampled (green, on track, not pitting, moving). */
  samples: number;
  /** ...with another car alongside (less than a car length apart along the track, within 6 m across). */
  alongside: number;
  /** ...in another car's draft. */
  drafting: number;
  /** Places gained on track under green (sampled once a second), and clean green car-laps run. */
  passes: number;
  carLaps: number;
  /** Lane (d, m): sum and sum of squares, for the spread of the field across the track. */
  laneSum: number;
  laneSq: number;
  /** Lockstep: sums over neighbouring pairs' control changes, same brain and different brains. */
  lockSame: Sums;
  lockDiff: Sums;
  /** Twins: a car following another, compared at the same spot on the track; same brain and different brains. */
  spotSame: SpotSums;
  spotDiff: SpotSums;
}
/** Sums of the differences between a car and the one ahead of it where that car was a moment ago: lane (m), speed (m/s), steering. */
type SpotSums = { d: number; v: number; steer: number; n: number };

/** Racing-surface coverage grid, accumulating the renderer's strokes as expected values. */
class MarkGrid {
  private readonly w: number;
  private readonly h: number;
  private readonly groove: Float32Array;
  private readonly skid: Float32Array;
  private readonly surface: number[] = [];
  private readonly last = new Map<Car, [number, number]>();

  constructor(private readonly track: Track) {
    const b = track.bounds;
    this.w = Math.ceil((b.maxX - b.minX) / MARK_CELL);
    this.h = Math.ceil((b.maxY - b.minY) / MARK_CELL);
    this.groove = new Float32Array(this.w * this.h);
    this.skid = new Float32Array(this.w * this.h);
    const seen = new Set<number>();
    for (let s = 0; s < track.length; s += MARK_CELL / 2) {
      for (let d = -track.halfWidth; d <= track.halfWidth; d += MARK_CELL / 2) {
        const c = this.cell(...track.toWorld(s, d));
        if (c >= 0 && !seen.has(c)) { seen.add(c); this.surface.push(c); }
      }
    }
  }

  private cell(x: number, y: number): number {
    const b = this.track.bounds;
    const cx = Math.floor((x - b.minX) / MARK_CELL), cy = Math.floor((y - b.minY) / MARK_CELL);
    return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h ? cx + cy * this.w : -1;
  }

  stamp(cars: Car[]): void {
    for (const car of cars) {
      const prev = this.last.get(car);
      if (prev && Math.hypot(car.x - prev[0], car.y - prev[1]) < 0.5) continue;
      this.last.set(car, [car.x, car.y]);
      if (!prev || Math.hypot(car.x - prev[0], car.y - prev[1]) > 30) continue;
      const g = GROOVE_STROKE_ALPHA * grooveChance(car);
      if (g > 0) this.stroke(this.groove, prev, [car.x, car.y], GROOVE_WIDTH, g);
      const skid = skidStroke(car);
      if (skid) this.stroke(this.skid, prev, [car.x, car.y], skid.width, skid.alpha);
    }
  }

  private stroke(layer: Float32Array, a: [number, number], b: [number, number], width: number, alpha: number): void {
    const r = width / 2;
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy || 1e-9;
    for (let x = Math.min(a[0], b[0]) - r; x <= Math.max(a[0], b[0]) + r; x += MARK_CELL) {
      for (let y = Math.min(a[1], b[1]) - r; y <= Math.max(a[1], b[1]) + r; y += MARK_CELL) {
        const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / len2));
        if (Math.hypot(x - a[0] - vx * t, y - a[1] - vy * t) > r) continue;
        const c = this.cell(x, y);
        if (c >= 0) layer[c] += alpha * (1 - layer[c]);
      }
    }
  }

  /** Shares of the racing surface: mean groove and skid darkness, and cells darker than 10% / 25% overall. */
  coverage(): { groove: number; skid: number; dark10: number; dark25: number } {
    let g = 0, k = 0, d10 = 0, d25 = 0;
    for (const c of this.surface) {
      const groove = GROOVE_DISPLAY_ALPHA * this.groove[c];
      const dark = 1 - (1 - groove) * (1 - this.skid[c]);
      g += groove;
      k += this.skid[c];
      if (dark > 0.1) d10++;
      if (dark > 0.25) d25++;
    }
    const n = this.surface.length;
    return { groove: g / n, skid: k / n, dark10: d10 / n, dark25: d25 / n };
  }
}

/** Where on pit road a car in a pit cycle is: the section, in or out, and the lane. */
function pitWhere(car: Car, track: Track): string | null {
  if (car.pit.phase === 'none') return null;
  const p = track.pit;
  const r = track.signedS(car.s);
  const section = r < p.entryStart ? 'before entry' : r < p.wallStart ? 'entry' : r < p.wallEnd ? 'along the wall'
    : r < p.exitEnd ? 'exit' : r < p.blendEnd ? 'blend' : 'past the blend';
  const lane = r >= p.wallStart && r < p.wallEnd ? (car.d > p.laneD ? ' (box lane)' : car.d > p.wallD ? ' (fast lane)' : ' (track side)') : '';
  return `${car.pit.phase} ${section}${lane}`;
}

function runRace(trackName: string, seed: number): RaceStats {
  const track = trackFor(trackName);
  const laps = lapsArg ? Number(lapsArg) : Math.round(150_000 / track.length);
  const rng = new Rng(seed * 7919 + 1);
  const world = new World(track, { collisions: true, drafting: true, wearScale: pace });
  const brains: Array<{ side: number; driver: number }> = [];
  for (let k = 0; k < fieldSize; k++) {
    const car = new Car(k);
    placeOnGrid(car, track, k, true);
    const side = mixRoster ? (k + swap) % 2 : 0;
    const list = side ? mixRoster! : roster;
    const driver = (mixRoster ? Math.floor(k / 2) + seed : k + seed) % list.length;
    brains.push({ side, driver });
    const d = list[driver];
    const chief = new StrategistCrewChief(randomTraits(() => rng.next()));
    const drawn = limitRanges && { latency: limitRanges[0][0] + rng.next() * (limitRanges[0][1] - limitRanges[0][0]),
      noise: limitRanges[1][0] + rng.next() * (limitRanges[1][1] - limitRanges[1][0]) };
    const limits = drawn ?? d.limits;
    if (teacher && side === 0) {
      // The teacher drives its own cautions and restarts (the pit maneuver still drives its stops).
      // teacher:styles: a field of individuals, 40 of them cycling round the grid like a roster, each with its own
      // nerve and talent (fixed per individual, whatever the race).
      let racer = new TrafficRacer(teacherStyle);
      if (teacher[1] === 'styles') {
        const who = new Rng(hashSeed(77, `racer${(k + seed) % STYLED_RACERS}`));
        const nerve = 0.15 + 0.7 * who.next(), talent = who.next();
        const { style, traits } = racerStyle(nerve, talent, () => who.next());
        racer = new TrafficRacer(style, undefined, traits);
        brains[k].driver = (k + seed) % STYLED_RACERS; // each an individual, for the twins numbers
      }
      world.addCar(car, new Team(racer, new TowerSpotter(), chief, false, true));
      continue;
    }
    world.addCar(car, neuralTeam(adaptWeights(Float32Array.from(d.weights)), chief,
      (d.pitLicensed && d.pitTrafficLicensed) ?? false, d.cautionLicensed ?? false,
      limits && { ...limits, seed: (seed * 7919 + k * 104729) >>> 0 }, d.caution && adaptWeights(Float32Array.from(d.caution.weights))));
  }
  const race = new Race(world, laps, new PaceCarDriver(), withRules ? { rulebook: OVAL_RULES, seed } : undefined);
  const ctl = race.control!;
  const cars = world.cars;
  const marks = measureMarks ? new MarkGrid(track) : null;

  const stats: RaceStats = {
    track: trackName, seed, laps, finished: 0, cautions: 0, cautionLaps: 0, retirements: [], wearPerLap: [], burnPerLap: [],
    stops: [], lapsByTire: [], slideSteps: [0, 0, 0], steps: 0, harm: 0, penalties: [], coverage: [],
    pack: { samples: 0, alongside: 0, drafting: 0, passes: 0, carLaps: 0, laneSum: 0, laneSq: 0,
      lockSame: { ab: 0, aa: 0, bb: 0, n: 0 }, lockDiff: { ab: 0, aa: 0, bb: 0, n: 0 },
      spotSame: { d: 0, v: 0, steer: 0, n: 0 }, spotDiff: { d: 0, v: 0, steer: 0, n: 0 } },
    entrants: [], driving: { samples: 0, formation: 0, pit: 0 },
  };
  const pack = stats.pack;
  // The goal is no scripted driving anywhere: count who drives each car on track, the driver or a script.
  const sampleDriving = () => {
    if (!race.started) return;
    cars.forEach((car, k) => {
      if (car.retired || race.isFinished(car) || car.waiting) return;
      const mode = (world.controllers[k] as unknown as { mode?: string } | null)?.mode;
      stats.driving.samples++;
      if (mode === 'formation') stats.driving.formation++;
      else if (mode === 'pit') stats.driving.pit++;
    });
  };
  // Lockstep: each neighbouring pair's running sums of its control changes while it stays together.
  const lastInput = cars.map(() => [0, 0]);
  const pairs = new Map<number, Sums>();
  const closePair = (key: number) => {
    const p = pairs.get(key)!;
    pairs.delete(key);
    if (p.n < LOCKSTEP_MIN) return;
    const a = brains[Math.floor(key / fieldSize)], b = brains[key % fieldSize];
    const into = a.side === b.side && a.driver === b.driver ? pack.lockSame : pack.lockDiff;
    into.ab += p.ab; into.aa += p.aa; into.bb += p.bb; into.n += p.n;
  };
  const racing = (c: Car) => !c.retired && c.pit.phase === 'none' && c.speed > 10 && !race.isFinished(c);
  // Twins: what each car did at each spot on the track (bins of SPOT_BIN m), so a car following can be compared with
  // the car ahead where it was. A copy of the same brain following in its tracks does exactly what the car ahead did.
  const bins = Math.ceil(track.length / SPOT_BIN);
  const spot = cars.map(() => ({ t: new Float64Array(bins).fill(-Infinity), d: new Float32Array(bins), v: new Float32Array(bins), steer: new Float32Array(bins) }));
  const sampleSpots = (on: Car[]) => {
    for (const A of on) {
      const b = Math.floor(A.s / SPOT_BIN) % bins;
      for (const B of on) {
        if (B === A) continue;
        const was = spot[B.id];
        const ago = world.time - was.t[b];
        if (!(ago > 0 && ago < SPOT_FOLLOW)) continue; // B passed this spot a moment ago: A is following it
        const a = brains[A.id], o = brains[B.id];
        const into = a.side === o.side && a.driver === o.driver ? pack.spotSame : pack.spotDiff;
        into.d += Math.abs(A.d - was.d[b]); into.v += Math.abs(A.speed - was.v[b]); into.steer += Math.abs(A.inputY - was.steer[b]); into.n++;
      }
      const mine = spot[A.id];
      mine.t[b] = world.time; mine.d[b] = A.d; mine.v[b] = A.speed; mine.steer[b] = A.inputY;
    }
  };
  const samplePack = () => {
    const L = track.length;
    const change = cars.map((c, k) => {
      const dx = c.inputX - lastInput[k][0], dy = c.inputY - lastInput[k][1];
      lastInput[k][0] = c.inputX; lastInput[k][1] = c.inputY;
      return [dx, dy];
    });
    if (ctl.flag !== 'green' || !race.started) { for (const key of [...pairs.keys()]) closePair(key); return; }
    const on = cars.filter(racing);
    sampleSpots(on);
    const seen = new Set<number>();
    for (let i = 0; i < on.length; i++) {
      const A = on[i];
      pack.samples++;
      if (A.draftFactor < 0.95) pack.drafting++;
      pack.laneSum += A.d; pack.laneSq += A.d * A.d;
      let alongside = false;
      for (let j = 0; j < on.length; j++) {
        if (i === j) continue;
        const B = on[j];
        const ds = ((A.s - B.s + 1.5 * L) % L) - L / 2;
        if (Math.abs(ds) < 2 * P.CAR_RADIUS && Math.abs(A.d - B.d) < 6) alongside = true;
        if (j < i || Math.hypot(A.x - B.x, A.y - B.y) > LOCKSTEP_RANGE) continue;
        const key = Math.min(A.id, B.id) * fieldSize + Math.max(A.id, B.id);
        seen.add(key);
        let p = pairs.get(key);
        if (!p) pairs.set(key, p = { ab: 0, aa: 0, bb: 0, n: 0 });
        const a = change[A.id], b = change[B.id];
        p.ab += a[0] * b[0] + a[1] * b[1];
        p.aa += a[0] * a[0] + a[1] * a[1];
        p.bb += b[0] * b[0] + b[1] * b[1];
        p.n++;
      }
      if (alongside) pack.alongside++;
    }
    for (const key of [...pairs.keys()]) if (!seen.has(key)) closePair(key);
  };
  // Passes, as the stewards see them: between two cars on track, which is ahead counts only once it's clear by a
  // car length, and a pass is that order turning over (nose to nose isn't a pass; a car going into the pits moves
  // nobody up). Under green only.
  const order = new Map<number, number>(); // pair key -> +1 lower id ahead, -1 behind
  const samplePasses = () => {
    if (ctl.flag !== 'green' || !race.started) { order.clear(); return; }
    const on = cars.filter(racing);
    const live = new Set<number>();
    for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
      const [a, b] = on[i].id < on[j].id ? [on[i], on[j]] : [on[j], on[i]];
      const key = a.id * fieldSize + b.id;
      live.add(key);
      const gap = a.dist - b.dist;
      if (Math.abs(gap) < 2 * P.CAR_RADIUS) continue;
      const now = Math.sign(gap), was = order.get(key);
      if (was !== undefined && was !== now) pack.passes++;
      order.set(key, now);
    }
    for (const key of [...order.keys()]) if (!live.has(key)) order.delete(key);
  };
  const out = new Set<Car>();
  const prevPhase = new Map<Car, string>();
  // Per car, the lap in progress: tire and fuel at its start, and whether it ran entirely green with no stop.
  const lap = new Map<Car, { n: number; tire: number; fuel: number; clean: boolean }>();
  let lastGreen = -Infinity, cautionStart = -Infinity, leaderLaps = 0;
  const coverageLaps = new Set([5, 20, laps]);

  while (race.state !== 'finished' && world.time < laps * 300) {
    const flagBefore = ctl.flag;
    const speedBefore = cars.map((c) => c.speed);
    race.step();
    if (ctl.flag === 'green' && flagBefore !== 'green') lastGreen = world.time;
    if (ctl.flag === 'caution' && flagBefore !== 'caution') cautionStart = world.time;
    marks?.stamp(cars);
    if (world.tick % P.CONTROL_EVERY === 0) { samplePack(); sampleDriving(); }
    if (world.tick % Math.round(1 / P.DT) === 0) samplePasses();

    cars.forEach((car, k) => {
      if (car.retired) {
        if (out.has(car)) return;
        out.add(car);
        // A car that has taken the flag isn't a retirement, whatever happens to it after (stopping on the
        // cool-down lap behind a last-lap caution, say).
        if (race.isFinished(car)) return;
        const merging = cars.some((o) => o !== car && o.pit.phase === 'out' && Math.hypot(o.x - car.x, o.y - car.y) < 40);
        const context = car.pit.phase === 'out' ? 'merging' : merging ? 'near a merging car'
          : flagBefore === 'green' ? (world.time - lastGreen < RESTART_WINDOW ? 'start/restart' : 'green')
          : flagBefore === 'caution' ? `caution +${Math.round(world.time - cautionStart)}s` : flagBefore;
        const team = world.controllers[k] as unknown as { mode?: string } | null;
        const imp = car.lastImpact;
        const otherTeam = imp?.kind === 'car' && imp.other !== null ? world.controllers[imp.other] as unknown as { mode?: string } | null : null;
        const hit = !imp ? 'stalled' : imp.kind === 'wall' ? 'wall' : `car (${otherTeam?.mode ?? 'official'})`;
        stats.retirements.push({ time: world.time, context, speed: speedBefore[k], mode: team?.mode ?? '?', hit, where: pitWhere(car, track),
          fault: imp?.kind === 'car' ? imp.fault ?? null : null });
        return;
      }
      stats.steps++;
      if (car.sliding > 0.05) stats.slideSteps[0]++;
      if (car.sliding > 0.35) stats.slideSteps[1]++;
      if (car.sliding > 0.6) stats.slideSteps[2]++;

      const phase = car.pit.phase;
      if (phase === 'service' && prevPhase.get(car) === 'in' && car.pit.call) {
        stats.stops.push({ tire: car.tireLife, fuel: car.fuel, tires: car.pit.call.tires, service: car.pit.timer, underCaution: ctl.flag !== 'green' });
      }
      prevPhase.set(car, phase);

      const cur = lap.get(car);
      const n = car.lapsCompleted;
      if (!cur || cur.n !== n) {
        if (cur && cur.clean && n === cur.n + 1 && race.started) {
          pack.carLaps++;
          stats.wearPerLap.push(cur.tire - car.tireLife);
          stats.burnPerLap.push(cur.fuel - car.fuel);
          stats.lapsByTire.push([car.tireLife, car.lapTimes[n - 1]]);
        }
        lap.set(car, { n, tire: car.tireLife, fuel: car.fuel, clean: ctl.flag === 'green' && phase === 'none' });
      } else if (ctl.flag !== 'green' || phase !== 'none') {
        cur.clean = false;
      }
    });

    const leader = race.leader();
    if (leader && leader.lapsCompleted > leaderLaps) {
      leaderLaps = leader.lapsCompleted;
      if (ctl.flag !== 'green') stats.cautionLaps++;
      if (marks && coverageLaps.has(leaderLaps)) stats.coverage.push({ lap: leaderLaps, ...marks.coverage() });
    }
  }
  stats.cautions = ctl.cautions;
  stats.finished = cars.filter((c) => race.isFinished(c)).length;
  stats.harm = cars.reduce((a, c) => a + c.harmDone, 0);
  stats.penalties = race.stewards?.record.map((p) => [p.offence, p.penalty] as [string, string]) ?? [];
  for (const key of [...pairs.keys()]) closePair(key);
  const place = new Map(race.standings().map((st) => [st.car, st.position]));
  stats.entrants = cars.map((c, k) => {
    const timed = c.lapTimes.slice(1);
    return { ...brains[k], place: place.get(c) ?? cars.length, retired: c.retired, harm: c.harmDone,
      lapTime: timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : NaN };
  });
  return stats;
}

// ---------- report ----------

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');

function chains(r: Retirement[]): Retirement[][] {
  const out: Retirement[][] = [];
  for (const e of [...r].sort((a, b) => a.time - b.time)) {
    const c = out[out.length - 1];
    if (c && e.time - c[0].time < CHAIN_WINDOW) c.push(e);
    else out.push([e]);
  }
  return out;
}

const all: RaceStats[] = [];
for (const name of trackNames) {
  for (let seed = seedStart; seed < seedStart + seeds; seed++) {
    const t0 = Date.now();
    const s = runRace(name, seed);
    all.push(s);
    const ch = chains(s.retirements);
    console.log(`\n=== ${name} seed ${seed}: ${s.laps} laps, ${fieldSize} cars, ${pace}x pace (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    console.log(`finished ${s.finished}/${fieldSize}  cautions ${s.cautions} (${s.cautionLaps} laps)  retirements ${s.retirements.length}  biggest wreck ${Math.max(0, ...ch.map((c) => c.length))} cars`);
    for (const c of ch.filter((c) => c.length > 1 || c[0].context !== 'green')) {
      console.log(`  t=${f(c[0].time, 0)}s  ${c.length} car(s): ${c.map((e) => `${e.context} @${f(e.speed, 0)}`).join(', ')}`);
    }
    for (const c of s.coverage) {
      console.log(`  marks lap ${c.lap}: groove ${pct(c.groove)}, skids ${pct(c.skid)} mean darkness; ${pct(c.dark10)} of surface >10% dark, ${pct(c.dark25)} >25%`);
    }
  }
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(all.map(raceSummary)));

/** One race in numbers, for scripts/bench.ts. */
export interface RaceSummary {
  track: string; seed: number; retirements: number; cautions: number; multiCar: number;
  atFault: number; hitByAnother: number; formationWrecks: number; harm: number; lapTime: number;
  /** Pack racing under green: places gained per 100 green car-laps; shares of car-time alongside another car and in the draft. */
  passes: number; alongside: number; drafting: number;
  /** Standard deviation of the field's lane across the track (m). */
  laneSpread: number;
  /** Lockstep: correlation of neighbouring cars' control changes (0 independent, 1 moving as one), same brain and different brains. */
  lockSame: number; lockDiff: number;
  /**
   * Twins: a car following within 2 s, against the car ahead at the same spot: mean difference in lane (m), speed (m/s) and
   * steering, for the same brain and for different brains. Copies of one brain follow each other's tracks exactly.
   */
  spotSameD: number; spotDiffD: number; spotSameV: number; spotDiffV: number; spotSameSteer: number; spotDiffSteer: number;
  /** Scripted driving (to be trained away): share of car-time on track a script drove, and cars that went out while one was. */
  scripted: number; scriptedFormation: number; scriptedPit: number; scriptedRetirements: number;
  /** Mixed fields: each side's mean finishing place, cars out, and damage done by fault. */
  sides?: Array<{ place: number; retirements: number; harm: number }>;
  entrants: RaceStats['entrants'];
}
function corr(x: Sums): number {
  return x.aa > 0 && x.bb > 0 ? x.ab / Math.sqrt(x.aa * x.bb) : NaN;
}
function raceSummary(s: RaceStats): RaceSummary {
  const laps = s.lapsByTire.filter(([tire]) => tire >= 0.6).map(([, t]) => t);
  return {
    track: s.track, seed: s.seed, retirements: s.retirements.length, cautions: s.cautions,
    multiCar: chains(s.retirements).filter((c) => c.length > 1).length,
    atFault: s.retirements.filter((e) => e.fault !== null && e.fault >= 0.5).length,
    hitByAnother: s.retirements.filter((e) => e.fault !== null && e.fault < 0.5).length,
    formationWrecks: s.retirements.filter((e) => e.mode === 'formation' && e.hit === 'car (formation)').length,
    harm: s.harm, lapTime: laps.length ? laps.reduce((a, b) => a + b, 0) / laps.length : NaN,
    passes: 100 * s.pack.passes / Math.max(1, s.pack.carLaps),
    alongside: s.pack.alongside / Math.max(1, s.pack.samples),
    drafting: s.pack.drafting / Math.max(1, s.pack.samples),
    laneSpread: Math.sqrt(Math.max(0, s.pack.laneSq / Math.max(1, s.pack.samples) - (s.pack.laneSum / Math.max(1, s.pack.samples)) ** 2)),
    lockSame: corr(s.pack.lockSame), lockDiff: corr(s.pack.lockDiff),
    spotSameD: s.pack.spotSame.d / s.pack.spotSame.n, spotDiffD: s.pack.spotDiff.d / s.pack.spotDiff.n,
    spotSameV: s.pack.spotSame.v / s.pack.spotSame.n, spotDiffV: s.pack.spotDiff.v / s.pack.spotDiff.n,
    spotSameSteer: s.pack.spotSame.steer / s.pack.spotSame.n, spotDiffSteer: s.pack.spotDiff.steer / s.pack.spotDiff.n,
    scripted: (s.driving.formation + s.driving.pit) / Math.max(1, s.driving.samples),
    scriptedFormation: s.driving.formation / Math.max(1, s.driving.samples),
    scriptedPit: s.driving.pit / Math.max(1, s.driving.samples),
    scriptedRetirements: s.retirements.filter((e) => e.mode === 'formation' || e.mode === 'pit').length,
    ...(mixRoster ? {
      sides: [0, 1].map((side) => {
        const e = s.entrants.filter((x) => x.side === side);
        return { place: mean(e.map((x) => x.place)), retirements: e.filter((x) => x.retired).length, harm: e.reduce((a, x) => a + x.harm, 0) };
      }),
    } : {}),
    entrants: s.entrants,
  };
}

console.log('\n=== summary by track');
for (const name of trackNames) {
  const runs = all.filter((s) => s.track === name);
  const ret = runs.flatMap((s) => s.retirements);
  const ch = runs.flatMap((s) => chains(s.retirements));
  const multi = ch.filter((c) => c.length > 1);
  const byContext = new Map<string, number>();
  for (const e of ret) {
    const key = e.context.startsWith('caution') ? 'under caution' : e.context;
    byContext.set(key, (byContext.get(key) ?? 0) + 1);
  }
  const wear = mean(runs.flatMap((s) => s.wearPerLap));
  const burn = mean(runs.flatMap((s) => s.burnPerLap));
  const stops = runs.flatMap((s) => s.stops);
  const steps = runs.reduce((a, s) => a + s.steps, 0);
  const slide = [0, 1, 2].map((i) => runs.reduce((a, s) => a + s.slideSteps[i], 0) / steps);
  console.log(`\n${name} (${runs.length} races)`);
  if (withRules) {
    const count = new Map<string, number>();
    for (const [o, p] of runs.flatMap((r) => r.penalties)) count.set(`${o}: ${p}`, (count.get(`${o}: ${p}`) ?? 0) + 1);
    console.log(`  STEWARDS ${f(runs.reduce((a, r) => a + r.penalties.length, 0) / runs.length)} decisions/race: ${[...count].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  console.log(`  WRECKS  ${f(ret.length / runs.length)} retirements/race, ${f(mean(runs.map((s) => s.cautions)))} cautions/race, `
    + `${multi.length} multi-car wrecks (mean ${f(mean(multi.map((c) => c.length)))} cars, max ${Math.max(0, ...ch.map((c) => c.length))})`);
  console.log(`          by context: ${[...byContext].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const byWho = new Map<string, number>();
  for (const e of ret) { const key = `${e.mode} hit ${e.hit}`; byWho.set(key, (byWho.get(key) ?? 0) + 1); }
  console.log(`          who / what: ${[...byWho].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const contact = ret.filter((e) => e.fault !== null);
  if (contact.length) {
    const own = contact.filter((e) => e.fault! >= 0.5).length;
    console.log(`          contact retirements: ${own} at fault, ${contact.length - own} hit by another`);
  }
  const harm = runs.reduce((a, r) => a + r.harm, 0) / runs.length;
  console.log(`          damage done to others (by fault): ${f(harm, 2)} health/race`);
  const sums = runs.map(raceSummary);
  const avg = (key: 'passes' | 'alongside' | 'drafting' | 'laneSpread' | 'lockSame' | 'lockDiff') => mean(sums.map((x) => x[key]).filter(Number.isFinite));
  console.log(`  PACK    ${f(avg('passes'))} passes/100 green car-laps, alongside ${pct(avg('alongside'))}, drafting ${pct(avg('drafting'))}, `
    + `lane spread ${f(avg('laneSpread'), 2)} m; lockstep same brain ${f(avg('lockSame'), 3)}, different brains ${f(avg('lockDiff'), 3)}`);
  const spotAvg = (key: 'spotSameD' | 'spotDiffD' | 'spotSameV' | 'spotDiffV' | 'spotSameSteer' | 'spotDiffSteer') =>
    mean(sums.map((x) => x[key]).filter(Number.isFinite));
  console.log(`  TWINS   following within ${SPOT_FOLLOW} s, at the same spot as the car ahead: same brain lane ${f(spotAvg('spotSameD'), 2)} m, `
    + `speed ${f(spotAvg('spotSameV'), 2)} m/s, steer ${f(spotAvg('spotSameSteer'), 3)}; different brains ${f(spotAvg('spotDiffD'), 2)} m, `
    + `${f(spotAvg('spotDiffV'), 2)} m/s, ${f(spotAvg('spotDiffSteer'), 3)}`);
  console.log(`  SCRIPTS ${pct(mean(sums.map((x) => x.scripted)))} of car-time on track driven by a script `
    + `(formation ${pct(mean(sums.map((x) => x.scriptedFormation)))}, pit maneuver ${pct(mean(sums.map((x) => x.scriptedPit)))}); `
    + `${f(mean(sums.map((x) => x.scriptedRetirements)))} retirements/race while a script drove`);
  if (mixRoster) {
    const side = (i: number, key: 'place' | 'retirements') => f(mean(sums.map((x) => x.sides![i][key])));
    console.log(`  MIXED   A: place ${side(0, 'place')}, ${side(0, 'retirements')} out; B: place ${side(1, 'place')}, ${side(1, 'retirements')} out`);
  }
  const byWhere = new Map<string, number>();
  for (const e of ret) if (e.where) byWhere.set(e.where, (byWhere.get(e.where) ?? 0) + 1);
  if (byWhere.size) console.log(`          in a pit cycle: ${[...byWhere].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  TIRES   wear ${f(wear, 4)}/green lap -> cliff (${P.TIRE_CLIFF}) after ${f((1 - P.TIRE_CLIFF) / wear, 0)} laps; `
    + `sliding >0.05 ${pct(slide[0])}, >0.35 ${pct(slide[1])}, >0.6 ${pct(slide[2])} of car-steps`);
  console.log(`  FUEL    burn ${f(burn, 2)} kg/green lap -> ${f(P.FUEL_CAPACITY / burn, 0)} laps per tank`);
  console.log(`  STOPS   ${f(stops.length / runs.length)}/race (${pct(stops.filter((s) => s.underCaution).length / stops.length)} under caution), `
    + `tires taken ${pct(stops.filter((s) => s.tires).length / stops.length)}, tire life at stop ${f(mean(stops.map((s) => s.tire)), 2)} `
    + `(min ${f(Math.min(...stops.map((s) => s.tire)), 2)}), service ${f(mean(stops.map((s) => s.service)))} s`);
  const lapsByTire = runs.flatMap((s) => s.lapsByTire);
  const bands: string[] = [];
  for (let b = 0; b + 1 < TIRE_BANDS.length; b++) {
    const hi = TIRE_BANDS[b], lo = TIRE_BANDS[b + 1];
    const lt = lapsByTire.filter(([t]) => t <= hi && t > lo).map(([, l]) => l);
    if (lt.length) bands.push(`${lo.toFixed(1)}-${hi.toFixed(1)}: ${f(mean(lt), 2)} s (${lt.length})`);
  }
  console.log(`  LAP TIME by tire life (green laps): ${bands.join(' | ')}`);
}
