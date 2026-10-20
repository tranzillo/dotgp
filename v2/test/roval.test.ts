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
/** The track a road course is cut from: the speedway, or the inner oval in its infield. */
const hostOf = (oval: TrackLayout, host?: 'inner') => new Track({
  ...(host === 'inner' ? oval.neighbours!.find((n) => n.id.endsWith('/inner'))! : oval), neighbours: undefined,
});

describe('road courses through the infield', () => {
  it('lays a bus-stop chicane that ends back on its line', () => {
    const { sections, length } = chicane(new Rng(3), 24, 13);
    const { end, points } = integrate(sections, 0, 0, 0);
    expect(Math.abs(end.y)).toBeLessThan(1e-6);
    expect(Math.abs(end.h)).toBeLessThan(1e-9);
    expect(end.x).toBeCloseTo(length, 6);
    expect(Math.max(...points.map((p) => p[1]))).toBeGreaterThan(20); // into the infield
  });

  it('compiles road courses that run exactly on the track they are cut from where they take it in', () => {
    expect(ovals.length).toBeGreaterThan(0);
    for (const oval of ovals) {
      for (const spec of oval.infield.rovals!) {
        const o = hostOf(oval, spec.host);
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
        expect(layout.neighbours!.map((n) => n.id)).toContain(oval.id);
      }
    }
  });

  it('closes the track it is cut from behind the road course with barriers clear of the route', () => {
    for (const oval of ovals) {
      for (const layout of rovalLayouts(oval)) {
        const spec = oval.infield.rovals!.find((sp) => layout.id.endsWith(`/${sp.id}`))!;
        const o = hostOf(oval, spec.host);
        const r = new Track(layout);
        expect(r.barriers.length).toBeGreaterThan(0);
        for (const b of r.barriers) {
          const [[ax, ay], [bx, by]] = b.points;
          // Across the oval where the course leaves and rejoins it, spanning its racing surface (the others close the
          // venue's other road courses where they part from this one)...
          if (!b.id.includes('-closed-')) {
            const pa = o.project(ax, ay), pb = o.project(bx, by);
            expect(Math.min(pa.d, pb.d)).toBeLessThan(o.outerEdgeAt(pa.s) + 1);
            expect(Math.max(pa.d, pb.d)).toBeGreaterThan(o.innerEdgeAt(pa.s));
          }
          // ...and all off the road course's own surface.
          for (let t = 0; t <= 1; t += 0.05) {
            const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
            const q = r.project(x, y);
            expect(q.d > r.innerEdgeAt(q.s) + 0.5 || q.d < r.outerEdgeAt(q.s) - 0.5, `${layout.name} ${b.id}`).toBe(true);
          }
        }
      }
    }
  });

  it("makes its layouts cross-sections of one road network, each different, each the others' scenery", () => {
    let found = false;
    for (let seed = 1; seed < 40 && !found; seed++) {
      const oval = generateLayout({ type: 'oval', seed, variant: 'speedway' });
      const specs = oval.infield.rovals ?? [];
      if (specs.length < 2) continue;
      found = true;
      expect(specs[0].name).toBe('Grand Prix');
      expect(new Set(specs.map((sp) => sp.name)).size).toBe(specs.length);
      const layouts = rovalLayouts(oval);
      const laps = layouts.map((l) => {
        const t = new Track({ ...l, neighbours: undefined });
        const pts: Array<[number, number]> = [];
        for (let s = 0; s < t.length; s += 10) pts.push(t.toWorld(s, 0));
        return pts;
      });
      const shareOf = (a: Array<[number, number]>, b: Array<[number, number]>) =>
        a.filter(([x, y]) => b.some(([u, v]) => Math.hypot(x - u, y - v) < 3)).length / a.length;
      laps.forEach((lap, i) => {
        // Each shares road with another beyond the front stretch (the network's), and none is another with a detour.
        const shares = laps.map((other, j) => (j === i ? 0 : shareOf(lap, other)));
        expect(Math.max(...shares), layouts[i].name).toBeGreaterThan(0.25);
        laps.forEach((other, j) => { if (j !== i) expect(shares[j] > 0.88 && shareOf(other, lap) > 0.88, `${layouts[i].name} ~ ${layouts[j].name}`).toBe(false); });
      });
      for (const layout of layouts) {
        const others = layout.neighbours!.map((n) => n.id);
        for (const other of layouts) if (other !== layout) expect(others).toContain(other.id);
        expect(layout.barriers!.some((b) => b.id.includes('-closed-'))).toBe(true);
      }
      // The oval's own layout has them as scenery, without their barriers across it.
      const oval0 = venueLayouts(oval)[0];
      expect(oval0.neighbours!.filter((n) => n.kind === 'road')).toHaveLength(specs.length);
      expect(oval0.neighbours!.every((n) => !n.barriers?.length)).toBe(true);
    }
    expect(found).toBe(true);
  });

  it('lays a road course across an infield too small for an inner oval', () => {
    let found = false;
    for (let seed = 1; seed < 30 && !found; seed++) {
      const oval = generateLayout({ type: 'oval', seed, variant: 'intermediate' });
      if (!oval.infield.rovals?.length) continue;
      found = true;
      for (const layout of rovalLayouts(oval)) expect(validateLayout(layout, new Track(layout)).filter((p) => p.severity === 'error')).toEqual([]);
    }
    expect(found).toBe(true);
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
