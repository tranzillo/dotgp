/**
 * The team's information, audited in races: what the spotter and the crew tell a driver, against what was there.
 * Drivers race as in readiness (their own skills, crew chiefs, pit stops, the track's rules); every quarter second
 * each racing car's radio and caution inputs are checked against the cars around it.
 *
 *   npx tsx scripts/audit.ts drivers.json [--tracks short,speedway,oval:<seed>:intermediate,circuit:<seed>:club,...]
 *     [--seeds 2] [--field 20] [--km 100] [--spotters perfect|random] [--jobs N] [--md out.md]
 *
 * - Coverage: of contacts that hurt (damage over 0.005), was the other car on the driver's radio a second before
 *   (ahead in its lane, the next car ahead, behind, alongside, the hazard call)? And of moments a car is about to run
 *   into another (time to contact under 3 s, on a path that meets it), was that car being called?
 * - Hazard calls: what the hazard channel names (a wreck or stopped car, a slow car, a car at speed).
 * - Saturation: how often the caution inputs sit at their clamp (the place in line, the gap ahead in it).
 * - The crew: stops called with a racing car on the bumper or alongside; contact on the way in; merges the spotter
 *   cleared that ended in contact within 5 s.
 * - Retirements: what finished them, under which flag.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { adaptWeights, makeupOf, NeuralDriver, Team } from '../src/ai/drivers';
import { PaceCarDriver } from '../src/ai/formation';
import { randomTraits, StrategistCrewChief } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import { PERFECT_SPOTTER, RADIO, randomSpotterSkill, TowerSpotter } from '../src/ai/spotter';
import { CIRCUIT_RULES, OVAL_RULES } from '../src/rules/rulebook';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { placeOnGrid } from '../src/sim/grid';
import { Race } from '../src/sim/race';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { FLAT_TRACK, generateLayout, hashSeed, ovalTrack, SHORT_TRACK, SPEEDWAY } from '../src/trackgen';
import { ask, tsWorker } from './pool';

interface DriverEntry {
  weights: number[]; nerve?: number; pitLicensed?: boolean; pitTrafficLicensed?: boolean; cautionLicensed?: boolean;
  roadCourse?: { weights: number[]; caution?: { weights: number[] } };
  limits?: { latency: number; noise: number }; caution?: { weights: number[] }; pit?: { weights: number[] };
}

interface Job { file: string; track: string; seed: number; field: number; km: number; spotters: string }

/** Counts, keyed by "situation|what": summed over races. */
type Tally = Record<string, number>;

/** The radio's ranges (the contract's scale: proximity 0..1 over these). */
const AHEAD_RANGE = 120, BEHIND_RANGE = 80, HAZARD_RANGE = 800;
const SAMPLE_TICKS = 8 * P.CONTROL_EVERY;
const HIT = 0.005;

function trackFor(name: string): Track {
  const presets: Record<string, unknown> = { short: SHORT_TRACK, speedway: SPEEDWAY, flat: FLAT_TRACK };
  if (name in presets) return ovalTrack(presets[name] as never);
  const [kind, seed, variant] = name.split(':');
  return new Track(generateLayout({ type: kind as 'oval', seed: Number(seed), variant: (variant || undefined) as never }));
}

function runRace(job: Job): Tally {
  const drivers = (JSON.parse(readFileSync(job.file, 'utf8')) as { drivers: DriverEntry[] }).drivers;
  const track = trackFor(job.track);
  const road = track.kind === 'road';
  const L = track.length;
  const laps = Math.max(3, Math.round((job.km * 1000) / L));
  const world = new World(track, { collisions: true, drafting: true, wearScale: 4 });
  const rng = new Rng(hashSeed(job.seed, `audit${job.track}`));
  const field = Math.min(job.field, track.maxField);
  const teams: Team[] = [];
  for (let k = 0; k < field; k++) {
    const d = drivers[(k + job.seed * 7) % drivers.length];
    const car = new Car(k);
    placeOnGrid(car, track, k, true);
    const m = makeupOf(d as never, hashSeed(job.seed, `hands${job.track}:${k}`));
    const w = (x?: { weights: number[] }) => (x ? adaptWeights(Float32Array.from(x.weights)) : undefined);
    const brain = new NeuralDriver(adaptWeights(Float32Array.from(d.weights)), w(d.roadCourse), m.knowledge,
      { limits: m.limits, caution: w(d.caution), roadCaution: w(d.roadCourse?.caution), pit: w(d.pit) });
    const spotter = new TowerSpotter(job.spotters === 'random' ? randomSpotterSkill(() => rng.next()) : PERFECT_SPOTTER);
    const team = new Team(brain, spotter, new StrategistCrewChief(randomTraits(() => rng.next())),
      !!(d.pitLicensed && d.pitTrafficLicensed), d.cautionLicensed ?? false);
    if (d.nerve !== undefined) team.autopilot.nerve = d.nerve;
    teams.push(team);
    world.addCar(car, team);
  }
  const race = new Race(world, laps, new PaceCarDriver(), { rulebook: road ? CIRCUIT_RULES : OVAL_RULES, seed: job.seed });
  const ctl = race.control!;
  const t: Tally = {};
  const add = (key: string, n = 1) => { t[key] = (t[key] ?? 0) + n; };
  const disc = road ? 'circuit' : 'oval';
  const flagOf = () => (ctl.flag === 'green' ? 'green' : 'pacing');
  const cars = world.cars;
  const signedDs = (a: Car, b: Car) => { let ds = b.s - a.s; if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L; return ds; };
  const along = (c: Car) => c.vx * track.tx[c.trackIdx] + c.vy * track.ty[c.trackIdx];
  const across = (c: Car) => c.vx * -track.ty[c.trackIdx] + c.vy * track.tx[c.trackIdx];
  const r2 = 2 * P.CAR_RADIUS;
  // Which cars each car's radio named, sample by sample (the last few seconds).
  const heard: Array<Array<{ time: number; ids: Set<number> }>> = cars.map(() => []);
  const prevHealth = cars.map((c) => c.health);
  const prevPhase = cars.map((c) => c.pit.phase);
  const mergedAt = cars.map(() => -Infinity);
  const out = new Set<Car>();

  /** The car whose distance (centre to centre, ahead +) is nearest `gap`, among those `pick` allows. */
  const named = (car: Car, gap: number, pick: (o: Car, ds: number) => boolean, ds: (o: Car) => number) => {
    // (The radio is from the driver's last decision, up to a control interval ago: cars have moved since.)
    let best: Car | null = null, err = 3;
    for (const o of cars) {
      if (o === car || o.cleared || !pick(o, ds(o))) continue;
      const e = Math.abs(ds(o) - gap);
      if (e < err) { err = e; best = o; }
    }
    return best;
  };

  while (race.state !== 'finished' && world.time < laps * (road ? 400 : 200)) {
    race.step();
    const flag = flagOf();
    // Contact, as it happens: was the other car on the radio a second before?
    cars.forEach((car, k) => {
      const hit = prevHealth[k] - car.health;
      prevHealth[k] = car.health;
      if (hit > HIT && car.lastImpact?.kind === 'car' && car.lastImpact.other !== null && !car.finished) {
        const where = car.pit.phase !== 'none' ? 'pit' : flag;
        const before = heard[k].filter((h) => h.time > world.time - 1.6 && h.time < world.time - 0.4);
        const other = car.lastImpact.other;
        add(`${disc} ${where}|contacts`);
        const o = cars.find((c) => c.id === other);
        if (before.some((h) => h.ids.has(other))) add(`${disc} ${where}|contacts named a second before`);
        else if (!o) add(`${disc} ${where}|unnamed: ${other === ctl.paceCar.id ? road ? 'the safety car' : 'the pace car' : 'not a race car'}`);
        else {
          // Where the car it didn't hear about was, as they touched.
          const ds = signedDs(car, o), dd = o.d - car.d;
          add(`${disc} ${where}|unnamed: ${ds > 2 * P.CAR_RADIUS ? 'ahead' : ds < -2 * P.CAR_RADIUS ? 'behind' : 'alongside'}, ${Math.abs(dd) < 2 ? 'same lane' : 'other lane'}${o.retired ? ', a wreck' : ''}`);
        }
        if (o && o.pit.phase !== 'none' && car.pit.phase === 'none') add(`${disc} ${where}|contacts with a car pitting`);
        if (o && world.time - mergedAt[o.id] < 5) add(`${disc} ${where}|contacts with a car just merged`);
      }
      // The crew's calls and the spotter's merges.
      const phase = car.pit.phase;
      if (prevPhase[k] === 'none' && phase === 'in' && car.pit.call && !car.pit.call.penalty) {
        add(`${disc} ${flag}|stops called`);
        const bumper = cars.some((o) => o !== car && !o.retired && o.pit.phase === 'none' && signedDs(car, o) < 0 && signedDs(car, o) > -15
          && Math.abs(o.d - car.d) < 3);
        const inside = cars.some((o) => o !== car && !o.retired && o.pit.phase === 'none' && Math.abs(signedDs(car, o)) < 6
          && o.d > car.d + 1 && o.d - car.d < 6);
        if (bumper) add(`${disc} ${flag}|stops called with a car on the bumper`);
        if (inside) add(`${disc} ${flag}|stops called with a car alongside inside`);
      }
      if (prevPhase[k] === 'out' && phase === 'none') { mergedAt[car.id] = world.time; add(`${disc} ${flag}|merges`); }
      if (phase === 'none' && world.time - mergedAt[car.id] < 5 && hit > HIT && car.lastImpact?.kind === 'car') {
        add(`${disc} ${flag}|merges ending in contact`);
        mergedAt[car.id] = -Infinity;
      }
      prevPhase[k] = phase;
      // Retirements.
      if (car.retired && !out.has(car) && !race.isFinished(car)) {
        out.add(car);
        const cause = car.health > 0 || !car.lastImpact ? 'stopped' : car.lastImpact.kind;
        add(`${disc} ${flag}|out: ${cause}`);
      }
    });
    if (world.tick % SAMPLE_TICKS !== 0) continue;
    cars.forEach((car, k) => {
      if (car.retired || car.finished) return;
      const radio = teams[k].radio;
      const ids = new Set<number>();
      const fwd = (o: Car) => signedDs(car, o);
      const call = (prox: number, range: number, pick: (o: Car, ds: number) => boolean, ds: (o: Car) => number) => {
        if (prox <= 0) return null;
        const o = named(car, (1 - prox) * range, pick, ds);
        if (o) ids.add(o.id);
        return o;
      };
      call(radio[RADIO.AHEAD_PROX], AHEAD_RANGE, (_, ds) => ds > 0, fwd);
      call(radio[RADIO.AHEAD2_PROX], AHEAD_RANGE, (_, ds) => ds > 0, fwd);
      call(radio[RADIO.BEHIND_PROX], BEHIND_RANGE, (_, ds) => ds < 0, (o) => -fwd(o));
      const hazard = call(radio[RADIO.HAZARD_PROX], HAZARD_RANGE, () => true, (o) => track.wrapS(o.s - car.s));
      for (const o of cars) {
        if (o === car || o.cleared) continue;
        const dd = o.d - car.d;
        if (Math.abs(fwd(o)) < 4 * P.CAR_RADIUS + 1.5 && Math.abs(dd) < 6
          && ((dd >= 0 && radio[RADIO.LOW_PROX] > 0) || (dd < 0 && radio[RADIO.HIGH_PROX] > 0))) ids.add(o.id);
      }
      heard[k].push({ time: world.time, ids });
      if (heard[k].length > 12) heard[k].shift();
      if (car.pit.phase !== 'none') return;
      const situation = `${disc} ${flagOf()}`;
      add(`${situation}|samples`);
      // What the hazard call names.
      if (radio[RADIO.HAZARD_PROX] > 0) {
        add(`${situation}|hazard calls`);
        const v = hazard ? (hazard.retired ? 0 : hazard.speed) : NaN;
        add(`${situation}|hazard calls: ${!hazard ? 'unmatched' : v < 5 ? 'stopped or wreck' : v < 25 ? 'moving under 25 m/s' : 'at speed'}`);
      }
      // About to run into a car: time to contact under 3 s on a path that meets it. Was it being called?
      let threat: Car | null = null, soonest = 3;
      for (const o of cars) {
        if (o === car || o.cleared) continue;
        const ds = fwd(o);
        if (ds <= 0 || ds > 150) continue;
        const closing = along(car) - (o.retired ? 0 : along(o));
        if (closing <= 0.5) continue;
        const tau = Math.max(0, ds - r2) / closing;
        if (tau >= soonest) continue;
        const dd = o.d + (o.retired ? 0 : across(o)) * tau - (car.d + across(car) * tau);
        if (Math.abs(dd) < r2 + 0.5) { soonest = tau; threat = o; }
      }
      if (threat) {
        const kind = threat.retired || threat.speed < 5 ? 'stopped' : 'moving';
        add(`${situation}|closing on a ${kind} car`);
        if (ids.has(threat.id)) add(`${situation}|closing on a ${kind} car, named`);
      }
      // Caution inputs at their clamps.
      if (flagOf() === 'pacing' && ctl.slotFor(car)) {
        const ci = teams[k].cautionInputs;
        add(`${situation}|caution samples`);
        if (Math.abs(ci[2]) >= 3) add(`${situation}|place in line at its clamp (120 m)`);
        if (ci[5] >= 1) add(`${situation}|gap ahead in line at its clamp (50 m) or none`);
      }
    });
  }
  return t;
}

if (!isMainThread && workerData?.audit) {
  parentPort!.on('message', (job: Job) => parentPort!.postMessage(runRace(job)));
} else if (isMainThread) {
  const args = new Map<string, string>();
  const files: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
    else files.push(process.argv[i]);
  }
  const file = files[0] ?? 'public/drivers/stable-candidate.json';
  const tracks = (args.get('tracks') ?? `short,speedway,oval:${hashSeed(2026, 'readiness-intermediate')}:intermediate,`
    + `circuit:${hashSeed(4242, 'race-club0')}:club,circuit:${hashSeed(4242, 'race-gp1')}:gp`).split(',');
  const seeds = Number(args.get('seeds') ?? 2), field = Number(args.get('field') ?? 20), km = Number(args.get('km') ?? 100);
  const spotters = args.get('spotters') ?? 'perfect';
  const jobs = Math.max(1, Number(args.get('jobs') ?? cpus().length - 1));
  const queue: Job[] = [];
  for (const track of tracks) for (let seed = 1; seed <= seeds; seed++) queue.push({ file, track, seed, field, km, spotters });
  const total: Tally = {};
  const todo = [...queue];
  let done = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    const w = tsWorker(import.meta.url, { audit: true });
    for (let job = todo.shift(); job; job = todo.shift()) {
      const r = await ask<Tally>(w, job);
      for (const [k, v] of Object.entries(r)) total[k] = (total[k] ?? 0) + v;
      process.stderr.write(`\r${++done}/${queue.length} races (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    await w.terminate();
  }));
  process.stderr.write('\n');
  const get = (k: string) => total[k] ?? 0;
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-');
  const lines: string[] = [`Audit of ${file.split(/[\\/]/).pop()}: ${tracks.length} tracks x ${seeds} seeds, ${field} cars, ${km} km, ${spotters} spotters`, ''];
  for (const disc of ['oval', 'circuit']) {
    for (const flag of ['green', 'pacing']) {
      const s = `${disc} ${flag}`;
      if (!get(`${s}|samples`)) continue;
      lines.push(`### ${s}`, '', '| Channel | Measure | Value |', '|---|---|---|');
      lines.push(`| radio | contacts that hurt, other car named a second before | ${pct(get(`${s}|contacts named a second before`), get(`${s}|contacts`))} of ${get(`${s}|contacts`)} |`);
      for (const kind of ['moving', 'stopped']) {
        lines.push(`| radio | closing on a ${kind} car (contact < 3 s), it named | ${pct(get(`${s}|closing on a ${kind} car, named`), get(`${s}|closing on a ${kind} car`))} of ${get(`${s}|closing on a ${kind} car`)} |`);
      }
      const hc = get(`${s}|hazard calls`);
      lines.push(`| hazard | calls per sample | ${pct(hc, get(`${s}|samples`))} |`);
      for (const what of ['stopped or wreck', 'moving under 25 m/s', 'at speed', 'unmatched']) lines.push(`| hazard | calls naming: ${what} | ${pct(get(`${s}|hazard calls: ${what}`), hc)} |`);
      if (flag === 'pacing') {
        const cs = get(`${s}|caution samples`);
        lines.push(`| caution | place in line at its clamp (120 m) | ${pct(get(`${s}|place in line at its clamp (120 m)`), cs)} |`);
        lines.push(`| caution | gap ahead in line at its clamp (50 m) or none | ${pct(get(`${s}|gap ahead in line at its clamp (50 m) or none`), cs)} |`);
      }
      const sc = get(`${s}|stops called`);
      lines.push(`| crew | stops called: with a car on the bumper / alongside inside | ${pct(get(`${s}|stops called with a car on the bumper`), sc)} / ${pct(get(`${s}|stops called with a car alongside inside`), sc)} of ${sc} |`);
      lines.push(`| crew | contacts on the way in or out (pit) | ${get(`${disc} pit|contacts`)} (named before: ${pct(get(`${disc} pit|contacts named a second before`), get(`${disc} pit|contacts`))}) |`);
      lines.push(`| crew | racing contacts with a car pitting / a car just merged | ${get(`${s}|contacts with a car pitting`)} / ${get(`${s}|contacts with a car just merged`)} |`);
      lines.push(`| spotter | merges ending in contact within 5 s | ${pct(get(`${s}|merges ending in contact`), get(`${s}|merges`))} of ${get(`${s}|merges`)} |`);
      const unnamed = Object.keys(total).filter((k) => k.startsWith(`${s}|unnamed: `)).sort((x, y) => get(y) - get(x));
      if (unnamed.length) lines.push(`| radio | contacts not named before, the other car: | ${unnamed.map((k) => `${k.split('|unnamed: ')[1]} ${get(k)}`).join('; ')} |`);
      lines.push(`| out | stopped / wall / car | ${get(`${s}|out: stopped`)} / ${get(`${s}|out: wall`)} / ${get(`${s}|out: car`)} |`, '');
    }
  }
  const text = lines.join('\n');
  console.log(text);
  if (args.has('md')) writeFileSync(args.get('md')!, text + '\n');
}
