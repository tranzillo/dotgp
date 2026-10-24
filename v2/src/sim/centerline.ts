import type { CenterlineSpec, Placement } from './layout';

const SAMPLE_SPACING = 0.5;
/** Spatial index: cell size (m), and every how many samples go in it (the nearest is refined from there). */
const CELL = 16;
const INDEX_STRIDE = 4;

export interface Projection {
  s: number;
  d: number;
  idx: number;
}

/**
 * A closed centerline sampled every ~0.5 m, with the track frame (s, d)
 * built on it: d is positive to the left of travel. Shared by the runtime
 * Track and by the generator (which needs geometry while it lays out pits
 * and infield).
 */
export class Centerline {
  readonly length: number;
  readonly n: number;
  readonly ds: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly tx: Float64Array;
  readonly ty: Float64Array;
  readonly kappa: Float64Array;
  /** Curvature as a share of the tightest curvature on the lap: 0 on straights, 1 in the tightest arc. */
  readonly turn: Float64Array;
  readonly maxKappa: number;
  /** Extent of the centerline itself (world, centred on the origin). */
  readonly extent: { minX: number; minY: number; maxX: number; maxY: number };
  /** Gap between the integrated end and start before it was spread along the lap (m). */
  readonly closureError: number;
  /** What it was built from. */
  readonly spec: CenterlineSpec;

  /** Lazily built grid of sample indices, for nearest-point queries with no hint (see near). */
  private grid: { x0: number; y0: number; nx: number; ny: number; start: Int32Array; items: Int32Array } | null = null;

  constructor(spec: CenterlineSpec, placement?: Placement) {
    this.spec = spec;
    const sections = spec.sections;
    const L = sections.reduce((sum, sec) => sum + sec[0], 0);
    const kappaAt = (s: number): number => {
      let acc = 0;
      for (const [len, k0, k1] of sections) {
        if (s <= acc + len) return k0 + ((s - acc) / len) * (k1 - k0);
        acc += len;
      }
      return 0;
    };

    this.length = L;
    this.n = Math.round(L / SAMPLE_SPACING);
    this.ds = L / this.n;
    const n = this.n;
    const ds = this.ds;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.tx = new Float64Array(n);
    this.ty = new Float64Array(n);
    this.kappa = new Float64Array(n);
    this.turn = new Float64Array(n);

    // Integrate heading and position (midpoint rule).
    let px = 0, py = 0, heading = 0;
    for (let i = 0; i < n; i++) {
      const s = i * ds;
      this.x[i] = px;
      this.y[i] = py;
      this.kappa[i] = kappaAt(s);
      this.tx[i] = Math.cos(heading);
      this.ty[i] = Math.sin(heading);
      const midHeading = heading + kappaAt(s + ds / 4) * (ds / 2);
      px += Math.cos(midHeading) * ds;
      py += Math.sin(midHeading) * ds;
      heading += kappaAt(s + ds / 2) * ds;
    }
    let maxKappa = 0;
    for (let i = 0; i < n; i++) maxKappa = Math.max(maxKappa, Math.abs(this.kappa[i]));
    this.maxKappa = maxKappa;
    for (let i = 0; i < n; i++) this.turn[i] = maxKappa > 0 ? this.kappa[i] / maxKappa : 0;
    // Remove the tiny numerical closure error by spreading it along the lap.
    const errX = px - this.x[0];
    const errY = py - this.y[0];
    this.closureError = Math.hypot(errX, errY);
    for (let i = 0; i < n; i++) {
      this.x[i] -= (errX * i) / n;
      this.y[i] -= (errY * i) / n;
    }
    // Center the track on the origin.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.x[i]); maxX = Math.max(maxX, this.x[i]);
      minY = Math.min(minY, this.y[i]); maxY = Math.max(maxY, this.y[i]);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (let i = 0; i < n; i++) {
      this.x[i] -= cx;
      this.y[i] -= cy;
    }
    this.extent = { minX: minX - cx, maxX: maxX - cx, minY: minY - cy, maxY: maxY - cy };
    // Then into its venue's frame.
    if (placement && (placement.x || placement.y || placement.angle)) {
      const c = Math.cos(placement.angle), s = Math.sin(placement.angle);
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = this.x[i], y = this.y[i], tx = this.tx[i], ty = this.ty[i];
        this.x[i] = placement.x + c * x - s * y;
        this.y[i] = placement.y + s * x + c * y;
        this.tx[i] = c * tx - s * ty;
        this.ty[i] = s * tx + c * ty;
        minX = Math.min(minX, this.x[i]); maxX = Math.max(maxX, this.x[i]);
        minY = Math.min(minY, this.y[i]); maxY = Math.max(maxY, this.y[i]);
      }
      this.extent = { minX, maxX, minY, maxY };
    }
  }

  /**
   * The nearest point on the centerline to a world point, if it is within
   * maxDist (a lap's worth of samples is indexed on a grid, so this is cheap
   * anywhere, unlike project with no hint). For points near a track that
   * isn't the one a car is racing on.
   */
  near(px: number, py: number, maxDist: number): Projection | null {
    const g = this.grid ?? this.buildGrid();
    const r = Math.ceil(maxDist / CELL);
    const cx = Math.floor((px - g.x0) / CELL), cy = Math.floor((py - g.y0) / CELL);
    let best = maxDist * maxDist, bi = -1;
    for (let gy = Math.max(0, cy - r); gy <= Math.min(g.ny - 1, cy + r); gy++) {
      for (let gx = Math.max(0, cx - r); gx <= Math.min(g.nx - 1, cx + r); gx++) {
        const c = gy * g.nx + gx;
        for (let k = g.start[c]; k < g.start[c + 1]; k++) {
          const d2 = this.dist2(g.items[k], px, py);
          if (d2 < best) { best = d2; bi = g.items[k]; }
        }
      }
    }
    if (bi < 0) return null;
    const p = this.project(px, py, bi);
    return Math.abs(p.d) <= maxDist ? p : null;
  }

  private buildGrid(): NonNullable<Centerline['grid']> {
    const e = this.extent;
    const x0 = e.minX - CELL, y0 = e.minY - CELL;
    const nx = Math.ceil((e.maxX - x0) / CELL) + 2, ny = Math.ceil((e.maxY - y0) / CELL) + 2;
    const cellOf = (i: number) => Math.floor((this.y[i] - y0) / CELL) * nx + Math.floor((this.x[i] - x0) / CELL);
    const start = new Int32Array(nx * ny + 1);
    for (let i = 0; i < this.n; i += INDEX_STRIDE) start[cellOf(i) + 1]++;
    for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
    const fill = start.slice(0, nx * ny);
    const items = new Int32Array(start[nx * ny]);
    for (let i = 0; i < this.n; i += INDEX_STRIDE) items[fill[cellOf(i)]++] = i;
    this.grid = { x0, y0, nx, ny, start, items };
    return this.grid;
  }

  wrapS(s: number): number {
    // Exactly ((s % L) + L) % L, without the floating-point modulos where they
    // aren't needed (this runs ~100 times per driver decision). s % L is s
    // itself on the lap; and with u = r + L, u % L is u - L for u in [L, 2L)
    // and u for u in (0, L), both exact.
    const L = this.length;
    const r = s >= 0 && s < L ? s : s % L;
    const u = r + L;
    if (r >= 0) { if (u < 2 * L) return u - L; } else if (u < L) return u;
    return u % L; // u landed on a boundary (or s isn't finite)
  }

  indexAt(s: number): number {
    return Math.floor(this.wrapS(s) / this.ds) % this.n;
  }

  curvatureAt(s: number): number {
    const f = this.wrapS(s) / this.ds;
    const i = Math.floor(f) % this.n;
    const j = (i + 1) % this.n;
    const t = f - Math.floor(f);
    return this.kappa[i] + (this.kappa[j] - this.kappa[i]) * t;
  }

  /** s relative to the start/finish line, in (-L/2, L/2]. */
  signedS(s: number): number {
    const w = this.wrapS(s);
    return w > this.length / 2 ? w - this.length : w;
  }

  /** Metres travelled along the lap from s0 to s (0..L), e.g. from a pit box. */
  distanceFrom(s0: number, s: number): number {
    return this.wrapS(s - s0);
  }

  /**
   * Metres travelled from s0 to s, like distanceFrom, but a point up to
   * `behind` metres short of s0 counts as slightly negative rather than
   * almost a full lap (a car that stopped just short of its pit box).
   */
  progressFrom(s0: number, s: number, behind = 20): number {
    const u = this.distanceFrom(s0, s);
    return u > this.length - behind ? u - this.length : u;
  }

  /** Is s within a signed range (null = the whole lap)? */
  inRange(s: number, range: [number, number] | null): boolean {
    if (!range) return true;
    const [a, b] = range;
    const half = this.length / 2;
    if (a > -half && b <= half) {
      const r = this.signedS(s);
      return r >= a && r <= b;
    }
    return this.distanceFrom(a, s) <= b - a;
  }

  toWorld(s: number, d: number): [number, number] {
    const f = this.wrapS(s) / this.ds;
    const i = Math.floor(f) % this.n;
    const j = (i + 1) % this.n;
    const t = f - Math.floor(f);
    const x = this.x[i] + (this.x[j] - this.x[i]) * t;
    const y = this.y[i] + (this.y[j] - this.y[i]) * t;
    let tx = this.tx[i] + (this.tx[j] - this.tx[i]) * t;
    let ty = this.ty[i] + (this.ty[j] - this.ty[i]) * t;
    const m = Math.hypot(tx, ty);
    tx /= m; ty /= m;
    return [x - ty * d, y + tx * d];
  }

  /**
   * Project a world point onto the track frame. With a hint index (the car's
   * previous sample), a local hill-climb is O(1); without one it scans the lap.
   */
  /** Squared distance from a point to sample i. */
  private dist2(i: number, px: number, py: number): number {
    const dx = px - this.x[i], dy = py - this.y[i];
    return dx * dx + dy * dy;
  }

  project(px: number, py: number, hint = -1): Projection {
    // Every car, every physics step: no closures here (tsx's keepNames makes each one a defineProperty).
    const n = this.n;
    let i: number;
    if (hint < 0) {
      i = 0;
      let best = Infinity;
      for (let k = 0; k < n; k++) {
        const d2 = this.dist2(k, px, py);
        if (d2 < best) { best = d2; i = k; }
      }
    } else {
      i = hint;
      let best = this.dist2(i, px, py);
      let moved = false;
      for (;;) {
        const j = (i + 1) % n;
        const dj = this.dist2(j, px, py);
        if (dj < best) { i = j; best = dj; moved = true; } else break;
      }
      if (!moved) {
        for (;;) {
          const j = (i - 1 + n) % n;
          const dj = this.dist2(j, px, py);
          if (dj < best) { i = j; best = dj; } else break;
        }
      }
    }
    // Refine onto the segment ahead of or behind the nearest sample.
    let a = i;
    let t = (px - this.x[a]) * this.tx[a] + (py - this.y[a]) * this.ty[a];
    if (t < 0) {
      a = (i - 1 + n) % n;
      t = (px - this.x[a]) * this.tx[a] + (py - this.y[a]) * this.ty[a];
    }
    t = Math.min(this.ds, Math.max(0, t));
    const cx = this.x[a] + this.tx[a] * t;
    const cy = this.y[a] + this.ty[a] * t;
    const d = (px - cx) * -this.ty[a] + (py - cy) * this.tx[a];
    return { s: this.wrapS(a * this.ds + t), d, idx: i };
  }
}
