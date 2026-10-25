import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomTraits, StrategistCrewChief } from '../src/ai/pitting';
import { observeDamage, observePitCalls, PIT_CALLS_SIZE } from '../src/ai/observe';
import { fastestLine, lineAt } from '../src/ai/racingLine';
import { racerStyle, TrafficRacer } from '../src/ai/trafficRacer';
import { applyImpact, Car, stepCar } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { compromise, damageModel, powerLeft } from '../src/sim/damage';
import { EXPERIMENT } from '../src/sim/experiment';
import { World } from '../src/sim/world';
import { presetTrack } from '../src/trackgen';
import { circuitTrack } from '../src/school/roadLesson';

describe('the damage model by track', () => {
  it('ovals race the second, road circuits the first, unless ?damage says one for all', () => {
    const oval = new Car(0), road = new Car(1);
    oval.placeOnTrack(presetTrack('short'), 0, 0);
    road.placeOnTrack(circuitTrack(7, 'club'), 0, 0);
    expect([oval.damageModel, road.damageModel]).toEqual([2, 1]);
    EXPERIMENT.damage = 1;
    expect(damageModel('oval')).toBe(1);
    EXPERIMENT.damage = 2;
    expect(damageModel('road')).toBe(2);
    EXPERIMENT.damage = 0;
  });
});

describe('the second damage model', () => {
  beforeAll(() => { EXPERIMENT.damage = 2; });
  afterAll(() => { EXPERIMENT.damage = 0; });
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

  it('a car loses a little down to half health, more the further down; past it, it breaks: a fraction, then barely moving', () => {
    const at = (health: number) => compromise({ health, damageModel: 2 });
    expect(at(0.6)).toBe(0);
    expect(at(0.25)).toBeCloseTo(0.5, 6);
    expect(at(0)).toBe(1);
    expect(compromise({ health: 0, damageModel: 1 })).toBe(0);
    const power = (health: number) => powerLeft({ health, damageModel: 2 });
    expect(power(1)).toBe(1);
    expect(power(0.75)).toBeCloseTo(0.98, 6); // the buffer: a little off ...
    expect(power(0.5)).toBeCloseTo(0.92, 6); // ... more the further down
    expect(power(0.499)).toBeLessThan(0.11); // over the limit: broken, at once
    expect(power(0.1)).toBeLessThan(0.005); // barely moving
    expect(power(0)).toBe(0);
    expect(powerLeft({ health: 0.1, damageModel: 1 })).toBe(1);
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

  it("a driver feels its own damage, and hears a smoking car ahead called as one heading in", () => {
    const world = new World(track, { collisions: true, drafting: true });
    const me = new Car(0), ahead = new Car(1);
    me.placeOnTrack(track, 600, 0);
    ahead.placeOnTrack(track, 660, 0);
    world.addCar(me, null as never);
    world.addCar(ahead, null as never);
    const calls = new Float32Array(PIT_CALLS_SIZE), damage = new Float32Array(1);
    expect(observePitCalls(me, world, calls)[0]).toBe(0);
    expect(observeDamage(me, damage)[0]).toBe(0);
    ahead.health = 0.2;
    me.health = 0.25;
    expect(observePitCalls(me, world, calls)[0]).toBeCloseTo(0.5, 6);
    expect(observeDamage(me, damage)[0]).toBeCloseTo(0.5, 6);
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

    it('a broken racer heads straight for the apron', () => {
      const s = 600;
      const lane = (health: number) => {
        const w = scene([s, 0, 40, health]);
        const r = new TrafficRacer(racerStyle(0.5, 0.5, () => 0.5).style);
        r.decide(w.cars[0], w);
        return lineAt(line, s).d + r.last.want;
      };
      expect(lane(1)).toBeCloseTo(lineAt(line, s).d, 6);
      expect(lane(0.6)).toBeCloseTo(lineAt(line, s).d, 6); // damaged, not broken: racing on
      expect(lane(0.45)).toBeGreaterThan(track.innerEdgeAt(s)); // the apron
      expect(lane(0.02)).toBeGreaterThan(track.innerEdgeAt(s));
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
