/**
 * The series' cars (src/sim/carSpec.ts) against real pole laps: the racing
 * line's best lap on each real track, the car's drag, downforce and tires
 * (grip, and how it falls with load) fitted to the poles' average speeds
 * (official lengths, so a surveyed lap a little shorter or longer than the
 * official one compares fairly); the F1 car's 0-300 km/h too (carperf.ts).
 * Each track's line is laid as the game lays it (fully refined: a quicker,
 * rougher line laps a few percent slower, and a car fitted to it comes out
 * that much too fast), the tracks in parallel, a process each.
 *
 *   npx tsx scripts/calibrate.ts [--f1 [--trace <dir>]] [--fit]
 *     the Cup car on the ovals (2024 poles, Michigan 2023), or the F1 car on the circuits (--f1: 2024 poles);
 *     without --fit, the car as it stands (CUP_FIT, F1_FIT)
 *   --trace: the F1 car fitted to real pole laps' speed traces instead (<dir>/<id>_ours.csv: OpenF1 car data registered
 *     onto our laid-out tracks, columns t,s,d,inner,outer,speed,...): the speed at every point of the lap, so the fast
 *     sweeps, slow corners and straights each count, which lap times alone trade against each other
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { lineAt, racingLine } from '../src/ai/racingLine';
import { CUP_FIT, F1_FIT } from '../src/sim/carSpec';
import { applyExperiment } from '../src/sim/experiment';
import { Track } from '../src/sim/track';
import { type MappedPits, REAL_TRACKS, realLayout } from '../src/trackgen/realtrack';
import { straightLine, testStraight } from './carperf';

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const f1 = process.argv.includes('--f1');
const traceDir = arg('--trace');
applyExperiment(f1 ? '?spec=f1' : '?spec=cup');

const MILE = 1609.344;
/**
 * Pole laps (s) and official lengths (m). Fitted with the rest unless `aside` (reported only); `group` for the
 * Cup car's superspeedway package (its own drag).
 */
interface Pole { id: string; time: number; length: number; group?: 'super'; aside?: string }
const CUP_POLES: Pole[] = [
  { id: 'daytona', time: 49.465, length: 2.5 * MILE, group: 'super' },
  { id: 'talladega', time: 52.609, length: 2.66 * MILE, group: 'super' },
  { id: 'indianapolis', time: 49.469, length: 2.5 * MILE },
  { id: 'michigan', time: 37.232, length: 2.0 * MILE },
  { id: 'charlotte', time: 29.355, length: 1.5 * MILE },
  { id: 'bristol', time: 15.142, length: 0.533 * MILE },
  { id: 'martinsville', time: 19.686, length: 0.526 * MILE },
];
const F1_POLES: Pole[] = [
  { id: 'monza', time: 79.327, length: 5793 },
  { id: 'silverstone', time: 85.819, length: 5891 },
  { id: 'budapest', time: 75.227, length: 4381 },
  { id: 'spielberg', time: 64.314, length: 4318 },
  { id: 'sakhir', time: 89.179, length: 5412 },
  { id: 'zandvoort', time: 69.673, length: 4259 },
  { id: 'austin', time: 92.33, length: 5513 },
  { id: 'montreal', time: 72.0, length: 4361 },
  { id: 'mexicocity', time: 75.946, length: 4304, aside: '2,200 m up: thin air (less drag and downforce) not modelled' },
];
const poles = f1 ? F1_POLES : CUP_POLES;
const fit: Record<string, number> = f1 ? F1_FIT : CUP_FIT;
/** A 2024 F1 car's 0-300 km/h (s, published figures: about 10.6). */
const F1_0_300 = 10.6;

/** Each real pole lap's speed (m/s) along our lap (s), where traced. */
const traceOf = (id: string): Array<[number, number]> | null => {
  if (!traceDir) return null;
  try {
    return readFileSync(`${traceDir}/${id}_ours.csv`, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',').map(Number))
      .filter((r) => r[5] > 10).map((r) => [r[1], r[5]] as [number, number]);
  } catch { return null; }
};

/** How one track went: our best lap (s) and the pole's on our lap, and how far our speed is from the real lap's, point by point (mean squared log ratio). */
interface Measure { lap: number; target: number; trace: number | null }

const workerId = arg('--worker');
if (workerId) {
  // A worker: one track, measured for each car it's sent (a line of JSON in, one out).
  const pole = poles.find((p) => p.id === workerId)!;
  const real = REAL_TRACKS.find((t) => t.id === pole.id)!;
  // (With their mapped pit lanes, as the app lays them out: Zandvoort's own won't fit.)
  const pits = JSON.parse(readFileSync('public/tracks/pits.json', 'utf8')) as MappedPits;
  const track = new Track(realLayout(real, readFileSync(`public/tracks/${real.file}`, 'utf8'), pits[pole.id]?.points));
  const trace = traceOf(pole.id);
  createInterface({ input: process.stdin }).on('line', (l) => {
    Object.assign(fit, JSON.parse(l));
    const line = racingLine(track);
    const m: Measure = {
      lap: line.lapTime,
      target: track.length / (pole.length / pole.time),
      trace: trace && trace.reduce((sum, [s, v]) => sum + Math.log(lineAt(line, s).speed / v) ** 2, 0) / trace.length,
    };
    process.stdout.write(`${JSON.stringify(m)}\n`);
  });
} else {
  const flags = [...(f1 ? ['--f1'] : []), ...(traceDir ? ['--trace', traceDir] : [])];
  const tracks = poles.map((pole) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...flags, '--worker', pole.id], { stdio: ['pipe', 'pipe', 'inherit'] });
    const waiting: Array<(m: Measure) => void> = [];
    createInterface({ input: child.stdout }).on('line', (l) => waiting.shift()!(JSON.parse(l)));
    const measure = () => new Promise<Measure>((done) => { waiting.push(done); child.stdin.write(`${JSON.stringify(fit)}\n`); });
    return { pole, traced: !!traceOf(pole.id), measure, child };
  });
  type Entry = (typeof tracks)[number];

  if (process.argv.includes('--fit')) {
    // A grid of load sensitivity and grip (more of one wants more of the other), the drag that suits each best (a
    // golden-section search: the ridges between them trap a search that moves one at a time); then downforce, and drag
    // again. The Cup car: one body, its downforce the same on both packages, then the superspeedway package's drag alone
    // on its two tracks (they're flat out: drag sets them). Squared log speed ratios.
    // (The F1 car's 0-300 km/h, about 10.6 s, counts as a track: it pins its drag down, which lap times trade with
    // downforce.)
    const straight = testStraight('road');
    const rest = tracks.filter((t) => !t.pole.group && !t.pole.aside && (!traceDir || t.traced)), sup = tracks.filter((t) => t.pole.group === 'super');
    const err = async (set: Entry[]) => {
      const ms = await Promise.all(set.map((t) => t.measure()));
      return traceDir
        ? ms.reduce((sum, m) => sum + m.trace!, 0)
        : ms.reduce((sum, m) => sum + Math.log(m.target / m.lap) ** 2, 0)
          + (f1 && set !== sup ? Math.log(Math.min(30, straightLine(straight).to300) / F1_0_300) ** 2 : 0);
    };
    /** The value of x in [lo, hi] minimising f (golden section, a dozen evaluations). */
    const golden = async (f: (x: number) => Promise<number>, lo: number, hi: number): Promise<{ x: number; e: number }> => {
      const r = (Math.sqrt(5) - 1) / 2;
      let a = lo, b = hi, c = b - r * (b - a), d = a + r * (b - a), fc = await f(c), fd = await f(d);
      for (let k = 0; k < 10; k++) {
        if (fc < fd) { b = d; d = c; fd = fc; c = b - r * (b - a); fc = await f(c); } else { a = c; c = d; fc = fd; d = a + r * (b - a); fd = await f(d); }
      }
      return fc < fd ? { x: c, e: fc } : { x: d, e: fd };
    };
    const [cdaLo, cdaHi] = f1 ? [0.5, 2] : [0.8, 2.4];
    const grips = f1 ? [1.4, 1.6, 1.8, 2.0, 2.2] : [1, 1.1, 1.2, 1.3, 1.4, 1.5];
    let best = { e: Infinity, cda: 0, k: 0, grip: 0 };
    for (const k of f1 ? [0.1, 0.15, 0.2, 0.25] : [0, 0.1, 0.15, 0.2, 0.25, 0.3]) {
      for (const grip of grips) {
        fit.loadSensitivity = k; fit.grip = grip;
        const g = await golden((cda) => { fit.cda = cda; return err(rest); }, cdaLo, cdaHi);
        if (g.e < best.e) best = { e: g.e, cda: g.x, k, grip };
      }
    }
    Object.assign(fit, { cda: best.cda, loadSensitivity: best.k, grip: best.grip });
    fit.cla = (await golden((cla) => { fit.cla = cla; return err(rest); }, 0, f1 ? 10 : 8)).x;
    fit.cda = (await golden((cda) => { fit.cda = cda; return err(rest); }, cdaLo, cdaHi)).x;
    if (!f1) {
      CUP_FIT.claSuper = CUP_FIT.cla;
      CUP_FIT.cdaSuper = (await golden((cda) => { CUP_FIT.cdaSuper = cda; return err(sup); }, 0.5, 2.5)).x;
    }
    console.log(`fit: ${JSON.stringify(Object.fromEntries(Object.entries(fit).map(([k, v]) => [k, +v.toFixed(3)])))}`);
  }
  const ms = await Promise.all(tracks.map((t) => t.measure()));
  tracks.forEach(({ pole }, i) => {
    const { lap, target, trace } = ms[i];
    const r = target / lap;
    const traced = trace !== null ? `, speed trace off by ${(Math.sqrt(trace) * 100).toFixed(1)}% (rms)` : '';
    console.log(`${pole.id.padEnd(13)} ours ${lap.toFixed(2)} s, pole ${target.toFixed(2)} s on our lap (${((r - 1) * 100).toFixed(1)}% ${r > 1 ? 'fast' : 'slow'})${traced}${pole.aside ? `  [not fitted: ${pole.aside}]` : ''}`);
  });
  for (const t of tracks) t.child.kill();
  if (f1) {
    const r = straightLine(testStraight('road'));
    console.log(`straight line: 0-100 ${r.to100.toFixed(2)} s, 0-200 ${r.to200.toFixed(2)} s, 0-300 ${r.to300.toFixed(2)} s (about ${F1_0_300}), top ${r.top.toFixed(0)} km/h, 200-0 ${r.brake200.d.toFixed(0)} m`);
  }
}
