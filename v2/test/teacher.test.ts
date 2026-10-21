import { describe, expect, it } from 'vitest';
import { Rng } from '../src/ai/rng';
import { followLoss, racerStyle } from '../src/ai/trafficRacer';
import { G, PHYSICS as P } from '../src/sim/constants';
import { newStableDriver, teacherOf } from '../src/school/ovalApprentice';

const brake = 0.5 * P.TIRE_MU * G;

describe('following in the draft', () => {
  it('leaves a reaction time of road against a car ahead that brakes as hard as it can, as the old rule did', () => {
    expect(followLoss(85, 0.4, brake, brake)).toBeCloseTo(0.4 * 85, 6);
  });

  it('closes up to nose to tail against a car ahead that only lifts', () => {
    expect(followLoss(85, 0.4, 1.5, brake)).toBeLessThan(0.5);
  });

  it('needs more room the harder the car ahead might slow', () => {
    let last = 0;
    for (const lead of [0.5, 1, 2, 3, 4, brake]) {
      const loss = followLoss(70, 0.4, lead, brake);
      expect(loss).toBeGreaterThan(last);
      last = loss;
    }
  });
});

describe('racers from personalities', () => {
  const style = (nerve: number) => { const rng = new Rng(3); return racerStyle(nerve, 0.5, () => rng.next()).style; };

  it('the bold follow closer, leave less room and pass on a smaller edge', () => {
    const timid = style(0), bold = style(1);
    expect(bold.insure!).toBeLessThan(timid.insure!);
    expect(bold.room).toBeLessThan(timid.room);
    expect(bold.pass).toBeLessThan(timid.pass);
    expect(timid.insure!).toBeCloseTo(brake, 6); // the timid insure against full braking
  });

  it('talent is grip used: a narrow spread', () => {
    const rng = new Rng(1);
    const g = [0, 1].map((t) => racerStyle(0.5, t, () => rng.next()).style.grip);
    expect(g[1]).toBeGreaterThan(g[0]);
    expect(g[1] - g[0]).toBeLessThan(0.1);
  });

  it('a stable driver is the same individual, with the same teacher, every time', () => {
    const a = newStableDriver(7, 1), b = newStableDriver(7, 1), c = newStableDriver(8, 1);
    expect([a.nerve, a.talent, a.limits]).toEqual([b.nerve, b.talent, b.limits]);
    expect(Array.from(a.weights)).toEqual(Array.from(b.weights));
    expect(teacherOf(a)).toEqual(teacherOf(b));
    expect(c.nerve).not.toBe(a.nerve);
  });
});
