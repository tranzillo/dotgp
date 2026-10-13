import type { Rng } from '../ai/rng';
import { Centerline } from '../sim/centerline';
import { LAYOUT_VERSION, type CenterlineSpec, type TrackLayout } from '../sim/layout';
import { Track } from '../sim/track';
import { buildLayout, registerTrackType, type GenContext } from './generator';
import { trackName } from './names';
import {
  bankingByCurvature, edgesByCurvature, escapeLane, garageLot, pitLane, standardMarkings, standardSurfaces, standardWalls, straightsOf,
} from './stages';
import type { Problem } from './validate';

const deg = (x: number) => (x * Math.PI) / 180;

/**
 * Oval: two straights joined by two 180-degree turns, each a constant-radius
 * arc eased in and out by clothoids. Counterclockwise (every turn is a left
 * turn), start/finish mid front straight, pit road along the front straight
 * on the infield side, garage behind it, an escape lane off the back
 * straight before turn 3.
 *
 * Shapes beyond the plain oval (tri-oval dogleg, paperclip, egg) are future
 * variants: extra curvature sections in ovalCenterline, everything else shared.
 */
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
  /** Display name (otherwise generated from the seed). */
  name?: string;
}

/** Pit lane geometry shared by every oval. Lengths in metres. */
export const OVAL_PIT = {
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
  STALL_SPACING: 12,
} as const;

const ESCAPE_WIDTH = 9;

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
}

/** Ranges per size class. Presets sit inside them: short ~ Short track, intermediate ~ Flat track, speedway ~ Speedway. */
export const OVAL_SIZE_CLASSES: Record<string, SizeClass> = {
  short: {
    straightLength: [150, 260], turnRadius: [70, 110], width: [14, 17], apronWidth: [5, 7],
    bankInner: [4, 16], bankProgression: [2, 6], bankStraight: [1, 4], flatChance: 0.15,
    wideningChance: 0.5, widening: [0.1, 0.35],
  },
  intermediate: {
    straightLength: [280, 420], turnRadius: [150, 210], width: [16, 19], apronWidth: [6, 9],
    bankInner: [10, 22], bankProgression: [2, 6], bankStraight: [2, 6], flatChance: 0.25,
    wideningChance: 0.5, widening: [0.1, 0.3],
  },
  speedway: {
    straightLength: [400, 560], turnRadius: [210, 280], width: [17, 20], apronWidth: [7, 9],
    bankInner: [14, 24], bankProgression: [2, 6], bankStraight: [3, 8], flatChance: 0.1,
    wideningChance: 0.4, widening: [0.1, 0.25],
  },
  superspeedway: {
    straightLength: [550, 750], turnRadius: [290, 380], width: [18, 22], apronWidth: [8, 10],
    bankInner: [22, 31], bankProgression: [1, 4], bankStraight: [3, 9], flatChance: 0,
    wideningChance: 0.3, widening: [0.05, 0.2],
  },
};

function sampleOval(rng: Rng, variant: string): OvalParams {
  const c = OVAL_SIZE_CLASSES[variant];
  if (!c) throw new Error(`unknown oval variant "${variant}"`);
  const pick = ([a, b]: Range) => a + rng.next() * (b - a);
  const round = (x: number, step: number) => Math.round(x / step) * step;
  const turnRadius = round(pick(c.turnRadius), 5);
  const flat = rng.next() < c.flatChance;
  const bankInner = flat ? pick([1, 5]) : pick(c.bankInner);
  const width = round(pick(c.width), 0.5);
  const turnWidening = rng.next() < c.wideningChance ? round(width * pick(c.widening), 0.5) : 0;
  return {
    straightLength: round(pick(c.straightLength), 10),
    turnRadius,
    easementLength: round(turnRadius * pick([0.3, 0.45]), 5),
    width,
    turnWidening,
    apronWidth: round(pick(c.apronWidth), 0.5),
    bankInner: deg(bankInner),
    bankOuter: deg(bankInner + (flat ? pick([1, 2]) : pick(c.bankProgression))),
    bankStraight: deg(Math.min(bankInner * 0.5, pick(c.bankStraight))),
  };
}

// ---------- layout ----------

export function ovalCenterline(p: OvalParams): CenterlineSpec {
  const { straightLength: S, turnRadius: R, easementLength: Le } = p;
  const k = 1 / R;
  const arcLen = Math.PI * R - Le;
  if (arcLen <= 0) throw new Error('easementLength too long for turnRadius');
  return {
    kind: 'curvature',
    sections: [
      [S / 2, 0, 0],
      [Le, 0, k], [arcLen, k, k], [Le, k, 0],
      [S, 0, 0],
      [Le, 0, k], [arcLen, k, k], [Le, k, 0],
      [S / 2, 0, 0],
    ],
  };
}

function buildOval(p: OvalParams, ctx: GenContext): TrackLayout {
  const centerline = ovalCenterline(p);
  const cl = new Centerline(centerline);
  const L = cl.length;
  // Constant inside edge (pit road and apron lie along it); the outside edge can widen through the turns.
  const { edgeIn, edgeOut } = edgesByCurvature(centerline, p.width, p.turnWidening ?? 0);
  const innerEdge = p.width / 2;
  const apronD = innerEdge + p.apronWidth;
  const [front, back] = straightsOf(centerline);

  // Pit road along the front straight; the blend line runs through turns 1-2 a little way down the back straight.
  const { pit, pavedInner } = pitLane({
    innerEdge, apronWidth: p.apronWidth,
    wallStart: front[0] + OVAL_PIT.WALL_START_INSET,
    wallEnd: front[1] - OVAL_PIT.WALL_END_INSET,
    blendEnd: Math.min(back[0] + OVAL_PIT.BLEND_INTO_BACK_STRAIGHT, L / 2 - 5),
    entryLength: OVAL_PIT.ENTRY_LENGTH, exitTaper: OVAL_PIT.EXIT_TAPER,
    wallGap: OVAL_PIT.WALL_GAP, wallThickness: OVAL_PIT.WALL_THICKNESS, roadWidth: OVAL_PIT.ROAD_WIDTH,
    stallSpacing: OVAL_PIT.STALL_SPACING,
  });

  // Garage lot behind pit road, as deep as the infield allows (within reason).
  const depth = Math.max(20, Math.min(45, p.turnRadius - pit.roadD - 30));
  const { garage, buildings } = garageLot(cl, { s0: pit.wallStart + 30, s1: pit.wallEnd - 30, d0: pit.roadD, depth });

  // Escape lane off the back straight before turn 3, across to the garage.
  const backEnd = back[1] > L / 2 ? back[1] : back[1] + L;
  const leadIn = p.escapeLeadIn ?? Math.min(160, p.straightLength * 0.4);
  const escape = escapeLane(cl, { leaveS: backEnd - leadIn, innerEdge, apronD, lot: garage.lot, width: ESCAPE_WIDTH });

  const banking = bankingByCurvature(centerline, { straight: p.bankStraight, inner: p.bankInner, outer: p.bankOuter });
  const { name, ...params } = p;
  return {
    version: LAYOUT_VERSION,
    id: name ? name.toLowerCase().replace(/\s+/g, '-') : `oval-${ctx.seed}`,
    name: name ?? trackName(ctx.rng('name'), p.straightLength * 2 + 2 * Math.PI * p.turnRadius > 3000 ? 'Superspeedway' : 'Speedway'),
    type: 'oval',
    seed: ctx.seed,
    params: { ...params },
    centerline,
    crossSection: { edgeIn, edgeOut, apronWidth: p.apronWidth, pavedInner, ...banking },
    surfaces: standardSurfaces(edgeIn, edgeOut, pavedInner, pit, garage, [escape]),
    ground: 'grass',
    walls: standardWalls(edgeOut, pit),
    pit,
    infield: { garage, escapeLanes: [escape] },
    markings: standardMarkings(L, edgeIn, [-innerEdge, innerEdge], pavedInner, pit),
    decor: buildings,
    notes: [],
  };
}

function validateOval(layout: TrackLayout, track: Track): Problem[] {
  const p = layout.params as unknown as OvalParams;
  const problems: Problem[] = [];
  // Pit entry must leave the apron after the last turn's arc, not in the middle of it.
  if (track.signedS(layout.pit.entryStart) < -(p.straightLength / 2 + p.easementLength + 0.5 * (Math.PI * p.turnRadius - p.easementLength))) {
    problems.push({ severity: 'error', message: 'pit entry starts before the middle of turn 4' });
  }
  if (p.bankOuter < p.bankInner) problems.push({ severity: 'warning', message: 'banking gets flatter toward the wall' });
  return problems;
}

export const OVAL = registerTrackType<OvalParams>({
  id: 'oval',
  name: 'Oval',
  variants: Object.keys(OVAL_SIZE_CLASSES),
  sample: sampleOval,
  build: buildOval,
  validate: validateOval,
});

/** A track from fixed oval parameters (presets, tests). */
export function ovalTrack(params: OvalParams): Track {
  return new Track(buildLayout('oval', params));
}
