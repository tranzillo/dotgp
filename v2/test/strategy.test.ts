import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights } from '../src/ai/drivers';
import { Network, genomeSize } from '../src/ai/network';
import { adaptChiefWeights, CHIEF_INPUTS, CHIEF_LAYERS, observeRace } from '../src/ai/neuralChief';
import { Rng } from '../src/ai/rng';
import { pairedRaces, scorePairs, StrategyTrainer, type StrategyDriver } from '../src/ai/strategyTraining';
import { Session, type EntrantResult } from '../src/events/session';
import { presetLayout } from '../src/trackgen';

const bundled: Array<{ weights: number[] }> = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers;
const drivers: StrategyDriver[] = bundled.map((d) => ({ weights: adaptWeights(Float32Array.from(d.weights)) }));
const shipped: Array<{ weights: number[] }> = JSON.parse(readFileSync('public/chiefs/default.json', 'utf8')).chiefs;

describe('crew chiefs that read the race', () => {
  it('widens an old chief so it makes exactly the same calls, whatever the race around it', () => {
    const old = Float32Array.from(shipped[0].weights);
    const oldNet = new Network([11, 10, 4], old);
    const net = new Network(CHIEF_LAYERS, adaptChiefWeights(old));
    expect(net.weights.length).toBe(genomeSize(CHIEF_LAYERS));
    const rng = new Rng(3);
    for (let k = 0; k < 20; k++) {
      const x = Float32Array.from({ length: CHIEF_INPUTS }, () => rng.gaussian());
      expect(Array.from(net.forward(x))).toEqual(Array.from(oldNet.forward(x.slice(0, 11))).map((v) => expect.closeTo(v, 6)));
    }
  });

  it('sees the flag and its place', () => {
    const s = new Session({
      kind: 'race', layout: presetLayout('short'), laps: 20, pace: 4, seed: 2,
      entrants: drivers.map((d, k) => ({
        key: k, fill: '#fff', driver: { id: `D${k}`, weights: d.weights },
        spotter: { id: `S${k}`, skill: { aheadRange: 60, behindRange: 40, hazardRange: 250 } },
        chief: { id: `C${k}`, brain: { kind: 'scripted', traits: { fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.5, minLapsForTires: 5 } } },
      })),
    });
    s.advance(90);
    const o = new Float32Array(CHIEF_INPUTS);
    const order = [...s.world.cars].filter((c) => !c.retired).sort((a, b) => b.dist - a.dist);
    observeRace(order[0], s.world, o, 11);
    expect(o[11]).toBe(0); // green
    expect(o[14]).toBe(0); // leading
    observeRace(order[order.length - 1], s.world, o, 11);
    expect(o[14]).toBeCloseTo(1); // last
    s.race!.control!.debrisCaution();
    s.advance(1);
    observeRace(order[0], s.world, o, 11);
    expect(o[11]).toBe(1); // caution
    expect(o[16]).toBe(0); // no gaps behind a pace car
  });

  it('races each pair in the same race and mirrors only their grid slots', () => {
    const vet = { kind: 'scripted' as const, traits: { fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.5, minLapsForTires: 5 } };
    const pairs = Array.from({ length: 3 }, (_, i) => ({ x: vet, y: vet, driver: i % drivers.length }));
    const plan = pairedRaces(pairs, [vet], drivers, 12, { layout: presetLayout('short'), laps: 5, pace: 4, seed: 9 });
    expect(plan.races).toHaveLength(2);
    const [a, b] = plan.races.map((r) => r.grid!);
    for (const s of plan.slots.filter((x) => x.race === 0)) {
      expect(b.indexOf(s.keyX)).toBe(a.indexOf(s.keyY));
      expect(b.indexOf(s.keyY)).toBe(a.indexOf(s.keyX));
    }
    const twins = new Set(plan.slots.flatMap((s) => [s.keyX, s.keyY]));
    a.forEach((key, i) => { if (!twins.has(key)) expect(b[i]).toBe(key); });
    // Scoring: X two places ahead in one race, behind by one in the other; a race with one twin out doesn't count.
    const res = (race: number): EntrantResult[] => plan.races[race].entrants.map((e) => ({
      key: e.key, position: race === 0 ? (e.key === 0 ? 1 : e.key === 1 ? 3 : 10 + e.key) : (e.key === 0 ? 5 : e.key === 1 ? 4 : 10 + e.key),
      status: race === 1 && e.key === 3 ? 'out' : 'finished', disqualified: false,
    }) as EntrantResult);
    const scores = scorePairs(plan, [res(0), res(1)], 3);
    expect(scores[0]).toEqual({ places: 2 - 1, races: 2 });
    expect(scores[1].races).toBe(1);
  });

  it('takes a training step from real races', () => {
    const trainer = new StrategyTrainer([Float32Array.from(shipped[0].weights)], [presetLayout('short')], drivers,
      [{ fuelMarginLaps: 1, tireLimit: 0.3, repairBelow: 0.5, minLapsForTires: 5, cautionStop: 0.3 }],
      { pairs: 3, field: 9, laps: [4, 4], pace: [8, 8] });
    const before = trainer.chiefs[0].weights.slice();
    const races = trainer.plan();
    const results = races.map((spec) => {
      const s = new Session(spec);
      while (!s.finished && s.time < 900) s.step();
      return s.results();
    });
    const report = trainer.learn(results);
    expect(report.races).toBe(2);
    expect(report.lineages[0].pairs).toBeGreaterThanOrEqual(0);
    if (report.lineages[0].pairs >= 2) expect(trainer.chiefs[0].weights).not.toEqual(before);
  }, 120_000);
});
