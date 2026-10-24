import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from '../src/ai/drivers';
import { Car } from '../src/sim/car';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { generateLayout, venueLayouts, validateVenue, type ShapedOvalParams } from '../src/trackgen';
import { validateLayout } from '../src/trackgen/validate';
import type { TrackLayout } from '../src/sim/layout';

/**
 * Generated ovals whose infields have services (the first `count` from `seed` on): where a road course goes in, the
 * infield is the course's and the services (placeholders for now) stay out.
 */
const withServices = (variant: string, count: number, seed = 1): TrackLayout[] => {
  const out: TrackLayout[] = [];
  for (let s = seed; out.length < count && s < seed + 200; s++) {
    const layout = generateLayout({ type: 'oval', seed: s, variant });
    if (!layout.infield.rovals?.length) out.push(layout);
  }
  return out;
};
const generated = (variant: string, count: number) => withServices(variant, count).map((l) => new Track(l));

describe('infields with road courses', () => {
  const withCourses = (variant: string, count: number): TrackLayout[] => {
    const out: TrackLayout[] = [];
    for (let s = 1; out.length < count && s < 40; s++) {
      const layout = generateLayout({ type: 'oval', seed: s, variant });
      if (layout.infield.rovals?.length) out.push(layout);
    }
    return out;
  };
  const venues = [...withCourses('intermediate', 2), ...withCourses('speedway', 2), ...withCourses('superspeedway', 2)];
  /** Each venue's courses' own roads (off the ovals' pavement), every 5 m. */
  const courseRoads = (l: TrackLayout) => {
    const oval = new Track({ ...l, neighbours: undefined });
    return venueLayouts(l).filter((c) => c.kind === 'road').flatMap((c) => {
      const t = new Track({ ...c, neighbours: undefined });
      const pts: Array<[number, number]> = [];
      for (let s = 0; s < t.length; s += 5) {
        const p = t.toWorld(s, 0), q = oval.near(p[0], p[1], 120);
        if (!q || q.d > oval.pavedInnerD(q.s) + 8) pts.push(p);
      }
      return pts;
    });
  };

  it('lays the services round them as one network, every way off the oval reaching a garage', () => {
    expect(venues.length).toBeGreaterThan(4);
    for (const l of venues) {
      const t = new Track(l);
      expect(l.surfaces.some((r) => r.id === 'infield-paving'), l.name).toBe(true);
      for (const n of t.roads.accesses) expect(t.roads.pathToGarage(n.id), `${l.name} ${n.id}`).not.toBeNull();
      expect(validateLayout(l, t).filter((p) => p.severity === 'error')).toEqual([]);
    }
  });

  it('takes the service road onto a course where it would run beside one, and keeps lots off them', () => {
    for (const l of venues) {
      const course = courseRoads(l);
      const near = ([x, y]: [number, number], r: number) => course.some(([u, v]) => Math.hypot(x - u, y - v) < r);
      // No stretch of service road 100 m long a few metres off a course the whole way (crossing one, or turning onto
      // it, is short).
      for (const road of l.infield.network!.roads.filter((r) => r.grade === 'service')) {
        let run = 0, longest = 0;
        for (let i = 1; i < road.points.length; i++) {
          const [a, b] = [road.points[i - 1], road.points[i]];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          run = near(b, 25) ? run + len : 0;
          longest = Math.max(longest, run);
        }
        expect(longest, `${l.name} ${road.id}`).toBeLessThan(100);
      }
      const t = new Track({ ...l, neighbours: undefined });
      for (const d of l.decor) {
        if (d.kind !== 'bays') continue;
        const { s0, s1, d0, d1 } = d.rect;
        for (const [s, dd] of [[s0, d0], [s1, d0], [s0, d1], [s1, d1], [(s0 + s1) / 2, (d0 + d1) / 2]] as const) {
          expect(near(t.toWorld(s, dd), 8), `${l.name} lot`).toBe(false);
        }
      }
    }
  });
});

describe('generated infields', () => {
  const tracks = [...generated('short', 2), ...generated('intermediate', 2), ...generated('speedway', 2), ...generated('superspeedway', 2)];

  it('lays out a service road, escape roads and the garage as one network', () => {
    for (const t of tracks) {
      const roads = t.roads;
      const escapes = roads.roads.filter((r) => r.grade === 'escape');
      expect(escapes.length, t.name).toBeGreaterThanOrEqual(1);
      expect(roads.roads.some((r) => r.id.startsWith('ring')), t.name).toBe(true);
      // Every way off the oval leads to a garage, and the escape roads are the infield's escape lanes.
      for (const n of roads.accesses) expect(roads.pathToGarage(n.id), `${t.name} ${n.id}`).not.toBeNull();
      expect(t.infield.escapeLanes).toHaveLength(escapes.length);
      expect(validateLayout(t.layout, t).filter((p) => p.severity === 'error')).toEqual([]);
    }
  });

  it('keeps escape roads off pit road, leaving the apron before and after the turns', () => {
    for (const t of tracks) {
      for (const n of t.roads.accesses.filter((a) => a.id.startsWith('escape'))) {
        const s = n.s!;
        expect(s > t.pit.entryStart - 40 && s < t.pit.exitEnd + 20, `${t.name} ${n.id}`).toBe(false);
        const p = t.project(...n.at);
        expect(p.d).toBeGreaterThan(t.innerEdgeAt(p.s) - 1);
        expect(p.d).toBeLessThan(t.pavedInnerD(p.s));
      }
    }
  });

  it('tows wreckers from an escape road along the service road to the garage', () => {
    const t = tracks[4];
    const path = t.roads.pathToGarage('escape0')!;
    expect(path.length).toBeGreaterThan(5); // escape road, then service road, then into the garage
    const [x, y] = path[path.length - 1];
    const p = t.project(x, y);
    const lot = t.infield.garage.lot;
    expect(t.inRange(p.s, [lot.s0 - 5, lot.s1 + 5]) && p.d >= lot.d0 - 1 && p.d <= lot.d1 + 1).toBe(true);
  });

  it('sometimes puts a smaller oval in the infield: a venue of two layouts', () => {
    const found = withServices('speedway', 30).map((l) => new Track(l)).find((t) => t.neighbours.length) ?? null;
    expect(found).not.toBeNull();
    const outer = found!;
    const plan = (outer.layout.params as unknown as ShapedOvalParams).infield!;
    expect(plan.inner).not.toBeNull();
    const layouts = venueLayouts(outer.layout).filter((l) => l.kind !== 'road'); // (its road courses aside)
    expect(layouts).toHaveLength(2);
    expect(layouts[1].neighbours!.map((l) => l.id)).toEqual([outer.layout.id]);
    expect(validateVenue(layouts.map((l) => ({ ...l, neighbours: undefined })))).toEqual([]);
    // No cross-infield roads through it.
    expect(outer.roads.roads.some((r) => r.id.startsWith('link'))).toBe(false);
    // Both can be lapped, each with the other round it.
    for (const layout of layouts) {
      const t = new Track(layout);
      const world = new World(t, { collisions: false });
      const car = new Car(0);
      car.placeOnTrack(t, t.length - 20, 0);
      world.addCar(car, new ScriptedDriver(0, 0.9));
      while (car.lapsCompleted < 1 && world.time < 300) world.step();
      expect(car.lapsCompleted, t.name).toBe(1);
      expect(car.health, t.name).toBe(1);
    }
  });

  it('puts inner ovals in different places, sometimes turned across an end; and lays skidpads', () => {
    const layouts = withServices('superspeedway', 24, 100);
    const inners = layouts.flatMap((l) => l.neighbours ?? []);
    expect(inners.length).toBeGreaterThan(3);
    const places = new Set(inners.map((l) => `${Math.round(l.placement!.x / 50)},${Math.round(l.placement!.y / 50)},${l.placement!.angle}`));
    expect(places.size).toBeGreaterThan(1);
    const pads = layouts.filter((l) => l.infield.network?.nodes.some((n) => n.id === 'skidpad'));
    expect(pads.length).toBeGreaterThan(0);
    for (const l of pads) {
      const t = new Track(l);
      // Its lane reaches its rim; across the disc from there is paved (a disc you can drive on).
      const rim = l.infield.network!.nodes.find((n) => n.id === 'skidpad')!.at;
      const lane = l.infield.network!.roads.find((r) => r.id === 'skidpad-lane')!.points;
      const [ax, ay] = lane[0], ux = rim[0] - ax, uy = rim[1] - ay, len = Math.hypot(ux, uy);
      for (const into of [5, 20]) {
        const x = rim[0] + (ux / len) * into, y = rim[1] + (uy / len) * into;
        const p = t.project(x, y);
        expect(t.surfaceAt(p.s, p.d, x, y)).toBe('road');
      }
    }
  });

  it('parks lots off the service road, clear of each other and the infield\'s middle', () => {
    for (const t of tracks) {
      // (Each lot paved with the roads, its bays marked.)
      const lots = t.layout.decor.flatMap((d) => (d.kind === 'bays' ? [d.rect] : []));
      expect(lots).toHaveLength(t.layout.infield.network?.nodes.filter((n) => /^lot\d/.test(n.id)).length ?? 0);
      for (const rect of lots) {
        const [mx, my] = t.toWorld((rect.s0 + rect.s1) / 2, (rect.d0 + rect.d1) / 2);
        const m = t.project(mx, my);
        expect(t.surfaceAt(m.s, m.d, mx, my)).toBe('road');
        // The back of the lot is still on this side of the infield.
        const [x, y] = t.toWorld((rect.s0 + rect.s1) / 2, rect.d1);
        const p = t.project(x, y);
        expect(Math.abs(t.signedS(p.s - (rect.s0 + rect.s1) / 2))).toBeLessThan(1);
      }
    }
  });
});
