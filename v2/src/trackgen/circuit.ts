import type { Rng } from '../ai/rng';
import { Centerline } from '../sim/centerline';
import {
  flat, LAYOUT_VERSION, type CenterlineSpec, type Marking, type Profile, type SurfaceRegion, type TrackLayout, type Wall,
} from '../sim/layout';
import type { Track } from '../sim/track';
import { buildLayout, registerTrackType, type GenContext } from './generator';
import { trackName } from './names';
import { garageLot, pitLane } from './stages';
import type { Problem } from './validate';

/**
 * Road circuits: a closed loop of corners and straights at real scale (cars
 * are 3 m across).
 *
 * The shape starts as an organic polygon (points round an ellipse at random
 * radii, a few pushed out into peninsulas, which is what makes right-handers
 * and hairpins), sized in metres to the class length. Each vertex becomes a
 * corner from a vocabulary (hairpin, slow, medium, fast, kink), its radius
 * set by how sharp the vertex is and the track's character, and fitted to the
 * straights either side the way road designers fillet an alignment: eased in
 * and out (clothoids), an arc between. Chicanes go into long straights. The
 * straights then take up the small closing error, and validation checks
 * that no part of the circuit, run-off included, comes too close to another.
 *
 * Longer tracks have more corners, not bigger ones. The pit lane and paddock
 * sit on the left of the main straight: the loop runs anticlockwise, so the
 * left is the infield.
 */

/** One corner: total heading change (rad, + left), arc radius, and the eased length in and out. */
export interface CornerSpec {
  angle: number;
  radius: number;
  ease: number;
}

/**
 * The lap from the start line: half the main straight, then each element in
 * turn (a straight, or a corner), then the rest of the main straight.
 */
export type CircuitElement = { straight: number } | { corner: CornerSpec };

export interface CircuitParams {
  /** Main straight length (the start line is in its middle). */
  main: number;
  elements: CircuitElement[];
  width: number;
  /** Grass between the track edge and the barrier on straights (m). */
  verge: number;
  /** Per corner, in order: what its outside run-off is. */
  runoff: Array<'gravel' | 'runoff'>;
  character: string;
  name?: string;
  /** Corners no tighter than this (m): gentler circuits for drivers learning road courses. */
  minRadius?: number;
}

interface SizeClass {
  length: [number, number];
  /** Metres of lap per polygon vertex (corner). */
  perCorner: [number, number];
  width: [number, number];
  verge: [number, number];
  gravelChance: number;
}

export const CIRCUIT_CLASSES: Record<string, SizeClass> = {
  club: { length: [1800, 3200], perCorner: [230, 320], width: [10, 12], verge: [6, 10], gravelChance: 0.7 },
  gp: { length: [4000, 6500], perCorner: [260, 380], width: [12, 15], verge: [10, 16], gravelChance: 0.4 },
};

/** How a circuit's corners lean: tighter and more of them, or fast and sweeping. */
const CHARACTERS: Record<string, { radius: number; chicanes: number; peninsulas: [number, number]; roughness: number }> = {
  technical: { radius: 0.75, chicanes: 0.35, peninsulas: [2, 4], roughness: 0.22 },
  power: { radius: 1, chicanes: 0.6, peninsulas: [1, 2], roughness: 0.12 },
  flowing: { radius: 1.4, chicanes: 0.15, peninsulas: [1, 3], roughness: 0.18 },
};

const MIN_STRAIGHT = 25;
const MIN_RADIUS = 12;
const MIN_MAIN = 420;
const BARRIER = 0.8;
const CIRCUIT_PIT = {
  WALL_GAP: 1, WALL_THICKNESS: 0.8, ROAD_WIDTH: 12, ENTRY_LENGTH: 90, EXIT_TAPER: 90, STALL_SPACING: 10,
  /** Pit road begins this far down the main straight after the entry taper, and ends this far before its end. */
  START_MARGIN: 20, END_MARGIN: 30,
  GARAGE_DEPTH: 30,
};

const pick = (rng: Rng, [a, b]: [number, number]) => a + rng.next() * (b - a);
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Radius a vertex of this sharpness asks for (before fitting): sharper vertices, slower corners. */
function preferredRadius(rng: Rng, turn: number): number {
  const a = Math.abs(turn) * 180 / Math.PI;
  const band: [number, number] = a > 120 ? [13, 24] : a > 70 ? [20, 45] : a > 35 ? [40, 90] : a > 15 ? [80, 200] : [160, 400];
  return pick(rng, band);
}

/** Eased length in and out for a corner of this radius and angle. */
function easeFor(radius: number, angle: number): number {
  return Math.min(Math.max(4, 0.35 * radius), 60, Math.abs(angle) * radius / 2);
}

/** Distance from the polygon vertex back along each edge to where the corner starts (clothoid-arc-clothoid). */
function tangentLength(c: CornerSpec): number {
  const R = c.radius, Ls = c.ease;
  const p = (Ls * Ls) / (24 * R);
  const q = Ls / 2 - (Ls * Ls * Ls) / (240 * R * R);
  return (R + p) * Math.tan(Math.abs(c.angle) / 2) + q;
}

/** Curvature sections for a corner. */
function cornerSections(c: CornerSpec): Array<[number, number, number]> {
  const k = Math.sign(c.angle) / c.radius;
  const arc = Math.abs(c.angle) * c.radius - c.ease;
  const out: Array<[number, number, number]> = [[c.ease, 0, k]];
  if (arc > 1e-6) out.push([arc, k, k]);
  out.push([c.ease, k, 0]);
  return out;
}

function sampleCircuit(rng: Rng, variant: string, hints?: Record<string, unknown>): CircuitParams {
  const cls = CIRCUIT_CLASSES[variant];
  if (!cls) throw new Error(`unknown circuit variant "${variant}"`);
  const names = Object.keys(CHARACTERS);
  const character = names[rng.int(names.length)];
  const ch = CHARACTERS[character];
  const minRadius = Math.max(MIN_RADIUS, Number(hints?.minRadius) || MIN_RADIUS);
  for (let attempt = 0; attempt < 400; attempt++) {
    const params = tryCircuit(rng, cls, character, ch, minRadius);
    if (params) return { ...params, minRadius };
  }
  throw new Error('no feasible circuit shape');
}

function tryCircuit(rng: Rng, cls: SizeClass, character: string, ch: (typeof CHARACTERS)[string], minRadius: number): CircuitParams | null {
  const length = pick(rng, cls.length);
  const m = Math.max(6, Math.round(length / pick(rng, cls.perCorner)));
  // Polygon: points round an ellipse in angle order (so it never crosses itself), radii jittered, some pushed out.
  const aspect = pick(rng, [1, 1.8]);
  const radii = Array.from({ length: m }, () => Math.max(0.4, 1 + ch.roughness * rng.gaussian()));
  const peninsulas = Math.round(pick(rng, ch.peninsulas));
  for (let k = 0; k < peninsulas; k++) radii[rng.int(m)] *= pick(rng, [1.3, 1.75]);
  // A few inward dents too: the other way to get a right-hander.
  for (let k = 0; k < Math.round(peninsulas / 2); k++) radii[rng.int(m)] *= pick(rng, [0.6, 0.8]);
  const pts = radii.map((r, k) => {
    const a = (2 * Math.PI * (k + 0.35 * (rng.next() - 0.5))) / m;
    return [r * aspect * Math.cos(a), r * Math.sin(a)];
  });
  const edge = (k: number) => { const a = pts[k], b = pts[(k + 1) % m]; return [b[0] - a[0], b[1] - a[1]]; };
  const perimeter = Array.from({ length: m }, (_, k) => Math.hypot(...edge(k) as [number, number])).reduce((a, b) => a + b, 0);
  const scale = length / perimeter;
  const lengths = Array.from({ length: m }, (_, k) => Math.hypot(...edge(k) as [number, number]) * scale);
  const headings = Array.from({ length: m }, (_, k) => Math.atan2(edge(k)[1], edge(k)[0]));
  // Vertex k joins edge k-1 to edge k.
  const turns = Array.from({ length: m }, (_, k) => wrapPi(headings[k] - headings[(k - 1 + m) % m]));
  if (turns.some((t) => Math.abs(t) > (165 * Math.PI) / 180)) return null; // a spike too sharp to drive round

  // Corners: preferred radii, then shrunk until each edge fits its two corners and a straight.
  const corners: CornerSpec[] = turns.map((angle) => {
    const radius = Math.max(minRadius, preferredRadius(rng, angle) * ch.radius);
    return { angle, radius, ease: easeFor(radius, angle) };
  });
  for (let pass = 0; pass < 30; pass++) {
    let ok = true;
    for (let k = 0; k < m; k++) {
      const a = corners[k], b = corners[(k + 1) % m];
      const room = lengths[k] - MIN_STRAIGHT;
      const need = tangentLength(a) + tangentLength(b);
      if (need > room) {
        ok = false;
        const f = Math.max(0.5, room / need);
        for (const c of [a, b]) {
          c.radius = Math.max(MIN_RADIUS, c.radius * f);
          c.ease = easeFor(c.radius, c.angle);
        }
      }
    }
    if (ok) break;
  }
  const straights = lengths.map((len, k) => len - tangentLength(corners[k]) - tangentLength(corners[(k + 1) % m]));
  if (straights.some((s) => s < MIN_STRAIGHT - 1)) return null;
  if (corners.some((c) => c.radius < minRadius - 1e-6)) return null; // fitting squeezed a corner below the floor

  // The longest straight is the main straight; the lap starts in its middle.
  let mainEdge = 0;
  straights.forEach((s, k) => { if (s > straights[mainEdge]) mainEdge = k; });
  if (straights[mainEdge] < MIN_MAIN) return null;
  const elements: CircuitElement[] = [];
  for (let j = 1; j <= m; j++) {
    const v = (mainEdge + j) % m;
    elements.push({ corner: corners[v] });
    if (j < m) elements.push(...straightWithFeatures(rng, straights[v], ch.chicanes, minRadius));
  }
  const params: CircuitParams = {
    main: straights[mainEdge], elements, width: Math.round(pick(rng, cls.width) * 2) / 2,
    verge: Math.round(pick(rng, cls.verge)), runoff: [], character,
  };
  params.runoff = elements.flatMap((e) => ('corner' in e ? [rng.next() < cls.gravelChance ? 'gravel' as const : 'runoff' as const] : []));
  return closeLoop(params) ? params : null;
}

/** A straight, sometimes with a chicane in it (left-right-left or the mirror, back onto the same line). */
function straightWithFeatures(rng: Rng, length: number, chicaneChance: number, minRadius: number): CircuitElement[] {
  if (length < 320 || rng.next() > chicaneChance) return [{ straight: length }];
  const dir = rng.next() < 0.5 ? 1 : -1;
  const a = pick(rng, [25, 45]) * Math.PI / 180;
  const radius = Math.max(minRadius, pick(rng, [15, 30]));
  const link = pick(rng, [4, 12]);
  const first: CornerSpec = { angle: dir * a, radius, ease: easeFor(radius, a) };
  const middle: CornerSpec = { angle: -dir * 2 * a, radius, ease: easeFor(radius, 2 * a) };
  const chicane: CircuitElement[] = [{ corner: first }, { straight: link }, { corner: middle }, { straight: link }, { corner: { ...first } }];
  const used = 2 * link + [first, middle, first].reduce((acc, c) => acc + 2 * c.ease + Math.abs(c.angle) * c.radius - c.ease, 0);
  const before = (length - used) * pick(rng, [0.35, 0.75]);
  const after = length - used - before;
  if (before < 120 || after < 80) return [{ straight: length }];
  return [{ straight: before }, ...chicane, { straight: after }];
}

export function circuitCenterline(p: CircuitParams): CenterlineSpec {
  const sections: Array<[number, number, number]> = [[p.main / 2, 0, 0]];
  for (const e of p.elements) {
    if ('straight' in e) sections.push([e.straight, 0, 0]);
    else sections.push(...cornerSections(e.corner));
  }
  sections.push([p.main / 2, 0, 0]);
  return { kind: 'curvature', sections };
}

/** Where a lap of these sections ends relative to where it starts (same integration as the sim's centerline). */
function lapEnd(spec: CenterlineSpec): { x: number; y: number; heading: number } {
  let x = 0, y = 0, h = 0;
  const step = 0.25;
  for (const [len, k0, k1] of spec.sections) {
    const n = Math.max(1, Math.ceil(len / step));
    const ds = len / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const k = k0 + (k1 - k0) * t;
      const mid = h + (k * ds) / 2;
      x += Math.cos(mid) * ds;
      y += Math.sin(mid) * ds;
      h += k * ds;
    }
  }
  return { x, y, heading: h };
}

/**
 * Adjust the straights so the lap closes: the end position is linear in the
 * straight lengths, so this is the smallest change (weighted toward longer
 * straights) that cancels the gap, with no straight below its minimum.
 */
function closeLoop(p: CircuitParams): boolean {
  const spec = circuitCenterline(p);
  const end = lapEnd(spec);
  if (Math.abs(end.heading - 2 * Math.PI) > 1e-6) return false;
  // Straight elements and the heading each runs at.
  const items: Array<{ el: { straight: number } | null; heading: number; len: number }> = [];
  let h = 0;
  items.push({ el: null, heading: 0, len: p.main }); // the main straight (both halves run at heading 0)
  for (const e of p.elements) {
    if ('straight' in e) items.push({ el: e, heading: h, len: e.straight });
    else h += e.corner.angle;
  }
  const r = [-end.x, -end.y];
  const free = items.map((it) => it.len > 60);
  for (let iter = 0; iter < items.length; iter++) {
    // Weighted minimum-norm: delta_i = w_i u_i . lambda, with (sum w_i u_i u_i^T) lambda = r.
    let a = 0, b = 0, c = 0;
    items.forEach((it, i) => {
      if (!free[i]) return;
      const ux = Math.cos(it.heading), uy = Math.sin(it.heading), w = it.len;
      a += w * ux * ux; b += w * ux * uy; c += w * uy * uy;
    });
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-6) return false;
    const lx = (c * r[0] - b * r[1]) / det, ly = (a * r[1] - b * r[0]) / det;
    let clamped = false;
    const deltas = items.map((it, i) => (free[i] ? it.len * (Math.cos(it.heading) * lx + Math.sin(it.heading) * ly) : 0));
    items.forEach((it, i) => {
      const min = it.el ? MIN_STRAIGHT : MIN_MAIN;
      if (free[i] && it.len + deltas[i] < min) {
        // Pin it at its minimum and solve again for the rest.
        const d = min - it.len;
        r[0] -= d * Math.cos(it.heading);
        r[1] -= d * Math.sin(it.heading);
        it.len = min;
        if (it.el) it.el.straight = min; else p.main = min;
        free[i] = false;
        clamped = true;
      }
    });
    if (clamped) continue;
    items.forEach((it, i) => {
      if (!free[i]) return;
      if (it.el) it.el.straight = it.len + deltas[i]; else p.main = it.len + deltas[i];
    });
    const after = lapEnd(circuitCenterline(p));
    return Math.hypot(after.x, after.y) < 0.5;
  }
  return false;
}

// ---------- layout ----------

interface CornerAt {
  /** Signed s where the corner's ease-in starts, its arc starts and ends, and its ease-out ends. */
  s0: number; a0: number; a1: number; s1: number;
  spec: CornerSpec;
  runoff: 'gravel' | 'runoff';
}

function cornersAlong(p: CircuitParams, L: number): CornerAt[] {
  const out: CornerAt[] = [];
  let s = p.main / 2;
  let k = 0;
  const signed = (x: number) => (x > L / 2 ? x - L : x);
  for (const e of p.elements) {
    if ('straight' in e) { s += e.straight; continue; }
    const c = e.corner;
    const arc = Math.max(0, Math.abs(c.angle) * c.radius - c.ease);
    out.push({ s0: signed(s), a0: signed(s + c.ease), a1: signed(s + c.ease + arc), s1: signed(s + 2 * c.ease + arc), spec: c, runoff: p.runoff[k++] ?? 'gravel' });
    s += 2 * c.ease + arc;
  }
  return out;
}

/** Run-off depth on the outside of a corner: room to stop a car leaving it at corner speed (gravel ~0.7 g). */
const runoffDepth = (radius: number) => Math.min(60, Math.max(12, 0.6 * radius + 8));

/**
 * Distance from the track edge to the barrier along one side: the verge on
 * straights, deeper on the outside of corners (and round their exits), tighter
 * on the inside of tight corners (the barrier must clear the arc's centre).
 * Breakpoints only where something changes, so the profile stays small.
 */
function barrierOffset(corners: CornerAt[], side: 1 | -1, verge: number, halfWidth: number, L: number, extra: Array<[number, number, number]>): Profile {
  type Bump = { from: number; to: number; ramp: number; value: number; min: boolean };
  const bumps: Bump[] = [];
  for (const c of corners) {
    const outside = Math.sign(c.spec.angle) !== side;
    const span = (x0: number, x1: number) => { let a = x0, b = x1; if (b < a) b += L; return [a, b]; };
    if (outside) {
      const [a, b] = span(c.s0, c.s1);
      bumps.push({ from: a - 10, to: b + 30, ramp: 25, value: runoffDepth(c.spec.radius), min: false });
    } else {
      const [a, b] = span(c.s0, c.s1);
      bumps.push({ from: a, to: b, ramp: 15, value: Math.max(2, Math.min(verge, c.spec.radius - halfWidth - 4)), min: true });
    }
  }
  for (const [a, b, value] of extra) bumps.push({ from: a, to: b, ramp: 20, value, min: false });
  const at = (x: number) => {
    let v = verge;
    let cap = Infinity;
    for (const bump of bumps) {
      for (const shift of [-L, 0, L]) {
        const lo = bump.from + shift, hi = bump.to + shift;
        const w = x < lo - bump.ramp || x > hi + bump.ramp ? 0 : x < lo ? (x - (lo - bump.ramp)) / bump.ramp : x > hi ? ((hi + bump.ramp) - x) / bump.ramp : 1;
        if (w <= 0) continue;
        if (bump.min) cap = Math.min(cap, verge + (bump.value - verge) * w);
        else v = Math.max(v, verge + (bump.value - verge) * w);
      }
    }
    return Math.min(v, cap);
  };
  const xs = new Set<number>();
  const signed = (x: number) => { let r = ((x % L) + L) % L; if (r > L / 2) r -= L; return r; };
  for (const b of bumps) for (const x of [b.from - b.ramp, b.from, b.to, b.to + b.ramp]) xs.add(Math.round(signed(x) * 10) / 10);
  if (!xs.size) return flat(verge);
  return { keys: [...xs].sort((p, q) => p - q).map((x) => [x, at(x)]), ease: 'linear' };
}

function buildCircuit(p: CircuitParams, ctx: GenContext): TrackLayout {
  const centerline = circuitCenterline(p);
  const cl = new Centerline(centerline);
  const L = cl.length;
  const half = p.width / 2;
  const corners = cornersAlong(p, L);

  // Pit road along the main straight, on the left (the infield), and the paddock behind it.
  const wallStart = -p.main / 2 + CIRCUIT_PIT.ENTRY_LENGTH + CIRCUIT_PIT.START_MARGIN;
  const wallEnd = p.main / 2 - CIRCUIT_PIT.EXIT_TAPER - CIRCUIT_PIT.END_MARGIN;
  const { pit, pavedInner } = pitLane({
    innerEdge: half, apronWidth: 0, wallStart, wallEnd, blendEnd: wallEnd + CIRCUIT_PIT.EXIT_TAPER + 10,
    entryLength: CIRCUIT_PIT.ENTRY_LENGTH, exitTaper: CIRCUIT_PIT.EXIT_TAPER,
    wallGap: CIRCUIT_PIT.WALL_GAP, wallThickness: CIRCUIT_PIT.WALL_THICKNESS, roadWidth: CIRCUIT_PIT.ROAD_WIDTH,
    stallSpacing: CIRCUIT_PIT.STALL_SPACING,
  });
  const { garage, buildings } = garageLot(cl, { s0: pit.wallStart + 20, s1: pit.wallEnd - 20, d0: pit.roadD, depth: CIRCUIT_PIT.GARAGE_DEPTH });

  // Barriers: the verge on straights, run-off on corner outsides, and (left side) behind the paddock.
  const paddock = garage.lot.d1 + 4 - half;
  const left = barrierOffset(corners, 1, p.verge, half, L, [[pit.entryStart, pit.exitEnd, paddock]]);
  const right = barrierOffset(corners, -1, p.verge, half, L, []);
  const leftWall: Profile = { ...left, keys: left.keys.map(([s, v]) => [s, half + v + BARRIER / 2]) };
  const rightWall: Profile = { ...right, keys: right.keys.map(([s, v]) => [s, -half - v - BARRIER / 2]) };
  const walls: Wall[] = [
    { id: 'barrier-left', range: null, d: leftWall, thickness: BARRIER, faces: 'out', caps: false },
    { id: 'barrier-right', range: null, d: rightWall, thickness: BARRIER, faces: 'in', caps: false },
    { id: 'pit-wall', range: [pit.wallStart, pit.wallEnd], d: pit.wallD, thickness: pit.wallThickness, faces: 'both', caps: true, attenuators: true },
  ];

  // Surfaces, bottom to top: run-off on corner outsides, kerbs, the pit approach, paddock, track, pit road.
  const surfaces: SurfaceRegion[] = [
    // Mown grass out to the barriers on both sides.
    { id: 'verges', surface: 'grass', shape: { kind: 'band', range: null, d0: rightWall, d1: leftWall }, pattern: 'mowing' },
  ];
  corners.forEach((c, i) => {
    const outside = -Math.sign(c.spec.angle);
    const depth = runoffDepth(c.spec.radius);
    const range: [number, number] = [c.s0 - 10, (c.s1 < c.s0 ? c.s1 + L : c.s1) + 30];
    const [d0, d1] = outside > 0 ? [half, half + depth] : [-half - depth, -half];
    surfaces.push({ id: `runoff${i}`, surface: c.runoff, shape: { kind: 'band', range, d0, d1 } });
  });
  corners.forEach((c, i) => {
    if (c.spec.radius > 150) return;
    const inside = Math.sign(c.spec.angle);
    const end = (x: number, from: number) => (x < from ? x + L : x);
    const apex: [number, number] = [c.a0 - 0.3 * c.spec.ease, end(c.a1, c.a0) + 0.3 * c.spec.ease];
    const exit: [number, number] = [end(c.a1, c.s0), end(c.s1, c.s0) + 15];
    const band = (side: number, range: [number, number], id: string): SurfaceRegion => ({
      id, surface: 'kerb', shape: { kind: 'band', range, d0: side > 0 ? half : -half - 1.5, d1: side > 0 ? half + 1.5 : -half },
    });
    surfaces.push(band(inside, apex, `kerb-apex${i}`), band(-inside, exit, `kerb-exit${i}`));
  });
  surfaces.push(
    { id: 'pit-approach', surface: 'apron', shape: { kind: 'band', range: [pit.entryStart, pit.exitEnd], d0: half, d1: pavedInner } },
    { id: 'garage', surface: 'garage', shape: { kind: 'rect', rect: garage.lot }, outline: true },
    { id: 'racing', surface: 'track', shape: { kind: 'band', range: null, d0: -half, d1: half } },
    { id: 'pit-road', surface: 'pit', shape: { kind: 'band', range: [pit.wallStart, pit.wallEnd], d0: pit.wallD, d1: pit.roadD } },
  );

  const halfStall = pit.stallSpacing / 2;
  const markings: Marking[] = [
    { kind: 'line', range: null, d: -half, style: 'edge' },
    { kind: 'line', range: [pit.blendEnd, L + pit.entryStart], d: half, style: 'edge' },
    { kind: 'line', range: [pit.entryStart, pit.wallStart], d: half, style: 'entry' },
    { kind: 'line', range: [pit.wallEnd, pit.blendEnd], d: half, style: 'blend' },
    { kind: 'line', range: [pit.wallStart, pit.wallEnd], d: pit.laneD, style: 'lane' },
    { kind: 'ticks', s: [...pit.stalls.map((s) => s - halfStall), pit.stalls[pit.stalls.length - 1] + halfStall], d0: pit.laneD, d1: pit.roadD - 1, style: 'stall' },
    { kind: 'ticks', s: [0], d0: -half, d1: half, style: 'start' },
  ];

  const { name, ...params } = p;
  return {
    version: LAYOUT_VERSION,
    id: name ? name.toLowerCase().replace(/\s+/g, '-') : `circuit-${ctx.seed}`,
    name: name ?? trackName(ctx.rng('name'), L > 3500 ? 'Grand Prix Circuit' : 'Circuit'),
    type: 'circuit',
    seed: ctx.seed,
    params: { ...params },
    centerline,
    crossSection: { edgeIn: half, edgeOut: -half, apronWidth: 0, pavedInner, bankInner: flat(0), bankOuter: flat(0), bankInfield: flat(0) },
    surfaces,
    ground: 'grass',
    walls,
    pit,
    infield: { garage, escapeLanes: [] },
    markings,
    decor: buildings,
    notes: [],
  };
}

/**
 * No part of the circuit may come within reach of another: for points far
 * apart along the lap, the gap between them must clear both their barriers on
 * the sides that face each other.
 */
function validateCircuit(layout: TrackLayout, track: Track): Problem[] {
  const problems: Problem[] = [];
  const left = layout.walls.find((w) => w.id === 'barrier-left')!.d;
  const right = layout.walls.find((w) => w.id === 'barrier-right')!.d;
  const step = 5;
  const n = Math.floor(track.length / step);
  const pts = Array.from({ length: n }, (_, k) => {
    const s = k * step;
    const i = track.indexAt(s);
    return { s, x: track.x[i], y: track.y[i], tx: track.tx[i], ty: track.ty[i], l: track.edgeAt(left, s), r: -track.edgeAt(right, s) };
  });
  let worst = Infinity;
  for (let a = 0; a < n; a++) {
    const p = pts[a];
    for (let b = a + 1; b < n; b++) {
      const q = pts[b];
      const along = Math.min(q.s - p.s, track.length - (q.s - p.s));
      const dx = q.x - p.x, dy = q.y - p.y;
      const dist = Math.hypot(dx, dy);
      // Which side of each the other lies on decides which barrier counts.
      const reachP = p.tx * dy - p.ty * dx > 0 ? p.l : p.r;
      const reachQ = q.tx * -dy - q.ty * -dx > 0 ? q.l : q.r;
      const need = reachP + reachQ + 2;
      if (along < Math.PI * need) continue; // neighbours round a corner
      worst = Math.min(worst, dist - need);
    }
  }
  if (worst < 0) problems.push({ severity: 'error', message: `parts of the circuit overlap (${(-worst).toFixed(0)} m too close)` });
  const p = layout.params as unknown as CircuitParams;
  if (p.main < MIN_MAIN - 1) problems.push({ severity: 'error', message: 'main straight too short for the pit lane' });
  return problems;
}

export const CIRCUIT = registerTrackType<CircuitParams>({
  id: 'circuit',
  name: 'Road circuit',
  variants: Object.keys(CIRCUIT_CLASSES),
  sample: sampleCircuit,
  build: buildCircuit,
  validate: validateCircuit,
});

/** A circuit layout from fixed parameters (tests). */
export function circuitLayout(params: CircuitParams): TrackLayout {
  return buildLayout('circuit', params);
}
