import type { Road, RoadNetwork, RoadNode } from './layout';
import type { Track } from './track';

/**
 * Everywhere a service vehicle can drive, as a road network: the layout's
 * own roads, and every other drivable surface they join.
 *
 *   - the garage lot, paved round its buildings, crossed between any of its
 *     nodes (the garage's lanes from pit road, its back gate on the service
 *     road): from its parking, trucks reach pit road
 *   - the venue's other tracks: road courses off the oval's pavement, and an
 *     inner oval, where their ends meet the oval's pavement ways onto it
 *   - a junction wherever two roads cross (the layout lays roads across
 *     courses with nowhere to turn)
 *
 * One-way roads (pit road's entry and exit) can be driven against the flow
 * at a cost (RoadGraph's wrongWay).
 */
export function serviceNetwork(t: Track, base: RoadNetwork): RoadNetwork {
  const nodes: RoadNode[] = [...base.nodes];
  const roads: Road[] = [...base.roads];
  const areas = [...(base.areas ?? [])];

  // ---- the garage lot: lanes down the clear strips between its rows of buildings and along its edges, across
  // between them at every gap, and whatever already reaches into it (the garage's lanes from pit road, its back gate
  // on the service road) joined to the nearest ----
  const lot = t.infield.garage.lot;
  const buildings = t.layout.decor.flatMap((dec) => (dec.kind === 'building' ? [dec.rect] : []))
    .filter((b) => b.s0 >= lot.s0 - 1 && b.s1 <= lot.s1 + 1 && b.d0 >= lot.d0 - 1 && b.d1 <= lot.d1 + 1);
  const rows = [...new Set(buildings.map((b) => `${b.d0},${b.d1}`))].map((r) => r.split(',').map(Number)).sort((a, b) => a[0] - b[0]);
  const lanesD: number[] = [];
  let free = lot.d0;
  for (const [r0, r1] of [...rows, [lot.d1, lot.d1]]) {
    if (r0 - free > 3) lanesD.push((free + r0) / 2);
    free = Math.max(free, r1);
  }
  const gapsS = new Set<number>([lot.s0 + LOT_INSET, lot.s1 - LOT_INSET]);
  for (const [r0] of rows) {
    const row = buildings.filter((b) => b.d0 === r0).sort((a, b) => a.s0 - b.s0);
    for (let i = 0; i + 1 < row.length; i++) if (row[i + 1].s0 - row[i].s1 > 4) gapsS.add((row[i].s1 + row[i + 1].s0) / 2);
    if (row.length) { gapsS.add((lot.s0 + row[0].s0) / 2); gapsS.add((row[row.length - 1].s1 + lot.s1) / 2); }
  }
  const across = [...gapsS].sort((a, b) => a - b);
  const lotNode = (li: number, gi: number) => `lot-${li}-${gi}`;
  lanesD.forEach((d, li) => across.forEach((s, gi) => nodes.push({ id: lotNode(li, gi), kind: 'junction', at: t.toWorld(s, d) })));
  const lane = (s0: number, s1: number, d: number) => {
    const pts: Array<[number, number]> = [];
    const steps = Math.max(1, Math.ceil(Math.abs(s1 - s0) / 8));
    for (let j = 0; j <= steps; j++) pts.push(t.toWorld(s0 + ((s1 - s0) * j) / steps, d));
    return pts;
  };
  lanesD.forEach((d, li) => across.forEach((s, gi) => {
    if (gi + 1 < across.length) {
      roads.push({ id: `lot-lane-${li}-${gi}`, from: lotNode(li, gi), to: lotNode(li, gi + 1), points: lane(s, across[gi + 1], d), width: LOT_LANE, grade: 'garage' });
    }
    if (li + 1 < lanesD.length) {
      roads.push({ id: `lot-across-${li}-${gi}`, from: lotNode(li, gi), to: lotNode(li + 1, gi), points: [t.toWorld(s, d), t.toWorld(s, lanesD[li + 1])], width: LOT_LANE, grade: 'garage' });
    }
  }));
  // Gates from the front of the lot down to pit road, at every way across it: from its parking, either end of pit road.
  // (Not just by where a road through the pit wall leaves pit road: two turns too close together to make. Unless
  // that leaves none.)
  const pitRoads = base.roads.filter((r) => r.grade === 'pit' && !/^gate\d+[ab]$/.test(r.id));
  const wallGates = base.nodes.filter((n) => /^pit-gate\d+[ab]$/.test(n.id));
  const lotGates: Array<{ gi: number; from: [number, number]; to: [number, number] }> = [];
  if (lanesD.length) {
    across.forEach((s, gi) => {
      const [gx, gy] = t.toWorld(s, lanesD[0]);
      let best: [number, number] | null = null, bestD = GATE_REACH;
      for (const r of pitRoads) {
        for (let j = 0; j + 1 < r.points.length; j++) {
          const [ax, ay] = r.points[j], [bx, by] = r.points[j + 1];
          const vx = bx - ax, vy = by - ay;
          const f = Math.max(0, Math.min(1, ((gx - ax) * vx + (gy - ay) * vy) / (vx * vx + vy * vy || 1)));
          const px = ax + vx * f, py = ay + vy * f, dist = Math.hypot(gx - px, gy - py);
          if (dist < bestD) { bestD = dist; best = [px, py]; }
        }
      }
      if (best) lotGates.push({ gi, from: [gx, gy], to: best });
    });
  }
  const clearOf = (p: [number, number]) => wallGates.every((n) => Math.hypot(n.at[0] - p[0], n.at[1] - p[1]) >= LOT_GATE_CLEAR);
  const kept = lotGates.some((g) => clearOf(g.to)) ? lotGates.filter((g) => clearOf(g.to)) : lotGates;
  for (const { gi, from, to } of kept) {
    const id = `lot-gate-${gi}`;
    nodes.push({ id, kind: 'junction', at: to });
    roads.push({ id, from: lotNode(0, gi), to: id, points: [from, to], width: LOT_LANE, grade: 'garage' });
  }
  const inLot = (p: [number, number]) => {
    const q = t.near(p[0], p[1], t.reach);
    return !!q && q.d >= lot.d0 - 3 && q.d <= lot.d1 + 3 && t.inRange(q.s, [lot.s0 - 3, lot.s1 + 3]);
  };
  for (const n of base.nodes) {
    if (!inLot(n.at)) continue;
    let near: RoadNode | null = null, nearD = Infinity;
    for (const m of nodes) {
      if (!m.id.startsWith('lot-')) continue;
      const dist = Math.hypot(m.at[0] - n.at[0], m.at[1] - n.at[1]);
      if (dist < nearD) { nearD = dist; near = m; }
    }
    if (near && nearD > 0.5) roads.push({ id: `lot-join-${n.id}`, from: n.id, to: near.id, points: [n.at, near.at], width: LOT_LANE, grade: 'garage' });
  }

  // ---- the venue's other tracks, off this one's pavement ----
  t.neighbours.forEach((nb, i) => {
    const onPavement = (x: number, y: number) => {
      const q = t.near(x, y, t.reach);
      return !!q && q.d >= t.outerEdgeAt(q.s) - 2 && q.d <= t.pavedInnerD(q.s) + 1;
    };
    // Its centerline every few metres, in pieces between where it's on this track's pavement.
    const pts: Array<[number, number]> = [];
    for (let s = 0; s < nb.length; s += COURSE_STEP) pts.push(nb.toWorld(s, 0));
    const closed = !pts.some(([x, y]) => onPavement(x, y));
    const pieces: Array<Array<[number, number]>> = [];
    if (closed) {
      // A loop of its own (an inner oval): two halves between two nodes.
      const half = Math.floor(pts.length / 2);
      pieces.push(pts.slice(0, half + 1), [...pts.slice(half), pts[0]]);
    } else {
      // Starting somewhere on the pavement, so no piece wraps round the start.
      // (Each piece from its last point on the pavement to its first back on it: its ends at the pavement's edge.)
      const start = pts.findIndex(([x, y]) => onPavement(x, y));
      let piece: Array<[number, number]> = [], last = pts[start];
      for (let j = 1; j <= pts.length; j++) {
        const p = pts[(start + j) % pts.length];
        if (!onPavement(p[0], p[1])) { if (!piece.length) piece.push(last); piece.push(p); continue; }
        if (piece.length > 1) pieces.push([...piece, p]);
        piece = [];
        last = p;
      }
    }
    pieces.forEach((piece, j) => {
      const end = (p: [number, number], which: string): string => {
        const id = `nb${i}-${j}${which}`;
        const q = t.near(p[0], p[1], t.reach);
        // (An end at the oval's pavement is a way onto it.)
        const atOval = !closed && !!q && q.d <= t.pavedInnerD(q.s) + COURSE_STEP + 2;
        nodes.push(atOval ? { id, kind: 'apron', at: p, s: t.signedS(q!.s) } : { id, kind: 'junction', at: p });
        return id;
      };
      const from = closed && j === 1 ? `nb${i}-0b` : end(piece[0], 'a');
      const to = closed && j === 1 ? `nb${i}-0a` : end(piece[piece.length - 1], 'b');
      roads.push({ id: `nb${i}-${j}`, from, to, points: piece, width: COURSE_WIDTH, grade: 'course' });
    });
  });

  return planarized({ nodes, roads, areas });
}

/** Where a truck can drive a road against its one-way flow, its length counts this many times over. */
export const WRONG_WAY = 2.5;
const LOT_INSET = 5;
const LOT_LANE = 7;
/** Pit road within this far of the front of the garage lot gets gates to it (m). */
const GATE_REACH = 30;
/** ...but none nearer than this to where a road through the pit wall leaves pit road (m). */
const LOT_GATE_CLEAR = 25;
const COURSE_STEP = 5;
const COURSE_WIDTH = 10;

/**
 * The network with a junction wherever two of its roads cross (or one ends
 * on another without a node there): each road split at its crossings.
 */
function planarized(net: RoadNetwork): RoadNetwork {
  type Seg = { r: number; k: number; ax: number; ay: number; bx: number; by: number };
  const segs: Seg[] = [];
  net.roads.forEach((road, r) => {
    for (let k = 0; k + 1 < road.points.length; k++) {
      const [ax, ay] = road.points[k], [bx, by] = road.points[k + 1];
      segs.push({ r, k, ax, ay, bx, by });
    }
  });
  // Buckets of segments by grid cell.
  const cell = 25, grid = new Map<string, number[]>();
  segs.forEach((g, i) => {
    for (let cx = Math.floor(Math.min(g.ax, g.bx) / cell); cx <= Math.floor(Math.max(g.ax, g.bx) / cell); cx++) {
      for (let cy = Math.floor(Math.min(g.ay, g.by) / cell); cy <= Math.floor(Math.max(g.ay, g.by) / cell); cy++) {
        const key = `${cx},${cy}`;
        (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
      }
    }
  });
  /** Cuts per road: where along it (segment, fraction) and the node there. */
  const cuts = new Map<number, Array<{ k: number; f: number; node: string }>>();
  const cut = (r: number, k: number, f: number, node: string) => (cuts.get(r) ?? cuts.set(r, []).get(r)!).push({ k, f, node });
  const nodes = [...net.nodes];
  const seen = new Set<string>();
  const EPS = 1e-6, END = 0.5; // (m: an end this near another road's middle meets it)
  let x = 0;
  for (const ids of grid.values()) {
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const A = segs[ids[a]], B = segs[ids[b]];
        if (A.r === B.r) continue;
        const pair = ids[a] < ids[b] ? `${ids[a]}|${ids[b]}` : `${ids[b]}|${ids[a]}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const rx = A.bx - A.ax, ry = A.by - A.ay, sx = B.bx - B.ax, sy = B.by - B.ay;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < EPS) continue; // parallel
        const qx = B.ax - A.ax, qy = B.ay - A.ay;
        const ta = (qx * sy - qy * sx) / den, tb = (qx * ry - qy * rx) / den;
        const la = Math.hypot(rx, ry), lb = Math.hypot(sx, sy);
        const ea = END / la, eb = END / lb;
        if (ta < -ea || ta > 1 + ea || tb < -eb || tb > 1 + eb) continue;
        const roadA = net.roads[A.r], roadB = net.roads[B.r];
        // (The two roads through a gate in the pit wall cross in it, each its own way through: no turning from one onto
        // the other there, back the way it came.)
        const gate = (road: Road) => /^gate(\d+)[ab]$/.exec(road.id)?.[1];
        if (gate(roadA) !== undefined && gate(roadA) === gate(roadB)) continue;
        // An end of a road (its first or last point) meeting the other: that end's node is the junction.
        const endOf = (road: Road, seg: Seg, t: number, e: number) =>
          seg.k === 0 && t <= e ? road.from : seg.k === road.points.length - 2 && t >= 1 - e ? road.to : null;
        const na = endOf(roadA, A, ta, ea), nb = endOf(roadB, B, tb, eb);
        if (na && nb) continue; // (two ends meeting: joined already, or the layout means them apart)
        // (Through a bend: the segment it starts claims it, so it's found once.)
        if (!na && (ta < -1e-9 || ta >= 1 - 1e-9)) continue;
        if (!nb && (tb < -1e-9 || tb >= 1 - 1e-9)) continue;
        const node = na ?? nb ?? `x${x++}`;
        if (!na && !nb) nodes.push({ id: node, kind: 'junction', at: [A.ax + rx * ta, A.ay + ry * ta] });
        if (!na) cut(A.r, A.k, Math.max(0, Math.min(1, ta)), node);
        if (!nb) cut(B.r, B.k, Math.max(0, Math.min(1, tb)), node);
      }
    }
  }
  const roads: Road[] = [];
  net.roads.forEach((road, r) => {
    const cs = (cuts.get(r) ?? []).sort((p, q) => p.k - q.k || p.f - q.f);
    if (!cs.length) { roads.push(road); return; }
    const at = new Map(nodes.map((n) => [n.id, n.at]));
    let from = road.from, pts: Array<[number, number]> = [road.points[0]], piece = 0, k = 0;
    for (const c of cs) {
      for (; k < c.k; k++) pts.push(road.points[k + 1]);
      if (c.node === from) continue;
      pts.push(at.get(c.node)!);
      roads.push({ ...road, id: `${road.id}~${piece++}`, from, to: c.node, points: pts });
      from = c.node;
      pts = [at.get(c.node)!];
    }
    for (; k < road.points.length - 1; k++) pts.push(road.points[k + 1]);
    roads.push({ ...road, id: `${road.id}~${piece}`, from, to: road.to, points: pts });
  });
  return { nodes, roads, areas: net.areas };
}
