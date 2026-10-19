import type { Rng } from '../ai/rng';
import { Centerline } from '../sim/centerline';
import { evalProfile, LAYOUT_VERSION, type CenterlineSpec, type Decoration, type EscapeLane, type Edge, type Profile, type RoadNetwork, type RovalSpec, type SurfaceRegion, type TrackLayout } from '../sim/layout';
import { Track } from '../sim/track';
import { buildLayout, registerTrackType, type GenContext } from './generator';
import { trackName } from './names';
import { escapeLane, garageLot, pitComplex, pitLane, serviceRoad, standardMarkings, standardSurfaces, standardWalls } from './stages';
import { buildInfield, sampleInfield, type InfieldPlan } from './infield';
import { compileRoval } from './roval';
import { validateLayout } from './validate';
import { validateVenue } from './geometry';
import type { Problem } from './validate';

const deg = (x: number) => (x * Math.PI) / 180;

/**
 * Ovals: a closed loop of left turns joined by straights, 360 degrees in all.
 * Each corner is a constant-radius arc eased in and out by clothoids, with
 * its own radius, easing, banking and widening, so one builder makes every
 * shape: the classic two-turn oval and paperclip, the egg (one end tighter
 * than the other), the tri-oval and D (a bend in the front stretch), the
 * quad-oval (two), the rectangle (four 90-degree corners and short chutes)
 * and the triangle (three corners, each its own).
 *
 * Counterclockwise, start/finish on the front stretch (the run from the last
 * turn to turn 1, doglegs and all), pit road along it on the infield side,
 * garage behind it, an escape lane off the longest other straight before the
 * turn at its end.
 *
 * Banking follows each corner's design speed: within a track the tighter
 * corners bank steeper, a sweeping tri-oval dogleg much less than the turns
 * (as at Daytona: 31 degrees in the turns, 18 in the tri-oval), and shapes
 * built for flat corners (rectangle, triangle) bank less overall.
 */

/** One corner: heading change, arc radius, clothoids in and out, banking and widening in the arc. */
export interface OvalCorner {
  /** Heading change (rad, > 0: every turn on an oval is a left). */
  angle: number;
  radius: number;
  easeIn: number;
  easeOut: number;
  /** Banking at the inside and outside edge of the racing surface in the arc. */
  bankInner: number;
  bankOuter: number;
  /** Extra width in the arc, on the outside (default 0). */
  widening?: number;
  /** A bend in the front stretch (tri-oval, quad-oval), not one of the turns: pit road runs along it. */
  dogleg?: boolean;
}

export interface OvalStraight {
  length: number;
  /** Racing surface width along it (default: the track's width). */
  width?: number;
}

/**
 * Pit road and the garage, as a generated oval lays them out (otherwise the
 * classic: pit road against the front stretch, the garage right behind it).
 * Lengths in metres.
 */
export interface PitPlan {
  /** Grass between the racing surface and the pit wall; under 4, pit road is against the track. */
  gap: number;
  /** The entry taper before the wall, and the exit lane after it. */
  entryLength: number;
  exitLength: number;
  /** How far down the straight after turn 1 the blend line runs. */
  blend: number;
  /** Where the wall starts after the last turn's exit, and ends before turn 1. */
  startInset: number;
  endInset: number;
  stallSpacing: number;
  /** Grass between pit road and the garage lot (0: right behind it), and the lanes across it. */
  garageSetBack: number;
  garageLanes: number;
  /**
   * front: pit road follows the front stretch (default). chord: on a front
   * stretch that bends (tri-oval, quad-oval), pit road runs straight across
   * it, from where the last turn ends to where turn 1 begins, as at Daytona,
   * Kansas and Iowa: the oval races the bulge, the infield between is grass.
   */
  style?: 'front' | 'chord';
}

export type OvalShape = 'classic' | 'egg' | 'tri-oval' | 'd-oval' | 'quad-oval' | 'rectangle' | 'triangle';
export const OVAL_SHAPES: readonly OvalShape[] = ['classic', 'egg', 'tri-oval', 'd-oval', 'quad-oval', 'rectangle', 'triangle'];

/** Any oval, as its corners and straights. */
export interface ShapedOvalParams {
  shape: OvalShape;
  /** The lap: straights[i] runs into corners[i], and the last corner back into straights[0]. */
  straights: OvalStraight[];
  corners: OvalCorner[];
  /** Start/finish line: distance along the lap from the beginning of straights[0]. */
  start: number;
  /** Racing surface width on the front stretch. Its inside edge is the inside edge all the way round. */
  width: number;
  apronWidth: number;
  bankStraight: number;
  /** How far before the end of its straight the escape lane leaves the apron (default min(160, 40% of the straight)). */
  escapeLeadIn?: number;
  /** How far from the front stretch's centerline the infield has room for (default: measured). */
  garageRoom?: number;
  /** The escape lane cuts across the infield to the garage (default), or goes round its edge (the infield holds another track). */
  escapeRoute?: 'across' | 'around';
  /** Pit road and garage (default: the classic, against the front stretch with the garage behind). */
  pits?: PitPlan;
  /** The infield's roads, lots and inner oval (default: one escape lane to the garage). Needs pits. */
  infield?: InfieldPlan;
  /** Display name (otherwise generated from the seed). */
  name?: string;
}

/** The classic oval: two straights joined by two 180-degree turns (the presets, and tests that vary one thing). */
export interface OvalParams {
  straightLength: number;
  turnRadius: number;
  /** Length of each clothoid transition between straight and arc. */
  easementLength: number;
  /** Racing surface width on the straights. */
  width: number;
  /** Extra width in the tightest part of the turns, added on the outside (default 0). */
  turnWidening?: number;
  apronWidth: number;
  /** Turn banking at the inside edge of the racing surface. */
  bankInner: number;
  /** Turn banking at the outside edge (progressive banking: higher = steeper). */
  bankOuter: number;
  bankStraight: number;
  /** How far before the end of the back straight the escape lane leaves the apron (default min(160, 40% of the straight)). */
  escapeLeadIn?: number;
  /** The escape lane cuts across the infield to the garage (default), or goes round its edge (the infield holds another track). */
  escapeRoute?: 'across' | 'around';
  /** Display name (otherwise generated from the seed). */
  name?: string;
}

export type AnyOvalParams = OvalParams | ShapedOvalParams;

/** Pit lane geometry shared by every oval. Lengths in metres. */
export const OVAL_PIT = {
  /** Gap between the racing surface and the pit wall. */
  WALL_GAP: 1,
  WALL_THICKNESS: 0.8,
  ROAD_WIDTH: 14,
  /** The wall starts this far after the last turn's exit and ends this far before turn 1. */
  WALL_START_INSET: 30,
  WALL_END_INSET: 20,
  /** Paved taper from apron to pit road, ending where the wall starts. */
  ENTRY_LENGTH: 150,
  /** Taper from pit road back down to apron width after the wall ends. */
  EXIT_TAPER: 120,
  /** How far down the straight after turn 1 the blend lane runs before merging. */
  BLEND_INTO_BACK_STRAIGHT: 100,
  STALL_SPACING: 12,
} as const;

const ESCAPE_WIDTH = 9;
/** Shortest straight a sampled oval keeps (closing the loop may not shrink one below it). */
const MIN_STRAIGHT = 20;
/** Steepest banking a corner gets (Talladega is 33 degrees). */
const MAX_BANK = deg(36);

// ---------- presets ----------

export const SPEEDWAY: OvalParams = {
  straightLength: 450, turnRadius: 230, easementLength: 90, width: 18, apronWidth: 8,
  bankInner: deg(20), bankOuter: deg(24), bankStraight: deg(5), name: 'Speedway',
};

export const SHORT_TRACK: OvalParams = {
  straightLength: 200, turnRadius: 90, easementLength: 40, width: 16, apronWidth: 6,
  bankInner: deg(10), bankOuter: deg(14), bankStraight: deg(3), name: 'Short track',
};

export const FLAT_TRACK: OvalParams = {
  straightLength: 380, turnRadius: 200, easementLength: 70, width: 18, apronWidth: 8,
  bankInner: deg(2), bankOuter: deg(4), bankStraight: deg(1), name: 'Flat track',
};

/** A classic oval as corners and straights. */
export function shapedOval(p: AnyOvalParams): ShapedOvalParams {
  if ('corners' in p) return p;
  const corner = (): OvalCorner => ({
    angle: Math.PI, radius: p.turnRadius, easeIn: p.easementLength, easeOut: p.easementLength,
    bankInner: p.bankInner, bankOuter: p.bankOuter, widening: p.turnWidening ?? 0,
  });
  return {
    shape: 'classic',
    straights: [{ length: p.straightLength }, { length: p.straightLength }],
    corners: [corner(), corner()],
    start: p.straightLength / 2,
    width: p.width, apronWidth: p.apronWidth, bankStraight: p.bankStraight,
    escapeLeadIn: p.escapeLeadIn, garageRoom: p.turnRadius, escapeRoute: p.escapeRoute, name: p.name,
  };
}

// ---------- variants ----------

type Range = [number, number];
interface SizeClass {
  straightLength: Range;
  turnRadius: Range;
  width: Range;
  apronWidth: Range;
  /** Corner banking at the inside edge (deg), the extra at the outside edge, and the straights. */
  bankInner: Range;
  bankProgression: Range;
  bankStraight: Range;
  /** Chance the track is flat instead (bankInner 1-5 deg). */
  flatChance: number;
  /** Chance the turns are wider than the straights, and by how much (share of the width). */
  wideningChance: number;
  widening: Range;
  /** How often each shape comes up in this class (relative weights). */
  shapes: Partial<Record<OvalShape, number>>;
}

/**
 * Ranges per size class. Presets sit inside them: short ~ Short track,
 * intermediate ~ Flat track, speedway ~ Speedway. The straight and radius
 * set the scale; each shape lays out its corners at that scale.
 */
export const OVAL_SIZE_CLASSES: Record<string, SizeClass> = {
  short: {
    straightLength: [150, 260], turnRadius: [70, 110], width: [14, 17], apronWidth: [5, 7],
    bankInner: [4, 16], bankProgression: [2, 6], bankStraight: [1, 4], flatChance: 0.15,
    wideningChance: 0.5, widening: [0.1, 0.35],
    shapes: { classic: 4, egg: 3, 'd-oval': 1, rectangle: 1 },
  },
  intermediate: {
    straightLength: [280, 420], turnRadius: [150, 210], width: [16, 19], apronWidth: [6, 9],
    bankInner: [10, 22], bankProgression: [2, 6], bankStraight: [2, 6], flatChance: 0.25,
    wideningChance: 0.5, widening: [0.1, 0.3],
    shapes: { classic: 3, egg: 2, 'tri-oval': 2, 'quad-oval': 2, 'd-oval': 1, rectangle: 1, triangle: 1 },
  },
  speedway: {
    straightLength: [400, 560], turnRadius: [210, 280], width: [17, 20], apronWidth: [7, 9],
    bankInner: [14, 24], bankProgression: [2, 6], bankStraight: [3, 8], flatChance: 0.1,
    wideningChance: 0.4, widening: [0.1, 0.25],
    shapes: { classic: 2, egg: 1, 'tri-oval': 3, 'quad-oval': 2, 'd-oval': 2, rectangle: 2, triangle: 2 },
  },
  superspeedway: {
    straightLength: [550, 750], turnRadius: [290, 380], width: [18, 22], apronWidth: [8, 10],
    bankInner: [22, 31], bankProgression: [1, 4], bankStraight: [3, 9], flatChance: 0,
    wideningChance: 0.3, widening: [0.05, 0.2],
    shapes: { classic: 1, 'tri-oval': 5, 'quad-oval': 2, 'd-oval': 2 },
  },
};

/** A shape's corners and straights at a scale: target lengths (closing the loop adjusts them), no banking yet. */
interface Outline {
  straights: number[];
  corners: Array<{ angle: number; radius: number; dogleg?: boolean; ease?: number }>;
  /** The line at the apex of corners[0] (a front-stretch bend), rather than the middle of straights[0]. */
  apex?: boolean;
  /** Banking relative to the class: shapes built for flat corners bank less. */
  bankScale: number;
}

type Pick = (r: Range) => number;

/** Each shape at turn radius R and straight S (what a classic oval of the class would have). */
const OUTLINES: Record<OvalShape, (pick: Pick, R: number, S: number, coin: () => boolean) => Outline | null> = {
  classic: (_pick, R, S) => ({
    straights: [S, S], corners: [{ angle: Math.PI, radius: R }, { angle: Math.PI, radius: R }], bankScale: 1,
  }),

  // Ends of different radii; the straights, tangent to both, close in toward the tight end.
  egg: (pick, R, S, coin) => {
    const big = R * pick([1.08, 1.25]), small = R * pick([0.72, 0.9]);
    const a = Math.asin((big - small) / S);
    const T = Math.sqrt(S * S - (big - small) ** 2);
    const ends = [{ angle: Math.PI + 2 * a, radius: big }, { angle: Math.PI - 2 * a, radius: small }];
    if (coin()) ends.reverse();
    return { straights: [T, T], corners: ends, bankScale: 1 };
  },

  // The front stretch bends once, in a long sweep, the line at its apex.
  'tri-oval': (pick, R, S) => dogleg(pick, R, S, [24, 44], [2.5, 4], null),
  // The same with a big bend and hardly any straight either side of it: the front stretch is one curve.
  'd-oval': (pick, R, S) => dogleg(pick, R, S, [60, 95], [2.2, 3.2], [20, 45]),

  // Two bends in the front stretch, the line on the short straight between them.
  'quad-oval': (pick, R, S) => {
    const theta = deg(pick([14, 26]));
    const Rd = R * pick([2, 3.5]);
    const M = S * pick([0.2, 0.35]);
    const chord = 2 * Rd * Math.sin(theta / 2);
    const A = Math.max(MIN_STRAIGHT + 10, (S - M - 2 * chord * Math.cos(theta / 2)) / (2 * Math.cos(theta)));
    const back = M + 2 * chord * Math.cos(theta / 2) + 2 * A * Math.cos(theta);
    const bend = { angle: theta, radius: Rd, dogleg: true };
    return {
      straights: [M, A, back, A],
      corners: [bend, { angle: Math.PI - theta, radius: R }, { angle: Math.PI - theta, radius: R }, { ...bend }],
      bankScale: 1,
    };
  },

  // Four 90-degree corners, tighter than a classic oval's turns, with short chutes between them.
  rectangle: (pick, R, S) => {
    const Rr = R * pick([0.6, 0.85]);
    const C = Rr * pick([0.6, 1.4]);
    const corner = () => ({ angle: Math.PI / 2, radius: Rr * pick([0.95, 1.05]) });
    return { straights: [S, C, S, C], corners: [corner(), corner(), corner(), corner()], bankScale: 0.6 };
  },

  // Three corners of different angles and radii; the longest side is the front stretch.
  triangle: (pick, R, S) => {
    const a1 = deg(pick([40, 75])), a2 = deg(pick([40, 75])), a3 = Math.PI - a1 - a2;
    if (a3 < deg(35) || a3 > deg(85)) return null;
    const interior = [a1, a2, a3];
    // Tighter than a two-turn oval's turns (each turns less), so the sides keep long straights.
    const corners = interior.map((a) => ({ angle: Math.PI - a, radius: R * pick([0.45, 0.75]), ease: 0 }));
    for (const c of corners) c.ease = easeFor(c.radius, c.angle, pick);
    // Side i runs from vertex i-1 to vertex i, opposite vertex i+1 (law of sines). Sized so the lap, corners
    // cut, is a two-turn oval's of the class: each corner saves its two tangents less its own length.
    const saved = corners.reduce((x, c) => x + 2 * tangentLength(c) - (c.angle * c.radius + c.ease), 0);
    const P = 2 * S + 2 * Math.PI * R + saved;
    const sines = interior.map((_, i) => Math.sin(interior[(i + 1) % 3]));
    const sum = sines.reduce((x, y) => x + y, 0);
    const straights = sines.map((sn, i) => (P * sn) / sum - tangentLength(corners[(i + 2) % 3]) - tangentLength(corners[i]));
    // The front stretch the longest side by some way (Pocono's is 1 km of 2.4 km of straights).
    if (straights.some((l) => l < MIN_STRAIGHT + 20) || Math.max(...straights) < 0.36 * straights.reduce((x, y) => x + y, 0)) return null;
    // Rotate the longest side to the front.
    const k = straights.indexOf(Math.max(...straights));
    const rot = <T>(xs: T[]) => [...xs.slice(k), ...xs.slice(0, k)];
    return { straights: rot(straights), corners: rot(corners), bankScale: 0.7 };
  },
};

/** A front stretch with one bend of `theta` degrees (radius in turn radii), the turns making up the rest. */
function dogleg(pick: Pick, R: number, S: number, theta: Range, radius: Range, sides: Range | null): Outline {
  const t = deg(pick(theta));
  const Rd = R * pick(radius);
  const chord = 2 * Rd * Math.sin(t / 2);
  const A = sides ? pick(sides) : Math.max(MIN_STRAIGHT + 10, (S - chord) / (2 * Math.cos(t / 2)));
  const back = chord + 2 * A * Math.cos(t / 2);
  const ease = Rd * t * pick([0.25, 0.4]);
  const bend = { angle: t, radius: Rd, dogleg: true, ease };
  const turn = { angle: Math.PI - t / 2, radius: R };
  return { straights: [A, A, back], corners: [bend, turn, { ...turn }], apex: true, bankScale: 1 };
}

/** Clothoid length into and out of a corner: a share of its radius, short enough to leave an arc. */
function easeFor(radius: number, angle: number, pick: Pick): number {
  return Math.min(radius * pick([0.3, 0.45]), angle * radius * 0.45);
}

/** Distance from where two straights would meet back along each to where a (symmetrically eased) corner starts. */
function tangentLength(c: { angle: number; radius: number; ease: number }): number {
  const R = c.radius, Ls = c.ease;
  const p = (Ls * Ls) / (24 * R);
  const q = Ls / 2 - (Ls * Ls * Ls) / (240 * R * R);
  return (R + p) * Math.tan(c.angle / 2) + q;
}

function sampleOval(rng: Rng, variant: string, hints?: Record<string, unknown>): ShapedOvalParams {
  const c = OVAL_SIZE_CLASSES[variant];
  if (!c) throw new Error(`unknown oval variant "${variant}"`);
  const shape = typeof hints?.shape === 'string' ? (hints.shape as OvalShape) : weighted(rng, c.shapes);
  if (!OUTLINES[shape]) throw new Error(`unknown oval shape "${shape}" (shapes: ${OVAL_SHAPES.join(', ')})`);
  for (let attempt = 0; attempt < 200; attempt++) {
    const params = tryOval(rng, c, shape);
    if (params && closeOval(params)) return { ...params, pits: samplePits(rng, variant, shape), infield: sampleInfield(rng, variant) };
  }
  throw new Error(`could not lay out a closed ${variant} ${shape}`);
}

/**
 * A pit complex: about half against the front stretch, the rest set back
 * across grass (less far on short tracks, where the infield is small); entry,
 * exit and blend lengths, wall insets and box spacing vary; the garage right
 * behind pit road or set back with one to three lanes to it.
 */
function samplePits(rng: Rng, variant: string, shape: OvalShape): PitPlan {
  const pick = ([a, b]: Range) => a + rng.next() * (b - a);
  const round = (x: number, step: number) => Math.round(x / step) * step;
  const short = variant === 'short';
  // A front stretch that bends can have pit road straight across it.
  if ((shape === 'tri-oval' || shape === 'quad-oval') && rng.next() < 0.55) {
    const gap = round(pick([4, 8]), 1);
    return {
      style: 'chord', gap,
      entryLength: round(pick(CLASSIC_ENTRY) + ENTRY_PER_GAP * gap, 5),
      exitLength: round(pick([90, 150]) + EXIT_PER_GAP * gap, 5),
      blend: round(pick([60, 160]), 5),
      startInset: round(pick([15, 35]), 5),
      endInset: round(pick([15, 35]), 5),
      stallSpacing: round(pick([11, 14]), 0.5),
      garageSetBack: rng.next() < 0.55 ? 0 : round(pick([15, 40]), 1),
      garageLanes: 1 + rng.int(3),
    };
  }
  const gap = rng.next() < 0.5 ? 1 : round(pick(short ? [6, 16] : [8, 45]), 1);
  return {
    gap,
    // A pit road set back across grass needs room to swing over to it, in and out (see fitPits).
    entryLength: round(pick(CLASSIC_ENTRY) + ENTRY_PER_GAP * gap, 5),
    exitLength: round(pick([90, 150]) + EXIT_PER_GAP * gap, 5),
    blend: round(pick([60, 160]), 5),
    startInset: round(pick([20, 50]), 5),
    endInset: round(pick([15, 40]), 5),
    stallSpacing: round(pick([11, 14]), 0.5),
    garageSetBack: rng.next() < 0.55 ? 0 : round(pick(short ? [10, 20] : [15, 45]), 1),
    garageLanes: 1 + rng.int(3),
  };
}

/** Entry taper of a pit road against the track (longer ones start too far round a short track's last turn). */
const CLASSIC_ENTRY: Range = [120, 150];
/** Extra entry and exit lane per metre a pit road is set back (m/m). */
const ENTRY_PER_GAP = 3;
const EXIT_PER_GAP = 2.5;
/** How far into the last turn (before its end) a set-back pit road's entry may begin, and past turn 1's start its exit may end. */
const PIT_SWING_INTO_TURN = 60;

/** A set-back pit road keeps room for at least this many boxes (else its gap shrinks). */
const SET_BACK_MIN_BOXES = 12;

/**
 * A pit plan fitted to the track. A set-back pit road swings over to its
 * lanes on the front stretch (from near the last turn's end, to early in
 * turn 1), not halfway round a turn, so its wall starts and ends far enough
 * down the straight for that; where that leaves too short a pit road the gap
 * shrinks, and where even a small one doesn't fit, pit road goes against the
 * track (the classic).
 */
function fitPits(plan: PitPlan, front: [number, number]): PitPlan {
  // (A chord's pit road meets the track at its ends: its lanes swing over only the small gap there.)
  if (plan.gap < 4 || plan.style === 'chord') return plan;
  const baseIn = plan.entryLength - ENTRY_PER_GAP * plan.gap, baseOut = plan.exitLength - EXIT_PER_GAP * plan.gap;
  const minRoad = SET_BACK_MIN_BOXES * plan.stallSpacing + 40;
  for (let gap = Math.floor(plan.gap); gap >= 4; gap--) {
    const entryLength = baseIn + ENTRY_PER_GAP * gap, exitLength = baseOut + EXIT_PER_GAP * gap;
    const startInset = Math.max(plan.startInset, entryLength - PIT_SWING_INTO_TURN);
    const endInset = Math.max(plan.endInset, exitLength - PIT_SWING_INTO_TURN);
    if (front[1] - endInset - (front[0] + startInset) >= minRoad) return { ...plan, gap, entryLength, exitLength, startInset, endInset };
  }
  return { ...plan, gap: 1, entryLength: baseIn, exitLength: baseOut };
}

function weighted<T extends string>(rng: Rng, weights: Partial<Record<T, number>>): T {
  const entries = Object.entries(weights) as Array<[T, number]>;
  let r = rng.next() * entries.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of entries) if ((r -= w) < 0) return k;
  return entries[entries.length - 1][0];
}

function tryOval(rng: Rng, c: SizeClass, shape: OvalShape): ShapedOvalParams | null {
  const pick: Pick = ([a, b]) => a + rng.next() * (b - a);
  const round = (x: number, step: number) => Math.round(x / step) * step;
  const R = round(pick(c.turnRadius), 5);
  const S = round(pick(c.straightLength), 10);
  const outline = OUTLINES[shape](pick, R, S, () => rng.next() < 0.5);
  if (!outline) return null;

  const flat = rng.next() < c.flatChance;
  const level = flat ? pick([1, 5]) : pick(c.bankInner);
  const progression = flat ? pick([1, 2]) : pick(c.bankProgression);
  const width = round(pick(c.width), 0.5);
  const widening = rng.next() < c.wideningChance ? width * pick(c.widening) : 0;
  // Sometimes the straights away from the line are narrower (or wider) than the front stretch.
  const backWidth = rng.next() < 0.35 ? round(width * pick([0.85, 1.12]), 0.5) : undefined;

  // Banking by design speed: corners tighter than the track's typical turn bank steeper, sweeping ones less.
  const turns = outline.corners.filter((k) => !k.dogleg);
  const Rref = turns.reduce((a, k) => a + k.radius, 0) / turns.length;
  const symmetric = shape === 'classic';
  const corners = outline.corners.map((k): OvalCorner => {
    const radius = round(k.radius, 5);
    const ease = round(k.ease ?? easeFor(radius, k.angle, pick), 5);
    const scale = outline.bankScale * Math.sqrt(Rref / radius) * (symmetric ? 1 : pick([0.92, 1.08]));
    const bank = Math.min(MAX_BANK, deg(level * scale));
    return {
      angle: k.angle, radius, easeIn: ease, easeOut: ease,
      bankInner: bank, bankOuter: Math.min(MAX_BANK + deg(3), bank + deg(progression * (k.dogleg ? 0.5 : 1))),
      widening: k.dogleg ? 0 : round(widening * Math.min(1.3, Rref / radius), 0.5),
      ...(k.dogleg ? { dogleg: true } : {}),
    };
  });
  if (symmetric) corners[1] = { ...corners[0] };
  const front = frontStraights(corners);
  const straights = outline.straights.map((length, i) => ({
    length: round(length, 1), ...(backWidth !== undefined && !front.has(i) ? { width: backWidth } : {}),
  }));
  // The line mid front straight, or at the apex of the bend: the straight before it, then half the bend.
  const c0 = corners[0];
  const bend = c0.easeIn + (c0.angle * c0.radius - (c0.easeIn + c0.easeOut) / 2) + c0.easeOut;
  return {
    shape,
    straights,
    corners,
    start: outline.apex ? straights[0].length + bend / 2 : straights[0].length / 2,
    width,
    apronWidth: round(pick(c.apronWidth), 0.5),
    bankStraight: deg(Math.min(level * 0.5, pick(c.bankStraight))),
  };
}

/** Straights on the front stretch: straights[0], and any joined to it by doglegs. */
function frontStraights(corners: Array<{ dogleg?: boolean }>): Set<number> {
  const n = corners.length;
  const out = new Set([0]);
  for (let i = 0; corners[i].dogleg && i < n - 1; i++) out.add(i + 1);
  for (let i = n - 1; corners[i].dogleg && i > 0; i--) out.add(i);
  return out;
}

// ---------- closing the loop ----------

/** Where a lap of these sections ends relative to where it starts (same integration as the sim's centerline). */
function lapEnd(sections: Array<[number, number, number]>): { x: number; y: number; heading: number } {
  let x = 0, y = 0, h = 0;
  const step = 0.25;
  for (const [len, k0, k1] of sections) {
    const n = Math.max(1, Math.ceil(len / step));
    const ds = len / n;
    for (let i = 0; i < n; i++) {
      const k = k0 + (k1 - k0) * ((i + 0.5) / n);
      const mid = h + (k * ds) / 2;
      x += Math.cos(mid) * ds;
      y += Math.sin(mid) * ds;
      h += k * ds;
    }
  }
  return { x, y, heading: h };
}

/**
 * Adjust the straights so the lap closes. The end position is linear in the
 * straight lengths, so this is the smallest change, weighted toward longer
 * straights, that cancels the gap. False if a straight would drop below its
 * minimum or the straights can't close it (all parallel, and the turns don't
 * line up).
 */
export function closeOval(p: ShapedOvalParams): boolean {
  const end = lapEnd(pieces(p).map((pc) => [pc.len, pc.k0, pc.k1]));
  if (Math.abs(end.heading - 2 * Math.PI) > 1e-6) return false;
  const r = [-end.x, -end.y];
  if (Math.hypot(r[0], r[1]) > 1e-3) {
    const headings: number[] = [];
    let h = 0;
    p.straights.forEach((_, i) => { headings.push(h); h += p.corners[i].angle; });
    let a = 0, b = 0, c = 0;
    p.straights.forEach((st, i) => {
      const ux = Math.cos(headings[i]), uy = Math.sin(headings[i]), w = st.length;
      a += w * ux * ux; b += w * ux * uy; c += w * uy * uy;
    });
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-6 * (a + c) ** 2) return false;
    const lx = (c * r[0] - b * r[1]) / det, ly = (a * r[1] - b * r[0]) / det;
    const before = p.straights[0].length;
    p.straights.forEach((st, i) => { st.length += st.length * (Math.cos(headings[i]) * lx + Math.sin(headings[i]) * ly); });
    // The line keeps its place relative to the front straight's ends.
    if (p.start < before) p.start *= p.straights[0].length / before;
    else p.start += p.straights[0].length - before;
  }
  if (p.straights.some((st) => st.length < MIN_STRAIGHT)) return false;
  const after = lapEnd(pieces(p).map((pc) => [pc.len, pc.k0, pc.k1]));
  return Math.hypot(after.x, after.y) < 0.05;
}

// ---------- the lap as sections ----------

/**
 * A curvature section of the lap and what it belongs to: a straight, or part
 * of a corner (ease in, arc, ease out). t0..t1 is the part of that piece it
 * covers (less than all of it where the start line splits it).
 */
interface Piece {
  len: number;
  k0: number;
  k1: number;
  straight?: number;
  corner?: number;
  part?: 'in' | 'arc' | 'out';
  t0: number;
  t1: number;
}

/** The lap from the beginning of straights[0]. */
function pieces(p: ShapedOvalParams): Piece[] {
  const out: Piece[] = [];
  p.straights.forEach((st, i) => {
    if (st.length > 0) out.push({ len: st.length, k0: 0, k1: 0, straight: i, t0: 0, t1: 1 });
    const c = p.corners[i];
    const k = 1 / c.radius;
    const arc = c.angle * c.radius - (c.easeIn + c.easeOut) / 2;
    if (arc <= 0) throw new Error(`corner ${i + 1}: easements too long for its radius`);
    if (c.easeIn > 0) out.push({ len: c.easeIn, k0: 0, k1: k, corner: i, part: 'in', t0: 0, t1: 1 });
    out.push({ len: arc, k0: k, k1: k, corner: i, part: 'arc', t0: 0, t1: 1 });
    if (c.easeOut > 0) out.push({ len: c.easeOut, k0: k, k1: 0, corner: i, part: 'out', t0: 0, t1: 1 });
  });
  return out;
}

/** The lap from the start line (splitting the piece it falls in). */
function lapFromLine(p: ShapedOvalParams): Piece[] {
  const list = pieces(p);
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    const pc = list[i];
    if (p.start < acc + pc.len) {
      const a = p.start - acc;
      if (a <= 0) return [...list.slice(i), ...list.slice(0, i)];
      const t = a / pc.len;
      const k = pc.k0 + (pc.k1 - pc.k0) * t;
      const tm = pc.t0 + (pc.t1 - pc.t0) * t;
      return [{ ...pc, len: pc.len - a, k0: k, t0: tm }, ...list.slice(i + 1), ...list.slice(0, i), { ...pc, len: a, k1: k, t1: tm }];
    }
    acc += pc.len;
  }
  throw new Error('start line is past the end of the lap');
}

export function ovalCenterline(p: AnyOvalParams): CenterlineSpec {
  return { kind: 'curvature', sections: lapFromLine(shapedOval(p)).map((pc) => [pc.len, pc.k0, pc.k1]) };
}

/**
 * A value along the lap, keyed at every section boundary: `straight(i)` on
 * straight i, `corner(c)` in corner c's arc, easing from one to the other
 * through the clothoids (so it follows curvature, as banking should).
 */
function alongLap(lap: Piece[], n: number, straight: (i: number) => number, corner: (c: number) => number): Profile {
  const value = (pc: Piece, t: number): number => {
    if (pc.straight !== undefined) return straight(pc.straight);
    const c = pc.corner!;
    if (pc.part === 'out') {
      const base = straight((c + 1) % n);
      return base + (corner(c) - base) * (1 - t);
    }
    const base = straight(c);
    return base + (corner(c) - base) * (pc.part === 'in' ? t : 1);
  };
  const L = lap.reduce((a, pc) => a + pc.len, 0);
  const signed = (s: number) => (s > L / 2 ? s - L : s);
  const keys = new Map<number, number>();
  let acc = 0;
  for (const pc of lap) {
    if (!keys.has(signed(acc))) keys.set(signed(acc), value(pc, pc.t0));
    acc += pc.len;
    keys.set(signed(acc), value(pc, pc.t1));
  }
  return { keys: [...keys].sort((x, y) => x[0] - y[0]), ease: 'linear' };
}

/** Where things are on the lap from the line (signed s). */
interface Landmarks {
  /** The front stretch: from the end of the last turn before the line to the start of turn 1. */
  front: [number, number];
  /** Start of the straight after turn 1. */
  afterTurn1: number;
  /** The longest straight off the front stretch (the escape lane's), its plan length, and its signed range. */
  escape: { length: number; range: [number, number] };
  /** Middle of the last turn's arc. */
  lastTurnMid: number;
}

function landmarks(p: ShapedOvalParams, lap: Piece[]): Landmarks {
  const L = lap.reduce((a, pc) => a + pc.len, 0);
  const isTurn = (pc: Piece) => pc.corner !== undefined && !p.corners[pc.corner].dogleg;
  const starts: number[] = [];
  let acc = 0;
  for (const pc of lap) { starts.push(acc); acc += pc.len; }
  const first = lap.findIndex(isTurn);
  let last = lap.length - 1;
  while (!isTurn(lap[last])) last--;
  if (first < 0) throw new Error('an oval needs turns');
  const after = lap.findIndex((pc, i) => i > first && pc.straight !== undefined && !isTurn(pc));
  const front = frontStraights(p.corners);
  let best = -1;
  lap.forEach((pc, i) => {
    if (pc.straight === undefined || front.has(pc.straight)) return;
    if (best < 0 || p.straights[pc.straight].length > p.straights[lap[best].straight!].length) best = i;
  });
  if (best < 0) throw new Error('an oval needs a straight off the front stretch');
  let range: [number, number] = [starts[best], starts[best] + lap[best].len];
  if (range[0] >= L / 2) range = [range[0] - L, range[1] - L];
  let lastArc = lap.length - 1;
  while (!(isTurn(lap[lastArc]) && lap[lastArc].part === 'arc')) lastArc--;
  return {
    front: [starts[last] + lap[last].len - L, starts[first]],
    afterTurn1: after < 0 ? starts[first] : starts[after],
    escape: { length: p.straights[lap[best].straight!].length, range },
    lastTurnMid: starts[lastArc] + lap[lastArc].len / 2 - (starts[lastArc] >= L / 2 ? L : 0),
  };
}

/** The turns (not front-stretch bends): where each starts and ends on the lap from the line (signed s). */
function turnSpans(p: ShapedOvalParams, lap: Piece[]): Array<[number, number]> {
  const L = lap.reduce((a, pc) => a + pc.len, 0);
  const spans = new Map<number, [number, number]>();
  let acc = 0;
  for (const pc of lap) {
    if (pc.corner !== undefined && !p.corners[pc.corner].dogleg) {
      const span = spans.get(pc.corner);
      if (span) span[1] = acc + pc.len; else spans.set(pc.corner, [acc, acc + pc.len]);
    }
    acc += pc.len;
  }
  return [...spans.values()].map(([a, b]) => (a >= L / 2 ? [a - L, b - L] : [a, b]));
}

// ---------- layout ----------

function buildOval(params: AnyOvalParams, ctx: GenContext): TrackLayout {
  const p = shapedOval(params);
  const lap = lapFromLine(p);
  const centerline: CenterlineSpec = { kind: 'curvature', sections: lap.map((pc) => [pc.len, pc.k0, pc.k1]) };
  const cl = new Centerline(centerline);
  const L = cl.length;
  const n = p.corners.length;
  const marks = landmarks(p, lap);

  // Constant inside edge (pit road and apron lie along it); the outside edge follows each straight's width
  // and widens through the turns.
  const innerEdge = p.width / 2;
  const outside = (i: number) => (p.straights[i].width === undefined ? -innerEdge : innerEdge - p.straights[i].width!);
  const varies = p.corners.some((c) => (c.widening ?? 0) > 0) || p.straights.some((st) => st.width !== undefined && st.width !== p.width);
  const edgeIn: Edge = innerEdge;
  const edgeOut: Edge = varies
    ? alongLap(lap, n, outside, (c) => (outside(c) + outside((c + 1) % n)) / 2 - (p.corners[c].widening ?? 0))
    : -innerEdge;
  const apronD = innerEdge + p.apronWidth;

  // Pit road along the front stretch; the blend line runs through turn 1 a little way down the straight after it.
  // The entry taper shortens where the last turn is short (a rectangle's 90-degree corner): it leaves after the turn's middle.
  const plan = p.pits && fitPits(p.pits, marks.front);
  const wallStart = marks.front[0] + (plan?.startInset ?? OVAL_PIT.WALL_START_INSET);
  const wallEnd = marks.front[1] - (plan?.endInset ?? OVAL_PIT.WALL_END_INSET);
  const pitOptions = {
    innerEdge, apronWidth: p.apronWidth, wallStart, wallEnd,
    blendEnd: Math.min(marks.afterTurn1 + (plan?.blend ?? OVAL_PIT.BLEND_INTO_BACK_STRAIGHT), L / 2 - 5),
    entryLength: Math.min(plan?.entryLength ?? OVAL_PIT.ENTRY_LENGTH, wallStart - marks.lastTurnMid - 10),
    exitTaper: plan?.exitLength ?? OVAL_PIT.EXIT_TAPER,
    wallGap: plan?.gap ?? OVAL_PIT.WALL_GAP, wallThickness: OVAL_PIT.WALL_THICKNESS, roadWidth: OVAL_PIT.ROAD_WIDTH,
    stallSpacing: plan?.stallSpacing ?? OVAL_PIT.STALL_SPACING,
  };
  // Garage lot behind pit road (or set back from it), as deep as the infield allows (within reason).
  const garageDepth = (d0: number) => (p.garageRoom !== undefined
    ? Math.max(20, Math.min(45, p.garageRoom - d0 - 30))
    : measuredDepth(cl, wallStart + 30, wallEnd - 30, d0));
  let pit, pavedInner, garage, buildings;
  let pitSurfaces: SurfaceRegion[] = [];
  let network: RoadNetwork | undefined;
  if (plan) {
    // A generated pit complex, with its road network (on a chord: shifted in by how far the chord is from the track).
    ({ pit, pavedInner, garage, buildings, surfaces: pitSurfaces, network } = pitComplex(cl, {
      ...pitOptions, garageSetBack: plan.garageSetBack, garageLanes: plan.garageLanes, garageDepth,
      ...(plan.style === 'chord' ? { offset: chordOffset(cl, marks.front) } : {}),
    }));
  } else {
    ({ pit, pavedInner } = pitLane(pitOptions));
    ({ garage, buildings } = garageLot(cl, { s0: pit.wallStart + 30, s1: pit.wallEnd - 30, d0: pit.roadD, depth: garageDepth(pit.roadD) }));
  }

  const id = p.name ? p.name.toLowerCase().replace(/\s+/g, '-') : `oval-${ctx.seed}`;
  let escapeLanes: EscapeLane[];
  let infieldSurfaces: SurfaceRegion[] = [];
  let infieldDecor: Decoration[] = [];
  let inner: TrackLayout | null = null;
  let rovals: RovalSpec[] = [];
  if (p.infield && network) {
    // A generated infield: service road, escape roads, links, lots, maybe an inner oval.
    const paved = pavedInner;
    const inf = buildInfield(p.infield, {
      cl, innerEdge, apronD, pavedInner: (s) => evalProfile(paved, s, L), pit, lot: garage.lot,
      turns: turnSpans(p, lap), rng: ctx.rng('infield'), id, seed: ctx.seed,
    });
    if (inf.problems.length) throw new Error(inf.problems.join('; '));
    network.nodes.push(...inf.nodes);
    network.roads.push(...inf.roads);
    escapeLanes = inf.escapeLanes;
    infieldSurfaces = inf.surfaces;
    infieldDecor = inf.decor;
    inner = inf.inner;
    rovals = inf.rovals;
  } else {
    // Escape lane off the longest other straight, before the turn at its end, across to the garage.
    const [, end] = marks.escape.range;
    const backEnd = end > L / 2 ? end : end + L;
    const leadIn = p.escapeLeadIn ?? Math.min(160, marks.escape.length * 0.4);
    const escape = (p.escapeRoute === 'around' ? serviceRoad : escapeLane)(cl, { leaveS: backEnd - leadIn, innerEdge, apronD, lot: garage.lot, width: ESCAPE_WIDTH });
    escapeLanes = [escape];
    if (network) {
      const first = escape.points[0], last = escape.points[escape.points.length - 1];
      network.nodes.push(
        { id: 'escape0', kind: 'apron', at: first, s: cl.signedS(cl.project(first[0], first[1]).s) },
        { id: 'garage-escape0', kind: 'garage', at: last },
      );
      network.roads.push({ id: 'escape0', from: 'escape0', to: 'garage-escape0', points: escape.points, width: ESCAPE_WIDTH, grade: 'escape' });
    }
  }
  // The pit complex's own surfaces: the grass island in front of a set-back pit road over the apron, garage lanes and
  // the infield's roads and lots with the roads.
  const surfaces = standardSurfaces(edgeIn, edgeOut, pavedInner, pit, garage, p.infield && network ? [] : escapeLanes);
  const after = (rid: string) => surfaces.findIndex((r) => r.id === rid) + 1;
  surfaces.splice(after('apron'), 0, ...pitSurfaces.filter((r) => r.id === 'pit-island'));
  surfaces.splice(after('infield'), 0, ...pitSurfaces.filter((r) => r.id !== 'pit-island'), ...infieldSurfaces);

  // Banking follows curvature into each corner's own banking; the paved infield is much flatter.
  const banking = {
    bankInner: alongLap(lap, n, () => p.bankStraight, (c) => p.corners[c].bankInner),
    bankOuter: alongLap(lap, n, () => p.bankStraight, (c) => p.corners[c].bankOuter),
    bankInfield: alongLap(lap, n, () => p.bankStraight * 0.5, (c) => p.corners[c].bankInner * 0.4),
  };
  const { name, ...rest } = params;
  return {
    version: LAYOUT_VERSION,
    id,
    name: name ?? trackName(ctx.rng('name'), L > 3000 ? 'Superspeedway' : 'Speedway'),
    type: 'oval',
    seed: ctx.seed,
    params: { ...rest },
    centerline,
    crossSection: { edgeIn, edgeOut, apronWidth: p.apronWidth, pavedInner, ...banking },
    surfaces,
    ground: 'grass',
    walls: standardWalls(edgeOut, pit),
    pit,
    infield: { garage, escapeLanes, ...(network ? { network } : {}), ...(rovals.length ? { rovals } : {}) },
    markings: standardMarkings(L, edgeIn, [-innerEdge, innerEdge], pavedInner, pit),
    decor: [...buildings, ...infieldDecor],
    ...(inner ? { neighbours: [inner] } : {}),
    notes: [],
  };
}

/**
 * How far in from the centerline (along its normal) the straight line from
 * the front stretch's start (the last turn's end) to its end (turn 1's start)
 * is, at each signed s on the front stretch; 0 elsewhere. On a front stretch
 * that bends outward (a tri-oval's) that is the chord's distance in from the
 * bulge: 0 at its ends, deepest at the apex.
 */
function chordOffset(cl: Centerline, [f0, f1]: [number, number]): (s: number) => number {
  const [ax, ay] = cl.toWorld(f0, 0), [bx, by] = cl.toWorld(f1, 0);
  const len = Math.hypot(bx - ax, by - ay);
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  const raw = (s: number) => {
    if (!cl.inRange(s, [f0, f1])) return 0;
    const [cx, cy] = cl.toWorld(s, 0);
    const i = cl.indexAt(s);
    const nx = -cl.ty[i], ny = cl.tx[i];
    // C + d N on the line through A along u: (C - A) x u + d (N x u) = 0.
    const d = -((cx - ax) * uy - (cy - ay) * ux) / (nx * uy - ny * ux);
    return Math.max(0, d);
  };
  // Rounded where the chord leaves the track (it does at an angle: a kink no car can follow), a running mean over 80 m.
  const step = 5, half = 8;
  const from = f0 - 60, n = Math.ceil((cl.distanceFrom(f0, f1) + 120) / step);
  const v = Array.from({ length: n + 1 }, (_, k) => raw(from + k * step));
  const smooth = v.map((_, k) => {
    let a = 0, c = 0;
    for (let j = -half; j <= half; j++) if (k + j >= 0 && k + j <= n) { a += v[k + j]; c++; }
    return a / c;
  });
  return (s: number) => {
    const f = cl.distanceFrom(from, s) / step;
    if (f > n) return 0;
    const k = Math.floor(f), t = f - k;
    return smooth[k] + ((smooth[Math.min(n, k + 1)] ?? 0) - smooth[k]) * t;
  };
}

/**
 * Garage depth where the infield is shaped by the corners (not two parallel
 * straights): the deepest lot, up to 45 m, whose back corners and middle
 * plus a 30 m margin still sit on the front stretch's side of the infield.
 */
function measuredDepth(cl: Centerline, s0: number, s1: number, d0: number): number {
  const staysPut = (s: number, d: number) => {
    const [x, y] = cl.toWorld(s, d);
    const q = cl.project(x, y);
    return Math.abs(cl.signedS(q.s - s)) < 1 && Math.abs(q.d - d) < 0.5;
  };
  for (let depth = 45; depth > 20; depth -= 5) {
    if ([s0, (s0 + s1) / 2, s1].every((s) => staysPut(s, d0 + depth + 30))) return depth;
  }
  return 20;
}

function validateOval(layout: TrackLayout, track: Track): Problem[] {
  const p = shapedOval(layout.params as unknown as AnyOvalParams);
  const problems: Problem[] = [];
  const marks = landmarks(p, lapFromLine(p));
  // The line is on the front stretch, and pit entry leaves the apron after the last turn's arc, not in the middle of it.
  if (!(marks.front[0] < 0 && marks.front[1] > 0)) problems.push({ severity: 'error', message: 'start line is not on the front stretch' });
  if (track.signedS(layout.pit.entryStart) < marks.lastTurnMid) {
    problems.push({ severity: 'error', message: 'pit entry starts before the middle of the last turn' });
  }
  if (p.corners.some((c) => c.bankOuter < c.bankInner)) problems.push({ severity: 'warning', message: 'banking gets flatter toward the wall' });
  // An oval in the infield: it and this one keep grass between them.
  if (layout.neighbours?.length) {
    for (const message of validateVenue([{ ...layout, neighbours: undefined }, ...layout.neighbours])) problems.push({ severity: 'error', message });
  }
  // Every road-course layout through the infield compiles to a valid track of its own.
  for (const spec of layout.infield.rovals ?? []) {
    try {
      const roval = compileRoval(layout, spec);
      for (const p of validateLayout(roval, new Track(roval))) if (p.severity === 'error') problems.push({ severity: 'error', message: `${spec.name}: ${p.message}` });
    } catch (e) {
      problems.push({ severity: 'error', message: (e as Error).message });
    }
  }
  return problems;
}

export const OVAL = registerTrackType<AnyOvalParams>({
  id: 'oval',
  name: 'Oval',
  variants: Object.keys(OVAL_SIZE_CLASSES),
  sample: sampleOval,
  build: buildOval,
  validate: validateOval,
});

/** A track from fixed oval parameters (presets, tests). */
export function ovalTrack(params: AnyOvalParams): Track {
  return new Track(buildLayout('oval', params));
}
