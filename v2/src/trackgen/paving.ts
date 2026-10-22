/**
 * Paving: an infield's roads, lots and pads as one paved area, as it would be
 * laid, rather than strokes painted over each other. Each piece is a distance
 * field (negative inside); the pieces are joined with a smooth minimum, so
 * where roads meet or cross the inside corners are filleted to a radius, and
 * the area's edge is traced from the field (marching squares) as even-odd
 * rings: holes where it closes round grass. Roads themselves are rounded
 * first: a polyline's corners become arcs (roundPolyline).
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

/** Polynomial smooth minimum: min(a, b), blended over k where they're close (fillets about k across). */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
}

function inRing(ring: P[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j], [x1, y1] = ring[i];
    if ((y0 > y) !== (y1 > y) && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) inside = !inside;
  }
  return inside;
}

/** The paved area's edge: even-odd rings in world coordinates (none if nothing to pave). */
export function pave(pieces: PavePiece[], opts: PaveOptions = {}): P[][] {
  if (!pieces.length) return [];
  const cell = opts.cell ?? 1, k = Math.max(1e-3, 2 * (opts.fillet ?? 6));
  // Each piece's reach: as far out as it can pull the edge (its fillet).
  const reach = k;
  const box = (pc: PavePiece): [number, number, number, number] => {
    const pts = pc.kind === 'path' ? pc.points : pc.kind === 'disc' ? [pc.at] : pc.ring;
    const grow = pc.kind === 'path' ? pc.width / 2 : pc.kind === 'disc' ? pc.radius : pc.round ?? 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0 - grow - reach, y0 - grow - reach, x1 + grow + reach, y1 + grow + reach];
  };
  const boxes = pieces.map(box);
  const gx0 = Math.min(...boxes.map((b) => b[0])) - 2 * cell, gy0 = Math.min(...boxes.map((b) => b[1])) - 2 * cell;
  const gx1 = Math.max(...boxes.map((b) => b[2])) + 2 * cell, gy1 = Math.max(...boxes.map((b) => b[3])) + 2 * cell;
  const nx = Math.ceil((gx1 - gx0) / cell) + 1, ny = Math.ceil((gy1 - gy0) / cell) + 1;
  const far = reach + 1;
  const field = new Float64Array(nx * ny).fill(far);
  const xAt = (i: number) => gx0 + i * cell, yAt = (j: number) => gy0 + j * cell;

  pieces.forEach((pc, n) => {
    const [bx0, by0, bx1, by1] = boxes[n];
    const i0 = Math.max(0, Math.floor((bx0 - gx0) / cell)), i1 = Math.min(nx - 1, Math.ceil((bx1 - gx0) / cell));
    const j0 = Math.max(0, Math.floor((by0 - gy0) / cell)), j1 = Math.min(ny - 1, Math.ceil((by1 - gy0) / cell));
    const w = i1 - i0 + 1;
    // The piece's own field over its box (plain min within a piece; a smooth one only between pieces).
    const own = new Float64Array(w * (j1 - j0 + 1)).fill(far);
    const at = (i: number, j: number) => (j - j0) * w + (i - i0);
    if (pc.kind === 'path') {
      const half = pc.width / 2, pad = half + reach;
      for (let s = 0; s + 1 < Math.max(2, pc.points.length); s++) {
        const [ax, ay] = pc.points[s], [bx, by] = pc.points[Math.min(s + 1, pc.points.length - 1)];
        const si0 = Math.max(i0, Math.floor((Math.min(ax, bx) - pad - gx0) / cell)), si1 = Math.min(i1, Math.ceil((Math.max(ax, bx) + pad - gx0) / cell));
        const sj0 = Math.max(j0, Math.floor((Math.min(ay, by) - pad - gy0) / cell)), sj1 = Math.min(j1, Math.ceil((Math.max(ay, by) + pad - gy0) / cell));
        for (let j = sj0; j <= sj1; j++) for (let i = si0; i <= si1; i++) {
          const d = segDist(xAt(i), yAt(j), ax, ay, bx, by) - half;
          if (d < own[at(i, j)]) own[at(i, j)] = d;
        }
      }
    } else if (pc.kind === 'disc') {
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) own[at(i, j)] = Math.hypot(xAt(i) - pc.at[0], yAt(j) - pc.at[1]) - pc.radius;
    } else {
      const ring = pc.ring, r = pc.round ?? 0;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = xAt(i), y = yAt(j);
        let d = Infinity;
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) d = Math.min(d, segDist(x, y, ring[b][0], ring[b][1], ring[a][0], ring[a][1]));
        own[at(i, j)] = (inRing(ring, x, y) ? -d : d) - r;
      }
    }
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const g = j * nx + i;
      field[g] = smin(field[g], Math.min(far, own[at(i, j)]), k);
    }
  });
  return contour(field, nx, ny, gx0, gy0, cell);
}

/** Marching squares at 0 over the field (inside negative): closed rings, simplified a little. */
function contour(f: Float64Array, nx: number, ny: number, x0: number, y0: number, cell: number): P[][] {
  // Edge ids: horizontal (i,j)-(i+1,j) is 2(j nx + i); vertical (i,j)-(i,j+1) is 2(j nx + i) + 1.
  const H = (i: number, j: number) => 2 * (j * nx + i), V = (i: number, j: number) => 2 * (j * nx + i) + 1;
  const v = (i: number, j: number) => f[j * nx + i];
  const point = (e: number): P => {
    const base = e >> 1, i = base % nx, j = Math.floor(base / nx);
    const a = v(i, j), b = e & 1 ? v(i, j + 1) : v(i + 1, j);
    const t = a / (a - b);
    return e & 1 ? [x0 + i * cell, y0 + (j + t) * cell] : [x0 + (i + t) * cell, y0 + j * cell];
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    const a = v(i, j) < 0, b = v(i + 1, j) < 0, c = v(i + 1, j + 1) < 0, d = v(i, j + 1) < 0;
    const e0 = H(i, j), e1 = V(i + 1, j), e2 = H(i, j + 1), e3 = V(i, j);
    const cut: number[] = [];
    if (a !== b) cut.push(e0);
    if (b !== c) cut.push(e1);
    if (c !== d) cut.push(e2);
    if (d !== a) cut.push(e3);
    if (cut.length === 2) link(cut[0], cut[1]);
    else if (cut.length === 4) {
      const centre = (v(i, j) + v(i + 1, j) + v(i + 1, j + 1) + v(i, j + 1)) / 4 < 0;
      // (A saddle: which corners the inside joins across decides how the edges pair.)
      if (a === centre) { link(e0, e1); link(e2, e3); } else { link(e3, e0); link(e1, e2); }
    }
  }
  const rings: P[][] = [];
  const used = new Set<number>();
  for (const start of links.keys()) {
    if (used.has(start)) continue;
    const ring: P[] = [];
    let prev = -1, cur = start;
    while (!used.has(cur)) {
      used.add(cur);
      ring.push(point(cur));
      const next = links.get(cur)!.find((e) => e !== prev && !used.has(e));
      if (next === undefined) break;
      prev = cur;
      cur = next;
    }
    // (Not a sliver: a pinhole of grass where two fillets nearly meet, or a speck of paving, is neither.)
    if (ring.length >= 4 && ringArea(ring) > MIN_AREA) rings.push(simplifyRing(ring, cell * 0.15));
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
    const r = tanLen / Math.tan(Math.abs(turn) / 2);
    const sx = cx - ux * tanLen, sy = cy - uy * tanLen;
    const side = Math.sign(turn);
    const ox = sx - uy * r * side, oy = sy + ux * r * side; // centre: left of travel for a left turn
    const a0 = Math.atan2(sy - oy, sx - ox);
    const n = Math.max(2, Math.ceil((r * Math.abs(turn)) / step));
    for (let k = 0; k <= n; k++) {
      const a = a0 + (turn * k) / n;
      out.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
