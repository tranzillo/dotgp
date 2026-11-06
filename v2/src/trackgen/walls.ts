import { G, PHYSICS as P, SURFACES } from '../sim/constants';
import type { Profile, TrackLayout, TrackRect, Wall } from '../sim/layout';
import type { Track } from '../sim/track';
import { ringSpeeds } from './roval';

/**
 * A venue's walls in its infield, each there for a reason: to stop a car that
 * leaves a track from reaching something it would hit. A car that runs off a
 * bend goes on along its heading from the outside edge at the speed it was
 * doing, and slides on the grass until it stops (its grip and rolling drag,
 * and the air's); if what it would cross on the way is another layout's track
 * (where cars race) or a garage or parking lot, a wall stands at that thing's
 * edge where the cars would come. Open grass everywhere else. Two layouts
 * aren't each other's hazard where they share road (a junction is no wall).
 */

/** Grid of who owns the ground (2 m). */
const CELL = 2;
/** Sampled every this far along each layout. */
const STEP = 4;
/** Where two layouts share road within this far either way, they are one road there. */
const SHARED = 60;
/** Nor is one another's hazard within this far of where it runs on it (where it leaves it and where it rejoins). */
const JUNCTION = 100;
/** A wall reaches this far past the stretch the cars would come at it, and stands this far off the edge. */
const PAD = 10, OFF = 2;

/** Distance (m) a car sliding on grass needs to stop from v (m/s): its grip and rolling drag, and the air's. */
function stopOnGrass(v: number): number {
  const grass = SURFACES.grass;
  let x = 0;
  for (let u = v; u > 1;) {
    const a = (grass.grip + grass.rolling) * G + (0.5 * P.AIR_DENSITY * P.CDA * u * u) / P.DRY_MASS;
    const du = 0.5;
    x += (u * du) / a; // dx = v dv / a
    u -= du;
  }
  return x;
}

/** What a hazard hit is: another layout's surface (its index), or a lot of one (its index and the rect). */
interface Hit { y: number; s: number; side: 1 | -1; rect?: TrackRect }

/**
 * The walls each layout of a venue gets (in its own frame), from every other layout's cars running off at it.
 * `tracks[i]` is layout i's track (its own lap, no neighbours).
 */
export function hazardWalls(all: TrackLayout[], tracks: Track[]): Wall[][] {
  const n = all.length;
  // ---- who owns the ground: each layout's surface (racing surface, apron and pit road), and each lot ----
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tracks) {
    minX = Math.min(minX, t.extent.minX); minY = Math.min(minY, t.extent.minY);
    maxX = Math.max(maxX, t.extent.maxX); maxY = Math.max(maxY, t.extent.maxY);
  }
  minX -= 50; minY -= 50; maxX += 50; maxY += 50;
  const nx = Math.ceil((maxX - minX) / CELL) + 1, ny = Math.ceil((maxY - minY) / CELL) + 1;
  const owner = new Uint32Array(nx * ny);
  const lotAt = new Int32Array(nx * ny).fill(-1);
  const cellOf = (x: number, y: number) => {
    const i = Math.floor((x - minX) / CELL), j = Math.floor((y - minY) / CELL);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  };
  const fill = (t: Track, s0: number, s1: number, d0: (s: number) => number, d1: (s: number) => number, mark: (c: number) => void) => {
    for (let s = s0; s <= s1; s += CELL / 2) {
      const a = d0(s), b = d1(s);
      for (let d = Math.min(a, b); d <= Math.max(a, b); d += CELL / 2) {
        const c = cellOf(...t.toWorld(s, d));
        if (c >= 0) mark(c);
      }
    }
  };
  tracks.forEach((t, i) => fill(t, 0, t.length, (s) => t.outerEdgeAt(s), (s) => Math.max(t.innerEdgeAt(s), t.pavedInnerD(s)), (c) => { owner[c] |= 1 << i; }));
  const lots: Array<{ y: number; rect: TrackRect }> = [];
  all.forEach((l, i) => {
    if (l.kind === 'road') return;
    const rects = [l.infield.garage.lot, ...l.decor.flatMap((d) => (d.kind === 'bays' ? [d.rect] : []))];
    for (const rect of rects) {
      const k = lots.push({ y: i, rect }) - 1;
      fill(tracks[i], rect.s0, rect.s1, () => rect.d0, () => rect.d1, (c) => { lotAt[c] = k; });
    }
  });

  // ---- where each layout runs on another (by the other's s, every STEP m, JUNCTION m either way): no hazard to it there,
  // whichever end of the stretch it is, leaving or rejoining ----
  const near: Uint8Array[][] = tracks.map(() => tracks.map((y) => new Uint8Array(Math.ceil(y.length / STEP) + 1)));
  tracks.forEach((t, x) => {
    for (let s = 0; s < t.length; s += STEP) {
      const [px, py] = t.toWorld(s, 0), c = cellOf(px, py);
      if (c < 0) continue;
      tracks.forEach((y, yi) => {
        if (yi === x || !(owner[c] & (1 << yi))) return;
        const q = y.near(px, py, y.reach);
        if (!q || Math.abs(q.d) > 3) return;
        const m = near[x][yi].length - 1, k0 = Math.round(q.s / STEP), w = Math.round(JUNCTION / STEP);
        for (let j = -w; j <= w; j++) near[x][yi][(((k0 + j) % m) + m) % m] = 1;
      });
    }
  });
  const atJunction = (x: number, y: number, s: number) => {
    const m = near[x][y].length - 1;
    return near[x][y][(((Math.round(s / STEP)) % m) + m) % m] === 1;
  };

  const hits: Hit[][] = Array.from({ length: n }, () => []);
  tracks.forEach((t, x) => {
    const speed = ringSpeeds(t, (s) => t.bankAt(t.indexAt(s), 0));
    const m = Math.floor(t.length / STEP);
    // Which layouts this one runs on, sample by sample (its line on their surface), and so shares road with nearby.
    const on = Array.from({ length: m }, (_, k) => { const c = cellOf(...t.toWorld(k * STEP, 0)); return c < 0 ? 0 : owner[c]; });
    const w = Math.round(SHARED / STEP);
    for (let k = 0; k < m; k++) {
      const s = k * STEP, curv = t.curvatureAt(s);
      if (Math.abs(curv) < 1e-4) continue;
      // Off the outside of the bend (a left-hander's outside is its right, -d), along its heading; unless its own wall
      // stands there (an oval's outer wall): it stops the car.
      const side = curv > 0 ? -1 : 1;
      const edge = side > 0 ? t.innerEdgeAt(s) : t.outerEdgeAt(s);
      if (all[x].walls.some((wl) => t.inRange(s, wl.range) && Math.abs((typeof wl.d === 'number' ? wl.d : t.edgeAt(wl.d, s)) - edge) < 6)) continue;
      let shared = 0;
      for (let j = -w; j <= w; j++) shared |= on[(k + j + m) % m];
      const [ax, ay] = t.toWorld(s, side > 0 ? t.innerEdgeAt(s) : t.outerEdgeAt(s));
      const [bx, by] = t.toWorld(s + 1, side > 0 ? t.innerEdgeAt(s + 1) : t.outerEdgeAt(s + 1));
      const len = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / len, uy = (by - ay) / len;
      const reach = stopOnGrass(speed(s));
      for (let r = CELL; r <= reach; r += CELL) {
        const px = ax + ux * r, py = ay + uy * r, c = cellOf(px, py);
        if (c < 0) break;
        const others = owner[c] & ~(1 << x) & ~shared;
        if (others) {
          const y = 31 - Math.clz32(others & -others);
          const q = tracks[y].near(px, py, tracks[y].reach);
          if (q && !atJunction(x, y, q.s)) hits[y].push({ y, s: q.s, side: q.d > 0 ? 1 : -1 });
          break;
        }
        if (owner[c] & (1 << x)) continue; // (still on its own surface)
        const lot = lotAt[c];
        if (lot >= 0) {
          const { y, rect } = lots[lot];
          const q = tracks[y].near(px, py, tracks[y].reach);
          if (q) hits[y].push({ y, s: q.s, side: q.d - rect.d0 < rect.d1 - q.d ? -1 : 1, rect });
          break;
        }
      }
    }
  });

  // ---- each layout's walls: runs of hits along one edge (or one side of one lot), padded ----
  return hits.map((list, y) => {
    const t = tracks[y], L = t.length;
    const walls: Wall[] = [];
    const groups = new Map<string, Hit[]>();
    for (const h of list) {
      const key = `${h.side}:${h.rect ? lots.findIndex((l) => l.rect === h.rect) : 'edge'}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(h);
    }
    for (const [key, hs] of groups) {
      // (Along the lap from the widest gap between hits, so a run round the start isn't split.)
      const ss = hs.map((h) => ((h.s % L) + L) % L).sort((a, b) => a - b);
      let gapAt = 0, gap = -1;
      ss.forEach((v, i) => { const g = (i + 1 < ss.length ? ss[i + 1] : ss[0] + L) - v; if (g > gap) { gap = g; gapAt = i; } });
      const order = [...ss.slice(gapAt + 1), ...ss.slice(0, gapAt + 1).map((v) => v + L)];
      const runs: Array<[number, number]> = [];
      for (const v of order) {
        const last = runs[runs.length - 1];
        if (last && v - last[1] < 3 * PAD) last[1] = v; else runs.push([v, v]);
      }
      const { side, rect } = hs[0];
      runs.forEach(([a, b], r) => {
        let s0 = a - PAD, s1 = b + PAD;
        if (rect) { s0 = Math.max(s0, rect.s0); s1 = Math.min(s1, rect.s1); }
        if (s1 - s0 < 2 * PAD) return;
        const at = (s: number) => (rect
          ? (side > 0 ? rect.d1 + OFF : rect.d0 - OFF)
          : side > 0 ? Math.max(t.innerEdgeAt(s), t.pavedInnerD(s)) + OFF : t.outerEdgeAt(s) - OFF);
        const keys: Array<[number, number]> = [];
        for (let s = s0; s < s1; s += 5) keys.push([t.signedS(s), at(s)]);
        keys.push([t.signedS(s1), at(s1)]);
        keys.sort((p, q) => p[0] - q[0]);
        const d: Profile = { keys: keys.filter((k, i) => i === 0 || k[0] - keys[i - 1][0] > 1e-6), ease: 'linear' };
        walls.push({ id: `guard-${key.replace(/[:]/g, '')}-${r}`, range: [t.signedS(s0), t.signedS(s0) + (s1 - s0)], d, thickness: 0.8, faces: 'both', caps: true, attenuators: true });
      });
    }
    return walls;
  });
}
