import { describe, expect, it } from 'vitest';
import { Rng } from '../src/ai/rng';
import { fastestLine, lineAt } from '../src/ai/racingLine';
import { followLoss, racerStyle, TrafficRacer } from '../src/ai/trafficRacer';
import { Car } from '../src/sim/car';
import { G, PHYSICS as P } from '../src/sim/constants';
import { World } from '../src/sim/world';
import { presetTrack } from '../src/trackgen';
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

describe('racing in traffic', () => {
  const track = presetTrack('speedway');
  /** Cars at [s, d across from the line (or absolute, with abs), speed]; the first is the racer's. */
  function scene(...cars: Array<[number, number, number, boolean?]>): World {
    const w = new World(track, { collisions: true, drafting: true });
    const line = fastestLine(track, racerStyle(0.5, 0.5, () => 0.5).style.margin);
    cars.forEach(([s, d, speed, abs], k) => {
      const c = new Car(k);
      c.placeOnTrack(track, s, abs ? d : lineAt(line, s).d + d);
      c.vx = track.tx[c.trackIdx] * speed;
      c.vy = track.ty[c.trackIdx] * speed;
      w.addCar(c, null as never);
    });
    return w;
  }
  const racer = () => new TrafficRacer(racerStyle(1, 0.5, () => 0.5).style);

  it('brakes for a slower car too close ahead to get beside (closer than its speed plan looks ahead, too)', () => {
    // A car closer than a quarter second dropped out of the speed plan, which floored it into that car.
    const w = scene([100, 0, 50], [105, 0, 40]);
    racer().decide(w.cars[0], w);
    expect(w.cars[0].inputX).toBeLessThan(0);
  });

  it('with room to get beside first, it pulls out with its run instead (a slingshot)', () => {
    const w = scene([100, 0, 50], [115, 0, 40]);
    const r = racer();
    r.decide(w.cars[0], w);
    expect(r.last.passing).toBe(true);
    expect(r.last.follow).toBe(Infinity); // not braked back to that car's speed
  });

  it('a car heading for pit road is crossing to the apron: a car on its inside is in its way', () => {
    const inside = track.innerEdgeAt(130) - 4;
    const w = scene([100, inside, 50, true], [130, inside - 5, 40, true]);
    const r = racer();
    r.takeOver(w.cars[0], w);
    r.decide(w.cars[0], w);
    const racing = r.last.follow;
    w.cars[1].pit.phase = 'in';
    r.decide(w.cars[0], w);
    expect(racing).toBe(Infinity); // a lane over, racing: not in the way
    expect(r.last.follow).toBeLessThan(50); // going in: it follows it
  });
});
