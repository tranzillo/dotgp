import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomTraits, StrategistCrewChief } from '../src/ai/pitting';
import { brokenRoute, CAUTION_SIZE, KNOWLEDGE_AHEAD, observeDamage, observePitCalls, PIT_CALLS_SIZE, PIT_SIZE } from '../src/ai/observe';
import { DRIVER_LAYERS, KNOWLEDGE_FROM, NeuralDriver } from '../src/ai/drivers';
import { genomeSize } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { RADIO_SIZE } from '../src/ai/spotter';
import { fastestLine, lineAt } from '../src/ai/racingLine';
import { racerStyle, TrafficRacer } from '../src/ai/trafficRacer';
import { applyImpact, Car, stepCar } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { compromise, damageModel, dragFactor, powerLeft } from '../src/sim/damage';
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

  it('light contact and scraping cost no health; past it, more the harder; a real hit still wrecks', () => {
    const car = new Car(0);
    applyImpact(car, 0, -1, 1.5, 200);
    expect(car.health).toBe(1);
    // A bump costs next to nothing, a harder one more than in proportion.
    applyImpact(car, 0, -1, 3, 0);
    const bump = 1 - car.health;
    expect(bump).toBeGreaterThan(0);
    expect(bump).toBeLessThan(0.005);
    applyImpact(car, 0, -1, 6, 0);
    expect(1 - car.health - bump).toBeGreaterThan(10 * bump);
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
    expect(power(0.75)).toBeCloseTo(0.95, 6); // the buffer: a little off ...
    expect(power(0.5)).toBeCloseTo(0.8, 6); // ... more the further down
    expect(power(0.499)).toBeLessThan(0.14); // over the limit: broken, at once
    expect(power(0.1)).toBeLessThan(0.006); // barely moving
    expect(power(0)).toBe(0);
    expect(powerLeft({ health: 0.1, damageModel: 1 })).toBe(1);
    // The aero goes too: more drag, more the worse it is ...
    const drag = (health: number) => dragFactor({ health, damageModel: 2 });
    expect(drag(1)).toBe(1);
    expect(drag(0.5)).toBeCloseTo(1.2, 6);
    expect(drag(0.499)).toBeGreaterThan(1.49);
    expect(drag(0)).toBeCloseTo(2, 6);
    expect(dragFactor({ health: 0.1, damageModel: 1 })).toBe(1);
    // ... but the grip stays: a broken car still steers where it's put.
    const car = new Car(0);
    car.health = 0.1;
    expect(car.grip).toBe(new Car(1).grip);
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

    it('a broken racer moves down only with its mirrors clear below: a car coming fast there, it holds its lane', () => {
      const s = 600;
      const want = (...others: Array<[number, number, number, number]>) => {
        const w = scene([s, 0, 40, 0.3], ...others);
        const r = new TrafficRacer(racerStyle(0.5, 0.5, () => 0.5).style);
        r.decide(w.cars[0], w);
        return r.last.want;
      };
      expect(want()).toBeGreaterThan(3); // nothing coming: down for the apron
      expect(want([s - 50, 5, 75, 1])).toBeLessThan(0.5); // a car 50 m back below it at 75 m/s: it stays put
      expect(want([s - 50, -5, 75, 1])).toBeGreaterThan(3); // the same car above it doesn't stop it going down
    });

    it('a broken racer on the apron gets by the pit wall, which stands on it', () => {
      // From the apron 250 m before the wall's nose, crawling: it was driving into the nose and sticking there.
      const from = track.pit.wallStart - 250, s0 = (from + track.length) % track.length;
      const w = new World(track, { collisions: true, drafting: true });
      const car = new Car(0);
      car.placeOnTrack(track, s0, (track.innerEdgeAt(s0) + track.apronEdgeAt(s0)) / 2);
      car.vx = track.tx[car.trackIdx] * 20;
      car.vy = track.ty[car.trackIdx] * 20;
      w.addCar(car, new TrafficRacer(racerStyle(0.5, 0.5, () => 0.5).style));
      for (let t = 0; t < 60; t += P.DT) { car.health = 0.15; w.step(); }
      expect(track.signedS(car.s)).toBeGreaterThan(track.pit.wallStart + 100);
      expect(car.lastImpact).toBeNull();
    });

    it('a broken car is driven by its broken-car skill, which knows the way to the apron as its line', () => {
      const w = scene([600, 0, 40, 0.3]);
      const car = w.cars[0];
      const rng = new Rng(3);
      const weights = Float32Array.from({ length: genomeSize(DRIVER_LAYERS) }, () => rng.gaussian() * 0.1);
      const skilled = new NeuralDriver(weights, undefined, undefined, { broken: weights.slice() });
      const plain = new NeuralDriver(weights);
      const radio = new Float32Array(RADIO_SIZE), pit = new Float32Array(PIT_SIZE), caution = new Float32Array(CAUTION_SIZE);
      const seen = (d: NeuralDriver) => d.inputs(car, w, radio, pit, caution);
      expect(skilled.netAt(track, seen(skilled))).toBe(skilled.brokenNet);
      expect(plain.netAt(track, seen(plain))).toBe(plain.net);
      // Where its line runs (the first look ahead: here): the apron's route for the skill, the racing line without it.
      expect(seen(skilled)[KNOWLEDGE_FROM] * 10 + car.d).toBeCloseTo(brokenRoute(track)(car.s + KNOWLEDGE_AHEAD[0]), 3);
      expect(seen(skilled)[KNOWLEDGE_FROM]).toBeGreaterThan(seen(plain)[KNOWLEDGE_FROM] + 0.3);
      car.health = 0.8; // mended: its racing again
      expect(skilled.netAt(track, seen(skilled))).toBe(skilled.net);
    });

    it('a smoking car ahead is got by cleanly, even by a racer that never passes', () => {
      // (Down the back straight, room to slow for it. The speedway's line runs high by the wall, so there is no way
      // round above it until it heads down: a snapshot can't say which side; driving it out can.)
      const w = new World(track, { collisions: true, drafting: true });
      const [car, smoking] = ([[1300, 60, 1], [1380, 30, 0.2]] as const).map(([s, speed, health], k) => {
        const c = new Car(k);
        c.placeOnTrack(track, s, lineAt(line, s).d);
        c.vx = track.tx[c.trackIdx] * speed;
        c.vy = track.ty[c.trackIdx] * speed;
        c.health = health;
        w.addCar(c, new TrafficRacer({ ...racerStyle(0.5, 0.5, () => 0.5).style, pass: Infinity }));
        return c;
      });
      for (let t = 0; t < 10; t += P.DT) { smoking.health = 0.2; w.step(); }
      expect(car.dist).toBeGreaterThan(smoking.dist);
      expect(car.lastImpact).toBeNull();
    });
  });
});
