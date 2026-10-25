import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomTraits, StrategistCrewChief } from '../src/ai/pitting';
import { fastestLine, lineAt } from '../src/ai/racingLine';
import { racerStyle, TrafficRacer } from '../src/ai/trafficRacer';
import { applyImpact, Car, stepCar } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { compromise, powerLeft } from '../src/sim/damage';
import { EXPERIMENT } from '../src/sim/experiment';
import { World } from '../src/sim/world';
import { presetTrack } from '../src/trackgen';

describe('the second damage model (?damage=2)', () => {
  beforeAll(() => { EXPERIMENT.damage = 2; });
  afterAll(() => { EXPERIMENT.damage = 1; });
  const track = presetTrack('speedway');

  it('light contact and scraping cost no health; a real hit still does, and still wrecks', () => {
    const car = new Car(0);
    applyImpact(car, 0, -1, 5, 200);
    expect(car.health).toBe(1);
    applyImpact(car, 0, -1, 30, 0);
    expect(car.health).toBe(0);
    expect(car.retired).toBe(true);
    EXPERIMENT.damage = 1;
    const before = new Car(1);
    applyImpact(before, 0, -1, 5, 200);
    EXPERIMENT.damage = 2;
    expect(before.health).toBeLessThan(1); // the first model: worn down by it
  });

  it('a car is sound above half health, and loses grip and power toward a crawl as it nears zero', () => {
    expect(compromise(0.6)).toBe(0);
    expect(compromise(0.25)).toBeCloseTo(0.5, 6);
    expect(compromise(0)).toBe(1);
    expect(powerLeft(0)).toBe(1);
    const car = new Car(0);
    car.health = 0.1;
    expect(car.condition).toBeLessThan(0.75);
    // Flat out down the straight from 40 m/s for 20 s: the crippled car is left far behind.
    const top = (health: number) => {
      const c = new Car(0);
      c.placeOnTrack(track, 0, 0);
      c.health = health;
      c.vx = track.tx[c.trackIdx] * 40;
      c.vy = track.ty[c.trackIdx] * 40;
      let best = 0;
      for (let t = 0; t < 8; t += P.DT) {
        c.inputX = 1 / P.OVERDRIVE_MAX;
        c.inputY = 0;
        stepCar(c, track, P.DT);
        best = Math.max(best, c.speed);
      }
      return { best, end: c.speed };
    };
    expect(top(0.02).end).toBeLessThan(0.75 * top(1).end);
  });

  it('the crew calls a compromised car in, whatever its chief would call a repair at', () => {
    const chief = new StrategistCrewChief({ ...randomTraits(() => 0.5), repairBelow: 0.1 });
    const world = new World(track);
    const car = new Car(0);
    world.addCar(car, null as never);
    car.health = 0.3;
    const call = chief.decide(car, world);
    expect(call?.repair).toBe(true);
    expect(call?.reason).toBe('damage');
  });

  describe('teachers', () => {
    const line = fastestLine(track, racerStyle(0.5, 0.5, () => 0.5).style.margin);
    function scene(...cars: Array<[number, number, number, number]>): World {
      const w = new World(track, { collisions: true, drafting: true });
      cars.forEach(([s, d, speed, health], k) => {
        const c = new Car(k);
        c.placeOnTrack(track, s, lineAt(line, s).d + d);
        c.vx = track.tx[c.trackIdx] * speed;
        c.vy = track.ty[c.trackIdx] * speed;
        c.health = health;
        w.addCar(c, null as never);
      });
      return w;
    }

    it('a compromised racer heads low, the worse the lower, onto the apron once it is crawling', () => {
      const s = 600;
      const lane = (health: number) => {
        const w = scene([s, 0, 40, health]);
        const r = new TrafficRacer(racerStyle(0.5, 0.5, () => 0.5).style);
        r.decide(w.cars[0], w);
        return lineAt(line, s).d + r.last.want;
      };
      expect(lane(1)).toBeCloseTo(lineAt(line, s).d, 6);
      expect(lane(0.3)).toBeGreaterThan(lineAt(line, s).d + 1);
      expect(lane(0.02)).toBeGreaterThan(track.innerEdgeAt(s)); // the apron
      expect(lane(0.02)).toBeGreaterThan(lane(0.3));
    });

    it('a smoking car ahead is gone round high, even by a racer that never passes', () => {
      // (Down the back straight: into a turn the line runs out to the wall, with no room beside it up there.)
      const w = scene([1300, 0, 60, 1], [1340, 0, 30, 0.2]);
      const r = new TrafficRacer({ ...racerStyle(0.5, 0.5, () => 0.5).style, pass: Infinity });
      r.decide(w.cars[0], w);
      expect(r.last.passing).toBe(true);
      expect(r.last.want).toBeLessThan(0); // high: away from the inside it's heading for
    });
  });
});
