import { describe, expect, it } from 'vitest';
import { adaptWeights, DRIVER_LAYERS } from '../src/ai/drivers';
import { genomeSize } from '../src/ai/network';
import { CHIEF_LAYERS, StintLog } from '../src/ai/neuralChief';
import { Rng } from '../src/ai/rng';
import { Car } from '../src/sim/car';
import { Roster } from '../src/ui/roster';

describe('roster', () => {
  it('builds teams of separate agents and swaps them between teams', () => {
    const r = new Roster(new Rng(1));
    r.ensureTeams(3);
    expect(r.teams).toHaveLength(3);
    expect(r.drivers.size).toBe(3);
    expect(r.spotters.size).toBe(3);
    expect(r.chiefs.size).toBe(3);
    const [a, b] = r.teams;
    const aDriver = a.driver, bDriver = b.driver;
    r.assign(a, 'driver', bDriver);
    expect(a.driver).toBe(bDriver);
    expect(b.driver).toBe(aDriver); // swapped, nobody drives two cars
    const numbers = new Set(r.teams.map((t) => t.livery.number));
    expect(numbers.size).toBe(3);
  });

  it('round-trips through JSON', () => {
    const r = new Roster(new Rng(2));
    r.ensureTeams(2);
    const back = Roster.load(JSON.parse(JSON.stringify(r.toJSON())), new Rng(3))!;
    expect(back.teams.map((t) => t.driver)).toEqual(r.teams.map((t) => t.driver));
    const d0 = r.driverOf(r.teams[0]);
    expect(Array.from(back.driverOf(back.teams[0]).weights)).toEqual(Array.from(d0.weights));
    expect(back.spotterOf(back.teams[1]).skill).toEqual(r.spotterOf(r.teams[1]).skill);
  });

  it('migrates an old driver list into teams and descends new drivers from trained ones', () => {
    const w = Array.from(adaptWeights(new Float32Array(genomeSize(DRIVER_LAYERS))));
    const old = { drivers: [{ lineage: 0, weights: w, rounds: 500 }, { lineage: 1, weights: w, rounds: 500 }] };
    const chiefTemplate = new Float32Array(genomeSize(CHIEF_LAYERS)).fill(0.1);
    const r = Roster.load(old, new Rng(4), [chiefTemplate])!;
    expect(r.teams).toHaveLength(2);
    r.ensureTeams(4);
    const rookie = r.driverOf(r.teams[3]);
    expect(rookie.mentor).not.toBeNull();
    expect(rookie.rounds).toBe(0);
    expect(r.chiefOf(r.teams[3]).brain.kind).toBe('neural'); // learned from the template
  });
});

describe('stint log', () => {
  it('measures fuel burn and tire wear per lap, ignoring laps with a stop', () => {
    const log = new StintLog();
    const car = new Car(0);
    car.fuel = 60; car.tireLife = 1;
    log.update(car);
    for (let lap = 1; lap <= 3; lap++) {
      car.lapTimes.push(30);
      car.fuel -= 2; car.tireLife -= 0.03;
      log.update(car);
    }
    expect(log.burnPerLap).toBeCloseTo(2, 5);
    expect(log.wearPerLap).toBeCloseTo(0.03, 5);
    expect(log.lapsSinceStop).toBe(3);
    // A lap with a pit stop (fuel went up) resets the stint without corrupting the rates.
    car.lapTimes.push(60);
    car.fuel = 60; car.tireLife = 1; car.pit.stops = 1;
    log.update(car);
    expect(log.burnPerLap).toBeCloseTo(2, 5);
    expect(log.lapsSinceStop).toBe(0);
  });
});

describe('chief upgrade', () => {
  it('turns scripted chiefs into learned ones, keeping who they are', () => {
    const r = new Roster(new Rng(9));
    r.ensureTeams(3); // no templates yet: scripted chiefs
    const before = r.teams.map((t) => ({ id: t.chief, name: r.chiefOf(t).name }));
    expect(r.teams.every((t) => r.chiefOf(t).brain.kind === 'scripted')).toBe(true);
    r.chiefTemplates = [new Float32Array(genomeSize(CHIEF_LAYERS)).fill(0.1)];
    expect(r.upgradeScriptedChiefs()).toBe(3);
    r.teams.forEach((t, i) => {
      expect(t.chief).toBe(before[i].id);
      expect(r.chiefOf(t).name).toBe(before[i].name);
      expect(r.chiefOf(t).brain.kind).toBe('neural');
    });
    expect(r.upgradeScriptedChiefs()).toBe(0);
  });
});
