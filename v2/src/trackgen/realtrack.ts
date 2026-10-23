import type { Profile, TrackLayout } from '../sim/layout';
import { closeLoop, curveCorners, type CircuitElement, type CircuitParams } from './circuit';
import { integrate } from './course';
import { buildLayout } from './generator';
import { closeOval, type OvalShape, type ShapedOvalParams } from './oval';

/**
 * Real tracks from survey data: a centreline (x, y in metres, closed, in
 * driving order: TUMFTM's racetrack-database, OpenStreetMap) fitted to our
 * builders' vocabulary (straights, and corners as clothoid, arc, clothoid),
 * so a real track gets everything a generated one has: pits, cross-section,
 * run-off, infield. Our laps turn left overall: a clockwise track is
 * mirrored (the same corners the other way: the same lap, physically).
 */
export interface Survey {
  /** The centreline, closed (the last point back to the first), in driving order; the first point on the start line. */
  points: Array<[number, number]>;
  /** Racing surface width at each point (m), if known. */
  widths?: number[];
  /** ...and how much of it is to the right of the centreline and to the left (driving), if known. */
  halves?: Array<[number, number]>;
}

export type FitPiece = { straight: number } | { corner: { angle: number; radius: number; ease: number; easeOut: number } };

export interface Fit {
  pieces: FitPiece[];
  /** Index of the piece the start line is on, and how far into it. */
  startPiece: number;
  startAt: number;
  mirrored: boolean;
  length: number;
  /** The centreline resampled every `step` m (mirrored if the fit is), for comparing against. */
  resampled: Array<[number, number]>;
  step: number;
  width: number;
  /** Where the fit's first piece starts and which way it heads (in the survey's frame, mirrored if the fit is). */
  origin: { x: number; y: number; h: number };
}

const STEP = 2;
/** Curvature knots along a measured lap (m). */
const KNOT = 4;
/** No real corner is tighter than this (m). */
const MIN_RADIUS = 10;

/** A closed polyline resampled every `step` m along its length. */
function resample(points: Array<[number, number]>, step: number): Array<[number, number]> {
  const n = points.length;
  const cum = [0];
  for (let i = 1; i <= n; i++) {
    const [a, b] = [points[i - 1], points[i % n]];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const L = cum[n];
  const out: Array<[number, number]> = [];
  let j = 0;
  for (let s = 0; s < L - step / 2; s += step) {
    while (cum[j + 1] < s) j++;
    const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    const [a, b] = [points[j], points[(j + 1) % n]];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** A closed series smoothed with a Gaussian of sigma samples (wrapping). */
function smoothClosed(v: number[], sigma: number): number[] {
  const n = v.length, r = Math.ceil(3 * sigma);
  const w = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = w.reduce((a, b) => a + b, 0);
  return v.map((_, i) => {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += w[k + r] * v[(((i + k) % n) + n) % n];
    return acc / sum;
  });
}

/**
 * A survey fitted as straights and corners. Curvature from the smoothed
 * centreline; a straight wherever it's gentler than `straightK` (a radius
 * of 1.2 km); each run of curvature one way a corner, keeping its length and
 * turn exactly, its radius from its tightest point (eased in and out over
 * the rest).
 */
export function fitSurvey(survey: Survey, opts: { straightK?: number; smooth?: number; refine?: boolean } = {}): Fit {
  const straightK = opts.straightK ?? 1 / 1200;
  // Driving order turning left overall, or mirrored to.
  let pts = survey.points;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const mirrored = area < 0;
  if (mirrored) pts = pts.map(([x, y]) => [-x, y]);
  const raw = resample(pts, STEP);
  const sigma = (opts.smooth ?? 8) / STEP;
  const xs = smoothClosed(raw.map((p) => p[0]), sigma), ys = smoothClosed(raw.map((p) => p[1]), sigma);
  const n = xs.length;
  const heading = xs.map((_, i) => Math.atan2(ys[(i + 1) % n] - ys[(i - 1 + n) % n], xs[(i + 1) % n] - xs[(i - 1 + n) % n]));
  const kRaw = heading.map((_, i) => {
    let d = heading[(i + 1) % n] - heading[(i - 1 + n) % n];
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return d / (2 * STEP);
  });
  const k = smoothClosed(kRaw, 2);

  // Runs: straight, or a corner one way (sign), from where the curvature crosses the threshold.
  const kind = k.map((v) => (Math.abs(v) < straightK ? 0 : Math.sign(v)));
  // Start the runs where a run begins (not mid-run at the start line).
  let first = 0;
  while (first < n && kind[first] === kind[(first - 1 + n) % n]) first++;
  if (first === n) first = 0;
  type Run = { kind: number; i0: number; len: number };
  const runs: Run[] = [];
  for (let c = 0; c < n; c++) {
    const i = (first + c) % n;
    const last = runs[runs.length - 1];
    if (last && last.kind === kind[i]) last.len++;
    else runs.push({ kind: kind[i], i0: i, len: 1 });
  }
  // Short straights between corners the same way: one corner (compound corners); corners turning almost nothing: straight.
  const turnOf = (r: Run) => { let t = 0; for (let c = 0; c < r.len; c++) t += k[(r.i0 + c) % n] * STEP; return t; };
  for (let changed = true; changed;) {
    changed = false;
    for (let j = 0; j < runs.length && !changed; j++) {
      const r = runs[j], a = runs[(j - 1 + runs.length) % runs.length], b = runs[(j + 1) % runs.length];
      const merge = (into: Run, ...rest: Run[]) => {
        for (const x of rest) into.len += x.len;
        for (const x of rest) runs.splice(runs.indexOf(x), 1);
        changed = true;
      };
      if (r.kind === 0 && r.len * STEP < 20 && a.kind !== 0 && a.kind === b.kind && a !== b && runs.length > 3) merge(a, r, b);
      else if (r.kind !== 0 && Math.abs(turnOf(r)) < (3 * Math.PI) / 180) { r.kind = 0; changed = true; }
      else if (r.kind === b.kind && r !== b) merge(r, b);
    }
  }
  // Pieces; the turns scaled to make a lap exactly (they're within a fraction of a degree).
  const turns = runs.map((r) => (r.kind ? turnOf(r) : 0));
  const total = turns.reduce((a, b) => a + b, 0);
  const pieces: FitPiece[] = runs.map((r, j) => {
    const len = r.len * STEP;
    if (!r.kind) return { straight: len };
    const angle = (turns[j] * 2 * Math.PI) / total;
    // The ease (and so the radius, the length and turn being kept) whose profile, up the ease, flat, down the ease, is
    // nearest the measured curvature's (least squares).
    const measured = Array.from({ length: r.len }, (_, c) => Math.abs(k[(r.i0 + c) % n]));
    let best = Infinity, ease = 0;
    for (let e = 0; e <= len / 2; e += STEP) {
      const top = Math.abs(angle) / (len - e);
      let sq = 0;
      measured.forEach((m, c) => {
        const x = (c + 0.5) * STEP;
        const model = e > 0 ? top * Math.min(1, x / e, (len - x) / e) : top;
        sq += (m - model) ** 2;
      });
      if (sq < best) { best = sq; ease = e; }
    }
    const radius = (len - ease) / Math.abs(angle);
    return { corner: { angle, radius, ease, easeOut: ease } };
  });
  // Where the start line (the survey's first point) falls.
  let acc = 0, startPiece = 0, startAt = 0;
  const startOffset = ((n - first) % n) * STEP;
  for (let j = 0; j < pieces.length; j++) {
    const len = runs[j].len * STEP;
    if (startOffset < acc + len) { startPiece = j; startAt = startOffset - acc; break; }
    acc += len;
  }
  const widths = survey.widths ?? [];
  const sorted = [...widths].sort((a, b) => a - b);
  const h0 = Math.atan2(ys[(first + 1) % n] - ys[(first - 1 + n) % n], xs[(first + 1) % n] - xs[(first - 1 + n) % n]);
  const refined = opts.refine === false ? { pieces, origin: { x: xs[first], y: ys[first], h: h0 } } : refine(pieces, raw, first, { x: xs[first], y: ys[first], h: h0 });
  return {
    pieces: refined.pieces, startPiece, startAt, mirrored, length: n * STEP, resampled: raw, step: STEP,
    width: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 12, origin: refined.origin,
  };
}

/**
 * A fit refined as a whole: every straight's length, every corner's turn,
 * ease and length, and where the lap starts and which way it heads, nudged
 * together so the fitted line lies on the survey's all the way round and
 * closes on itself (damped Gauss-Newton, numerical derivatives). Fitting
 * each corner on its own isn't enough: half a degree off at one end of a
 * kilometre straight is nine metres at the other.
 */
function refine(
  pieces: FitPiece[], real: Array<[number, number]>, first: number, origin: { x: number; y: number; h: number },
): { pieces: FitPiece[]; origin: { x: number; y: number; h: number } } {
  const n = real.length, L = n * STEP, EVERY = 8, K = Math.floor(L / EVERY);
  // Parameters: the origin (x, y, heading), then each straight's length, each corner's turn, ease and length.
  const theta: number[] = [origin.x, origin.y, origin.h];
  const scale: number[] = [0.01, 0.01, 1e-4];
  for (const p of pieces) {
    if ('straight' in p) { theta.push(p.straight); scale.push(0.05); }
    else { theta.push(p.corner.angle, p.corner.ease, p.corner.easeOut, pieceLength(p)); scale.push(1e-4, 0.05, 0.05, 0.05); }
  }
  /** A corner's parameters from t at i, kept sensible: eases of at least nothing leaving an arc of a metre or more. */
  const corner = (t: number[], i: number) => {
    const angle = t[i], len = Math.max(4, t[i + 3]);
    let ein = Math.max(0, t[i + 1]), eout = Math.max(0, t[i + 2]);
    const room = len - 1;
    if (ein + eout > room) { const f = room / (ein + eout); ein *= f; eout *= f; }
    return { angle, ein, eout, len };
  };
  const sectionsOf = (t: number[]): Array<[number, number, number]> => {
    const out: Array<[number, number, number]> = [];
    let i = 3;
    for (const p of pieces) {
      if ('straight' in p) { out.push([Math.max(0.5, t[i++]), 0, 0]); continue; }
      const { angle, ein, eout, len } = corner(t, i);
      i += 4;
      const kk = angle / (len - (ein + eout) / 2);
      if (ein > 0) out.push([ein, 0, kk]);
      if (len - ein - eout > 1e-6) out.push([len - ein - eout, kk, kk]);
      if (eout > 0) out.push([eout, kk, 0]);
    }
    return out;
  };
  /** The line every EVERY m (K points, carried on straight past its end if it's short), its end and heading there. */
  const residuals = (t: number[]): number[] => {
    const secs = sectionsOf(t);
    const out: number[] = [];
    let x = t[0], y = t[1], h = t[2], s = 0, next = 0;
    const ds = 0.5;
    for (const [len, k0, k1] of secs) {
      const m = Math.max(1, Math.ceil(len / ds)), d = len / m;
      for (let j = 0; j < m; j++) {
        while (next < K && next * EVERY <= s) {
          const [u, v] = real[(first + Math.round((next * EVERY) / STEP)) % n];
          out.push(x - u, y - v);
          next++;
        }
        const k = k0 + ((k1 - k0) * (j + 0.5)) / m, mid = h + (k * d) / 2;
        x += Math.cos(mid) * d; y += Math.sin(mid) * d; h += k * d; s += d;
      }
    }
    for (; next < K; next++) {
      const [u, v] = real[(first + Math.round((next * EVERY) / STEP)) % n], ahead = next * EVERY - s;
      out.push(x + Math.cos(h) * ahead - u, y + Math.sin(h) * ahead - v);
    }
    // Closed: back where it started, heading round a whole turn.
    out.push(10 * (x - t[0]), 10 * (y - t[1]), 2000 * (h - t[2] - 2 * Math.PI));
    // Each piece near what was measured of it (a corner's turn within a few degrees, its length and the straights'
    // within a little), no corner tighter than MIN_RADIUS: else the lap closes by bending corners into knots.
    let i = 3;
    for (const p of pieces) {
      if ('straight' in p) { out.push(0.3 * (t[i] - p.straight)); i++; continue; }
      const { angle, ein, eout, len } = corner(t, i);
      out.push(150 * (angle - p.corner.angle), 0.3 * (len - pieceLength(p)));
      const radius = (len - (ein + eout) / 2) / Math.abs(angle);
      out.push(radius < MIN_RADIUS ? 50 * (MIN_RADIUS - radius) : 0);
      i += 4;
    }
    return out;
  };
  let r = residuals(theta), cost = r.reduce((a, v) => a + v * v, 0), lambda = 1e-3;
  for (let iter = 0; iter < 40; iter++) {
    const P = theta.length, M = r.length;
    const J: number[][] = [];
    for (let j = 0; j < P; j++) {
      const t = [...theta];
      t[j] += scale[j];
      const rj = residuals(t);
      J.push(rj.map((v, i) => (v - r[i]) / scale[j]));
    }
    const A = Array.from({ length: P }, (_, a) => Array.from({ length: P }, (__, b) => {
      let acc = 0;
      for (let i = 0; i < M; i++) acc += J[a][i] * J[b][i];
      return acc;
    }));
    const g = Array.from({ length: P }, (_, a) => { let acc = 0; for (let i = 0; i < M; i++) acc += J[a][i] * r[i]; return acc; });
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const D = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-9 : v)));
      const step = solve(D, g.map((v) => -v));
      if (!step) { lambda *= 10; continue; }
      const t = theta.map((v, j) => v + step[j]);
      const rt = residuals(t), c = rt.reduce((a, v) => a + v * v, 0);
      if (c < cost) { theta.splice(0, P, ...t); r = rt; improved = c > cost * (1 - 1e-6) ? false : true; cost = c; lambda = Math.max(1e-7, lambda / 3); }
      else lambda *= 10;
    }
    if (!improved) break;
  }
  // Back to pieces (radius from turn, ease and length), the turns scaled to make a lap exactly (they're within a
  // hundredth of a degree: the closing is weighted, not exact).
  let turn = 0;
  {
    let j = 3;
    for (const p of pieces) { if ('straight' in p) j++; else { turn += theta[j]; j += 4; } }
  }
  {
    let j = 3;
    for (const p of pieces) { if ('straight' in p) j++; else { theta[j] *= (2 * Math.PI) / turn; j += 4; } }
  }
  let i = 3;
  const out: FitPiece[] = pieces.map((p) => {
    if ('straight' in p) return { straight: Math.max(0.5, theta[i++]) };
    const { angle, ein, eout, len } = corner(theta, i);
    i += 4;
    return { corner: { angle, radius: (len - (ein + eout) / 2) / Math.abs(angle), ease: ein, easeOut: eout } };
  });
  return { pieces: out, origin: { x: theta[0], y: theta[1], h: theta[2] } };
}

/** Solves A x = b (Gaussian elimination, partial pivoting); null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let acc = M[r][n];
    for (let k = r + 1; k < n; k++) acc -= M[r][k] * x[k];
    x[r] = acc / M[r][r];
  }
  return x;
}

/** The sections of a fit, in order from its first piece. */
export function fitSections(fit: Fit): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const p of fit.pieces) {
    if ('straight' in p) out.push([p.straight, 0, 0]);
    else {
      const { angle, radius, ease, easeOut } = p.corner;
      const kk = Math.sign(angle) / radius, arc = Math.abs(angle) * radius - (ease + easeOut) / 2;
      if (ease > 0) out.push([ease, 0, kk]);
      if (arc > 1e-6) out.push([arc, kk, kk]);
      if (easeOut > 0) out.push([easeOut, kk, 0]);
    }
  }
  return out;
}

/** How far the fit's line strays from the survey's (max and mean, m), laid from the same place heading the same way. */
export function fitError(fit: Fit): { max: number; mean: number } {
  const real = fit.resampled;
  const pts = integrate(fitSections(fit), fit.origin.x, fit.origin.y, fit.origin.h, 4).points;
  let max = 0, sum = 0;
  for (const [x, y] of pts) {
    let best = Infinity;
    for (const [u, v] of real) best = Math.min(best, (x - u) ** 2 + (y - v) ** 2);
    max = Math.max(max, Math.sqrt(best));
    sum += Math.sqrt(best);
  }
  return { max, mean: sum / pts.length };
}

function pieceLength(p: FitPiece): number {
  return 'straight' in p ? p.straight : Math.abs(p.corner.angle) * p.corner.radius + (p.corner.ease + p.corner.easeOut) / 2;
}

/**
 * A fit as a road circuit's parameters: the straight the start line is on as
 * the main straight (the start line moves to its middle), the rest in order,
 * closed exactly by the smallest change to the straights. Null if the start
 * line isn't on a straight long enough to be a main straight, or it doesn't
 * close.
 */
export function circuitFromFit(fit: Fit, opts: { name: string; verge?: number }): CircuitParams | null {
  const m = fit.startPiece;
  const main = fit.pieces[m];
  if (!('straight' in main) || main.straight < 300) return null;
  const elements: CircuitElement[] = [];
  for (let j = 1; j < fit.pieces.length; j++) {
    const p = fit.pieces[(m + j) % fit.pieces.length];
    elements.push('straight' in p ? { straight: p.straight } : { corner: { ...p.corner } });
  }
  const corners = elements.filter((e) => 'corner' in e).length;
  const params: CircuitParams = {
    main: main.straight, elements, width: fit.width, verge: opts.verge ?? 12,
    runoff: Array.from({ length: corners }, () => 'runoff' as const), character: 'real', name: opts.name,
  };
  return closeLoop(params) ? params : null;
}

/**
 * A survey's curvature as measured: turning left overall (mirrored if it
 * doesn't), resampled every STEP m, smoothed (over `smooth` m), curvature
 * against the smoothed line's own length (a curve rebuilt from its own
 * curvature closes on itself), sampled every KNOT m from the start line.
 */
function measure(survey: Survey, smooth: number) {
  let pts = survey.points;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const mirrored = area < 0;
  if (mirrored) pts = pts.map(([x, y]) => [-x, y]);
  const raw = resample(pts, STEP);
  const sigma = smooth / STEP;
  const xs = smoothClosed(raw.map((p) => p[0]), sigma), ys = smoothClosed(raw.map((p) => p[1]), sigma);
  const n = xs.length;
  // Along the smoothed line: segment lengths and headings, curvature at each vertex.
  const seg = xs.map((_, i) => Math.hypot(xs[(i + 1) % n] - xs[i], ys[(i + 1) % n] - ys[i]));
  const head = xs.map((_, i) => Math.atan2(ys[(i + 1) % n] - ys[i], xs[(i + 1) % n] - xs[i]));
  const kv = smoothClosed(xs.map((_, i) => {
    const d = head[i] - head[(i - 1 + n) % n];
    return Math.atan2(Math.sin(d), Math.cos(d)) / ((seg[i] + seg[(i - 1 + n) % n]) / 2);
  }), 1.5);
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + seg[i]);
  const L = cum[n];
  // Knots every KNOT m from the start line, curvature there by interpolation.
  const m = Math.round(L / KNOT), knot = L / m;
  const kAt: number[] = [];
  for (let j = 0, i = 0; j < m; j++) {
    const s = j * knot;
    while (cum[i + 1] < s) i++;
    const t = (s - cum[i]) / (seg[i] || 1);
    kAt.push(kv[i] + (kv[(i + 1) % n] - kv[i]) * t);
  }
  return { mirrored, pts, raw, xs, ys, n, seg, head, cum, L, m, knot, kAt };
}

/**
 * Curvature sections (every `knot` m, from the knots' curvature) closed
 * exactly: a whole turn (scaled), and back where they started, by two smooth
 * waves of curvature added along them (each turning nothing in all; `weight`
 * where they may go, 0 at sections that must keep their shape), sized to
 * cancel the gap. Null if it won't close.
 */
function closeCurvature(
  k: number[], knot: number, pre: Array<[number, number, number]>, post: Array<[number, number, number]>, weight: (u: number) => number,
): Array<[number, number, number]> | null {
  const q = k.length - 1;
  const fixed = [...pre, ...post].reduce((acc, [len, k0, k1]) => acc + (len * (k0 + k1)) / 2, 0);
  const build = (c: [number, number]) => {
    const kk = k.map((v, j) => {
      const u = j / q;
      return v + weight(u) * (c[0] * Math.sin(2 * Math.PI * u) + c[1] * Math.cos(2 * Math.PI * u));
    });
    const turn = kk.reduce((acc, v, j) => (j ? acc + (knot * (v + kk[j - 1])) / 2 : acc), 0);
    const f = (2 * Math.PI - fixed) / turn;
    const sections: Array<[number, number, number]> = [];
    for (let j = 1; j <= q; j++) sections.push([knot, kk[j - 1] * f, kk[j] * f]);
    return sections;
  };
  const gap = (c: [number, number]) => {
    const e = integrate([...pre, ...build(c), ...post], 0, 0, 0).end;
    return [e.x, e.y];
  };
  let c: [number, number] = [0, 0];
  for (let iter = 0; iter < 6; iter++) {
    const g = gap(c);
    if (Math.hypot(g[0], g[1]) < 0.05) break;
    const e = 1e-7, g1 = gap([c[0] + e, c[1]]), g2 = gap([c[0], c[1] + e]);
    const J = [[(g1[0] - g[0]) / e, (g2[0] - g[0]) / e], [(g1[1] - g[1]) / e, (g2[1] - g[1]) / e]];
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
    if (Math.abs(det) < 1e-12) return null;
    c = [c[0] - (J[1][1] * g[0] - J[0][1] * g[1]) / det, c[1] - (-J[1][0] * g[0] + J[0][0] * g[1]) / det];
  }
  const g = gap(c);
  return Math.hypot(g[0], g[1]) > 0.5 ? null : build(c);
}

/**
 * A survey as a road circuit's parameters, its corners as measured: the
 * centreline smoothed (over `smooth` m), its curvature against its own
 * length every KNOT m (a curve rebuilt from its own curvature closes on
 * itself), gentler than `straightK` straight. The straight the start line is
 * on is the main straight (the start line moves to its middle); the rest
 * alternate straights and measured curves, closed exactly by the smallest
 * change to the straights. Null if the start line isn't on a straight long
 * enough for a main straight, or it doesn't close.
 */
export function circuitFromSurvey(
  survey: Survey, opts: { name: string; verge?: number; smooth?: number; straightK?: number },
): { params: CircuitParams; mirrored: boolean; resampled: Array<[number, number]>; origin: { x: number; y: number; h: number } } | null {
  const straightK = opts.straightK ?? 1 / 1500;
  const { mirrored, pts, raw, xs, ys, n, seg, head, cum, L, m, knot, kAt } = measure(survey, opts.smooth ?? 5);
  // The main straight: the stretch round the start line gentler than straightK on average over 50 m (survey noise
  // makes a straight's curvature flicker), made dead straight; or, if the line isn't on one, the longest such
  // stretch (the start line moves to its middle). The rest keeps its curvature as measured (straightening gentle bends
  // elsewhere throws the lap tens of metres out).
  const w = Math.round(25 / knot);
  const avg = kAt.map((_, j) => {
    let acc = 0;
    for (let d = -w; d <= w; d++) acc += Math.abs(kAt[(((j + d) % m) + m) % m]);
    return acc / (2 * w + 1);
  });
  const gentle = (j: number) => avg[((j % m) + m) % m] < straightK;
  const stretchAt = (j0: number): [number, number] => {
    let lo = j0, hi = j0 + 1;
    while (lo > j0 - m / 2 && gentle(lo - 1)) lo--;
    while (hi < j0 + m / 2 && gentle(hi)) hi++;
    return [lo, hi];
  };
  let [a, b] = gentle(0) ? stretchAt(0) : [0, 0];
  if ((b - a) * knot < 300) {
    for (let j = 0; j < m; j++) {
      if (!gentle(j) || gentle(j - 1)) continue;
      const [lo, hi] = stretchAt(j);
      if (hi - lo > b - a) [a, b] = [lo, hi];
    }
  }
  // The main straight: the line between the survey's points where that stretch begins and ends.
  const poseAt = (j: number) => {
    const sj = ((((j % m) + m) % m) * knot);
    let i = 0;
    while (cum[i + 1] < sj) i++;
    const t = (sj - cum[i]) / (seg[i] || 1);
    return { x: xs[i] + (xs[(i + 1) % n] - xs[i]) * t, y: ys[i] + (ys[(i + 1) % n] - ys[i]) * t, h: head[i] };
  };
  const A = poseAt(a), B = poseAt(b);
  const main = Math.hypot(B.x - A.x, B.y - A.y), phi = Math.atan2(B.y - A.y, B.x - A.x);
  if (main < 300) return null;
  // The rest, from the main straight's end round to its start, as one measured curve: its curvature as measured, plus
  // the turn from the straight's line onto the survey's heading eased in over its first BLEND m (and off it again
  // over its last), so it leaves and meets the straight square; then closed exactly, a whole turn (its curvature
  // scaled) and back where it started (two smooth waves of curvature added along it, each turning nothing in all,
  // sized to cancel what's left of the gap: a metre or two).
  const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
  const BLEND = 40, nb = Math.max(2, Math.round(BLEND / knot));
  const rest: number[] = [];
  for (let j = b; j <= a + m; j++) rest.push(kAt[((j % m) + m) % m]);
  const q = rest.length - 1;
  const into = wrap(B.h - phi), outOf = wrap(phi - A.h);
  const tri = (d: number) => 1 - Math.abs(2 * d - nb) / nb; // 0 at the ends, 1 in the middle
  const triArea = Array.from({ length: nb }, (_, d) => (knot * (tri(d) + tri(d + 1))) / 2).reduce((x, y) => x + y, 0);
  for (let d = 0; d <= nb; d++) {
    rest[d] += (into / triArea) * tri(d);
    rest[q - nb + d] += (outOf / triArea) * tri(d);
  }
  rest[0] = 0; rest[q] = 0;
  // (Nothing added at the ends: they meet the main straight.)
  const closed = closeCurvature(rest, knot, [[main / 2, 0, 0]], [[main / 2, 0, 0]], (u) => Math.sin(Math.PI * u) ** 2);
  if (!closed) return null;
  const curve = closed;
  const elements: CircuitElement[] = [{ curve }];
  // Its widths either side as surveyed, along the lap from the main straight's middle (mirrored: right is left), over
  // 30 m (satellite widths are noisy).
  let edges: CircuitParams['edges'];
  if (survey.halves && survey.halves.length === pts.length) {
    const cumO = [0];
    for (let i = 1; i <= pts.length; i++) {
      const [p, q] = [pts[i - 1], pts[i % pts.length]];
      cumO.push(cumO[i - 1] + Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    const sideAt = (side: 0 | 1) => {
      const out: number[] = [];
      for (let i = 0, j = 0; i < n; i++) {
        const sr = i * STEP;
        while (cumO[j + 1] < sr) j++;
        const t = (sr - cumO[j]) / (cumO[j + 1] - cumO[j] || 1);
        const a = survey.halves![j][side], b = survey.halves![(j + 1) % pts.length][side];
        out.push(a + (b - a) * t);
      }
      return smoothClosed(out, 15 / STEP);
    };
    const right = sideAt(mirrored ? 1 : 0), left = sideAt(mirrored ? 0 : 1);
    const sMid0 = ((((a + b) / 2) * knot) % L + L) % L;
    const profile = (v: number[]): Profile => {
      const keys: Array<[number, number]> = [];
      for (let i = 0; i < n; i += 5) {
        let x = cum[i] - sMid0;
        x = ((x % L) + L) % L;
        if (x > L / 2) x -= L;
        keys.push([x, v[i]]);
      }
      keys.sort((p, q) => p[0] - q[0]);
      return { keys: keys.filter((k, i) => i === 0 || k[0] - keys[i - 1][0] > 1e-6), ease: 'linear' };
    };
    edges = { left: profile(left), right: profile(right) };
  }
  const corners = curveCorners(curve, straightK).length;
  const widths = survey.widths ?? [];
  const sorted = [...widths].sort((p, q) => p - q);
  const params: CircuitParams = {
    main, elements, width: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 12, verge: opts.verge ?? 12,
    runoff: Array.from({ length: corners }, () => 'runoff' as const), character: 'real', name: opts.name, straightK,
    ...(edges ? { edges } : {}),
  };
  // Where the lap (from the main straight's middle) starts on the survey, and which way it heads.
  const origin = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, h: phi };
  return { params, mirrored, resampled: raw, origin };
}

/**
 * A fit (fitSurvey) as an oval's parameters: its straights and turns in
 * order, the first straight the one before the first turn, every turn banked
 * as given (the survey has no banking: published figures do), closed exactly
 * by the smallest change to the straights. The start line where the
 * survey's is. Null if it doesn't alternate straight and turn, or doesn't
 * close.
 */
export function ovalFromFit(
  fit: Fit, opts: { name: string; bank: number; bankStraight?: number; doglegBank?: number; apronWidth?: number; shape?: OvalShape },
): ShapedOvalParams | null {
  // The front stretch: the straights (and a tri-oval's dogleg bends) the start line is on, or, if the survey's start
  // line is in a turn (pit road along both straights: Bristol, Martinsville), the nearest straight's middle. The lap's
  // first straight is the front stretch's first.
  const P = fit.pieces.length;
  const isTurn = (p: FitPiece) => 'corner' in p && p.corner.angle >= Math.PI / 3;
  const lengthOf = (p: FitPiece) => pieceLength(p);
  const at = (j: number) => fit.pieces[((j % P) + P) % P];
  let startPiece = fit.startPiece, startAt = fit.startAt;
  if (isTurn(at(startPiece))) {
    // (Whichever straight is nearer: the one after the turn, or before it.)
    const after = (() => { let j = startPiece + 1, d = lengthOf(at(startPiece)) - startAt; while (!('straight' in at(j))) { d += lengthOf(at(j)); j++; } return { j, d }; })();
    const before = (() => { let j = startPiece - 1, d = startAt; while (!('straight' in at(j))) { d += lengthOf(at(j)); j--; } return { j, d }; })();
    const pick = after.d <= before.d ? after.j : before.j;
    startPiece = ((pick % P) + P) % P;
    startAt = lengthOf(at(pick)) / 2;
  }
  let k0 = startPiece;
  while (!isTurn(at(k0 - 1))) k0--;
  while (!('straight' in at(k0))) k0++; // (the first straight of it)
  if (!fit.pieces.some((p) => 'straight' in p)) return null;
  const order = fit.pieces.map((_, j) => at(k0 + j));
  const straights: ShapedOvalParams['straights'] = [], corners: ShapedOvalParams['corners'] = [];
  for (let j = 0; j < order.length; j += 2) {
    const st = order[j], c = order[j + 1];
    if (!st || !c || !('straight' in st) || !('corner' in c) || c.corner.angle <= 0) return null;
    straights.push({ length: st.straight });
    // (A bend of under 60 degrees is the front stretch's dogleg, as a tri-oval's: banked as published for it.)
    const dogleg = c.corner.angle < Math.PI / 3;
    const bank = (((dogleg ? opts.doglegBank ?? opts.bankStraight ?? 0 : opts.bank) * Math.PI) / 180);
    corners.push({
      angle: c.corner.angle, radius: c.corner.radius, easeIn: c.corner.ease, easeOut: c.corner.easeOut,
      bankInner: bank, bankOuter: bank, ...(dogleg ? { dogleg: true } : {}),
    });
  }
  // The start line: how far it is round from the first straight's beginning.
  let start = startAt;
  for (let j = k0; ((j % P) + P) % P !== startPiece; j++) start += lengthOf(at(j));
  const params: ShapedOvalParams = {
    shape: opts.shape ?? 'rectangle', straights, corners, start, width: fit.width,
    apronWidth: opts.apronWidth ?? 8, bankStraight: ((opts.bankStraight ?? 0) * Math.PI) / 180, name: opts.name,
  };
  return closeOval(params) ? params : null;
}

/** A real track DotGP can lay out: where its survey is (under public/tracks/), and what it is. */
export interface RealTrack {
  id: string;
  name: string;
  file: string;
  kind: 'circuit' | 'oval';
  /** An oval's turn banking (deg: published figures, the survey has none), its straights', and a tri-oval's dogleg. */
  bank?: number;
  bankStraight?: number;
  doglegBank?: number;
  /** Smoothing of the survey (m): more for OpenStreetMap's sparse points than for a survey's. */
  smooth?: number;
  /** Curvature (1/m) below which it counts as straight (default 1/1200): less for a long, gently curving front stretch. */
  straightK?: number;
}

/** The real tracks (TUMFTM's racetrack-database: public/tracks/tumftm/README.md, and OpenStreetMap). Suzuka crosses itself: left out. */
export const REAL_TRACKS: RealTrack[] = [
  { id: 'austin', name: 'Circuit of the Americas', file: 'tumftm/Austin.csv', kind: 'circuit' },
  { id: 'brandshatch', name: 'Brands Hatch', file: 'tumftm/BrandsHatch.csv', kind: 'circuit' },
  { id: 'budapest', name: 'Hungaroring', file: 'tumftm/Budapest.csv', kind: 'circuit' },
  { id: 'catalunya', name: 'Barcelona-Catalunya', file: 'tumftm/Catalunya.csv', kind: 'circuit' },
  { id: 'hockenheim', name: 'Hockenheimring', file: 'tumftm/Hockenheim.csv', kind: 'circuit' },
  { id: 'indianapolis', name: 'Indianapolis Motor Speedway', file: 'tumftm/IMS.csv', kind: 'oval', bank: 9.2, bankStraight: 0 },
  { id: 'melbourne', name: 'Albert Park', file: 'tumftm/Melbourne.csv', kind: 'circuit' },
  { id: 'mexicocity', name: 'Hermanos Rodríguez', file: 'tumftm/MexicoCity.csv', kind: 'circuit' },
  { id: 'montreal', name: 'Circuit Gilles Villeneuve', file: 'tumftm/Montreal.csv', kind: 'circuit' },
  { id: 'monza', name: 'Monza', file: 'tumftm/Monza.csv', kind: 'circuit' },
  { id: 'moscow', name: 'Moscow Raceway', file: 'tumftm/MoscowRaceway.csv', kind: 'circuit' },
  { id: 'norisring', name: 'Norisring', file: 'tumftm/Norisring.csv', kind: 'circuit' },
  { id: 'nurburgring', name: 'Nürburgring', file: 'tumftm/Nuerburgring.csv', kind: 'circuit' },
  { id: 'oschersleben', name: 'Oschersleben', file: 'tumftm/Oschersleben.csv', kind: 'circuit' },
  { id: 'sakhir', name: 'Bahrain', file: 'tumftm/Sakhir.csv', kind: 'circuit' },
  { id: 'saopaulo', name: 'Interlagos', file: 'tumftm/SaoPaulo.csv', kind: 'circuit' },
  { id: 'sepang', name: 'Sepang', file: 'tumftm/Sepang.csv', kind: 'circuit' },
  { id: 'shanghai', name: 'Shanghai', file: 'tumftm/Shanghai.csv', kind: 'circuit' },
  { id: 'silverstone', name: 'Silverstone', file: 'tumftm/Silverstone.csv', kind: 'circuit' },
  { id: 'sochi', name: 'Sochi', file: 'tumftm/Sochi.csv', kind: 'circuit' },
  { id: 'spa', name: 'Spa-Francorchamps', file: 'tumftm/Spa.csv', kind: 'circuit' },
  { id: 'spielberg', name: 'Red Bull Ring', file: 'tumftm/Spielberg.csv', kind: 'circuit' },
  { id: 'yasmarina', name: 'Yas Marina', file: 'tumftm/YasMarina.csv', kind: 'circuit' },
  { id: 'zandvoort', name: 'Zandvoort', file: 'tumftm/Zandvoort.csv', kind: 'circuit' },
  // From OpenStreetMap (public/tracks/osm/README.md), banking from published figures.
  { id: 'daytona', name: 'Daytona International Speedway', file: 'osm/Daytona.csv', kind: 'oval', bank: 31, bankStraight: 3, doglegBank: 18, smooth: 20 },
  { id: 'talladega', name: 'Talladega Superspeedway', file: 'osm/Talladega.csv', kind: 'oval', bank: 33, bankStraight: 2, doglegBank: 16.5, smooth: 20 },
  // (Charlotte's, Bristol's and Michigan's banking, and the widths, as commonly cited: to check against the tracks'.)
  { id: 'michigan', name: 'Michigan International Speedway', file: 'osm/Michigan.csv', kind: 'oval', bank: 18, bankStraight: 5, doglegBank: 12, smooth: 20 },
  { id: 'charlotte', name: 'Charlotte Motor Speedway', file: 'osm/Charlotte.csv', kind: 'oval', bank: 24, bankStraight: 5, smooth: 20 },
  { id: 'bristol', name: 'Bristol Motor Speedway', file: 'osm/Bristol.csv', kind: 'oval', bank: 26, bankStraight: 5, smooth: 12 },
  { id: 'martinsville', name: 'Martinsville Speedway', file: 'osm/Martinsville.csv', kind: 'oval', bank: 12, bankStraight: 0, smooth: 12 },
];

/** A survey from a TUMFTM-style CSV: x, y, width right, width left (m) a row, '#' comments. */
export function parseSurvey(csv: string): Survey {
  const rows = csv.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split(',').map(Number));
  const sides = rows[0]?.length >= 4;
  return {
    points: rows.map((r) => [r[0], r[1]]),
    ...(sides ? { widths: rows.map((r) => r[2] + r[3]), halves: rows.map((r) => [r[2], r[3]] as [number, number]) } : {}),
  };
}

/**
 * A real track's layout from its survey (as DotGP lays it out: its own pits,
 * run-off and cross-section on the real line). Throws, saying why, if it
 * can't be laid out.
 */
export function realLayout(track: RealTrack, csv: string): TrackLayout {
  const survey = parseSurvey(csv);
  if (track.kind === 'oval') {
    const made = ovalFromSurvey(survey, {
      name: track.name, bank: track.bank ?? 0, bankStraight: track.bankStraight, doglegBank: track.doglegBank, smooth: track.smooth,
    });
    if (!made) throw new Error(`${track.name}: its survey doesn't close, or has no turns`);
    const layout = buildLayout('oval', made.params);
    return { ...layout, params: { ...layout.params, surveyOrigin: made.origin } };
  }
  const made = circuitFromSurvey(survey, { name: track.name });
  if (!made) throw new Error(`${track.name}: no straight long enough for a main straight, or the lap doesn't close`);
  const layout = buildLayout('circuit', { ...made.params, name: track.name });
  // A clockwise track is raced as its mirror image (DotGP's laps turn left), and drawn the right way round. Where its
  // start line is on the survey (mirrored with it), for laying the two over each other.
  return { ...layout, params: { ...layout.params, surveyOrigin: made.origin, ...(made.mirrored ? { drawnMirrored: true } : {}) } };
}

/**
 * A survey as an oval's parameters, every straight and turn as measured (a
 * straight may bend gently, as Michigan's D-shaped front stretch does): the
 * lap closed exactly (two smooth waves of curvature, a few thousandths of a
 * degree a metre); turns where its curvature (averaged over 20 m) is
 * tighter than `turnK` (bends of under 60 degrees the front stretch's
 * doglegs), banked as given; the straights between. The front stretch is the
 * one the start line is on (a start line in a turn moves to the nearest
 * straight's middle: pit road along both straights, Bristol). Null if it
 * won't close, or has no turns.
 */
export function ovalFromSurvey(
  survey: Survey, opts: { name: string; bank: number; bankStraight?: number; doglegBank?: number; smooth?: number; turnK?: number; apronWidth?: number },
): { params: ShapedOvalParams; origin: { x: number; y: number; h: number } } | null {
  const { m, knot, kAt, xs, ys, head } = measure(survey, opts.smooth ?? 12);
  const closed = closeCurvature([...kAt, kAt[0]], knot, [], [], () => 1);
  if (!closed) return null;
  // Curvature at each knot (as closed), averaged over 20 m, and which knots are in turns.
  const kk = closed.map((sec) => sec[1]);
  const w = Math.max(1, Math.round(10 / knot));
  const at = (j: number) => kk[((j % m) + m) % m];
  const turnK = opts.turnK ?? 1 / 800;
  const inTurn = kk.map((_, j) => {
    let acc = 0;
    for (let d = -w; d <= w; d++) acc += at(j + d);
    return acc / (2 * w + 1) > turnK;
  });
  // (A gap of under 40 m between two stretches of turn is still the turn.)
  const gapMax = Math.round(40 / knot);
  for (let j = 0; j < m; j++) {
    if (inTurn[j] || !inTurn[(j - 1 + m) % m]) continue;
    let e = j;
    while (e - j < gapMax && !inTurn[e % m]) e++;
    if (e - j < gapMax) for (let x = j; x < e; x++) inTurn[x % m] = true;
  }
  if (!inTurn.some(Boolean) || inTurn.every(Boolean)) return null;
  // Runs from the start of a straight: straight, turn, straight, turn...
  let s0 = 0;
  while (!(!inTurn[s0] && inTurn[(s0 - 1 + m) % m])) s0++;
  const runs: Array<{ turn: boolean; from: number; len: number }> = [];
  for (let c = 0; c < m; c++) {
    const j = (s0 + c) % m, last = runs[runs.length - 1];
    if (last && last.turn === inTurn[j]) last.len++;
    else runs.push({ turn: inTurn[j], from: j, len: 1 });
  }
  const sectionsOf = (r: { from: number; len: number }) => Array.from({ length: r.len }, (_, c) => closed[(r.from + c) % m]);
  const turnOf = (secs: Array<[number, number, number]>) => secs.reduce((a, [len, k0, k1]) => a + (len * (k0 + k1)) / 2, 0);
  // Pair them: straights[i] runs into corners[i].
  type Pair = { straight: Array<[number, number, number]>; from: number; corner: Array<[number, number, number]> };
  const pairs: Pair[] = [];
  for (let r = 0; r + 1 < runs.length; r += 2) pairs.push({ straight: sectionsOf(runs[r]), from: runs[r].from, corner: sectionsOf(runs[r + 1]) });
  const dogleg = (p: Pair) => turnOf(p.corner) < Math.PI / 3;
  // The start line (knot 0): on a straight, or moved to the nearest straight's middle.
  const startPair = (() => {
    const offs = pairs.map((p) => (((0 - p.from) % m) + m) % m);
    // (On a straight, or a front-stretch dogleg: the start line stays where it is.)
    const onStraight = pairs.findIndex((p, i) => offs[i] < p.straight.length || (dogleg(p) && offs[i] < p.straight.length + p.corner.length));
    if (onStraight >= 0) return { i: onStraight, at: offs[onStraight] * knot, knot: 0 };
    // (In a turn: the straight before it or after it, whichever is nearer.)
    const into = pairs.findIndex((p, i) => offs[i] < p.straight.length + p.corner.length);
    const before = (offs[into] - pairs[into].straight.length) * knot;
    const next = (into + 1) % pairs.length;
    const after = (pairs[into].corner.length - (offs[into] - pairs[into].straight.length)) * knot;
    const i = before <= after ? into : next;
    return { i, at: (pairs[i].straight.length * knot) / 2, knot: (pairs[i].from + Math.floor(pairs[i].straight.length / 2)) % m };
  })();
  // The front stretch begins after the last real turn before the line (doglegs are part of it).
  let first = startPair.i, start = startPair.at;
  while (dogleg(pairs[(first - 1 + pairs.length) % pairs.length])) {
    first = (first - 1 + pairs.length) % pairs.length;
    start += (pairs[first].straight.length + pairs[first].corner.length) * knot;
  }
  const order = pairs.map((_, j) => pairs[(first + j) % pairs.length]);
  const deg = (x: number) => (x * Math.PI) / 180;
  const params: ShapedOvalParams = {
    shape: 'rectangle',
    straights: order.map((p) => ({ length: p.straight.length * knot, sections: p.straight })),
    corners: order.map((p) => {
      const angle = turnOf(p.corner);
      const peak = Math.max(...p.corner.map(([, k0, k1]) => Math.max(Math.abs(k0), Math.abs(k1))));
      const tight = (sec: [number, number, number]) => Math.max(Math.abs(sec[1]), Math.abs(sec[2])) >= 0.85 * peak;
      const a = p.corner.findIndex(tight), b = p.corner.length - 1 - [...p.corner].reverse().findIndex(tight);
      const bank = deg(dogleg(p) ? opts.doglegBank ?? opts.bankStraight ?? 0 : opts.bank);
      return {
        angle, radius: 1 / peak, easeIn: a * knot, easeOut: (p.corner.length - 1 - b) * knot,
        bankInner: bank, bankOuter: bank, sections: p.corner, ...(dogleg(p) ? { dogleg: true } : {}),
      };
    }),
    start, width: survey.widths?.length ? [...survey.widths].sort((x, y) => x - y)[Math.floor(survey.widths.length / 2)] : 15,
    apronWidth: opts.apronWidth ?? 8, bankStraight: deg(opts.bankStraight ?? 0), name: opts.name,
  };
  // Where the start line is on the survey, heading which way: from knot 0's pose along the lap as closed.
  const e = integrate(closed.slice(0, startPair.knot), xs[0], ys[0], head[0]).end;
  return { params, origin: { x: e.x, y: e.y, h: e.h } };
}
