import type { Rng } from '../ai/rng';
import { Centerline } from '../sim/centerline';
import {
  evalProfile, flat, LAYOUT_VERSION, smoothstep,
  type CenterlineSpec, type Marking, type PitLane, type Profile, type SurfaceRegion, type TrackLayout, type TrackRect, type Wall,
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
  /** Per corner: a hairpin whose inside barrier stands right behind the apex kerb (no verge). */
  apexWall?: boolean[];
  /** Per corner: grass to the barrier and no run-off, where the corner needs little (slow, off a short straight). */
  bare?: boolean[];
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
export const CHARACTERS: Record<string, { radius: number; chicanes: number; peninsulas: [number, number]; roughness: number }> = {
  technical: { radius: 0.75, chicanes: 0.35, peninsulas: [2, 4], roughness: 0.22 },
  power: { radius: 1, chicanes: 0.6, peninsulas: [1, 2], roughness: 0.12 },
  flowing: { radius: 1.4, chicanes: 0.15, peninsulas: [1, 3], roughness: 0.18 },
};

const MIN_STRAIGHT = 25;
/** Turns sharper than this are hairpins. */
const HAIRPIN = (110 * Math.PI) / 180;
const MIN_RADIUS = 12;
const MIN_MAIN = 420;
export const BARRIER = 0.8;
export const CIRCUIT_PIT = {
  WALL_GAP: 1, WALL_THICKNESS: 0.8, ROAD_WIDTH: 12, ENTRY_LENGTH: 90, EXIT_TAPER: 90, STALL_SPACING: 10,
  /** Pit road begins this far down the main straight after the entry taper, and ends this far before its end. */
  START_MARGIN: 20, END_MARGIN: 30,
  GARAGE_DEPTH: 30,
};

const pick = (rng: Rng, [a, b]: [number, number]) => a + rng.next() * (b - a);
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Radius a vertex of this sharpness asks for (before fitting): sharper vertices, slower corners. */
export function preferredRadius(rng: Rng, turn: number): number {
  const a = Math.abs(turn) * 180 / Math.PI;
  const band: [number, number] = a > 120 ? [13, 24] : a > 70 ? [20, 45] : a > 35 ? [40, 90] : a > 15 ? [80, 200] : [160, 400];
  return pick(rng, band);
}

/** Eased length in and out for a corner of this radius and angle. */
export function easeFor(radius: number, angle: number): number {
  return Math.min(Math.max(4, 0.35 * radius), 60, Math.abs(angle) * radius / 2);
}

/** Distance from the polygon vertex back along each edge to where the corner starts (clothoid-arc-clothoid). */
export function tangentLength(c: CornerSpec): number {
  const R = c.radius, Ls = c.ease;
  const p = (Ls * Ls) / (24 * R);
  const q = Ls / 2 - (Ls * Ls * Ls) / (240 * R * R);
  return (R + p) * Math.tan(Math.abs(c.angle) / 2) + q;
}

/** Curvature sections for a corner. */
export function cornerSections(c: CornerSpec): Array<[number, number, number]> {
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
  if (!closeLoop(params)) return null;
  // Drawn once the shape is settled, so they don't change which shapes come out.
  const cornerSpecs = elements.flatMap((e) => ('corner' in e ? [e.corner] : []));
  params.apexWall = cornerSpecs.map((c) => Math.abs(c.angle) > HAIRPIN && c.radius < 35 && rng.next() < 0.5);
  params.bare = cornerSpecs.map(() => rng.next() < 0.4);
  return params;
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

export interface CornerAt {
  /** Signed s where the corner's ease-in starts; its arc start and end and ease-out end follow on (they may pass L/2). */
  s0: number; a0: number; a1: number; s1: number;
  spec: CornerSpec;
  runoff: 'gravel' | 'runoff';
  apexWall: boolean;
  bare: boolean;
  /** Straight before and after (m), from the corner either side: what the corner is braked into and driven out onto. */
  before: number; after: number;
  /** First corner of the chicane this corner is part of, or -1. */
  chicane: number;
  /** How much the corner turns (rad), for what it asks of the track; a chicane counts as its sharpest part. */
  turn: number;
  /** Share of the run-off it would have on a circuit (default all of it): less on open, flat ground. */
  depthScale?: number;
}

/**
 * What a cross-section is laid out for: the track's width, its verge, and its
 * corners along the lap. A circuit's whole lap; a road course's own part of one.
 */
export interface Course {
  width: number;
  verge: number;
  corners: CornerAt[];
}

/** A circuit's course. */
function courseOf(p: CircuitParams, L: number): Course {
  return { width: p.width, verge: p.verge, corners: cornersAlong(p, L) };
}

/** Corners joined by straights shorter than this, whose turns cancel, are a chicane. */
const CHICANE_LINK = 15;

function cornersAlong(p: CircuitParams, L: number): CornerAt[] {
  const out: CornerAt[] = [];
  let s = p.main / 2;
  let run = p.main;
  let k = 0;
  const signed = (x: number) => (x > L / 2 ? x - L : x);
  for (const e of p.elements) {
    if ('straight' in e) { s += e.straight; run += e.straight; continue; }
    const c = e.corner;
    const arc = Math.max(0, Math.abs(c.angle) * c.radius - c.ease);
    const s0 = signed(s);
    out.push({
      s0, a0: s0 + c.ease, a1: s0 + c.ease + arc, s1: s0 + 2 * c.ease + arc, spec: c,
      runoff: p.runoff[k] ?? 'gravel', apexWall: p.apexWall?.[k] ?? false, bare: p.bare?.[k] ?? false,
      before: run, after: 0, chicane: -1, turn: Math.abs(c.angle),
    });
    k++;
    s += 2 * c.ease + arc;
    run = 0;
  }
  // The last corner leads onto the main straight.
  out.forEach((c, i) => { c.after = i + 1 < out.length ? out[i + 1].before : p.main; });
  markChicanes(out);
  return out;
}

/** Chicanes: corners on short links whose turns cancel, back onto the line they left (in place). */
export function markChicanes(out: CornerAt[]): void {
  for (let i = 0; i < out.length; i++) {
    let j = i, net = out[i].spec.angle;
    while (j + 1 < out.length && out[j + 1].before < CHICANE_LINK) net += out[++j].spec.angle;
    if (j > i && Math.abs(net) < 1e-3) {
      for (let m = i; m <= j; m++) out[m].chicane = i;
      out[i].turn = Math.max(...out.slice(i, j + 1).map((c) => Math.abs(c.spec.angle)));
    }
    i = j;
  }
}

/**
 * Turn numbers, as on real circuits: the corners in order from the start
 * line. Where on the lap is turn n (within it, or the last one passed)?
 * Null on tracks that aren't road circuits.
 */
export function turnAt(layout: TrackLayout, s: number): number | null {
  if (layout.type !== 'circuit') return null;
  const p = layout.params as unknown as CircuitParams;
  const L = circuitLength(p);
  const signed = (x: number) => { let r = ((x % L) + L) % L; if (r > L / 2) r -= L; return r; };
  const corners = cornersAlong(p, L);
  if (!corners.length) return null;
  const r = signed(s);
  let turn = corners.length; // before the first corner: still after the last one
  corners.forEach((c, i) => { if (r >= c.s0 - 10) turn = i + 1; });
  return turn;
}

function circuitLength(p: CircuitParams): number {
  return circuitCenterline(p).sections.reduce((a, sec) => a + sec[0], 0);
}

/** Spacing of the samples the cross-section is worked out on (m). */
const GEO_STEP = 2;
/** A barrier stands at least this far short of the line midway to another part of the circuit (or a tight corner's centre). */
const WALL_MARGIN = 2;
/** ...and no more than this share of the way there from the track edge: round a tight corner's inside, a curve rather than a point. */
const WALL_REACH = 0.75;
/** Barriers and run-off move out or in by at most this much per metre along themselves: long tapers, no short jagged walls. */
const SLOPE = 0.4;
/** Track edge to that midline, at least: closer and two parts of the circuit are too close. */
const MIN_SEPARATION = 4;
/** Widening stops this far short of the midline. */
const WIDEN_ROOM = 6;
/**
 * Extra width (share of the track width): the funnel into a hairpin off a
 * long straight (outside, at turn-in), room to dive down the inside under
 * braking, and the track-out of a slow corner onto a long straight.
 */
const WIDEN_FUNNEL = 0.6;
const WIDEN_DIVE = 0.2;
const WIDEN_TRACK_OUT = 0.45;
/** The inside barrier of a tight corner runs parallel to the track round it, then eases out along the legs this gently. */
const INSIDE_TAPER = 0.15;
/** Round a chicane, the barrier's bulge eases out over this many metres per metre it stands out (at least 50 m). */
const CHICANE_TAPER = 5;
/** Run-off carries across a gap this short between two corners' (m). */
const RUNOFF_FILL = 80;
const KERB = 1.5;
/** A kerb's white ends taper it into the track edge over this long. */
const KERB_END = 4;

/** Run-off depth on the outside of a corner: room to stop a car leaving it at corner speed (gravel ~0.7 g). */
const runoffDepth = (radius: number) => Math.min(60, Math.max(12, 0.6 * radius + 8));

/** Is signed x within [a, b] (signed, b >= a, possibly past L / 2) on a lap of L? */
function inSRange(x: number, [a, b]: [number, number], L: number): boolean {
  return ((((x - a) % L) + L) % L) <= b - a;
}

/** 1 over [from, to], easing to 0 over the ramps either side; at signed x on a lap of L. */
function plateau(x: number, from: number, to: number, rampIn: number, rampOut: number, L: number): number {
  let w = 0;
  for (const shift of [-L, 0, L]) {
    const lo = from + shift, hi = to + shift;
    if (x < lo - rampIn || x > hi + rampOut) continue;
    w = Math.max(w, x < lo ? smoothstep((x - (lo - rampIn)) / rampIn) : x > hi ? smoothstep((hi + rampOut - x) / rampOut) : 1);
  }
  return w;
}

/**
 * What a corner asks of the cross-section, where real circuits give drivers
 * room. Braking hard into a slow corner off a long straight, the track opens
 * into a funnel on the outside, widest at turn-in and narrowing to the apex
 * (room for more than one line in), with a little more on the inside for a
 * car diving down it; and there's deep run-off straight on from the braking
 * zone. Out of a slow corner onto a long straight, the outside opens at the
 * track-out and narrows back down the straight. Fast corners keep their
 * width but get run-off round the outside and past the exit, as deep as
 * their speed needs (less where they barely turn). A slow corner off a short
 * straight may have none.
 */
function cornerNeeds(c: CornerAt, width: number) {
  const sharp = Math.min(1, c.turn / (Math.PI / 2));
  const slow = Math.min(1, Math.max(0, (120 - c.spec.radius) / 90));
  const brake = sharp * Math.min(1, Math.max(0, (c.before - 100) / 500));
  const drive = sharp * slow * Math.min(1, Math.max(0, (c.after - 150) / 600));
  const lead = Math.min(150, Math.max(40, 0.35 * c.before));
  const exitRun = Math.min(150, Math.max(50, 0.3 * c.after));
  const mid = (c.a0 + c.a1) / 2;
  const entryDepth = brake > 0.05 ? 12 + 60 * brake : 0;
  const exitDepth = runoffDepth(c.spec.radius) * Math.min(1, 0.25 + Math.abs(c.spec.angle) / (75 * Math.PI / 180));
  const bare = c.bare && brake < 0.15 && c.spec.radius < 45;
  return {
    /** Extra width at s, outside and inside. */
    widen(x: number, L: number): { out: number; in: number } {
      const funnel = width * WIDEN_FUNNEL * brake * plateau(x, c.s0 - 0.25 * lead, c.a0, 0.75 * lead, Math.max(10, c.a1 - c.a0), L);
      const dive = width * WIDEN_DIVE * brake * plateau(x, c.s0 - 0.5 * lead, c.s0 - 10, 0.5 * lead, c.a0 - c.s0 + 10, L);
      const trackOut = width * WIDEN_TRACK_OUT * drive * plateau(x, c.s1, c.s1 + 15, Math.max(10, c.s1 - mid), exitRun, L);
      return { out: Math.max(funnel, trackOut), in: dive };
    },
    /** Run-off wanted beyond the outside edge at s. */
    depth(x: number, L: number): number {
      if (bare || c.chicane >= 0) return 0; // (a chicane's run-off is everything out to its lines)
      if (c.depthScale !== undefined) return c.depthScale * Math.max(exitDepth * plateau(x, c.s0, c.s1 + 20, 20, 20, L), entryDepth * plateau(x, c.s0, mid, lead, 30, L));
      return Math.max(exitDepth * plateau(x, c.s0, c.s1 + 20, 20, 20, L), entryDepth * plateau(x, c.s0, mid, lead, 30, L));
    },
    mid,
    brake,
  };
}

/**
 * How far each side of the centerline can reach, per sample: the radius of
 * the largest circle touching the centerline there that holds no other part
 * of it (so the radius of a corner on its inside, and half the gap to another
 * part of the circuit, e.g. the other leg of a hairpin). Anything laid out
 * beyond it would cross over something else. The far versions count only
 * parts of the circuit more than `near` metres away along the lap (not the
 * corner itself, nor its neighbours).
 */
function clearances(cl: Centerline, n: number, near = 120): { left: Float64Array; right: Float64Array; farLeft: Float64Array; farRight: Float64Array } {
  const step = cl.length / n;
  const px = new Float64Array(n), py = new Float64Array(n), nx = new Float64Array(n), ny = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const [x0, y0] = cl.toWorld(k * step, 0);
    const [x1, y1] = cl.toWorld(k * step, 1);
    px[k] = x0; py[k] = y0; nx[k] = x1 - x0; ny[k] = y1 - y0;
  }
  const left = new Float64Array(n), right = new Float64Array(n), farLeft = new Float64Array(n), farRight = new Float64Array(n);
  const span = Math.round(near / step);
  for (let i = 0; i < n; i++) {
    let l = Infinity, r = Infinity, fl = Infinity, fr = Infinity;
    for (let j = 0; j < n; j++) {
      const dx = px[j] - px[i], dy = py[j] - py[i];
      const dot = nx[i] * dx + ny[i] * dy;
      const far = Math.min(Math.abs(i - j), n - Math.abs(i - j)) > span;
      if (dot > 1e-9) {
        const v = (dx * dx + dy * dy) / (2 * dot);
        l = Math.min(l, v);
        if (far) fl = Math.min(fl, v);
      } else if (dot < -1e-9) {
        const v = (dx * dx + dy * dy) / (-2 * dot);
        r = Math.min(r, v);
        if (far) fr = Math.min(fr, v);
      }
    }
    left[i] = l; right[i] = r; farLeft[i] = fl; farRight[i] = fr;
  }
  for (const v of [left, right, farLeft, farRight]) settle(v, 1);
  return { left, right, farLeft, farRight };
}

/**
 * Even out the ripple sampling leaves in a limit, only ever lowering it (in
 * place): the least over a window, then the average of those over the same
 * window, which is never more than the value it replaces.
 */
function settle(v: Float64Array, r: number): void {
  const n = v.length;
  const least = Float64Array.from(v, (_, k) => {
    let m = Infinity;
    for (let j = -r; j <= r; j++) m = Math.min(m, v[(k + j + n) % n]);
    return m;
  });
  for (let k = 0; k < n; k++) {
    let sum = 0, finite = true;
    for (let j = -r; j <= r; j++) { const x = least[(k + j + n) % n]; if (!Number.isFinite(x)) { finite = false; break; } sum += x; }
    v[k] = finite ? sum / (2 * r + 1) : least[k];
  }
}

/**
 * How far a line `d` out from the centerline runs per metre of centerline at
 * sample k: less on the inside of a corner (toward its centre), more on the
 * outside. A taper measured along the centerline is that much steeper or
 * gentler on the ground.
 */
type Stretch = (k: number, d: number) => number;

/**
 * Raise values so none falls away faster than `drop` per sample (per metre
 * along the line itself, given a stretch), round the lap (in place): run-off
 * and barriers taper out instead of ending abruptly. Owners, if given, follow
 * the value they take.
 */
function spread(v: Float64Array, drop: number, owner?: Int32Array, stretch?: Stretch): void {
  const n = v.length;
  for (const dir of [1, -1]) {
    for (let j = 0; j < 2 * n; j++) {
      const k = dir > 0 ? j % n : (2 * n - 1 - j) % n;
      const prev = (k - dir + n) % n;
      const to = v[prev] - drop * (stretch ? stretch(prev, v[prev]) : 1);
      if (to > v[k]) {
        v[k] = to;
        if (owner) owner[k] = owner[prev];
      }
    }
  }
}

/** Lower values so none changes faster than `rise` per sample (as spread), round the lap (in place); fixed ones stay put. */
function limitSlope(v: Float64Array, rise: number, fixed?: (k: number) => boolean, stretch?: Stretch): void {
  const n = v.length;
  for (const dir of [1, -1]) {
    for (let j = 0; j < 2 * n; j++) {
      const k = dir > 0 ? j % n : (2 * n - 1 - j) % n;
      const prev = (k - dir + n) % n;
      const to = v[prev] + rise * (stretch ? stretch(prev, v[prev]) : 1);
      if (to < v[k] && !fixed?.(k)) v[k] = to;
    }
  }
}

/**
 * Moving average over `w` metres either side, measured along the line itself
 * (given its stretch: more centerline on a corner's inside, less on its
 * outside, so a corner is rounded off as much there as anywhere), round the
 * lap (in place), `passes` times.
 */
function groundSmooth(v: Float64Array, step: number, w: number, passes: number, stretch: Stretch): void {
  const n = v.length;
  const at = new Float64Array(3 * n + 1), sum = new Float64Array(3 * n + 1);
  for (let pass = 0; pass < passes; pass++) {
    // Ground position and running weighted sum over three laps, so windows can wrap.
    for (let i = 0; i < 3 * n; i++) {
      const k = i % n, len = step * stretch(k, v[k]);
      at[i + 1] = at[i] + len;
      sum[i + 1] = sum[i] + v[k] * len;
    }
    // The integral up to ground position x (in sample i's stretch), so the window takes its end samples in part.
    const upTo = (i: number, x: number) => sum[i] + v[i % n] * (x - at[i]);
    const out = new Float64Array(n);
    let lo = n, hi = n;
    for (let i = n; i < 2 * n; i++) {
      const mid = (at[i] + at[i + 1]) / 2;
      while (at[lo + 1] <= mid - w) lo++;
      while (at[hi + 1] < mid + w) hi++;
      out[i - n] = (upTo(hi, mid + w) - upTo(lo, mid - w)) / (2 * w);
    }
    v.set(out);
  }
}

/** Moving average round the lap (in place). */
function smooth(v: Float64Array, radius: number, passes: number): void {
  const n = v.length;
  for (let pass = 0; pass < passes; pass++) {
    const src = Float64Array.from(v);
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (let j = -radius; j <= radius; j++) sum += src[(k + j + n) % n];
      v[k] = sum / (2 * radius + 1);
    }
  }
}

/** Round off the corners a min() leaves (in place), only ever lowering a value. */
function smoothDown(v: Float64Array, radius = 4, passes = 3): void {
  const n = v.length;
  for (let pass = 0; pass < passes; pass++) {
    const src = Float64Array.from(v);
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (let j = -radius; j <= radius; j++) sum += src[(k + j + n) % n];
      v[k] = Math.min(src[k], sum / (2 * radius + 1));
    }
  }
}

/** Indices of the points (x, v) a straight line between kept neighbours can't stand in for (first and last always kept). */
function keyPoints(xs: ArrayLike<number>, vs: ArrayLike<number>, tol: number): number[] {
  const keep = [0];
  let a = 0;
  for (let e = 2; e < xs.length; e++) {
    let ok = true;
    for (let k = a + 1; k < e && ok; k++) ok = Math.abs(vs[a] + (vs[e] - vs[a]) * ((xs[k] - xs[a]) / (xs[e] - xs[a])) - vs[k]) <= tol;
    if (!ok) { keep.push(e - 1); a = e - 1; }
  }
  if (xs.length > 1) keep.push(xs.length - 1);
  return keep;
}

function toProfile(xs: ArrayLike<number>, vs: ArrayLike<number>, keep: number[], L: number): Profile {
  const keys = keep.map((k): [number, number] => {
    const x = ((xs[k] % L) + L) % L;
    return [Math.round((x > L / 2 ? x - L : x) * 100) / 100, Math.round(vs[k] * 1000) / 1000];
  });
  if (keys.every(([, value]) => value === keys[0][1])) return flat(keys[0][1]);
  return { keys: keys.sort((p, q) => p[0] - q[0]), ease: 'linear' };
}

/** A profile through samples round the lap (k * L / n), keeping only the keys a straight line between them can't stand in for. */
export function sampledProfile(v: ArrayLike<number>, L: number, tol = 0.05): Profile {
  const n = v.length;
  const xs = Array.from({ length: n + 1 }, (_, k) => (k * L) / n);
  const vs = Array.from({ length: n + 1 }, (_, k) => v[k % n]);
  return toProfile(xs, vs, keyPoints(xs, vs, tol).filter((k) => k < n), L);
}

/** A profile that only has to hold over a range (a surface's edge): sampled across it alone, so it stays small. */
export function rangeProfile([lo, hi]: [number, number], L: number, f: (x: number) => number, tol = 0.05, stepAt?: (x: number) => number): Profile {
  let xs: number[];
  if (stepAt) {
    xs = [];
    for (let x = lo; x < hi; x += stepAt(x)) xs.push(x);
    xs.push(hi);
  } else {
    const m = Math.max(1, Math.ceil((hi - lo) / GEO_STEP));
    xs = Array.from({ length: m + 1 }, (_, k) => lo + ((hi - lo) * k) / m);
  }
  const vs = xs.map(f);
  return toProfile(xs, vs, keyPoints(xs, vs, tol), L);
}

/** Where the pit lane leaves and rejoins the track (signed s), and how far behind the track edge its barrier must stand at s. */
export interface PitZone { entryStart: number; blendEnd: number; gap: (x: number) => number }

/** Behind the pit lane, the barrier clears pit road and the garage lot (with room behind it). */
export function pitZone(pit: PitLane, pavedInner: Profile, lot: TrackRect, half: number, L: number): PitZone {
  return {
    entryStart: pit.entryStart,
    blendEnd: pit.blendEnd,
    gap: (x) => {
      // Pit road and 3 m behind it, from nothing where the pit lane leaves the track.
      const paved = Math.max(0, evalProfile(pavedInner, x, L) - half);
      return Math.max(paved + 3 * Math.min(1, paved / 3), (lot.d1 + 4 - half) * plateau(x, lot.s0 - 12, lot.s1 + 12, 25, 25, L));
    },
  };
}

/** One side of the track (magnitudes: metres out from the centerline, on that side). */
export interface Side {
  edge: Float64Array;
  /** How far this side can reach before it meets another part of the circuit (see clearances), and before a part well away along the lap. */
  clear: Float64Array;
  far: Float64Array;
  /** Through a chicane, the distance to the barrier line running straight past (NaN elsewhere). */
  line: Float64Array;
  /** Either side of a chicane, the gap out to the barrier as it eases out to the line (NaN elsewhere). */
  taper: Float64Array;
  /** Run-off wanted beyond the edge, and the corner (index) it belongs to, -1 for none. */
  runoff: Float64Array;
  owner: Int32Array;
  /** Barrier centre wanted (verge, run-off, paddock), and where it stands after keeping clear of the rest of the circuit. */
  want: Float64Array;
  wall: Float64Array;
}

/** A circuit's cross-section round the lap, sample by sample. */
export interface Geometry {
  n: number;
  /** Signed s of each sample. */
  s: Float64Array;
  left: Side;
  right: Side;
  corners: Array<CornerAt & ReturnType<typeof cornerNeeds>>;
  /** Chicanes: where (signed s) their barrier lines run, and the distance out to each line at any s in there (left, right). */
  chicanes: Array<{ z0: number; z1: number; line: (x: number) => [number, number] }>;
}

/**
 * Fill dips narrower than about 2w samples (in place): dilate, then erode. Where one corner's run-off
 * ramps out as the next one's ramps in, the barrier carries straight across instead of notching in.
 */
function closeGaps(v: Float64Array, w: number): void {
  const n = v.length;
  const pass = (src: Float64Array, pick: (a: number, b: number) => number) => {
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let m = src[k];
      for (let j = 1; j <= w; j++) m = pick(m, pick(src[(k + j) % n], src[(k - j + n) % n]));
      out[k] = m;
    }
    return out;
  };
  v.set(pass(pass(v, Math.max), Math.min));
}

/** Painted run-off, laid where cars leaving the track need room (see escapes): owner of no corner. */
const PAINTED = -2;

/**
 * The cross-section, then made safe for cars leaving the track: wherever a
 * car running off in the direction it was travelling would meet a barrier
 * too soon for the angle it meets it at, the barrier goes back and the room
 * is paved (twice, as moving one barrier can expose another).
 */
function circuitGeometry(p: Course, cl: Centerline, pit: PitZone, spec?: CenterlineSpec, bound?: Bound): Geometry {
  // (Validation lays out the same circuit again: it finds this one by its centerline.)
  const known = spec && laidOut.get(spec);
  if (known) return known;
  const clear = clearances(cl, Math.round(cl.length / GEO_STEP));
  if (bound) {
    for (let k = 0; k < clear.left.length; k++) {
      clear.left[k] = Math.min(clear.left[k], bound.left[k]);
      clear.farLeft[k] = Math.min(clear.farLeft[k], bound.left[k]);
      clear.right[k] = Math.min(clear.right[k], bound.right[k]);
      clear.farRight[k] = Math.min(clear.farRight[k], bound.right[k]);
    }
  }
  let g = crossSection(p, cl, pit, clear, null);
  const v = speeds(Float64Array.from(g.s, (x) => cl.curvatureAt(x)), cl.length / g.n);
  let floors: [Float64Array, Float64Array] | null = null;
  for (let pass = 0; pass < 2; pass++) {
    const more = escapes(g, cl, v, floors);
    if (!more) break;
    floors = more;
    g = crossSection(p, cl, pit, clear, [outline(floors[0], g, cl, 1), outline(floors[1], g, cl, -1)]);
  }
  if (spec) laidOut.set(spec, g);
  return g;
}

/**
 * The room escapes asks for, point by point, as one smooth outline: each
 * point a wide bump (wider the further it stands out, measured along the
 * barrier, so no tighter round a corner's inside), dips between neighbours
 * filled, the whole blurred. Barriers set back to it stay smooth rather than following every
 * point.
 */
function outline(need: Float64Array, g: Geometry, cl: Centerline, sign: 1 | -1): Float64Array {
  const n = g.n, step = cl.length / n;
  const side = sign > 0 ? g.left : g.right;
  const out = new Float64Array(n);
  for (let h = 0; h < n; h++) {
    if (!(need[h] > 0)) continue;
    // Metres of barrier per metre of centerline here (less on a corner's inside).
    const along = Math.max(0.15, 1 - sign * cl.curvatureAt(g.s[h]) * (side.edge[h] + need[h]));
    const reach = Math.max(30, 4 * need[h]) / along / step;
    for (let j = -Math.ceil(reach); j <= Math.ceil(reach); j++) {
      const k = (h + j + n) % n;
      out[k] = Math.max(out[k], need[h] * smoothstep(1 - Math.abs(j) / reach));
    }
  }
  closeGaps(out, Math.round(20 / step));
  // (Blurred too, so overlapping bumps make one curve; the next pass makes up any room this takes off a peak.)
  smooth(out, Math.round(12 / step), 3);
  return out;
}

const laidOut = new WeakMap<CenterlineSpec, Geometry>();

/**
 * How far each side of the centerline anything may reach, per sample (every
 * GEO_STEP or so round the lap): what lies beyond that isn't the course's
 * (another track's pavement, say). Counted as other parts of the course are.
 */
export interface Bound {
  left: Float64Array;
  right: Float64Array;
}

/** Samples a cross-section is worked out on, round a lap of length L. */
export function geometrySamples(L: number): number {
  return Math.round(L / GEO_STEP);
}

/** Roughly how fast a car goes round the lap, per sample: cornering at 1.5 g, braking at 1.2 g, accelerating at 0.5 g, 85 m/s flat out. */
function speeds(kappa: Float64Array, step: number): Float64Array {
  const n = kappa.length;
  const v = Float64Array.from(kappa, (k) => Math.min(85, Math.sqrt(15 / Math.max(1e-6, Math.abs(k)))));
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 2 * n - 1; j >= 0; j--) { const k = j % n; v[k] = Math.min(v[k], Math.sqrt(v[(k + 1) % n] ** 2 + 2 * 12 * step)); }
    for (let j = 0; j < 2 * n; j++) { const k = j % n; v[k] = Math.min(v[k], Math.sqrt(v[(k - 1 + n) % n] ** 2 + 2 * 5 * step)); }
  }
  return v;
}

/** A car leaving the track needs this long, at the speed it leaves at, before it meets a barrier head on (less, the more glancing). */
const ESCAPE_TIME = 2.0;
const ESCAPE_MAX = 70;
/** Directions cars leave in: straight on, and turned out a little or a lot (a car pushed wide, a slide, a lock-up). */
const ESCAPE_ANGLES = [0, 0.15, 0.3, 0.45];

/**
 * Barriers cars leaving the track would meet head on. From each point of
 * each edge, a car carries on in the direction of travel (and a little
 * further out) at the speed it had there. Barriers it would run along are
 * fine; ones standing steeply across the way it was going need room before
 * them, more the faster and the steeper. Where there isn't enough, the barrier there must stand back
 * (the run-off it gains is paved). Returns the gaps (from the edge) needed,
 * or null if none is short.
 */
function escapes(g: Geometry, cl: Centerline, v: Float64Array, before: [Float64Array, Float64Array] | null): [Float64Array, Float64Array] | null {
  const n = g.n, L = cl.length, step = L / n;
  const floors: [Float64Array, Float64Array] = before ? [Float64Array.from(before[0]), Float64Array.from(before[1])] : [new Float64Array(n), new Float64Array(n)];
  const sides = [g.left, g.right] as const;
  const index = (x: number) => Math.round((((x % L) + L) % L) / step) % n;
  let short = false;
  for (let k = 0; k < n; k += 3) {
    if (v[k] < 20) continue;
    const [ax, ay] = cl.toWorld(g.s[k] - 1, 0);
    const [bx, by] = cl.toWorld(g.s[k] + 1, 0);
    const hl = Math.hypot(bx - ax, by - ay);
    const tx = (bx - ax) / hl, ty = (by - ay) / hl;
    sides.forEach((sd, j) => {
      const sign = j === 0 ? 1 : -1;
      const [ex, ey] = cl.toWorld(g.s[k], sign * sd.edge[k]);
      for (const angle of ESCAPE_ANGLES) {
        const a = sign * angle; // (positive turns left)
        const dx = tx * Math.cos(a) - ty * Math.sin(a), dy = tx * Math.sin(a) + ty * Math.cos(a);
        let hint = cl.indexAt(g.s[k]);
        for (let t = 2; t <= ESCAPE_MAX; t += 2) {
          const q = cl.project(ex + dx * t, ey + dy * t, hint);
          hint = q.idx;
          const kq = index(q.s);
          const hit = q.d > g.left.wall[kq] - BARRIER / 2 ? 0 : q.d < -(g.right.wall[kq] - BARRIER / 2) ? 1 : null;
          if (hit === null) continue;
          const hs = sides[hit], hsign = hit === 0 ? 1 : -1;
          // (A chicane's outline is laid out for cars missing it.)
          if (!Number.isNaN(hs.line[kq]) || !Number.isNaN(hs.taper[kq])) break;
          const [w0x, w0y] = cl.toWorld(g.s[kq] - step, hsign * hs.wall[(kq - 1 + n) % n]);
          const [w1x, w1y] = cl.toWorld(g.s[kq] + step, hsign * hs.wall[(kq + 1) % n]);
          const wl = Math.hypot(w1x - w0x, w1y - w0y) || 1;
          // (How steep against the way the car was going on the track, not the line it left on: a barrier
          // along a straight is fine however a car leaves.)
          const steep = Math.abs(tx * (w1y - w0y) - ty * (w1x - w0x)) / wl;
          const need = Math.min(ESCAPE_MAX, v[k] * steep * ESCAPE_TIME);
          if (steep > 0.25 && t < need) {
            // Standing back about this much puts it `need` on along the line of travel.
            const gap = hs.wall[kq] - BARRIER / 2 - hs.edge[kq] + (need - t) * steep;
            if (gap > floors[hit][kq] + 0.5) { floors[hit][kq] = gap; short = true; }
          }
          break;
        }
      }
    });
  }
  return short ? floors : null;
}

function crossSection(
  p: Course, cl: Centerline, pit: PitZone, clear: ReturnType<typeof clearances>, floors: [Float64Array, Float64Array] | null,
): Geometry {
  const L = cl.length;
  const n = Math.round(L / GEO_STEP);
  const step = L / n;
  const half = p.width / 2;
  const corners = p.corners.map((c) => ({ ...c, ...cornerNeeds(c, p.width) }));
  const side = (c: Float64Array, far: Float64Array): Side => ({
    edge: new Float64Array(n).fill(half), clear: c, far, line: new Float64Array(n).fill(NaN), taper: new Float64Array(n).fill(NaN), runoff: new Float64Array(n),
    owner: new Int32Array(n).fill(-1), want: new Float64Array(n), wall: new Float64Array(n),
  });
  const left = side(clear.left, clear.farLeft), right = side(clear.right, clear.farRight);
  // A left-hander's inside is on the left.
  const outsideOf = (c: CornerAt) => (c.spec.angle > 0 ? right : left);
  const insideOf = (c: CornerAt) => (c.spec.angle > 0 ? left : right);
  const s = new Float64Array(n);
  const sample = (x: number) => Math.round((((x % L) + L) % L) / step) % n;
  for (let k = 0; k < n; k++) {
    const x = k * step > L / 2 ? k * step - L : k * step;
    s[k] = x;
    corners.forEach((c, i) => {
      const out = outsideOf(c), ins = insideOf(c);
      const w = c.widen(x, L);
      out.edge[k] = Math.max(out.edge[k], half + w.out);
      ins.edge[k] = Math.max(ins.edge[k], half + w.in);
      const depth = c.depth(x, L);
      if (depth > out.runoff[k]) { out.runoff[k] = depth; out.owner[k] = i; }
    });
    // The pit side of the main straight keeps its edge: the pit lane leaves and rejoins it there.
    left.edge[k] = half + (left.edge[k] - half) * (1 - plateau(x, pit.entryStart - 10, pit.blendEnd + 10, 40, 40, L));
  }
  for (const { edge, clear } of [left, right]) {
    closeGaps(edge, 10);
    for (let k = 0; k < n; k++) edge[k] = Math.max(half, Math.min(edge[k], clear[k] - WIDEN_ROOM));
    smoothDown(edge);
  }

  // The inside of a tight corner: the barrier parallel to the track all the way round (right behind the
  // kerb at an apex-wall hairpin, else a little way back), so the tip is a smooth curve rather than a
  // point, easing out gently along the legs.
  const caps = [new Float64Array(n).fill(Infinity), new Float64Array(n).fill(Infinity)];
  // (Round the corner itself the barrier takes in another corner's run-off too, which would only wrap round
  // to a point at the apex; along the legs, only verge.)
  const hard = [new Float64Array(n).fill(Infinity), new Float64Array(n).fill(Infinity)];
  corners.forEach((c) => {
    if (c.chicane >= 0 || c.spec.radius > 60 || Math.abs(c.spec.angle) < Math.PI / 3) return;
    const ins = insideOf(c), cap = caps[ins === left ? 0 : 1];
    // (A barrier right behind the apex only where nobody arrives fast: not at the end of a long straight.)
    // (Otherwise not far in: close to the corner's centre a barrier parallel to the track turns too tightly to look right.)
    const room = c.apexWall && c.brake < 0.3 ? KERB + 0.6 : Math.min(p.verge, Math.max(KERB + 0.6, 0.2 * (c.spec.radius - half)));
    for (let x = c.s0 - 10; x <= c.s1 + 10; x += step) {
      const k = sample(x);
      cap[k] = Math.min(cap[k], ins.edge[k] + room + BARRIER / 2);
      hard[ins === left ? 0 : 1][k] = cap[k];
    }
  });
  const kappa = Float64Array.from(s, (x) => cl.curvatureAt(x));
  // (Left and right: a left-hander's inside is on the left.)
  const stretches: Stretch[] = [1, -1].map((side) => (k: number, d: number) => Math.max(0.15, 1 - side * kappa[k] * d));
  caps.forEach((cap, j) => limitSlope(cap, INSIDE_TAPER * step, undefined, stretches[j]));

  // Chicanes: room either side for a car that misses the chicane to carry on. The barriers flow round its
  // swing in one wide, smooth bulge (as the rest of the track's barriers flow), out at the verge from the
  // swing's furthest point and easing back to the straight's verge well before and after; everything
  // between them and the track is open run-off. Each point's barrier is where its normal meets that
  // outline, so it lies on it even from the inside of the middle corner, past the corner's centre (the
  // barrier there is drawn over, back along it).
  const chicanes: Geometry['chicanes'] = [];
  corners.forEach((first, f) => {
    if (first.chicane !== f) return;
    let l = f;
    while (l + 1 < corners.length && corners[l + 1].chicane === f) l++;
    const z0 = first.s0 - 10, z1 = corners[l].s1 + 10;
    // The straight's frame: along it (u) and to its left (y), from where the chicane starts.
    const [ox, oy] = cl.toWorld(z0, 0);
    const [qx, qy] = cl.toWorld(z0, 1);
    const nx = qx - ox, ny = qy - oy, tx = ny, ty = -nx;
    const frame = (x: number) => {
      const [px, py] = cl.toWorld(x, 0);
      const [vx, vy] = cl.toWorld(x, 1);
      const mx = vx - px, my = vy - py; // this point's left
      return { u: (px - ox) * tx + (py - oy) * ty, y: (px - ox) * nx + (py - oy) * ny, c: mx * nx + my * ny, e: mx * tx + my * ty };
    };
    const pts: Array<{ k: number; u: number; y: number; c: number }> = [];
    for (let x = z0; x <= z1; x += step) pts.push({ k: sample(x), ...frame(x) });
    // Per side (outward: +1 left, -1 right), how far out the barrier stands across the straight, at u.
    const outlines = ([[left, 1], [right, -1]] as const).map(([sd, sign]) => {
      const base = sd.edge[pts[0].k] + p.verge;
      const need = pts.map(({ k, y, c }) => Math.max(0, sign * y + sd.edge[k] * c + p.verge - base));
      const most = Math.max(...need);
      const reach = Math.max(50, CHICANE_TAPER * most);
      const u0 = pts[0].u - reach, du = 1;
      const env = new Float64Array(Math.ceil((pts[pts.length - 1].u + reach - u0) / du) + 1);
      if (most > 0) {
        env.forEach((_, i) => {
          const u = u0 + i * du;
          let v = 0;
          pts.forEach((pt, m) => { const t = Math.abs(u - pt.u) / reach; if (t < 1) v = Math.max(v, need[m] * smoothstep(1 - t)); });
          env[i] = v;
        });
        // Smoothed, then raised back over the swing everywhere it reaches (so the bulge is one smooth curve).
        smooth(env, Math.max(1, Math.round(reach / 6)), 3);
        let lift = 1;
        pts.forEach((pt, m) => { const v = env[Math.round((pt.u - u0) / du)]; if (need[m] > 0) lift = Math.max(lift, need[m] / Math.max(1e-6, v)); });
        env.forEach((v, i) => { env[i] = v * lift; });
      }
      const at = (u: number) => {
        const i = (u - u0) / du;
        if (i <= 0 || i >= env.length - 1) return base;
        const i0 = Math.floor(i);
        return base + env[i0] + (env[i0 + 1] - env[i0]) * (i - i0);
      };
      // Where this point's normal meets the outline: d = (Y(u + d e) - y) / c, a few steps from Y(u).
      const distance = (x: number) => {
        const { u, y, c, e } = frame(x);
        const toward = sign * e, across = sign * y;
        let d = (at(u) - across) / c;
        for (let it = 0; it < 6; it++) d = (at(u + toward * d) - across) / c;
        return d;
      };
      return { distance, reach };
    });
    chicanes.push({ z0, z1, line: (x) => [outlines[0].distance(x), outlines[1].distance(x)] });
    ([left, right] as const).forEach((sd, i) => {
      const { distance, reach } = outlines[i];
      for (const { k } of pts) {
        sd.line[k] = distance(s[k]);
        sd.runoff[k] = Math.max(sd.runoff[k], sd.line[k] - sd.edge[k] - BARRIER / 2);
        sd.owner[k] = f;
      }
      // Either side, along the straight, the outline easing back to the verge: run-off out to it by the
      // chicane, fading into the verge further out.
      for (const [end, dir] of [[z0, -1], [z0 + (pts.length - 1) * step, 1]] as const) {
        for (let d = step; d < reach; d += step) {
          const k = sample(end + dir * d);
          if (!Number.isNaN(sd.line[k])) continue; // (still on the line: sampling rounds either way at its ends)
          const g = distance(s[k]) - sd.edge[k] - BARRIER / 2;
          if (g > sd.taper[k] || Number.isNaN(sd.taper[k])) sd.taper[k] = g;
          const r = g * smoothstep(1 - d / reach);
          if (r > sd.runoff[k]) { sd.runoff[k] = r; sd.owner[k] = f; }
        }
      }
    });
  });

  [left, right].forEach(({ edge, clear, far, line, taper, runoff, owner, want, wall }, j) => {
    // Run-off: gaps between two corners' filled in, tapering out either side, each stretch belonging to the corner that wants it most.
    // Room cars leaving the track need (see escapes): paved where it reaches well past the verge (and isn't
    // a corner's run-off already, or the pit lane's); where it barely does the barrier stands back on grass.
    if (floors) {
      for (let k = 0; k < n; k++) {
        if (j === 0 && pit.gap(s[k]) > 0) continue;
        // (Fading in as it gets past the verge, so the paint tapers out rather than ending square.)
        const paved = floors[j][k] * smoothstep((floors[j][k] - p.verge - 0.5) / 4);
        if (paved > Math.max(runoff[k], 0.5)) { runoff[k] = paved; if (owner[k] === -1) owner[k] = PAINTED; }
      }
    }
    closeGaps(runoff, RUNOFF_FILL / GEO_STEP / 2);
    const start = owner.findIndex((o) => o !== -1);
    if (start >= 0) {
      let last = owner[start];
      for (let i = 0; i < n; i++) {
        const k = (start + i) % n;
        if (owner[k] !== -1) last = owner[k];
        else if (runoff[k] > 0) owner[k] = last;
      }
    }
    // Through a chicane, exactly out to its outline (tapering and gap-filling would bend it), and either
    // side at least out to where the outline eases back.
    const chicane = (v: Float64Array, tapers: boolean) => {
      for (let k = 0; k < n; k++) {
        if (!Number.isNaN(line[k])) v[k] = line[k] - edge[k] - BARRIER / 2;
        else if (tapers && !Number.isNaN(taper[k])) v[k] = Math.max(v[k], taper[k]);
      }
    };
    chicane(runoff, false);
    const stretch = stretches[j];
    // (Run-off and gaps are measured from the track edge.)
    const beyondEdge: Stretch = (k, g) => stretch(k, edge[k] + g);
    spread(runoff, SLOPE * step, owner, beyondEdge);
    chicane(runoff, false);
    const gap = Float64Array.from(runoff, (r, k) => Math.max(p.verge, r, j === 0 ? pit.gap(s[k]) : 0, floors ? floors[j][k] : 0));
    spread(gap, SLOPE * step, undefined, beyondEdge);
    chicane(gap, true);
    const cap = caps[j];
    // What the inside of a tight corner may not take in (tapered as the barrier is): run-off along its legs,
    // the pit lane and room for cars leaving the track anywhere.
    const keepPit = Float64Array.from(runoff, (_, k) => Math.max(j === 0 ? pit.gap(s[k]) : 0, floors ? floors[j][k] : 0));
    spread(keepPit, SLOPE * step, undefined, beyondEdge);
    const keep = Float64Array.from(runoff, (r, k) => Math.max(r, keepPit[k]));
    spread(keep, SLOPE * step, undefined, beyondEdge);
    // How far out the barrier may stand: never past the line midway to another part of the circuit (hard),
    // and by choice no closer than partway to it, tight round a corner's inside (soft: these are smoothed,
    // so that where one gives way to another the barrier curves rather than turning a corner).
    const limit = new Float64Array(n);
    const soft = new Float64Array(n);
    const fixed = new Float64Array(n).fill(NaN);
    const inChicane = (k: number) => !Number.isNaN(line[k]) || !Number.isNaN(taper[k]);
    for (let k = 0; k < n; k++) {
      want[k] = edge[k] + gap[k] + BARRIER / 2;
      // (The paddock's barrier takes all the room it can: the lot has to fit.)
      const pitNeed = j === 0 ? pit.gap(s[k]) : 0;
      const reach = pitNeed > p.verge ? 1 : WALL_REACH;
      // A tight corner's inside takes in the verge (and round the corner, run-off), never the pit lane.
      const inside = Math.min(Math.max(cap[k], edge[k] + keep[k] + BARRIER / 2), Math.max(hard[j][k], edge[k] + keepPit[k] + BARRIER / 2));
      // (Through a chicane and its tapers only parts of the circuit well away count: not its own corners.)
      limit[k] = inChicane(k) ? far[k] - WALL_MARGIN : clear[k] - WALL_MARGIN;
      soft[k] = Math.min(want[k] + 50, inChicane(k) ? Infinity : Math.min(edge[k] + reach * (clear[k] - edge[k]), inside));
      if (!Number.isNaN(line[k])) fixed[k] = line[k];
    }
    limitSlope(soft, SLOPE * step, undefined, stretch);
    groundSmooth(soft, step, 15, 2, stretch);
    for (let k = 0; k < n; k++) {
      // (Smoothing never takes it in past what the pit lane and cars leaving the track need.)
      soft[k] = Math.max(soft[k], edge[k] + keepPit[k] + BARRIER / 2);
      if (!inChicane(k)) limit[k] = Math.min(limit[k], soft[k]);
      wall[k] = Math.min(want[k], limit[k]);
    }
    // Where something nearer pulls the barrier in, it comes in gradually; then the corners are rounded off.
    // Through a chicane (only parts of the circuit well away can bring it in), taken as it is: held there
    // while the rest is tapered and smoothed (its outline, easing out either side, is smooth already).
    const onTheLine = (k: number) => !Number.isNaN(fixed[k]);
    const pin = () => {
      for (let k = 0; k < n; k++) if (onTheLine(k)) wall[k] = Math.min(fixed[k], limit[k]);
    };
    // (The limit too, so clamping to it at the end can't put back a step that tapering took out.)
    limitSlope(limit, SLOPE * step, onTheLine, stretch);
    for (let k = 0; k < n; k++) wall[k] = Math.min(wall[k], limit[k]);
    pin();
    limitSlope(wall, SLOPE * step, onTheLine, stretch);
    // (Smoothing would pull the barrier down beside a fixed stretch, leaving a step; near one it gives way to the unsmoothed taper.)
    const tapered = Float64Array.from(wall);
    groundSmooth(wall, step, 12, 3, stretch);
    const near = new Float64Array(n).fill(Infinity);
    for (const dir of [1, -1]) {
      for (let j = 0, d = Infinity; j < 2 * n; j++) {
        const k = dir > 0 ? j % n : (2 * n - 1 - j) % n;
        d = onTheLine(k) ? 0 : d + 1;
        near[k] = Math.min(near[k], d);
      }
    }
    for (let k = 0; k < n; k++) {
      const w = Math.max(0, 1 - near[k] / 10);
      wall[k] += (tapered[k] - wall[k]) * w;
    }
    pin();
    for (let k = 0; k < n; k++) {
      // Never in past what the pit lane and cars leaving the track need (smoothing can round a corner off
      // them), nor onto the track, whatever is beyond (validation rejects a circuit that close to itself).
      wall[k] = Math.max(Math.min(Math.max(wall[k], edge[k] + keepPit[k] + BARRIER / 2), limit[k]), edge[k] + BARRIER / 2 + 0.5);
      if (!Number.isNaN(line[k])) {
        want[k] = line[k];
        runoff[k] = wall[k] - edge[k] - BARRIER / 2;
      }
    }
  });
  return { n, s, left, right, corners, chicanes };
}

function buildCircuit(p: CircuitParams, ctx: GenContext): TrackLayout {
  const centerline = circuitCenterline(p);
  const cl = new Centerline(centerline);
  const L = cl.length;
  const half = p.width / 2;

  // Pit road along the main straight, on the left (the infield), and the paddock behind it.
  const wallStart = -p.main / 2 + CIRCUIT_PIT.ENTRY_LENGTH + CIRCUIT_PIT.START_MARGIN;
  const wallEnd = p.main / 2 - CIRCUIT_PIT.EXIT_TAPER - CIRCUIT_PIT.END_MARGIN;
  const { pit, pavedInner: pitPaved } = pitLane({
    innerEdge: half, apronWidth: 0, wallStart, wallEnd, blendEnd: wallEnd + CIRCUIT_PIT.EXIT_TAPER + 10,
    entryLength: CIRCUIT_PIT.ENTRY_LENGTH, exitTaper: CIRCUIT_PIT.EXIT_TAPER,
    wallGap: CIRCUIT_PIT.WALL_GAP, wallThickness: CIRCUIT_PIT.WALL_THICKNESS, roadWidth: CIRCUIT_PIT.ROAD_WIDTH,
    stallSpacing: CIRCUIT_PIT.STALL_SPACING,
  });
  const { garage, buildings } = garageLot(cl, { s0: pit.wallStart + 20, s1: pit.wallEnd - 20, d0: pit.roadD, depth: CIRCUIT_PIT.GARAGE_DEPTH });

  // The cross-section: edges widened round the corners that need it, barriers at the verge, run-off on
  // corner outsides and behind the paddock, all kept clear of the rest of the circuit.
  const { edgeIn, edgeOut, walls: barriers, surfaces } = dressCourse(courseOf(p, L), cl, pitZone(pit, pitPaved, garage.lot, half, L), { spec: centerline });
  const g = circuitGeometry(courseOf(p, L), cl, pitZone(pit, pitPaved, garage.lot, half, L), centerline);
  const pavedInner = sampledProfile(Array.from(g.s, (x, k) => Math.max(g.left.edge[k], evalProfile(pitPaved, x, L))), L);
  const walls: Wall[] = [
    ...barriers,
    { id: 'pit-wall', range: [pit.wallStart, pit.wallEnd], d: pit.wallD, thickness: pit.wallThickness, faces: 'both', caps: true, attenuators: true },
  ];

  surfaces.push(
    { id: 'pit-approach', surface: 'apron', shape: { kind: 'band', range: [pit.entryStart, pit.exitEnd], d0: half, d1: pavedInner } },
    { id: 'garage', surface: 'garage', shape: { kind: 'rect', rect: garage.lot }, outline: true },
    { id: 'racing', surface: 'track', shape: { kind: 'band', range: null, d0: edgeOut, d1: edgeIn } },
    { id: 'pit-road', surface: 'pit', shape: { kind: 'band', range: [pit.wallStart, pit.wallEnd], d0: pit.wallD, d1: pit.roadD } },
  );

  const halfStall = pit.stallSpacing / 2;
  const markings: Marking[] = [
    { kind: 'line', range: null, d: edgeOut, style: 'edge' },
    { kind: 'line', range: [pit.blendEnd, L + pit.entryStart], d: edgeIn, style: 'edge' },
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
    crossSection: { edgeIn, edgeOut, apronWidth: 0, pavedInner, bankInner: flat(0), bankOuter: flat(0), bankInfield: flat(0) },
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
 * A course laid out as a circuit is: its cross-section (edges widened round
 * the corners that need it, barriers at the verge, run-off on corner outsides,
 * all kept clear of the rest of the course and anything bounding it), its two
 * barriers, and its verges, run-off and kerbs. Over the whole lap, or (a road
 * course's own part of one) the verges over `range` and each barrier over its
 * own (null: none).
 */
export function dressCourse(
  course: Course, cl: Centerline, pit: PitZone,
  opts: { spec?: CenterlineSpec; bound?: Bound; range?: [number, number]; walls?: [[number, number] | null, [number, number] | null] } = {},
): { edgeIn: Profile; edgeOut: Profile; walls: Wall[]; surfaces: SurfaceRegion[]; geometry: Geometry; wallLines: [Profile, Profile] } {
  const L = cl.length;
  // The cross-section: edges widened round the corners that need it, barriers at the verge, run-off on
  // corner outsides and behind the paddock, all kept clear of the rest of the circuit.
  const g = circuitGeometry(course, cl, pit, opts.spec, opts.bound);
  const neg = (v: Float64Array) => v.map((d) => -d);
  const edgeIn = sampledProfile(g.left.edge, L);
  const edgeOut = sampledProfile(neg(g.right.edge), L);
  const leftWall = sampledProfile(g.left.wall, L);
  const rightWall = sampledProfile(neg(g.right.wall), L);
  // Through a chicane the barrier is laid exactly on its line, finely: near the middle corner a step along
  // the lap moves the point where the normal meets the line a long way, and coarse keys would leave it off the line.
  const chicaneAt = (x: number) => g.chicanes.find((z) => ((((x - z.z0) % L) + L) % L) <= z.z1 - z.z0);
  const fine = (x: number) => (chicaneAt(x) ? 0.25 : GEO_STEP);
  // (One barrier each side, all the way round. Through a chicane's middle corner, points past the corner's
  // centre meet the outline back along from where their neighbours do: laid finely and exactly on it, they
  // only go over it again, so the barrier there is continuous.)
  const barrier = (side: Side, j: 0 | 1, profile: Profile, sign: number): Wall => {
    const at = (x: number) => {
      const z = chicaneAt(x);
      if (!z) return evalProfile(profile, x, L);
      const k = Math.round((((x % L) + L) % L) / (L / g.n)) % g.n;
      return sign * Math.max(side.edge[k] + BARRIER / 2 + 0.5, Math.min(z.line(x)[j], side.far[k] - WALL_MARGIN));
    };
    return {
      id: `barrier-${sign > 0 ? 'left' : 'right'}`, range: opts.walls?.[j] ?? null, d: g.chicanes.length ? rangeProfile([-L / 2, L / 2], L, at, 0.05, fine) : profile,
      thickness: BARRIER, faces: sign > 0 ? 'out' : 'in', caps: false,
    };
  };
  const walls: Wall[] = [barrier(g.left, 0, leftWall, 1), barrier(g.right, 1, rightWall, -1)].filter((_, j) => opts.walls?.[j] !== null);

  // Surfaces, bottom to top: run-off on corner outsides, kerbs, the pit approach, paddock, track, pit road.
  const surfaces: SurfaceRegion[] = [
    // Mown grass out to the barriers on both sides.
    { id: 'verges', surface: 'grass', shape: { kind: 'band', range: opts.range ?? null, d0: rightWall, d1: leftWall }, pattern: 'mowing' },
  ];
  // Run-off, a band for each stretch of it: from the edge out to the barrier where a corner wants it all,
  // tapering back into the verge either side. Chicanes' is asphalt, to drive straight on over; so is the
  // room made for cars leaving the track elsewhere, painted.
  const step = L / g.n;
  ([[g.left, 1, edgeIn], [g.right, -1, edgeOut]] as const).forEach(([side, sign, edgeProfile]) => {
    const { runoff, edge, wall } = side;
    // (A road course's own part of the lap only: elsewhere is another track's.)
    const owner = opts.range
      ? Int32Array.from(side.owner, (o, k) => (inSRange(g.s[k], opts.range!, L) ? o : -1))
      : side.owner;
    let start = owner.findIndex((o) => o === -1);
    if (start < 0) start = 0;
    for (let j = 0; j < g.n;) {
      const o = owner[(start + j) % g.n];
      let len = 1;
      while (o !== -1 && j + len < g.n && owner[(start + j + len) % g.n] === o) len++;
      if (o !== -1) {
        // (A sample past either end, so neighbouring run-off meets without a sliver of grass between.)
        const lo = ((start + j - 1) * step) % L;
        const signedLo = lo > L / 2 ? lo - L : lo;
        const range: [number, number] = [signedLo, signedLo + (len + 1) * step];
        const reach = (x: number) => {
          const k = Math.round((((x % L) + L) % L) / step) % g.n;
          return sign * (edge[k] + Math.max(0, Math.min(runoff[k], wall[k] - BARRIER / 2 - edge[k])));
        };
        const inner = rangeProfile(range, L, (x) => evalProfile(edgeProfile, x, L));
        const outer = rangeProfile(range, L, reach);
        const c = o === PAINTED ? null : g.corners[o];
        surfaces.push({
          id: `runoff${o === PAINTED ? 'p' : o}${sign > 0 ? 'l' : 'r'}${j}`, surface: !c || c.chicane >= 0 ? 'runoff' : c.runoff,
          shape: { kind: 'band', range, d0: sign > 0 ? inner : outer, d1: sign > 0 ? outer : inner },
          ...(c ? {} : { pattern: 'painted' as const }),
        });
      }
      j += len;
    }
  });
  g.corners.forEach((c, i) => {
    if (c.spec.radius > 150) return;
    const inside = Math.sign(c.spec.angle);
    const apex: [number, number] = [c.a0 - 0.3 * c.spec.ease, c.a1 + 0.3 * c.spec.ease];
    const exit: [number, number] = [c.a1, c.s1 + 15];
    // A kerb, with a plain white end either side tapering it into the track edge.
    const kerb = (side: number, [a, b]: [number, number], id: string): SurfaceRegion[] => {
      const edgeAt = (x: number) => evalProfile(side > 0 ? edgeIn : edgeOut, x, L);
      const piece = (range: [number, number], width: (x: number) => number, pid: string, end: boolean): SurfaceRegion => {
        const inner = rangeProfile(range, L, edgeAt);
        const outer = rangeProfile(range, L, (x) => edgeAt(x) + side * width(x), 0.02);
        return {
          id: pid, surface: 'kerb', shape: { kind: 'band', range, d0: side > 0 ? inner : outer, d1: side > 0 ? outer : inner },
          ...(end ? { pattern: 'kerbEnd' as const } : {}),
        };
      };
      return [
        piece([a - KERB_END, a], (x) => KERB * (x - (a - KERB_END)) / KERB_END, `${id}-in`, true),
        piece([a, b], () => KERB, id, false),
        piece([b, b + KERB_END], (x) => KERB * (b + KERB_END - x) / KERB_END, `${id}-out`, true),
      ];
    };
    surfaces.push(...kerb(inside, apex, `kerb-apex${i}`), ...kerb(-inside, exit, `kerb-exit${i}`));
  });
  return { edgeIn, edgeOut, walls, surfaces, geometry: g, wallLines: [leftWall, rightWall] };
}

/**
 * No part of the circuit may come too close to another: every track edge
 * keeps its distance from the line midway to the next part of the circuit
 * (barriers stand between, and never cross it), corners keep most of the
 * run-off they need, and the paddock its barrier.
 */
function validateCircuit(layout: TrackLayout, track: Track): Problem[] {
  const problems: Problem[] = [];
  const p = layout.params as unknown as CircuitParams;
  const half = p.width / 2;
  const pit = layout.pit;
  const lot = layout.infield.garage.lot;
  const paved = layout.crossSection.pavedInner;
  const g = circuitGeometry(courseOf(p, track.length), track, pitZone(pit, typeof paved === 'number' ? flat(paved) : paved, lot, half, track.length), layout.centerline);
  let worst = Infinity;
  for (const { clear, edge } of [g.left, g.right]) for (let k = 0; k < g.n; k++) worst = Math.min(worst, clear[k] - edge[k]);
  if (worst < MIN_SEPARATION) problems.push({ severity: 'error', message: `parts of the circuit too close (${(MIN_SEPARATION - worst).toFixed(0)} m)` });
  const L = track.length;
  const sample = (x: number) => Math.round((((x % L) + L) % L) / (L / g.n)) % g.n;
  g.corners.forEach((c, i) => {
    if (c.chicane >= 0) return; // its run-off is everything out to the lines either side
    const k = sample(c.mid);
    const want = c.depth(c.mid, L);
    const out = c.spec.angle < 0 ? g.left : g.right;
    const room = out.wall[k] - BARRIER / 2 - out.edge[k];
    if (room < 0.6 * want) problems.push({ severity: 'error', message: `turn ${i + 1}'s run-off is squeezed by another part of the circuit` });
  });
  for (let x = pit.entryStart; x <= pit.exitEnd; x += GEO_STEP) {
    const k = sample(x);
    const behind = Math.max(track.pavedInnerD(x), x >= lot.s0 && x <= lot.s1 ? lot.d1 : -Infinity);
    if (g.left.wall[k] - BARRIER / 2 < behind + 0.5) { problems.push({ severity: 'error', message: 'pit lane or paddock squeezed by another part of the circuit' }); break; }
  }
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
