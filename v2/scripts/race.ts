/**
 * Headless race with contact, drafting, crew chiefs and pit stops.
 *
 *   npx tsx scripts/race.ts <drivers.json> --track speedway --laps 50 --copies 2 --pace 4 [--pits 0]
 */
import { readFileSync } from 'node:fs';
import { adaptWeights, neuralTeam } from '../src/ai/drivers';
import { PaceCarDriver } from '../src/ai/formation';
import { randomTraits, StrategistCrewChief } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import { Car } from '../src/sim/car';
import { placeOnGrid } from '../src/sim/grid';
import { Race } from '../src/sim/race';
import { FLAT_TRACK, SHORT_TRACK, SPEEDWAY, Track } from '../src/sim/track';
import { World } from '../src/sim/world';

const args = new Map<string, string>();
for (let i = 3; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const run = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const list: Array<{ lineage: number; weights: number[] }> = run.drivers ?? run.champions;
const specs = { speedway: SPEEDWAY, short: SHORT_TRACK, flat: FLAT_TRACK } as const;
const track = new Track(specs[(args.get('track') ?? 'speedway') as keyof typeof specs]);
const laps = Number(args.get('laps') ?? 20);
const copies = Number(args.get('copies') ?? 2);
const pace = Number(args.get('pace') ?? 1);
const pits = args.get('pits') !== '0';
const rng = new Rng(Number(args.get('seed') ?? 1));

const world = new World(track, { collisions: true, drafting: true, wearScale: pace });
const names: string[] = [];
let k = 0;
for (let c = 0; c < copies; c++) {
  for (const d of list) {
    const car = new Car(k);
    placeOnGrid(car, track, k, true);
    const chief = pits ? new StrategistCrewChief(randomTraits(() => rng.next())) : null;
    world.addCar(car, neuralTeam(adaptWeights(Float32Array.from(d.weights)), chief));
    names.push(`L${d.lineage}${copies > 1 ? String.fromCharCode(97 + c) : ''}`);
    k++;
  }
}
// Race control (pace laps, cautions, wreckers) unless --control 0.
const race = new Race(world, laps, args.get('control') === '0' ? undefined : new PaceCarDriver());

const order = () => race.standings().map((s) => world.cars.indexOf(s.car));
let prev = order();
let passes = 0;
let contacts = 0;
let drafting = 0;
let samples = 0;
const touching = new Set<string>();

while (race.state !== 'finished' && world.time < laps * 200) {
  race.step();
  if (world.tick % 12 !== 0) continue;
  // Passes: changes in running order among cars on track (not pitting, not finished).
  const now = order();
  for (let p = 0; p < now.length; p++) {
    const car = world.cars[now[p]];
    if (race.isFinished(car) || car.pit.phase !== 'none') continue;
    if (prev.indexOf(now[p]) > p) passes++;
  }
  prev = now;
  for (let a = 0; a < world.cars.length; a++) {
    for (let b = a + 1; b < world.cars.length; b++) {
      const A = world.cars[a], B = world.cars[b];
      const key = `${a}-${b}`;
      const near = Math.hypot(A.x - B.x, A.y - B.y) < 3.1;
      if (near && !touching.has(key)) { contacts++; touching.add(key); }
      if (!near) touching.delete(key);
    }
  }
  for (const c of world.cars) { if (!c.retired) { samples++; if (c.draftFactor < 0.95) drafting++; } }
}

console.log(`${track.length.toFixed(0)} m oval, ${laps} laps, ${world.cars.length} cars, pace ${pace}x, pits ${pits ? 'on' : 'off'}`);
console.log(`cautions ${race.control?.cautions ?? 0}  ` + `passes ${passes}  contacts ${contacts}  time-in-draft ${((drafting / Math.max(1, samples)) * 100).toFixed(0)}%  race ${race.state}\n`);
console.log('pos car   result         best    avg  stops  hits  health  tire  fuel');
for (const st of race.standings()) {
  const c = st.car;
  const i = world.cars.indexOf(c);
  const result = st.status === 'finished' ? `${st.time.toFixed(1)}s${st.laps < laps ? ` -${laps - st.laps}L` : ''}`
    : st.status === 'out' ? `DNF lap ${c.lapsCompleted}` : `${c.lapsCompleted} laps`;
  const timed = c.lapTimes.slice(1);
  const avg = timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : NaN;
  console.log(
    `${String(st.position).padStart(3)} ${names[i].padEnd(5)} ${result.padEnd(14)} ${(c.lapTimes.length ? Math.min(...c.lapTimes) : NaN).toFixed(2).padStart(6)} ` +
    `${avg.toFixed(2).padStart(6)} ${String(c.pit.stops).padStart(6)} ${String(c.wallHits).padStart(5)} ${c.health.toFixed(2).padStart(7)} ` +
    `${c.tireLife.toFixed(2).padStart(5)} ${c.fuel.toFixed(0).padStart(5)}`,
  );
}
const missed = world.events.filter((e) => e.kind === 'missed-pit').length;
if (missed) console.log(`missed pit entries: ${missed}`);
