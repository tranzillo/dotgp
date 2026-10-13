import type { CenterlineSpec } from './layout';

const SAMPLE_SPACING = 0.5;

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

  constructor(spec: CenterlineSpec) {
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
  }

  wrapS(s: number): number {
    const L = this.length;
    return ((s % L) + L) % L;
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
  project(px: number, py: number, hint = -1): Projection {
    const n = this.n;
    const dist2 = (i: number) => {
      const dx = px - this.x[i], dy = py - this.y[i];
      return dx * dx + dy * dy;
    };
    let i: number;
    if (hint < 0) {
      i = 0;
      let best = Infinity;
      for (let k = 0; k < n; k++) {
        const d2 = dist2(k);
        if (d2 < best) { best = d2; i = k; }
      }
    } else {
      i = hint;
      let best = dist2(i);
      let moved = false;
      for (;;) {
        const j = (i + 1) % n;
        const dj = dist2(j);
        if (dj < best) { i = j; best = dj; moved = true; } else break;
      }
      if (!moved) {
        for (;;) {
          const j = (i - 1 + n) % n;
          const dj = dist2(j);
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
