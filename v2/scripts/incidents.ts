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
 *   npx tsx scripts/incidents.ts [drivers.json] --tracks speedway,short --seeds 2 --field 24 --pace 4 [--laps N] [--marks 0]
 */
import { readFileSync } from 'node:fs';
import { adaptWeights, neuralTeam } from '../src/ai/drivers';
import { PaceCarDriver } from '../src/ai/formation';
import { randomTraits, StrategistCrewChief } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import { GROOVE_DISPLAY_ALPHA, GROOVE_STROKE_ALPHA, GROOVE_WIDTH, grooveChance, skidStroke } from '../src/render/marks';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { placeOnGrid } from '../src/sim/grid';
import { Race } from '../src/sim/race';
import { Track } from '../src/sim/track';
import { FLAT_TRACK, ovalTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';
import { World } from '../src/sim/world';

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
}
const driversFile = positional[0] ?? 'public/drivers/default.json';
const specs = { speedway: SPEEDWAY, short: SHORT_TRACK, flat: FLAT_TRACK } as const;
const trackNames = (args.get('tracks') ?? 'speedway,short').split(',') as Array<keyof typeof specs>;
const seeds = Number(args.get('seeds') ?? 2);
const fieldSize = Number(args.get('field') ?? 24);
const pace = Number(args.get('pace') ?? 4);
const lapsArg = args.get('laps');
const measureMarks = args.get('marks') !== '0';

/** Retirements this close together (s) count as one incident. */
const CHAIN_WINDOW = 12;
/** A retirement this soon after a green flag is a start/restart wreck. */
const RESTART_WINDOW = 20;
const MARK_CELL = 0.5; // m
const TIRE_BANDS = [1, 0.8, 0.6, 0.4, 0.3, 0.2, 0];

const roster: Array<{ weights: number[] }> = JSON.parse(readFileSync(driversFile, 'utf8')).drivers;

interface Retirement { time: number; context: string; speed: number }
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
  coverage: Array<{ lap: number; groove: number; skid: number; dark10: number; dark25: number }>;
}

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

function runRace(trackName: keyof typeof specs, seed: number): RaceStats {
  const track = ovalTrack(specs[trackName]);
  const laps = lapsArg ? Number(lapsArg) : Math.round(150_000 / track.length);
  const rng = new Rng(seed * 7919 + 1);
  const world = new World(track, { collisions: true, drafting: true, wearScale: pace });
  for (let k = 0; k < fieldSize; k++) {
    const car = new Car(k);
    placeOnGrid(car, track, k, true);
    const d = roster[(k + seed) % roster.length];
    world.addCar(car, neuralTeam(adaptWeights(Float32Array.from(d.weights)), new StrategistCrewChief(randomTraits(() => rng.next()))));
  }
  const race = new Race(world, laps, new PaceCarDriver());
  const ctl = race.control!;
  const cars = world.cars;
  const marks = measureMarks ? new MarkGrid(track) : null;

  const stats: RaceStats = {
    track: trackName, seed, laps, finished: 0, cautions: 0, cautionLaps: 0, retirements: [], wearPerLap: [], burnPerLap: [],
    stops: [], lapsByTire: [], slideSteps: [0, 0, 0], steps: 0, coverage: [],
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

    cars.forEach((car, k) => {
      if (car.retired) {
        if (out.has(car)) return;
        out.add(car);
        const merging = cars.some((o) => o !== car && o.pit.phase === 'out' && Math.hypot(o.x - car.x, o.y - car.y) < 40);
        const context = car.pit.phase === 'out' ? 'merging' : merging ? 'near a merging car'
          : flagBefore === 'green' ? (world.time - lastGreen < RESTART_WINDOW ? 'start/restart' : 'green')
          : flagBefore === 'caution' ? `caution +${Math.round(world.time - cautionStart)}s` : flagBefore;
        stats.retirements.push({ time: world.time, context, speed: speedBefore[k] });
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
  for (let seed = 1; seed <= seeds; seed++) {
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
  console.log(`  WRECKS  ${f(ret.length / runs.length)} retirements/race, ${f(mean(runs.map((s) => s.cautions)))} cautions/race, `
    + `${multi.length} multi-car wrecks (mean ${f(mean(multi.map((c) => c.length)))} cars, max ${Math.max(0, ...ch.map((c) => c.length))})`);
  console.log(`          by context: ${[...byContext].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
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
