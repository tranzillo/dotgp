/**
 * Oval track defined by its curvature profile and integrated into a centerline.
 *
 * Coordinates: world is metres with y up (the renderer flips y). Cars run
 * counterclockwise, so every turn is a left turn (positive curvature).
 *
 * Track frame: s = distance along the centerline from the start/finish line,
 * d = lateral offset, positive to the LEFT of travel (toward the infield).
 *   d = -halfWidth        outer wall (SAFER barrier)
 *   d = +halfWidth        inside edge of the racing surface
 *   d = pavedInnerD(s)    end of the paved apron / pit road; grass beyond
 *
 * Pit layout (front straight, start/finish at s = 0):
 *   entry   leaves the apron at the exit of turn 4 and widens into pit road
 *   wall    pit wall just inside the racing surface along the front straight
 *   exit    pit road narrows back to the apron, which is the blend lane through
 *           turns 1-2, merging on the back straight
 * There is no inner wall anywhere else: the infield is grass.
 *
 * Infield: a garage lot behind pit road (reachable straight from it), and an
 * escape lane leaving the apron near the end of the back straight and
 * crossing the infield to the garage (exit for cars in trouble, tow route).
 */

const deg = (x: number) => (x * Math.PI) / 180;

export interface OvalSpec {
  straightLength: number;
  turnRadius: number;
  /** Length of each clothoid transition between straight and arc. */
  easementLength: number;
  width: number;
  apronWidth: number;
  /** Turn banking at the inside edge of the racing surface. */
  bankInner: number;
  /** Turn banking at the outside edge (progressive banking: higher = steeper). */
  bankOuter: number;
  bankStraight: number;
}

export const SPEEDWAY: OvalSpec = {
  straightLength: 450,
  turnRadius: 230,
  easementLength: 90,
  width: 18,
  apronWidth: 8,
  bankInner: deg(20),
  bankOuter: deg(24),
  bankStraight: deg(5),
};

export const SHORT_TRACK: OvalSpec = {
  straightLength: 200,
  turnRadius: 90,
  easementLength: 40,
  width: 16,
  apronWidth: 6,
  bankInner: deg(10),
  bankOuter: deg(14),
  bankStraight: deg(3),
};

export const FLAT_TRACK: OvalSpec = {
  straightLength: 380,
  turnRadius: 200,
  easementLength: 70,
  width: 18,
  apronWidth: 8,
  bankInner: deg(2),
  bankOuter: deg(4),
  bankStraight: deg(1),
};

export type Surface = 'track' | 'apron' | 'pit' | 'garage' | 'road' | 'grass';

/** A rectangle in track coordinates (only used on straights, where it is a true rectangle). */
export interface TrackRect {
  s0: number;
  s1: number;
  d0: number;
  d1: number;
}

export interface InfieldLayout {
  /** Paved lot behind pit road. */
  garage: TrackRect;
  /** Garage buildings inside the lot (visual for now). */
  buildings: TrackRect[];
  /** Escape lane: world-space polyline from the back-straight apron to the garage. */
  escape: Array<[number, number]>;
  escapeWidth: number;
}

const SAMPLE_SPACING = 0.5;

/** Pit lane geometry, shared by every oval. Lengths in metres. */
export const PIT = {
  /** Gap between the racing surface and the pit wall. */
  WALL_GAP: 1,
  WALL_THICKNESS: 0.8,
  ROAD_WIDTH: 14,
  /** The wall starts this far after turn 4 exit and ends this far before turn 1. */
  WALL_START_INSET: 30,
  WALL_END_INSET: 20,
  /** Paved taper from apron to pit road, ending where the wall starts. */
  ENTRY_LENGTH: 150,
  /** Taper from pit road back down to apron width after the wall ends. */
  EXIT_TAPER: 120,
  /** How far down the back straight the blend lane runs before merging. */
  BLEND_INTO_BACK_STRAIGHT: 100,
} as const;

export interface Projection {
  s: number;
  d: number;
  idx: number;
}

export class Track {
  readonly spec: OvalSpec;
  readonly length: number;
  readonly n: number;
  readonly ds: number;
  readonly halfWidth: number;
  readonly outerWallD: number;
  /** Inner edge of the apron where there is no pit road. */
  readonly apronD: number;
  /** Centre line of the pit wall, and its extent as signed s (-L/2..L/2) around the line. */
  readonly pitWallD: number;
  readonly pitWallStart: number;
  readonly pitWallEnd: number;
  /** Inner edge of the pit road. */
  readonly pitRoadD: number;
  /** Signed s where the blend lane ends on the back straight. */
  readonly blendEnd: number;
  /** World positions of the two pit wall ends (start, end). */
  readonly pitWallEnds: Array<[number, number]>;
  readonly infield: InfieldLayout;

  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly tx: Float64Array;
  readonly ty: Float64Array;
  readonly kappa: Float64Array;
  /** 0 on straights, 1 in the constant-radius arc; follows curvature through easements. */
  readonly turn: Float64Array;

  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };

  constructor(spec: OvalSpec) {
    this.spec = spec;
    const { straightLength: S, turnRadius: R, easementLength: Le } = spec;
    const k = 1 / R;
    const arcLen = Math.PI * R - Le;
    if (arcLen <= 0) throw new Error('easementLength too long for turnRadius');

    // [length, curvature at start, curvature at end]
    const sections: Array<[number, number, number]> = [
      [S / 2, 0, 0],
      [Le, 0, k], [arcLen, k, k], [Le, k, 0],
      [S, 0, 0],
      [Le, 0, k], [arcLen, k, k], [Le, k, 0],
      [S / 2, 0, 0],
    ];
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
    this.halfWidth = spec.width / 2;
    this.outerWallD = -this.halfWidth;
    this.apronD = this.halfWidth + spec.apronWidth;
    this.pitWallD = this.halfWidth + PIT.WALL_GAP + PIT.WALL_THICKNESS / 2;
    this.pitWallStart = -S / 2 + PIT.WALL_START_INSET;
    this.pitWallEnd = S / 2 - PIT.WALL_END_INSET;
    this.pitRoadD = this.pitWallD + PIT.WALL_THICKNESS / 2 + PIT.ROAD_WIDTH;
    this.blendEnd = Math.min(S / 2 + 2 * Le + arcLen + PIT.BLEND_INTO_BACK_STRAIGHT, L / 2 - 5);

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
      this.turn[i] = this.kappa[i] / k;
      this.tx[i] = Math.cos(heading);
      this.ty[i] = Math.sin(heading);
      const midHeading = heading + kappaAt(s + ds / 4) * (ds / 2);
      px += Math.cos(midHeading) * ds;
      py += Math.sin(midHeading) * ds;
      heading += kappaAt(s + ds / 2) * ds;
    }
    // Remove the tiny numerical closure error by spreading it along the lap.
    const errX = px - this.x[0];
    const errY = py - this.y[0];
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
    this.pitWallEnds = [this.toWorld(this.pitWallStart, this.pitWallD), this.toWorld(this.pitWallEnd, this.pitWallD)];
    this.infield = this.layoutInfield();
    const pad = this.halfWidth + 4;
    this.bounds = {
      minX: minX - cx - pad, maxX: maxX - cx + pad,
      minY: minY - cy - pad, maxY: maxY - cy + pad,
    };
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

  /** Inner edge of the paved surface: the apron, widened into pit road along the front straight. */
  pavedInnerD(s: number): number {
    const r = this.signedS(s);
    const a = this.pitWallStart, b = this.pitWallEnd;
    if (r >= a && r <= b) return this.pitRoadD;
    if (r > a - PIT.ENTRY_LENGTH && r < a) {
      return this.apronD + (this.pitRoadD - this.apronD) * smoothstep((r - (a - PIT.ENTRY_LENGTH)) / PIT.ENTRY_LENGTH);
    }
    if (r > b && r < b + PIT.EXIT_TAPER) {
      return this.pitRoadD + (this.apronD - this.pitRoadD) * smoothstep((r - b) / PIT.EXIT_TAPER);
    }
    return this.apronD;
  }

  /** Metres travelled along the lap from s0 to s (0..L), e.g. from a pit box. */
  distanceFrom(s0: number, s: number): number {
    return this.wrapS(s - s0);
  }

  /** True where the pit wall stands (signed s within the wall's extent). */
  inPitWallZone(s: number): boolean {
    const r = this.signedS(s);
    return r >= this.pitWallStart && r <= this.pitWallEnd;
  }

  /**
   * Surface at a track position. Infield features need the world position
   * too (x, y); without it, anything beyond the apron/pit road counts as grass.
   */
  surfaceAt(s: number, d: number, x?: number, y?: number): Surface {
    if (d <= this.halfWidth) return 'track';
    if (d <= this.pavedInnerD(s)) return this.inPitWallZone(s) && d > this.pitWallD ? 'pit' : 'apron';
    const g = this.infield.garage;
    const r = this.signedS(s);
    if (r >= g.s0 && r <= g.s1 && d <= g.d1) return 'garage';
    if (x !== undefined && y !== undefined && this.onEscapeLane(x, y)) return 'road';
    return 'grass';
  }

  onEscapeLane(x: number, y: number): boolean {
    const pts = this.infield.escape;
    const half = this.infield.escapeWidth / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const vx = bx - ax, vy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
      if (Math.hypot(x - (ax + vx * t), y - (ay + vy * t)) <= half) return true;
    }
    return false;
  }

  /** Generate the infield for this oval: garage lot and buildings, escape lane. */
  private layoutInfield(): InfieldLayout {
    const { straightLength: S, turnRadius: R, easementLength: Le } = this.spec;
    const depth = Math.max(20, Math.min(45, R - this.pitRoadD - 30));
    const garage: TrackRect = {
      s0: this.pitWallStart + 30, s1: this.pitWallEnd - 30, d0: this.pitRoadD, d1: this.pitRoadD + depth,
    };
    // Two rows of garage buildings with gaps for driving between them.
    const buildings: TrackRect[] = [];
    const rows = depth >= 36 ? [[8, 16], [depth - 14, depth - 6]] : [[depth * 0.35, depth * 0.75]];
    for (const [a, b] of rows) {
      for (let s0 = garage.s0 + 10; s0 + 24 <= garage.s1 - 10; s0 += 32) {
        buildings.push({ s0, s1: s0 + 24, d0: this.pitRoadD + a, d1: this.pitRoadD + b });
      }
    }
    // Escape lane: off the back-straight apron before turn 3, angling into the
    // infield, then across to the garage's turn-4-end corner.
    const backStraightEnd = S / 2 + 2 * (Math.PI * R + Le) / 2 + S;
    const sOff = backStraightEnd - Math.min(160, S * 0.4);
    const escape: Array<[number, number]> = [
      this.toWorld(sOff - 60, this.halfWidth + 1),
      this.toWorld(sOff, this.apronD + 6),
      this.toWorld(sOff + 30, this.apronD + 30),
      this.toWorld(garage.s0 + 6, garage.d1 - 2),
    ];
    return { garage, buildings, escape, escapeWidth: 9 };
  }

  /** Banking angle at a sample index and lateral offset. */
  bankAt(idx: number, d: number): number {
    const { bankInner, bankOuter, bankStraight } = this.spec;
    const turn = this.turn[idx];
    if (d > this.halfWidth) {
      // Apron, pit road and infield: much flatter than the racing surface.
      return bankStraight * 0.5 + (bankInner * 0.4 - bankStraight * 0.5) * turn;
    }
    const u = Math.min(1, Math.max(0, (this.halfWidth - d) / (2 * this.halfWidth)));
    const turnBank = bankInner + (bankOuter - bankInner) * u;
    return bankStraight + (turnBank - bankStraight) * turn;
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

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
