import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from '../src/ai/drivers';
import { Rng } from '../src/ai/rng';
import { Session } from '../src/events/session';
import { Car } from '../src/sim/car';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import type { TrackLayout } from '../src/sim/layout';
import { chicane, generateLayout, integrate, rovalLayouts, venueLayouts } from '../src/trackgen';
import { validateLayout } from '../src/trackgen/validate';
import { multiLayoutVenue, venueSeries } from '../src/venue/venue';

/** The first generated superspeedways with road courses through their infields. */
function withRovals(count: number): TrackLayout[] {
  const out: TrackLayout[] = [];
  for (let seed = 1; out.length < count && seed < 60; seed++) {
    const layout = generateLayout({ type: 'oval', seed, variant: 'superspeedway' });
    if (layout.infield.rovals?.length) out.push(layout);
  }
  return out;
}
const ovals = withRovals(2);

describe('road courses through the infield', () => {
  it('lays a bus-stop chicane that ends back on its line', () => {
    const { sections, length } = chicane(new Rng(3), 24, 13);
    const { end, points } = integrate(sections, 0, 0, 0);
    expect(Math.abs(end.y)).toBeLessThan(1e-6);
    expect(Math.abs(end.h)).toBeLessThan(1e-9);
    expect(end.x).toBeCloseTo(length, 6);
    expect(Math.max(...points.map((p) => p[1]))).toBeGreaterThan(20); // into the infield
  });

  it('compiles road courses that run exactly on the oval where they take it in', () => {
    expect(ovals.length).toBeGreaterThan(0);
    for (const oval of ovals) {
      const o = new Track({ ...oval, neighbours: undefined });
      for (const spec of oval.infield.rovals!) {
        const layout = rovalLayouts(oval).find((l) => l.id.endsWith(spec.id))!;
        const r = new Track(layout);
        expect(layout.kind).toBe('road');
        expect(r.closureError).toBeLessThan(0.5);
        // On the oval's part of the lap, the course's line is the oval's.
        const part = o.distanceFrom(spec.join, spec.leave);
        for (let f = 0.05; f < 1; f += 0.1) {
          const [x, y] = o.toWorld(spec.join + f * part, 0);
          expect(Math.abs(r.project(x, y).d), `${layout.name} at ${f.toFixed(2)} of the oval's part`).toBeLessThan(0.5);
        }
        // Pitting on the oval's pit road, it starts on the oval's line.
        if (spec.pit === 'oval') {
          const [ox, oy] = o.toWorld(0, 0), [rx, ry] = r.toWorld(0, 0);
          expect(Math.hypot(ox - rx, oy - ry)).toBeLessThan(0.5);
        }
        expect(validateLayout(layout, r).filter((p) => p.severity === 'error')).toEqual([]);
        // The oval (and anything in its infield) is scenery round it.
        expect(layout.neighbours!.map((n) => n.id)[0]).toBe(oval.id);
      }
    }
  });

  it('closes the oval behind the road course with barriers clear of the route', () => {
    for (const oval of ovals) {
      const o = new Track({ ...oval, neighbours: undefined });
      for (const layout of rovalLayouts(oval)) {
        const r = new Track(layout);
        expect(r.barriers.length).toBeGreaterThan(0);
        for (const b of r.barriers) {
          const [[ax, ay], [bx, by]] = b.points;
          // It spans the oval's racing surface...
          const pa = o.project(ax, ay), pb = o.project(bx, by);
          expect(Math.min(pa.d, pb.d)).toBeLessThan(o.outerEdgeAt(pa.s) + 1);
          expect(Math.max(pa.d, pb.d)).toBeGreaterThan(o.innerEdgeAt(pa.s));
          // ...and stays off the road course's own surface.
          for (let t = 0; t <= 1; t += 0.05) {
            const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
            const q = r.project(x, y);
            expect(q.d > r.innerEdgeAt(q.s) + 0.5 || q.d < r.outerEdgeAt(q.s) - 0.5, `${layout.name} ${b.id}`).toBe(true);
          }
        }
      }
    }
  });

  it('can be lapped cleanly, and races to road-course rules', () => {
    const oval = ovals[0];
    const [layout] = rovalLayouts(oval);
    const t = new Track(layout);
    const world = new World(t, { collisions: false });
    const car = new Car(0);
    car.placeOnTrack(t, t.length - 20, 0);
    world.addCar(car, new ScriptedDriver(0, 0.9));
    while (car.lapsCompleted < 1 && world.time < 400) world.step();
    expect(car.lapsCompleted).toBe(1);
    expect(car.health).toBeGreaterThan(0.95);
    const race = new Session({ kind: 'race', layout, entrants: [], laps: 1, pace: 4, seed: 1, series: 'road' }).race!;
    expect(race.control!.safetyCar).toBe(true);
  });

  it('offers road racing at a venue whose infield has a road course', () => {
    const oval = ovals[0];
    const layouts = venueLayouts(oval);
    expect(layouts.some((l) => l.kind === 'road')).toBe(true);
    const venue = multiLayoutVenue(oval.id, oval.name, layouts);
    expect(venueSeries(venue).map((s) => s.id)).toContain('road');
    expect(venueSeries(venue).map((s) => s.id)).toContain('stock');
  });
});

describe('road courses leaving a banked turn', () => {
  it('peel off mid-turn, the lap\'s curvature unbroken, and lap cleanly', async () => {
    const { infieldSection, compileRoval, presetLayout } = await import('../src/trackgen');
    const oval = presetLayout('speedway');
    const t = new Track(oval);
    // From the middle of turn 1 into the infield, back onto the back straight.
    const L = t.length;
    const from = L * 0.2, to = L * 0.42;
    expect(Math.abs(t.curvatureAt(from))).toBeGreaterThan(1e-3);
    const wps: Array<[number, number]> = [t.toWorld(L * 0.28, 120), t.toWorld(L * 0.34, 70), t.toWorld(L * 0.38, 110)];
    let sections: Array<[number, number, number]> | null = null;
    for (let seed = 1; seed < 20 && !sections; seed++) sections = infieldSection(t, from, to, wps, [0, 40], new Rng(seed), 13);
    expect(sections).not.toBeNull();
    expect(sections![0][1]).toBeCloseTo(t.curvatureAt(from), 6); // eases in from the turn's own curvature
    const spec = { id: 'r', name: 'Road course', join: t.signedS(to), leave: t.signedS(from), sections: sections!, width: 13, verge: 8, character: 'power', corners: [], pit: 'oval' as const };
    const roval = new Track(compileRoval(oval, spec));
    expect(roval.closureError).toBeLessThan(0.5);
    // Banking eases off over the road's first metres rather than dropping in a step.
    const at = (s: number) => roval.bankAt(roval.indexAt(s), 0);
    expect(at(from - 5)).toBeGreaterThan(0.2);
    expect(at(from + 15)).toBeGreaterThan(0.05);
    expect(at(from + 15)).toBeLessThan(at(from - 5));
    const world = new World(roval, { collisions: false });
    const car = new Car(0);
    car.placeOnTrack(roval, roval.length - 20, 0);
    world.addCar(car, new ScriptedDriver(0, 0.9));
    while (car.lapsCompleted < 1 && world.time < 400) world.step();
    expect(car.lapsCompleted).toBe(1);
    expect(car.health).toBeGreaterThan(0.95);
  });
});
