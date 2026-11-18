/**
 * Alone at the wall: each driver of a bundle (or its teacher) drives a track alone, as the apprenticeship's solo
 * drives do, and this counts its wall hits, the health they cost and its lap times. Tells drift in the racing
 * skill (a car that finds the wall by itself) from trouble that only comes with traffic.
 *
 *   DOTGP_EXPERIMENT='?spec=cup' npx tsx scripts/soloWall.ts <bundle.json | teacher:bundle.json> [--hands 1] [--tracks short,oval:894715320:short] [--seconds 180]
 */
import { readFileSync } from 'node:fs';
import { adaptWeights, type DriverBrain, Hands, NeuralDriver, Team } from '../src/ai/drivers';
import { TowerSpotter } from '../src/ai/spotter';
import { TrafficRacer } from '../src/ai/trafficRacer';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { ROLLING_START_SPEED } from '../src/sim/grid';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { FLAT_TRACK, generateLayout, ovalTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';
import { lineOf, teacherOf } from '../src/school/ovalApprentice';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const file = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'))!;
const teacher = file.startsWith('teacher:');
const seconds = Number(args.get('seconds') ?? 180);
/** With --hands k, a teacher drives through its student's human limits (latency and motor noise) times k. */
const handed = Number(args.get('hands') ?? 0);
const specs = { speedway: SPEEDWAY, short: SHORT_TRACK, flat: FLAT_TRACK } as const;
const trackFor = (name: string): Track => {
  if (name in specs) return ovalTrack(specs[name as keyof typeof specs]);
  const [, seed, variant] = name.split(':');
  return new Track(generateLayout({ type: 'oval', seed: Number(seed), variant: variant || undefined }));
};

interface BundleDriver { lineage: number; nerve: number; talent: number; limits: { latency: number; noise: number }; weights: number[]; caution?: { weights: number[] }; tactics?: { weights: number[] } }
const drivers: BundleDriver[] = JSON.parse(readFileSync(file.replace(/^teacher:/, ''), 'utf8')).drivers;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

for (const name of (args.get('tracks') ?? 'short,oval:894715320:short').split(',')) {
  const track = trackFor(name);
  let hits = 0, lost = 0, out = 0, hitters = 0;
  const laps: number[] = [], perDriver: number[] = [];
  for (const d of drivers) {
    const world = new World(track, { collisions: false, drafting: false });
    const car = new Car(0);
    car.placeOnTrack(track, 0, 0);
    car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
    car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
    const racer = (): DriverBrain => {
      const t = new TrafficRacer(teacherOf(d).style, undefined, { ...teacherOf(d).traits, reaction: 0 });
      if (!handed) return t;
      // The teacher through the student's own hands (its latency and motor noise), as a NeuralDriver drives.
      const hands = new Hands({ latency: handed * d.limits.latency, noise: handed * d.limits.noise, seed: d.lineage }, P.CONTROL_EVERY * P.DT);
      return { decide: (c, w) => { t.decide(c, w); hands.apply(c.inputX, c.inputY, c); } };
    };
    const brain = teacher
      ? racer()
      : new NeuralDriver(adaptWeights(Float32Array.from(d.weights)), undefined, lineOf(d), {
        limits: { ...d.limits, seed: d.lineage },
        caution: d.caution ? adaptWeights(Float32Array.from(d.caution.weights)) : undefined,
        tactics: d.tactics ? Float32Array.from(d.tactics.weights) : undefined,
      });
    world.addCar(car, new Team(brain, new TowerSpotter(), null));
    let mine = 0, touching = false;
    for (let k = 0; k < seconds / P.DT && !car.retired; k++) {
      const before = car.health;
      world.step();
      const wall = before - car.health > 1e-4 && car.lastImpact?.kind === 'wall';
      if (wall) { lost += before - car.health; if (!touching) { hits++; mine++; } }
      touching = wall;
    }
    if (car.retired) out++;
    if (mine) hitters++;
    perDriver.push(mine);
    laps.push(...car.lapTimes.slice(1));
  }
  console.log(`${name}: ${drivers.length} drivers alone ${seconds} s: ${hits} wall hits (${hitters} drivers, most ${Math.max(...perDriver)}), `
    + `health lost ${lost.toFixed(2)}, ${out} out, median lap ${median(laps).toFixed(2)} s, best ${Math.min(...laps).toFixed(2)} s`);
}
