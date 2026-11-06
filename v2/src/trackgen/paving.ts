/**
 * Paving: an infield's roads, lots and pads as one paved area, as it would be
 * laid, rather than strokes painted over each other. Each piece is a distance
 * field (negative inside) and the area is their exact union, closed by the
 * fillet radius (grown by it, then shrunk by it again: a morphological
 * closing): where roads meet or cross, every inside corner becomes an arc of
 * that radius, and everywhere else the edge stays where the pieces put it (no
 * swelling where pieces overlap or run on from each other). It lies beneath
 * the racing surfaces (drawn under them): a road that meets or crosses a track
 * runs on under it, rather than being cut to fit. The edge is traced from the
 * field (marching squares) as even-odd rings, holes where it closes round
 * grass, and smoothed of the grid's scale. Roads themselves are rounded first:
 * a polyline's corners become arcs (roundPolyline).
 */

type P = [number, number];

export type PavePiece =
  /** A road along a polyline (round-ended), this wide. */
  | { kind: 'path'; points: P[]; width: number }
  /** A round pad (a skidpad). */
  | { kind: 'disc'; at: P; radius: number }
  /** An area inside a ring, its corners rounded by `round` (the ring given already inset by that much). */
  | { kind: 'polygon'; ring: P[]; round?: number };

export interface PaveOptions {
  /** Grid spacing (m). */
  cell?: number;
  /** Radius of the fillets where pieces meet (m). */
  fillet?: number;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
}

/** The paved area's edge: even-odd rings in world coordinates (none if nothing to pave). */
export function pave(pieces: PavePiece[], opts: PaveOptions = {}): P[][] {
  if (!pieces.length) return [];
  const cell = opts.cell ?? 1, r = Math.max(0, opts.fillet ?? 8);
  // How far from the pieces the field matters: out to the fillet (the closing grows by it; it measures back from the
  // edge it traces there, not from the field), and a little more.
  const reach = r + 3 * cell;
  const box = (pc: PavePiece, pad: number): [number, number, number, number] => {
    const pts = pc.kind === 'path' ? pc.points : pc.kind === 'disc' ? [pc.at] : pc.ring;
    const grow = (pc.kind === 'path' ? pc.width : pc.kind === 'disc' ? pc.radius : pc.round ?? 0) + pad;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
  };
  const boxes = pieces.map((pc) => box(pc, reach));
  // (Off the round metre by an odd fraction of a cell: an edge lying exactly along a grid line, all zeros, is ambiguous.)
  const gx0 = Math.min(...boxes.map((b) => b[0])) - 2 * cell + 0.371 * cell, gy0 = Math.min(...boxes.map((b) => b[1])) - 2 * cell + 0.283 * cell;
  const gx1 = Math.max(...boxes.map((b) => b[2])) + 2 * cell, gy1 = Math.max(...boxes.map((b) => b[3])) + 2 * cell;
  const nx = Math.ceil((gx1 - gx0) / cell) + 1, ny = Math.ceil((gy1 - gy0) / cell) + 1;
  const far = reach + 1;
  const xAt = (i: number) => gx0 + i * cell, yAt = (j: number) => gy0 + j * cell;

  /** A piece's field into `target` (the least of what's there and it), out to `pad` beyond it. */
  const fill = (pc: PavePiece, target: Float64Array, pad: number) => {
    const [bx0, by0, bx1, by1] = box(pc, pad);
    const i0 = Math.max(0, Math.floor((bx0 - gx0) / cell)), i1 = Math.min(nx - 1, Math.ceil((bx1 - gx0) / cell));
    const j0 = Math.max(0, Math.floor((by0 - gy0) / cell)), j1 = Math.min(ny - 1, Math.ceil((by1 - gy0) / cell));
    if (i0 > i1 || j0 > j1) return;
    const put = (i: number, j: number, d: number) => { const g = j * nx + i; if (d < target[g]) target[g] = d; };
    /** Distance to a polyline's segments, each over its own neighbourhood only. */
    const segments = (pts: P[], closed: boolean, half: number, into: (i: number, j: number, d: number) => void) => {
      const reachOut = half + pad;
      const n = closed ? pts.length : pts.length - 1;
      for (let s = 0; s < Math.max(1, n); s++) {
        const [ax, ay] = pts[s], [bx, by] = pts[Math.min((s + 1) % pts.length, pts.length - 1)];
        const si0 = Math.max(i0, Math.floor((Math.min(ax, bx) - reachOut - gx0) / cell)), si1 = Math.min(i1, Math.ceil((Math.max(ax, bx) + reachOut - gx0) / cell));
        const sj0 = Math.max(j0, Math.floor((Math.min(ay, by) - reachOut - gy0) / cell)), sj1 = Math.min(j1, Math.ceil((Math.max(ay, by) + reachOut - gy0) / cell));
        for (let j = sj0; j <= sj1; j++) for (let i = si0; i <= si1; i++) into(i, j, segDist(xAt(i), yAt(j), ax, ay, bx, by) - half);
      }
    };
    if (pc.kind === 'path') {
      segments(pc.points, false, pc.width / 2, put);
    } else if (pc.kind === 'disc') {
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) put(i, j, Math.hypot(xAt(i) - pc.at[0], yAt(j) - pc.at[1]) - pc.radius);
    } else {
      // Distance to its edge near the edge, then signed by scanlines (inside where a row crosses the ring an odd number
      // of times to the left), its corners rounded by `round`.
      const w = i1 - i0 + 1, h = j1 - j0 + 1, round = pc.round ?? 0;
      const dist = new Float64Array(w * h).fill(Infinity);
      segments(pc.ring, true, 0, (i, j, d) => { const k = (j - j0) * w + (i - i0); if (d < dist[k]) dist[k] = d; });
      const ring = pc.ring;
      for (let j = j0; j <= j1; j++) {
        const y = yAt(j), xs: number[] = [];
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const [x0, y0] = ring[b], [x1, y1] = ring[a];
          if ((y0 > y) !== (y1 > y)) xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          for (let i = Math.max(i0, Math.ceil((xs[k] - gx0) / cell)); i <= Math.min(i1, Math.floor((xs[k + 1] - gx0) / cell)); i++) {
            const q = (j - j0) * w + (i - i0);
            dist[q] = -Math.min(dist[q], 1e6);
          }
        }
      }
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const d = dist[(j - j0) * w + (i - i0)];
        if (d < Infinity) put(i, j, d - round);
      }
    }
  };

  // ---- the union, exactly: the least of the pieces' fields ----
  const u = new Float64Array(nx * ny).fill(far);
  for (const pc of pieces) fill(pc, u, reach);

  // ---- the closing: grown by r, shrunk by r again: inside it, everything at least r from the grown area's edge (that
  // edge traced between grid points, and measured to exactly) ----
  const close = (f: Float64Array, rr: number): Float64Array => {
    if (rr <= 0) return f;
    const grown = Float64Array.from(f, (v) => v - rr);
    const edges = new SegmentIndex(2 * rr);
    for (const ring of traceRings(grown, nx, ny, gx0, gy0, cell)) {
      for (let k = 0; k < ring.length; k++) edges.add(ring[k], ring[(k + 1) % ring.length]);
      // Where two grown pieces meet, their edge has a sharp corner (the fillet's centre) which the grid cuts across: put it
      // back, where the edge's runs either side of it, carried on, cross.
      for (const corner of corners(ring, cell)) edges.add(corner, corner);
    }
    // (Only the grass it might fill needs measuring: what's paved stays paved, what's beyond the grown edge stays grass.)
    const out = Float64Array.from(f);
    for (let g = 0; g < out.length; g++) {
      if (f[g] <= 0 || grown[g] > 0) continue;
      const closed = rr - edges.distance(xAt(g % nx), yAt(Math.floor(g / nx)), rr + cell);
      if (closed < out[g]) out[g] = closed;
    }
    return out;
  };
  const field = close(u, r);
  return contour(field, nx, ny, gx0, gy0, cell);
}


/**
 * The sharp corners of a traced ring, put back where the grid cut across them: wherever the ring turns more than 25
 * degrees between its run three points before and three after, where those runs, carried on, cross (if that's near).
 */
function corners(ring: P[], cell: number): P[] {
  const n = ring.length, out: P[] = [];
  if (n < 8) return out;
  const at = (k: number) => ring[((k % n) + n) % n];
  for (let k = 0; k < n; k++) {
    const [a0, a1, b0, b1] = [at(k - 3), at(k - 1), at(k + 1), at(k + 3)];
    const ux = a1[0] - a0[0], uy = a1[1] - a0[1], vx = b1[0] - b0[0], vy = b1[1] - b0[1];
    const cross = ux * vy - uy * vx, dot = ux * vx + uy * vy;
    if (Math.abs(Math.atan2(cross, dot)) < (25 * Math.PI) / 180) continue;
    // Lines a1 + t u and b0 + s v.
    const t = ((b0[0] - a1[0]) * vy - (b0[1] - a1[1]) * vx) / cross;
    const p: P = [a1[0] + t * ux, a1[1] + t * uy];
    if (Math.hypot(p[0] - ring[k][0], p[1] - ring[k][1]) < 1.5 * cell) out.push(p);
  }
  return out;
}

/** Segments hashed on a grid, for the exact distance from a point to the nearest. */
class SegmentIndex {
  private cells = new Map<number, Array<[P, P]>>();
  constructor(private readonly size: number) {}
  private key(i: number, j: number) { return (i + 32768) * 65536 + (j + 32768); }
  add(a: P, b: P): void {
    const i0 = Math.floor(Math.min(a[0], b[0]) / this.size), i1 = Math.floor(Math.max(a[0], b[0]) / this.size);
    const j0 = Math.floor(Math.min(a[1], b[1]) / this.size), j1 = Math.floor(Math.max(a[1], b[1]) / this.size);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this.key(i, j);
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push([a, b]);
    }
  }
  /** Distance to the nearest segment, or `cap` if none is nearer. */
  distance(x: number, y: number, cap: number): number {
    let best = cap;
    const i0 = Math.floor((x - cap) / this.size), i1 = Math.floor((x + cap) / this.size);
    const j0 = Math.floor((y - cap) / this.size), j1 = Math.floor((y + cap) / this.size);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      for (const [a, b] of this.cells.get(this.key(i, j)) ?? []) best = Math.min(best, segDist(x, y, a[0], a[1], b[0], b[1]));
    }
    return best;
  }
}

/** The paved area's rings: traced, slivers dropped, the grid's steps smoothed out (on the dense trace), simplified a little. */
function contour(f: Float64Array, nx: number, ny: number, x0: number, y0: number, cell: number): P[][] {
  // (Not a sliver: a pinhole of grass where two fillets nearly meet, or a speck of paving, is neither.)
  return traceRings(f, nx, ny, x0, y0, cell).filter((ring) => ring.length >= 4 && ringArea(ring) > MIN_AREA).map((ring) => simplifyRing(smooth(ring), 0.03));
}

/** Marching squares at 0 over the field (inside negative or 0): closed rings, each point placed between grid points. */
function traceRings(f: Float64Array, nx: number, ny: number, x0: number, y0: number, cell: number): P[][] {
  // Edge ids: horizontal (i,j)-(i+1,j) is 2(j nx + i); vertical (i,j)-(i,j+1) is 2(j nx + i) + 1. Each edge the
  // edge crosses is linked to at most two others (one in each cell it borders): kept in flat arrays, -1 for none.
  const E = 2 * nx * ny;
  const linkA = new Int32Array(E).fill(-1), linkB = new Int32Array(E).fill(-1);
  const crossed: number[] = [];
  const v = (i: number, j: number) => f[j * nx + i];
  const point = (e: number): P => {
    const base = e >> 1, i = base % nx, j = Math.floor(base / nx);
    const a = v(i, j), b = e & 1 ? v(i, j + 1) : v(i + 1, j);
    const t = a / (a - b);
    return e & 1 ? [x0 + i * cell, y0 + (j + t) * cell] : [x0 + (i + t) * cell, y0 + j * cell];
  };
  const join = (a: number, b: number) => {
    if (linkA[a] < 0) { linkA[a] = b; crossed.push(a); } else linkB[a] = b;
    if (linkA[b] < 0) { linkA[b] = a; crossed.push(b); } else linkB[b] = a;
  };
  const cut = [0, 0, 0, 0];
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    // (On the edge counts as in: an edge that falls on a grid line doesn't cut what's either side of it apart.)
    const a = f[j * nx + i] <= 0, b = f[j * nx + i + 1] <= 0, c = f[(j + 1) * nx + i + 1] <= 0, d = f[(j + 1) * nx + i] <= 0;
    if (a === b && b === c && c === d) continue;
    const e0 = 2 * (j * nx + i), e1 = 2 * (j * nx + i + 1) + 1, e2 = 2 * ((j + 1) * nx + i), e3 = 2 * (j * nx + i) + 1;
    let n = 0;
    if (a !== b) cut[n++] = e0;
    if (b !== c) cut[n++] = e1;
    if (c !== d) cut[n++] = e2;
    if (d !== a) cut[n++] = e3;
    if (n === 2) join(cut[0], cut[1]);
    else if (n === 4) {
      const centre = (v(i, j) + v(i + 1, j) + v(i + 1, j + 1) + v(i, j + 1)) / 4 <= 0;
      // (A saddle: which corners the inside joins across decides how the edges pair.)
      if (a === centre) { join(e0, e1); join(e2, e3); } else { join(e3, e0); join(e1, e2); }
    }
  }
  const rings: P[][] = [];
  const used = new Uint8Array(E);
  for (const start of crossed) {
    if (used[start]) continue;
    const ring: P[] = [];
    let prev = -1, cur = start;
    while (!used[cur]) {
      used[cur] = 1;
      ring.push(point(cur));
      const p = linkA[cur], q = linkB[cur];
      const next = p >= 0 && p !== prev && !used[p] ? p : q >= 0 && q !== prev && !used[q] ? q : -1;
      if (next < 0) break;
      prev = cur;
      cur = next;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Smallest patch of grass or paving kept (m^2): a car's footprint or so. */
const MIN_AREA = 40;

function ringArea(ring: P[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/**
 * A closed ring with the grid's scale taken out of it: resampled every `spacing` m along it, then each point the mean
 * of those within `half` m either way along it, twice. The grid's wobble (a metre or so long) averages away; an arc of
 * radius R comes in by about half^2 / 3R (a few centimetres for the fillets' 8 m, the roads' rounded ends' 4 m).
 */
function smooth(ring: P[], spacing = 0.5, half = 1.5): P[] {
  // Resampled evenly by distance along the ring.
  let length = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    length += Math.hypot(x1 - x0, y1 - y0);
  }
  const n = Math.max(8, Math.round(length / spacing)), step = length / n;
  let pts: P[] = [];
  for (let i = 0, along = 0, k = 0; k < n; k++) {
    const want = k * step;
    for (;;) {
      const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      if (along + seg >= want || i === ring.length - 1) {
        const t = seg > 0 ? Math.min(1, (want - along) / seg) : 0;
        pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
        break;
      }
      along += seg;
      i++;
    }
  }
  // A running mean round it (wrapping), twice.
  const w = Math.max(1, Math.round(half / step));
  for (let pass = 0; pass < 2; pass++) {
    let sx = 0, sy = 0;
    for (let j = -w; j <= w; j++) { const [x, y] = pts[(j + n) % n]; sx += x; sy += y; }
    const out: P[] = [];
    for (let k = 0; k < n; k++) {
      out.push([sx / (2 * w + 1), sy / (2 * w + 1)]);
      const [ax, ay] = pts[(k - w + n) % n], [bx, by] = pts[(k + w + 1) % n];
      sx += bx - ax; sy += by - ay;
    }
    pts = out;
  }
  return pts;
}

/** Douglas-Peucker on a closed ring. */
function simplifyRing(ring: P[], tol: number): P[] {
  const keep = new Uint8Array(ring.length);
  const dp = (a: number, b: number) => {
    let worst = -1, far = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(ring[i][0], ring[i][1], ring[a][0], ring[a][1], ring[b][0], ring[b][1]);
      if (d > far) { far = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; dp(a, worst); dp(worst, b); }
  };
  const mid = ring.length >> 1;
  keep[0] = keep[mid] = 1;
  dp(0, mid);
  dp(mid, ring.length - 1);
  keep[ring.length - 1] = 1;
  return ring.filter((_, i) => keep[i]);
}

/**
 * A polyline with its corners turned into arcs of (up to) this radius: each
 * corner's arc runs between points on its legs, no further along either than
 * half of it (so neighbouring arcs never overlap). Sampled every `step` m.
 */
export function roundPolyline(points: P[], radius: number, step = 2): P[] {
  if (points.length < 3) return points;
  const out: P[] = [points[0]];
  for (let i = 1; i + 1 < points.length; i++) {
    const [px, py] = points[i - 1], [cx, cy] = points[i], [qx, qy] = points[i + 1];
    const l0 = Math.hypot(cx - px, cy - py), l1 = Math.hypot(qx - cx, qy - cy);
    if (l0 < 1e-6 || l1 < 1e-6) continue;
    const ux = (cx - px) / l0, uy = (cy - py) / l0, wx = (qx - cx) / l1, wy = (qy - cy) / l1;
    const turn = Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy);
    if (Math.abs(turn) < 1e-3) { out.push([cx, cy]); continue; }
    // Tangent length for the radius, held to half of each leg.
    const tanLen = Math.min(radius * Math.tan(Math.abs(turn) / 2), l0 / 2, l1 / 2);
    const rr = tanLen / Math.tan(Math.abs(turn) / 2);
    const sx = cx - ux * tanLen, sy = cy - uy * tanLen;
    const side = Math.sign(turn);
    const ox = sx - uy * rr * side, oy = sy + ux * rr * side; // centre: left of travel for a left turn
    const a0 = Math.atan2(sy - oy, sx - ox);
    const n = Math.max(2, Math.ceil((rr * Math.abs(turn)) / step));
    for (let k = 0; k <= n; k++) {
      const a = a0 + (turn * k) / n;
      out.push([ox + rr * Math.cos(a), oy + rr * Math.sin(a)]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
