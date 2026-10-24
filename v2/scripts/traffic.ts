/**
 * Racing in traffic, scripted racers and drivers alike: circuit racecraft's
 * drills (launches, packs on straights, braking zones, chicanes: 12 cars,
 * contact and drafting) on benchmark circuits, every car driven the same
 * way. Per drill: contacts (car-to-car hits), damage, retirements,
 * track-limit excursions (cutting a corner, running wide), overtakes, and
 * progress at the track's pace.
 *
 *   npx tsx scripts/traffic.ts [line] [traffic] [follower] [drivers.json ...] [--drills 24]
 *
 * line: the fastest line at 85% of grip, no racecraft; traffic: the traffic
 * racer (default style); follower: the line follower (the old teacher).
 */
import { readFileSync } from 'node:fs';
import { trackPace } from '../src/ai/costs';
import { adaptWeights, makeupOf, NeuralDriver, ScriptedDriver, Team, type MakeupEntry } from '../src/ai/drivers';
import { RacingLineDriver } from '../src/ai/racingLine';
import { Rng } from '../src/ai/rng';
import { TowerSpotter } from '../src/ai/spotter';
import { DEFAULT_STYLE, TrafficRacer, type RacerStyle } from '../src/ai/trafficRacer';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { pastTrackLimits } from '../src/sim/limits';
import { Track } from '../src/sim/track';
import { World, type Controller } from '../src/sim/world';
import { roadcraftLayout } from '../src/school/roadcraftLesson';
import { straightStart } from '../src/school/classroom';
import { generateLayout, hashSeed } from '../src/trackgen';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const who = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const drills = Number(args.get('drills') ?? 24);
const log = console.log;
console.log = () => {};

/** A field: who drives car k. */
type Field = { name: string; make: (k: number, drill: number) => Controller };
const style = (spec: string): RacerStyle => {
  // traffic:grip:margin:room:pass
  const [, ...v] = spec.split(':').map(Number);
  return { grip: v[0] || DEFAULT_STYLE.grip, margin: v[1] ?? DEFAULT_STYLE.margin, room: v[2] ?? DEFAULT_STYLE.room, pass: v[3] ?? DEFAULT_STYLE.pass };
};
const fields: Field[] = who.map((w) => {
  if (w === 'line') return { name: w, make: () => new RacingLineDriver(0.85) };
  if (w === 'follower') return { name: w, make: () => new ScriptedDriver(0, 0.9) };
  if (w.startsWith('traffic')) return { name: w, make: () => new TrafficRacer(style(w)) };
  const list = JSON.parse(readFileSync(w, 'utf8')).drivers as Array<MakeupEntry & { weights: number[]; roadCourse?: { weights: number[] } }>;
  return {
    name: w.split(/[\\/]/).pop()!,
    make: (k, drill) => {
      const d = list[k % list.length];
      const m = makeupOf(d, hashSeed(drill, `hands${k}`));
      return new Team(new NeuralDriver(adaptWeights(Float32Array.from(d.weights)), d.roadCourse ? adaptWeights(Float32Array.from(d.roadCourse.weights)) : undefined,
        m.knowledge, { limits: m.limits }), new TowerSpotter(), null);
    },
  };
});

interface Tally { contacts: number; damage: number; retired: number; cuts: number; wide: number; overtakes: number; progress: number; cars: number }
for (const field of fields) {
  const t: Tally = { contacts: 0, damage: 0, retired: 0, cuts: 0, wide: 0, overtakes: 0, progress: 0, cars: 0 };
  for (let n = 0; n < drills; n++) {
    const variant = n % 2 ? 'gp' : 'club';
    const track = new Track(generateLayout({ type: 'circuit', seed: hashSeed(4242, `race-${variant}${n % 8}`), variant }));
    const rng = new Rng(hashSeed(77, `drill${n}`));
    const layout = roadcraftLayout(track, straightStart(track, rng), rng);
    const world = new World(track, { collisions: true, drafting: true });
    layout.spots.forEach((spot, k) => {
      const car = new Car(k);
      car.placeOnTrack(track, track.wrapS(layout.frontS - spot.back), spot.lane);
      car.vx = track.tx[car.trackIdx] * spot.speed;
      car.vy = track.ty[car.trackIdx] * spot.speed;
      car.tireLife = spot.tire;
      world.addCar(car, field.make(k, n));
    });
    const cars = world.cars;
    const start = cars.map((c) => c.dist);
    const hit = cars.map((c) => c.lastImpact);
    const lastContact = cars.map(() => -Infinity);
    const off = cars.map(() => false);
    const order = () => cars.map((_, k) => k).sort((a, b) => cars[b].dist - cars[a].dist);
    let before = order();
    const steps = Math.round((layout.seconds ?? 50) / P.DT);
    for (let i = 0; i < steps; i++) {
      world.step();
      cars.forEach((c, k) => {
        // A contact: a car-to-car impact after a second without one (counted from both cars, so a half each).
        if (c.lastImpact !== hit[k]) {
          if (c.lastImpact?.kind === 'car' && world.time - lastContact[k] > 1) t.contacts += 0.5;
          if (c.lastImpact?.kind === 'car') lastContact[k] = world.time;
          hit[k] = c.lastImpact;
        }
        const past = pastTrackLimits(c, track);
        if (past && !off[k]) {
          const kap = track.curvatureAt(c.s);
          const inner = c.d > track.innerEdge(c.trackIdx);
          if (Math.abs(kap) > 1e-3 && (kap > 0) === inner) t.cuts++; else t.wide++;
        }
        off[k] = past;
      });
      if (i % 60 === 0) {
        const now = order();
        // Overtakes: pairs whose order changed since the last look (both running).
        const rank = new Map(before.map((k, r) => [k, r]));
        for (let a = 0; a < now.length; a++) for (let b = a + 1; b < now.length; b++) {
          if (rank.get(now[a])! > rank.get(now[b])! && !cars[now[a]].retired && !cars[now[b]].retired) t.overtakes++;
        }
        before = now;
      }
    }
    const pace = trackPace(track);
    cars.forEach((c, k) => {
      t.damage += 1 - c.health; t.retired += c.retired ? 1 : 0; t.progress += (c.dist - start[k]) / pace / (layout.seconds ?? 50); t.cars++;
    });
  }
  const per = (x: number) => (x / drills).toFixed(2);
  log(`${field.name.padEnd(28)} per drill: contacts ${per(t.contacts)}, damage ${per(t.damage)}, retired ${per(t.retired)}, cuts ${per(t.cuts)}, wide ${per(t.wide)}, overtakes ${per(t.overtakes)}; progress ${(t.progress / t.cars).toFixed(3)} of the track's pace`);
}
