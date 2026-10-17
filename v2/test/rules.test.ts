import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights, neuralTeam } from '../src/ai/drivers';
import { PaceCarDriver } from '../src/ai/formation';
import { randomTraits, StrategistCrewChief } from '../src/ai/pitting';
import { Rng } from '../src/ai/rng';
import type { Violation } from '../src/rules/detect';
import { OVAL_RULES } from '../src/rules/rulebook';
import { Stewards } from '../src/rules/stewards';
import { Detector } from '../src/rules/detect';
import { PHYSICS as P } from '../src/sim/constants';
import { Track } from '../src/sim/track';
import { Car, serviceTime } from '../src/sim/car';
import { placeOnGrid } from '../src/sim/grid';
import { Race } from '../src/sim/race';
import { World } from '../src/sim/world';
import { generateLayout, presetTrack } from '../src/trackgen';

const violation = (offence: Violation['offence'], severity: number): Violation => ({
  offence, car: new Car(0), time: 0, severity, against: null, detail: '',
});

describe('stewards', () => {
  it('go by the rulebook: worse incidents, stiffer penalties', () => {
    const s = new Stewards(OVAL_RULES, { strictness: 0.5, consistency: 1 });
    expect(s.judge(violation('avoidable-contact', 0.1)).penalty).toBe('warning');
    expect(s.judge(violation('avoidable-contact', 0.4)).penalty).toBe('time');
    expect(s.judge(violation('avoidable-contact', 0.7)).penalty).toBe('drive-through');
    expect(s.judge(violation('avoidable-contact', 1)).penalty).toBe('black-flag');
  });

  it('a strict panel reads the same incident as worse than a lenient one', () => {
    const strict = new Stewards(OVAL_RULES, { strictness: 1, consistency: 1 });
    const lenient = new Stewards(OVAL_RULES, { strictness: 0, consistency: 1 });
    for (const sev of [0.2, 0.45, 0.8]) {
      expect(strict.judge(violation('avoidable-contact', sev)).judged).toBeGreaterThan(lenient.judge(violation('avoidable-contact', sev)).judged);
    }
  });

  it('a penalty served on pit road gets no service: a drive-through barely stops, a stop-and-go stops its seconds', () => {
    const car = new Car(0);
    expect(serviceTime(car, { tires: false, fuel: 0, repair: false, penalty: 'drive-through' })).toBeLessThan(1);
    expect(serviceTime(car, { tires: false, fuel: 0, repair: false, penalty: 'stop-go', penaltySeconds: 10 })).toBe(10);
  });

  it('runs a race to the oval rulebook: decisions on record, penalties served or flagged', () => {
    const drivers: Array<{ weights: number[] }> = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers;
    const track = presetTrack('short');
    const rng = new Rng(3);
    const world = new World(track, { collisions: true, drafting: true, wearScale: 4 });
    for (let k = 0; k < 12; k++) {
      const car = new Car(k);
      placeOnGrid(car, track, k, true);
      world.addCar(car, neuralTeam(adaptWeights(Float32Array.from(drivers[k % drivers.length].weights)), new StrategistCrewChief(randomTraits(() => rng.next()))));
    }
    const race = new Race(world, 12, new PaceCarDriver(), { rulebook: OVAL_RULES, seed: 1 });
    for (let k = 0; k < 120 * 900 && race.state !== 'finished'; k++) race.step();
    const desk = race.stewards!;
    expect(desk).toBeTruthy();
    for (const p of desk.record) expect(OVAL_RULES.offences[p.offence]).toBeDefined();
    // Every car the stewards black-flagged is out, and disqualified.
    for (const p of desk.record.filter((r) => r.penalty === 'black-flag')) {
      expect(p.car.retired).toBe(true);
      expect(p.car.disqualified).toBe(true);
    }
    // Time penalties count in the classification: finishers are in order of laps, then time with penalties.
    const fin = race.standings().filter((s) => s.status === 'finished');
    for (let i = 1; i < fin.length; i++) {
      if (fin[i].laps === fin[i - 1].laps) expect(fin[i].time).toBeGreaterThanOrEqual(fin[i - 1].time);
    }
  });
});

describe('stewards review moves, not moments', () => {
  /** Two cars on a superspeedway, green: a passes b, going from behind to clear ahead, at lateral positions da / db. */
  function pass(da: (t: ReturnType<typeof generateLayout>, s: number) => number, apron: boolean) {
    const layout = generateLayout({ type: 'oval', seed: 3, variant: 'superspeedway' } as never);
    const world = new World(new Track(layout), { collisions: false, drafting: false });
    const t = world.track;
    const a = new Car(0), b = new Car(1);
    world.addCar(a, null as never);
    world.addCar(b, null as never);
    const race = new Race(world, 10, new PaceCarDriver(), { rulebook: OVAL_RULES });
    race.startGreen();
    const det = new Detector(world, race.control!, OVAL_RULES);
    const found = [];
    for (let k = 0; k <= 60; k++) {
      const sB = 1000 + k * 0.5;
      const sA = sB - 6 + k * 0.2; // from 6 m behind to 6 m ahead
      b.placeOnTrack(t, sB, 0);
      a.placeOnTrack(t, sA, apron ? t.innerEdgeAt(sA) + P.CAR_RADIUS + 1 : da(layout, sA));
      found.push(...det.step());
    }
    return found;
  }

  it('a pass made on the apron of a superspeedway is a case, once, with the share of the move below the line', () => {
    const found = pass(() => 0, true).filter((v) => v.offence === 'passing-below-the-line');
    expect(found).toHaveLength(1);
    expect(found[0].car.id).toBe(0);
    expect(found[0].severity).toBeGreaterThan(0.9);
  });

  it('the same pass on the racing surface is no case', () => {
    expect(pass(() => -3, false).filter((v) => v.offence === 'passing-below-the-line')).toHaveLength(0);
  });
});

describe('track limits', () => {
  it('counts each excursion past the white line: strikes, the black-and-white flag, then time', async () => {
    const { ScriptedDriver, Team } = await import('../src/ai/drivers');
    const { followLine } = await import('../src/ai/lineFollower');
    const { PaceCarDriver } = await import('../src/ai/formation');
    const { TowerSpotter } = await import('../src/ai/spotter');
    const { CIRCUIT_RULES } = await import('../src/rules/rulebook');
    const { Car } = await import('../src/sim/car');
    const { Race } = await import('../src/sim/race');
    const { Track } = await import('../src/sim/track');
    const { World } = await import('../src/sim/world');
    const { generateLayout } = await import('../src/trackgen');
    const track = new Track(generateLayout({ type: 'circuit', seed: 1, variant: 'club' }));
    const world = new World(track, { wearScale: 4, collisions: false });
    // One car weaves out past the left-hand line every few seconds (onto the verge), slowly; the other stays on track.
    const weaver = { decide: (car: InstanceType<typeof Car>, w: InstanceType<typeof World>) => followLine(car, w, () => (Math.floor(w.time / 4) % 2 ? track.halfWidth + 4 : 0), () => 20, 0.7) };
    world.addCar(new Car(0), new Team(new ScriptedDriver(0, 0.8), new TowerSpotter()));
    world.addCar(new Car(1), new Team(weaver, new TowerSpotter()));
    const rulebook = { ...CIRCUIT_RULES, trackLimits: { strikes: 2 } };
    const race = new Race(world, 3, new PaceCarDriver(), { rulebook, seed: 1 });
    const lines: string[] = [];
    let greenAt = NaN;
    while (world.time < 400 && (Number.isNaN(greenAt) || world.time < greenAt + 60)) {
      race.step();
      if (Number.isNaN(greenAt) && race.started) greenAt = world.time;
      for (const e of world.events.splice(0)) if (/track limits/.test(e.text)) lines.push(`#${e.car.id} ${e.text}`);
    }
    const [clean, weaving] = world.cars;
    expect(lines.some((l) => l.startsWith('#0'))).toBe(false); // the car on track: nothing
    expect(lines.filter((l) => /\(1 of 2\)/.test(l)).length).toBe(1);
    expect(lines.some((l) => /\(2 of 2\): black and white flag/.test(l))).toBe(true);
    expect(weaving.timePenalty).toBeGreaterThan(0); // every one after the flag costs time
    expect(clean.timePenalty).toBe(0);
    expect(lines.every((l) => /turn \d+/.test(l))).toBe(true); // named by the corner
  });
});
