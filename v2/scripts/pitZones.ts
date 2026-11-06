/**
 * Where pit-cycle contact happens (2026-10-26). One race: each damaging car-car contact with a car in a pit cycle is
 * put in a zone for both cars (approach on track, entry, lane in, pulling into its box, in its box, leaving it, lane
 * out, exit; or racing: on track near the entry or exit, or elsewhere), with the flag, how many cars were in a pit
 * cycle, the boxes between the two cars and the health lost; retirements in pit cycles; each pit entry's speed and
 * offset from the fast lane 30 m before the pit wall's nose and at it, and whether it hit the nose; where each stop was
 * made against its box; stops the crew waved in. Then a summary over several races' JSON, side by side by directory.
 *   npx tsx scripts/pitZones.ts drivers.json --track short|speedway|flat|c<k> --seed 1 [--field 40] [--km 150] [--scripted 1] [--json out.json]
 *     c<k>: the bench's generated circuits (circuit:<k>:club for even k, gp for odd)
 *     --scripted 1: the maneuver drives every stop (the pit skill's teacher)
 *     --trace 12,30 --from 1010 --to 1030: those cars, 4 times a second
 *   npx tsx scripts/pitZones.ts --summarize dirA [dirB ...]   (each directory's <track>-<seed>.json files)
 * The car is the classic one unless DOTGP_EXPERIMENT says otherwise ('?spec=cup').
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adaptWeights, makeupOf, NeuralDriver, Team } from '../src/ai/drivers';
import { PaceCarDriver } from '../src/ai/formation';
import { pitLanes, randomTraits, StrategistCrewChief } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import { TowerSpotter } from '../src/ai/spotter';
import { CIRCUIT_RULES, OVAL_RULES } from '../src/rules/rulebook';
import { Car } from '../src/sim/car';
import { placeOnGrid } from '../src/sim/grid';
import { Race } from '../src/sim/race';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { generateLayout, hashSeed, presetTrack } from '../src/trackgen';

const args = new Map<string, string>();
const pos: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]); else pos.push(process.argv[i]);
}

interface Hit { t: number; flag: string; cycle: number; striker: string; struck: string; vs: number; vt: number; boxGap: number | null; at: number; hp: number; cars: string }
interface Entry { t: number; flag: string; hp: number; v30: number; d30: number; v0?: number; d0?: number; nose?: number; stuck?: boolean }
interface Result {
  which: string; seed: number; scripted: boolean; finished: boolean; out: number; cautions: number; wavedIn: number;
  hits: Hit[]; outs: Array<{ t: number; flag: string; car: number; zone?: string; why: string }>; entries: Entry[];
  services: Array<{ off: number; along: number; flag: string }>;
}

if (args.has('summarize')) summarize([args.get('summarize')!, ...pos]);
else race();

function race(): void {
  const quiet = console.log;
  console.log = () => {};
  const which = args.get('track') ?? 'short', seed = Number(args.get('seed') ?? 1), km = Number(args.get('km') ?? 150);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drivers = (JSON.parse(readFileSync(pos[0], 'utf8')) as { drivers: any[] }).drivers;
  const circuit = which.startsWith('c');
  const track = circuit
    ? (() => { const k = Number(which.slice(1)), variant = k % 2 === 0 ? 'club' : 'gp'; return new Track(generateLayout({ type: 'circuit', seed: hashSeed(4242, `race-${variant}${k}`), variant })); })()
    : presetTrack(which as never);
  const laps = Math.max(3, Math.round((km * 1000) / track.length));
  const world = new World(track, { collisions: true, drafting: true, wearScale: 4 });
  const rng = new Rng(hashSeed(seed, `pitzones${which}`));
  const field = Math.min(Number(args.get('field') ?? 40), track.maxField);
  const scripted = args.get('scripted') === '1';
  const teams = new Map<Car, Team>();
  for (let k = 0; k < field; k++) {
    const d = drivers[(k + seed) % drivers.length];
    const car = new Car(k);
    placeOnGrid(car, track, k, true);
    const m = makeupOf(d, hashSeed(seed, `hands${which}:${k}`));
    const w = (x?: { weights: number[] }) => (x ? adaptWeights(Float32Array.from(x.weights)) : undefined);
    const brain = new NeuralDriver(adaptWeights(Float32Array.from(d.weights)), w(d.roadCourse), m.knowledge,
      { limits: m.limits, caution: w(d.caution), roadCaution: w(d.roadCourse?.caution), pit: w(d.pit), broken: d.brokenLicensed ? w(d.broken) : undefined });
    const team = new Team(brain, new TowerSpotter(), new StrategistCrewChief(randomTraits(() => rng.next())),
      !scripted && !!(d.pitLicensed && d.pitTrafficLicensed), d.cautionLicensed ?? false);
    if (d.nerve !== undefined) team.autopilot.nerve = d.nerve;
    world.addCar(car, team);
    teams.set(car, team);
  }
  const race = new Race(world, laps, new PaceCarDriver(), { rulebook: circuit ? CIRCUIT_RULES : OVAL_RULES, seed });
  const ctl = race.control!;
  const pit = track.pit;
  const lanes = pitLanes(track);
  const inCycle = (c: Car) => c.pit.phase !== 'none' || c.surface === 'pit';

  /** The car's zone. */
  const zoneOf = (c: Car): string => {
    const ph = c.pit.phase;
    if (ph === 'service') return 'box';
    if (ph === 'in') {
      const r = track.pitInR(c);
      if (r < pit.entryStart) return 'approach';
      if (r < pit.wallStart) return 'entry';
      if (r < c.pit.boxS - 40) return 'lane-in';
      return r <= c.pit.boxS + 5 ? 'box-in' : 'overshot';
    }
    if (ph === 'out') {
      const r = track.pitOutAt(c, c.s);
      if (r < c.pit.boxS + 30) return 'box-out';
      return r < pit.wallEnd ? 'lane-out' : 'exit';
    }
    if (c.surface === 'pit') return 'pit-road(none)';
    if (track.distanceFrom(c.s, pit.entryStart) < 200 || track.inRange(c.s, [pit.entryStart, pit.wallStart])) return 'track@entry';
    return track.inRange(c.s, [pit.wallEnd, pit.blendEnd + 150]) ? 'track@exit' : 'track';
  };
  const boxIndex = (c: Car) => pit.stalls.indexOf(c.pit.boxS);

  const prev = new Map<Car, { phase: string; surface: string; d: number; v: number; health: number; zone: string }>();
  const hits: Hit[] = [];
  const outs: Result['outs'] = [];
  const entries: Entry[] = [];
  const entering = new Map<Car, Entry>();
  const lastR = new Map<Car, number>();
  const services: Result['services'] = [];
  const wavedIn = new Set<string>();
  const seen = new Set<string>();
  const trace = (args.get('trace') ?? '').split(',').filter(Boolean).map(Number);
  const traceFrom = Number(args.get('from') ?? 0), traceTo = Number(args.get('to') ?? 1e9);
  const announce = world.announce.bind(world);
  world.announce = (car, kind, text, extra) => {
    if (kind === 'retired' && (inCycle(car) || prev.get(car)?.zone !== 'track')) {
      outs.push({ t: +world.time.toFixed(0), flag: ctl.flag, car: car.number, zone: prev.get(car)?.zone, why: text });
    }
    announce(car, kind, text, extra);
  };
  while (race.state !== 'finished' && world.time < laps * 400) {
    for (const c of world.cars) prev.set(c, { phase: c.pit.phase, surface: c.surface, d: c.d, v: c.speed, health: c.health, zone: zoneOf(c) });
    const flag = ctl.flag;
    race.step();
    if (trace.length && world.time >= traceFrom && world.time <= traceTo && Math.abs(world.time * 4 - Math.round(world.time * 4)) < 1e-3) {
      for (const c of world.cars.filter((x) => trace.includes(x.number))) {
        const r = c.pit.phase === 'out' ? track.pitOutAt(c, c.s) : track.pitInR(c);
        const other = c.lastImpact?.kind === 'car' ? `#${world.cars.find((o) => o.id === c.lastImpact!.other)?.number}` : '';
        quiet(`${world.time.toFixed(2)} ${ctl.flag} #${c.number} ${c.pit.phase}/${c.surface} ${zoneOf(c)} r ${r.toFixed(1)} box ${c.pit.boxS?.toFixed(0)}`
          + ` d ${c.d.toFixed(2)} v ${c.speed.toFixed(1)} in ${c.inputX.toFixed(2)},${c.inputY.toFixed(2)} hp ${c.health.toFixed(2)}`
          + ` hit ${c.lastImpact?.kind ?? '-'}${other} ${c.retired ? 'retired' : ''}`);
      }
    }
    for (const c of world.cars) {
      const p = prev.get(c)!;
      if (c.pit.phase === 'service' && p.phase === 'in') {
        services.push({ off: +(c.d - lanes.boxLane - track.pitOffset(c.s)).toFixed(2), along: +(track.pitInR(c) - c.pit.boxS).toFixed(2), flag });
      }
      const team = teams.get(c);
      if (team?.driverPits && team.mode === 'pit' && c.pit.phase === 'in') wavedIn.add(`${c.id}:${c.pit.stops}`);
      if (c.pit.phase !== 'in' || p.phase !== 'in') { lastR.delete(c); continue; }
      // Crossing 30 m before the wall's nose, and the nose: speed and offset from the fast lane; hitting the wall near it.
      const r = track.pitInR(c), r0 = lastR.get(c) ?? r;
      lastR.set(c, r);
      const at = (x: number) => r0 < x && r >= x;
      const lane = lanes.fastLane + track.pitOffset(c.s);
      if (at(pit.wallStart - 30)) entering.set(c, { t: +world.time.toFixed(1), flag, hp: +c.health.toFixed(2), v30: +c.speed.toFixed(1), d30: +(c.d - lane).toFixed(2) });
      const e = entering.get(c);
      if (!e) continue;
      if (at(pit.wallStart)) { e.v0 = +c.speed.toFixed(1); e.d0 = +(c.d - lane).toFixed(2); }
      if (r < pit.wallStart + 15 && c.health < p.health - 1e-6 && c.lastImpact?.kind === 'wall') e.nose = +(p.health - c.health).toFixed(2);
      if (r > pit.wallStart + 15) { entries.push(e); entering.delete(c); }
    }
    for (const c of world.cars) {
      const p = prev.get(c)!;
      if (c.health >= p.health - 1e-6 || c.lastImpact?.kind !== 'car') continue;
      const o = world.cars.find((x) => x.id === c.lastImpact!.other);
      if (!o) continue;
      const q = prev.get(o)!;
      if (!(p.phase !== 'none' || p.surface === 'pit' || q.phase !== 'none' || q.surface === 'pit')) continue;
      const key = `${Math.min(c.id, o.id)}-${Math.max(c.id, o.id)}@${Math.floor(world.time / 2)}`; // one record per pair per 2 s
      if (seen.has(key)) continue;
      seen.add(key);
      // The faster car is the striker.
      const [a, pa, b, pb] = p.v >= q.v ? [c, p, o, q] : [o, q, c, p];
      hits.push({
        t: +world.time.toFixed(1), flag, cycle: world.cars.filter((x) => !x.retired && inCycle(x)).length,
        striker: pa.zone, struck: pb.zone, vs: +pa.v.toFixed(1), vt: +pb.v.toFixed(1),
        boxGap: a.pit.phase !== 'none' && b.pit.phase !== 'none' ? Math.abs(boxIndex(a) - boxIndex(b)) : null,
        at: +track.signedS(a.s).toFixed(0), hp: +((p.health - c.health) + (q.health - o.health)).toFixed(3), cars: `#${a.number}>#${b.number}`,
      });
    }
  }
  const res: Result = {
    which, seed, scripted, finished: race.state === 'finished', cautions: ctl.cautions,
    out: world.cars.filter((c) => c.retired && !race.isFinished(c)).length,
    wavedIn: wavedIn.size, hits, outs, services, entries: [...entries, ...[...entering.values()].map((e) => ({ ...e, stuck: true }))],
  };
  if (args.get('json')) writeFileSync(args.get('json')!, JSON.stringify(res));
  quiet(JSON.stringify({ which, seed, scripted, finished: res.finished, out: res.out, pitContacts: hits.length, pitOuts: outs.length, wavedIn: res.wavedIn }));
}

/** Per track, each directory's races side by side: cars out, pit-cycle contact and damage by zone, the nose, the boxes. */
function summarize(dirs: string[]): void {
  const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
  const load = (dir: string) => {
    const byTrack = new Map<string, Result[]>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Result;
      byTrack.set(r.which, [...(byTrack.get(r.which) ?? []), r]);
    }
    return byTrack;
  };
  const all = dirs.map(load);
  const tracks = [...new Set(all.flatMap((m) => [...m.keys()]))];
  for (const t of tracks) {
    const rows: Array<[string, (R: Result[]) => number]> = [
      ['races', (R) => R.length],
      ['cars out', (R) => R.reduce((a, r) => a + r.out, 0) / R.length],
      ['out in pit cycles', (R) => R.reduce((a, r) => a + r.outs.length, 0) / R.length],
      ['pit contacts', (R) => R.reduce((a, r) => a + r.hits.length, 0) / R.length],
      ['health lost', (R) => R.reduce((a, r) => a + r.hits.reduce((b, h) => b + h.hp, 0), 0) / R.length],
      ['  approach', (R) => zone(R, ['approach'])],
      ['  entry', (R) => zone(R, ['entry'])],
      ['  boxes', (R) => zone(R, ['box', 'box-in', 'box-out'])],
      ['  lane', (R) => zone(R, ['lane-in', 'lane-out'])],
      ['  exit', (R) => zone(R, ['exit'])],
      ['nose hits', (R) => R.reduce((a, r) => a + r.entries.filter((e) => e.nose !== undefined).length, 0) / R.length],
      ['speed at nose p90', (R) => pct(R.flatMap((r) => r.entries.flatMap((e) => (e.v0 === undefined ? [] : [e.v0]))), 0.9)],
      ['stops short >1.5 m', (R) => { const s = R.flatMap((r) => r.services); return s.length ? s.filter((x) => x.off < -1.5).length / s.length : NaN; }],
      ['waved in', (R) => R.reduce((a, r) => a + r.wavedIn, 0) / R.length],
    ];
    console.log(`\n${t}${' '.repeat(Math.max(1, 22 - t.length))}${dirs.map((d) => d.split(/[\\/]/).pop()!.padStart(10)).join('')}`);
    for (const [name, f] of rows) console.log(`  ${name.padEnd(20)}${all.map((m) => { const R = m.get(t); return (R ? f(R) : NaN).toFixed(2).padStart(10); }).join('')}`);
  }
  /** Health lost a race in contacts with a car in one of these zones. */
  function zone(R: Result[], zones: string[]): number {
    return R.reduce((a, r) => a + r.hits.filter((h) => zones.includes(h.striker) || zones.includes(h.struck)).reduce((b, h) => b + h.hp, 0), 0) / R.length;
  }
}
