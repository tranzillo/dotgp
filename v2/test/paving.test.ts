import { describe, expect, it } from 'vitest';
import { pave, roundPolyline } from '../src/trackgen/paving';

type P = [number, number];
const area = (ring: P[]) => Math.abs(ring.reduce((a, [x, y], i) => { const [u, v] = ring[(i + 1) % ring.length]; return a + x * v - u * y; }, 0)) / 2;
const inside = (rings: P[][], x: number, y: number) => {
  let n = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j], [x1, y1] = ring[i];
      if ((y0 > y) !== (y1 > y) && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) n = !n;
    }
  }
  return n;
};

describe('paving', () => {
  it('joins crossing roads into one area, its edge traced once', () => {
    const rings = pave([
      { kind: 'path', points: [[-100, 0], [100, 0]], width: 8 },
      { kind: 'path', points: [[0, -100], [0, 100]], width: 8 },
    ], { fillet: 4 });
    expect(rings).toHaveLength(1);
    // The two roads' area (round-ended), the crossing counted once, a little more for the four fillets.
    const roads = 2 * 200 * 8 - 64 + 4 * (Math.PI * 16) / 2;
    const a = area(rings[0]);
    expect(a).toBeGreaterThan(roads);
    expect(a).toBeLessThan(roads + 4 * 20);
    expect(inside(rings, 50, 0)).toBe(true);
    expect(inside(rings, 50, 10)).toBe(false);
  });

  it('fillets the inside corners where a road meets another', () => {
    const t = (fillet: number) => pave([
      { kind: 'path', points: [[-100, 0], [100, 0]], width: 8 },
      { kind: 'path', points: [[0, 0], [0, 100]], width: 8 },
    ], { fillet });
    // Just off both roads' edges, in the corner between them: grass at a sharp join, paved at a filleted one.
    expect(inside(t(0.01), 5, 5)).toBe(false);
    expect(inside(t(6), 5, 5)).toBe(true);
    // Away from the join, the edges are where the roads put them.
    expect(inside(t(6), 50, 5)).toBe(false);
  });

  it('never swells a road where its pieces overlap or run on from each other, nor opposite a junction', () => {
    // Two pieces of one road, overlapping end to end: as wide there as anywhere (8 m).
    const run = pave([
      { kind: 'path', points: [[0, 0], [100, 0]], width: 8 },
      { kind: 'path', points: [[90, 0], [200, 0]], width: 8 },
    ]);
    for (const x of [50, 95, 100, 150]) {
      expect(inside(run, x, 3.5), `at ${x}`).toBe(true);
      expect(inside(run, x, 4.8), `at ${x}`).toBe(false);
    }
    // A road meeting another: across the road from the branch, the edge stays straight.
    const tee = pave([
      { kind: 'path', points: [[-100, 0], [100, 0]], width: 8 },
      { kind: 'path', points: [[0, 0], [0, 100]], width: 8 },
    ]);
    expect(inside(tee, 0, -4.8)).toBe(false);
    // (The fillet on the branch's side: between the edges and an arc of 8 m round (12, 12).)
    expect(inside(tee, 5, 5)).toBe(true);
    expect(inside(tee, 9, 9)).toBe(false);
  });

  it('traces a fillet as a smooth arc, the grid not showing in it', () => {
    // A road meeting another at a right angle (at an odd angle to the grid): the fillet an arc of 8 m. Its traced edge
    // turns one way only from the one road's edge round to the other's, no wobble (the 1 m grid's steps smoothed out),
    // and keeps close to the arc.
    const a = 0.37, c = Math.cos(a), sn = Math.sin(a), rot = ([x, y]: P): P => [c * x - sn * y, sn * x + c * y];
    const back = ([x, y]: P): P => [c * x + sn * y, -sn * x + c * y];
    const rings = pave([
      { kind: 'path', points: [rot([-100, 0]), rot([100, 0])], width: 8 },
      { kind: 'path', points: [rot([0, 0]), rot([0, 100])], width: 8 },
    ], { fillet: 8 });
    // (In the junction's own frame: the corner between the edges y = 4 and x = 4, from where the arc leaves the one
    // straight edge round to where it joins the other.)
    const ring = rings[0].map(back);
    let k0 = -1;
    ring.forEach(([x, y], k) => { if (Math.abs(y - 4) < 0.3 && x > 12 && x < 60 && (k0 < 0 || x < ring[k0][0])) k0 = k; });
    expect(k0).toBeGreaterThanOrEqual(0);
    const dir = ring[(k0 + 1) % ring.length][0] < ring[k0][0] ? 1 : -1; // (towards the corner)
    const path: P[] = [];
    for (let k = k0; path.length < ring.length; k = (k + dir + ring.length) % ring.length) {
      path.push(ring[k]);
      if (Math.abs(ring[k][0] - 4) < 0.3 && ring[k][1] > 12) break;
    }
    expect(path.length).toBeGreaterThan(5);
    const turns = path.slice(1, -1).map((p, i) => {
      const [p0, p1] = [path[i], path[i + 2]];
      return (p[0] - p0[0]) * (p1[1] - p[1]) - (p[1] - p0[1]) * (p1[0] - p[0]);
    });
    const sign = Math.sign(turns.reduce((s, t) => s + t, 0));
    for (const t of turns) expect(t * sign).toBeGreaterThan(-1e-3);
    for (const [x, y] of path.filter(([x, y]) => x > 4.3 && y > 4.3 && x < 11.7 && y < 11.7)) {
      expect(Math.abs(Math.hypot(x - 12, y - 12) - 8), `(${x.toFixed(2)}, ${y.toFixed(2)})`).toBeLessThan(0.2);
    }
  });

  it('leaves the grass inside a loop of road as a hole', () => {
    const loop: P[] = [[0, 0], [200, 0], [200, 120], [0, 120], [0, 0]];
    const rings = pave([{ kind: 'path', points: roundPolyline(loop, 30), width: 8 }]);
    expect(rings).toHaveLength(2);
    expect(inside(rings, 100, 60)).toBe(false);
    expect(inside(rings, 100, 0)).toBe(true);
  });

  it('paves discs and rounded areas', () => {
    const rings = pave([
      { kind: 'disc', at: [0, 0], radius: 30 },
      { kind: 'polygon', ring: [[100, -20], [160, -20], [160, 20], [100, 20]], round: 5 },
    ]);
    expect(rings).toHaveLength(2);
    expect(area(rings.find((r) => r[0][0] < 50)!)).toBeCloseTo(Math.PI * 900, -2);
    // The area's corner is rounded: its square corner point is off it, a point just inside the arc is on it.
    expect(inside(rings, 164.5, 24.5)).toBe(false);
    expect(inside(rings, 162, 22)).toBe(true);
  });

  it('rounds a polyline\'s corners into arcs, its ends kept', () => {
    const pts = roundPolyline([[0, 0], [100, 0], [100, 100]], 20, 1);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([100, 100]);
    // No sharp turn left: heading changes by a little each metre (1/20 rad on the arc).
    for (let i = 1; i + 1 < pts.length; i++) {
      const h0 = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      const h1 = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
      expect(Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)))).toBeLessThan(0.08);
    }
    // The arc's centre is (80, 20): every arc point 20 m from it.
    const arc = pts.filter(([x, y]) => x > 80.5 && y < 19.5);
    for (const [x, y] of arc) expect(Math.hypot(x - 80, y - 20)).toBeCloseTo(20, 1);
  });
});
