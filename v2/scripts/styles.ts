/**
 * Each driver of a file, solo on the benchmark circuits, beside the style it
 * was taught (if it has one): lap time against the line follower's, share of
 * runs with a valid lap, track-limit excursions per lap driven, and its line
 * through corners (turn-in / apex / exit toward the outside, as a share of
 * the half width). Do different teachers make different drivers, and what
 * does each style cost or buy?
 *
 *   npx tsx scripts/styles.ts drivers.json [--tracks 8]
 */
import { readFileSync } from 'node:fs';
import { adaptWeights, makeupOf, NeuralDriver, ScriptedDriver, Team } from '../src/ai/drivers';
import { TowerSpotter } from '../src/ai/spotter';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { corners } from '../src/sim/features';
import { ROLLING_START_SPEED } from '../src/sim/grid';
import { bestValidLap, pastTrackLimits } from '../src/sim/limits';
import { Track } from '../src/sim/track';
import { World, type Controller } from '../src/sim/world';
import { generateLayout, hashSeed } from '../src/trackgen';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const file = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
if (!file) throw new Error('drivers.json');
const count = Number(args.get('tracks') ?? 8);
const log = console.log;
console.log = () => {};

const tracks = Array.from({ length: count }, (_, t) => {
  const variant = t % 2 === 0 ? 'club' : 'gp';
  return new Track(generateLayout({ type: 'circuit', seed: hashSeed(4242, `race-${variant}${t}`), variant }));
});

/** Three laps from the line: best valid lap, laps, excursions, and the line through real corners on the laps after the first. */
function drive(track: Track, who: Controller): { lap: number; laps: number; excursions: number; line: number[] | null } {
  const world = new World(track, { collisions: false, drafting: false });
  const car = new Car(0);
  world.addCar(car, who);
  car.placeOnTrack(track, track.length - 20, 0);
  car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
  car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
  const d = new Float32Array(track.n).fill(NaN);
  let excursions = 0, off = false;
  for (let i = 0; i < 400 / P.DT && car.lapTimes.length < 3 && !car.retired; i++) {
    world.step();
    if (car.lapTimes.length >= 1) d[car.trackIdx] = car.d;
    const past = pastTrackLimits(car, track);
    if (past && !off) excursions++;
    off = past;
  }
  const at = [0, 0, 0], n = [0, 0, 0];
  for (const c of corners(track)) {
    if (Math.abs(c.turn) < Math.PI / 4) continue;
    const out = -Math.sign(c.turn);
    const span = ((c.s1 - c.s0) % track.length + track.length) % track.length;
    [c.s0 - 25, c.s0 + span / 2, c.s1 + 25].forEach((s, j) => {
      const i = track.indexAt(s);
      if (Number.isNaN(d[i])) return;
      const half = (track.innerEdge(i) - track.outerEdge(i)) / 2, mid = (track.innerEdge(i) + track.outerEdge(i)) / 2;
      at[j] += out * (d[i] - mid) / half; n[j]++;
    });
  }
  return { lap: bestValidLap(car), laps: car.lapTimes.length, excursions, line: n[0] && n[1] && n[2] ? at.map((v, j) => v / n[j]) : null };
}

const teacher = tracks.map((t) => drive(t, new ScriptedDriver(0, 0.9)).lap);
const drivers = JSON.parse(readFileSync(file, 'utf8')).drivers as Array<{
  weights: number[]; roadCourse?: { weights: number[]; style?: { grip: number; margin: number; room: number } }; limits?: { latency: number; noise: number };
}>;
const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
log(`${file.split(/[\\/]/).pop()}, solo on ${count} benchmark circuits (3 laps each):`);
log('  driver  style (grip / margin / room)   lap vs follower  valid  excursions/lap  line in / apex / out');
drivers.forEach((d, k) => {
  let ratio = 0, rn = 0, valid = 0, exc = 0, laps = 0;
  const line = [0, 0, 0];
  let ln = 0;
  tracks.forEach((track, t) => {
    const m = makeupOf(d, hashSeed(5, `hands${t}:${k}`));
    const r = drive(track, new Team(new NeuralDriver(adaptWeights(Float32Array.from(d.weights)),
      d.roadCourse ? adaptWeights(Float32Array.from(d.roadCourse.weights)) : undefined, m.knowledge, { limits: m.limits }), new TowerSpotter(), null));
    if (Number.isFinite(r.lap)) { ratio += r.lap / teacher[t]; rn++; valid++; }
    exc += r.excursions; laps += Math.max(1, r.laps);
    if (r.line) { r.line.forEach((v, j) => (line[j] += v)); ln++; }
  });
  const st = d.roadCourse?.style;
  log(`  D${String(k).padEnd(5)} ${st ? `${(100 * st.grip).toFixed(0)}% / ${st.margin.toFixed(1)} m / ${st.room.toFixed(1)} m`.padEnd(30) : '-'.padEnd(30)}`
    + ` ${rn ? `${(100 * ratio / rn).toFixed(1)}%` : '-'}`.padEnd(17) + ` ${(100 * valid / tracks.length).toFixed(0)}%`.padEnd(7)
    + ` ${(exc / laps).toFixed(2)}`.padEnd(16) + ` ${ln ? line.map((v) => sign(v / ln)).join(' / ') : '-'}`);
});
