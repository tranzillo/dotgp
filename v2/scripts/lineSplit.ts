/**
 * A teacher field on an oval (the bundle's roster as teachers): side by side (another car within 2 m along, within 6 m
 * and 12 m across), and on an oval raced in two lines (?lines=2) the share of green car-time on the high line, two wide
 * (a car within 3 m along on the other line) and how often a car changes line.
 *
 *   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/lineSplit.ts speedway [bundle.json]
 */

const { Team } = await import('../src/ai/drivers');
const { PaceCarDriver } = await import('../src/ai/formation');
const { TrafficRacer } = await import('../src/ai/trafficRacer');
const { TowerSpotter } = await import('../src/ai/spotter');
const { teacherOf } = await import('../src/school/ovalApprentice');
const { whichLine, twoLines, ovalLines, lineAt } = await import('../src/ai/racingLine');
const { Car } = await import('../src/sim/car');
const { placeOnGrid } = await import('../src/sim/grid');
const { Race } = await import('../src/sim/race');
const { World } = await import('../src/sim/world');
const { OVAL_RULES } = await import('../src/rules/rulebook');
const { presetTrack } = await import('../src/trackgen/index');
import { readFileSync } from 'node:fs';
const roster = JSON.parse(readFileSync(process.argv[3] ?? 'public/drivers/stable-candidate-v6.json', 'utf8')).drivers;
const track = presetTrack(process.argv[2]);
const world = new World(track, { collisions: true, drafting: true, wearScale: 4 });
const racers: any[] = [];
for (let k = 0; k < Math.min(40, track.maxField); k++) {
  const car = new Car(k); placeOnGrid(car, track, k, true);
  const { style, traits } = teacherOf(roster[(k + 1) % 40]); const r = new TrafficRacer(style, undefined, traits); racers.push(r);
  world.addCar(car, new Team(r, new TowerSpotter(), null, false, true));
}
const laps = Math.round(40_000 / track.length);
const race = new Race(world, laps, new PaceCarDriver(), { rulebook: OVAL_RULES, seed: 1 });
let n = 0, high = 0, twoWide = 0, homeHigh = 0, changes = 0, wide6 = 0, wide12 = 0, sepSum = 0, sepN = 0; const last = racers.map(() => '');
while (race.state !== 'finished' && world.time < laps * 300) {
  race.step();
  if (!race.started || race.control!.flag !== 'green' || world.tick % 60) continue;
  const cars = world.cars.filter((c: any) => !c.retired && c.pit.phase === 'none');
  const on = cars.map((c: any) => (twoLines(track) ? whichLine(track, 0.6, c.s, c.d) : 'low'));
  if (twoLines(track)) { const { low, high: hi } = ovalLines(track, 0.6); for (const c of cars) { sepSum += lineAt(low, c.s).d - lineAt(hi, c.s).d; sepN++; } }
  cars.forEach((c: any, i: number) => {
    n++; if (on[i] === 'high') high++;
    if ((racers[c.id] as any).home === 'high') homeHigh++;
    if (last[c.id] && last[c.id] !== (racers[c.id] as any).home) changes++; last[c.id] = (racers[c.id] as any).home;
    const along = (o: any) => Math.abs(((o.s - c.s + 1.5 * track.length) % track.length) - track.length / 2) < 2;
    if (cars.some((o: any) => o !== c && along(o) && Math.abs(o.d - c.d) < 6)) wide6++;
    if (cars.some((o: any) => o !== c && along(o) && Math.abs(o.d - c.d) < 12)) wide12++;
    if (cars.some((o: any, j: number) => o !== c && on[j] !== on[i] && Math.abs(((o.s - c.s + 1.5 * track.length) % track.length) - track.length / 2) < 3)) twoWide++;
  });
}
console.log(`${process.argv[2]} ${twoLines(track) ? 'two lines' : 'today'}: alongside (2 m along) within 6 m across ${(100 * wide6 / n).toFixed(1)}%, within 12 m ${(100 * wide12 / n).toFixed(1)}%; lines ${(sepSum / Math.max(1, sepN)).toFixed(1)} m apart; on the high line ${(100 * high / n).toFixed(0)}% of green car-time (home line high ${(100 * homeHigh / n).toFixed(0)}%), two wide ${(100 * twoWide / n).toFixed(1)}%, home-line changes ${(changes / (n / 60)).toFixed(2)} per car-minute`);
