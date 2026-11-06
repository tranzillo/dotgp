import type { Rng } from '../ai/rng';
import { Centerline } from '../sim/centerline';
import { cornerSections, easeFor, preferredRadius, tangentLength, type CornerSpec } from './circuit';

/**
 * Course sections: curvature tools for the road courses laid through an
 * oval's infield (trackgen/roval.ts). A section leaves the oval (on a straight,
 * or mid-turn, easing from the turn's curvature) and rejoins it, through
 * corners fitted from the circuit vocabulary at its waypoints, as curvature
 * sections; spliced into the oval's own, they make one closed centerline the
 * sim races like any other.
 */

/** A pose on a course road: where, heading which way, at what curvature. */
export interface Pose {
  x: number;
  y: number;
  h: number;
  k: number;
}

/** Shortest straight between two corners of a course road (and what the chicane's legs keep to). */
const MIN_SECTION_STRAIGHT = 8;
const MIN_STRAIGHT = MIN_SECTION_STRAIGHT;
const MIN_RADIUS = 14;

/** The world positions and end pose of curvature sections driven from (x, y) heading h (same integration as the sim's centerline). */
export function integrate(sections: Array<[number, number, number]>, x: number, y: number, h: number, every = 5): {
  points: Array<[number, number]>; end: { x: number; y: number; h: number };
} {
  const points: Array<[number, number]> = [[x, y]];
  const step = 0.25;
  let since = 0;
  for (const [len, k0, k1] of sections) {
    const n = Math.max(1, Math.ceil(len / step));
    const ds = len / n;
    for (let i = 0; i < n; i++) {
      const k = k0 + (k1 - k0) * ((i + 0.5) / n);
      const mid = h + (k * ds) / 2;
      x += Math.cos(mid) * ds;
      y += Math.sin(mid) * ds;
      h += k * ds;
      since += ds;
      if (since >= every) { points.push([x, y]); since = 0; }
    }
  }
  if (since > 0) points.push([x, y]);
  return { points, end: { x, y, h } };
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Heading of the centerline at s, interpolated between samples (in a turn, the sample before s is off by up to a sample's turn). */
export function headingAt(cl: Centerline, s: number): number {
  const f = cl.wrapS(s) / cl.ds, i = Math.floor(f) % cl.n, j = (i + 1) % cl.n, t = f - Math.floor(f);
  return Math.atan2(cl.ty[i] + (cl.ty[j] - cl.ty[i]) * t, cl.tx[i] + (cl.tx[j] - cl.tx[i]) * t);
}

/** A corner's sections easing in from curvature kStart and out to kEnd (0 off a straight; a junction in a turn: the turn's). */
function cornerFrom(c: CornerSpec, kStart: number, kEnd: number): Array<[number, number, number]> | null {
  const k = Math.sign(c.angle) / c.radius;
  const arc = (c.angle - (c.ease * (kStart + k)) / 2 - (c.ease * (k + kEnd)) / 2) / k;
  if (!(arc >= 0)) return null;
  const out: Array<[number, number, number]> = [[c.ease, kStart, k]];
  if (arc > 1e-6) out.push([arc, k, k]);
  out.push([c.ease, k, kEnd]);
  return out;
}

/**
 * An infield section from the oval at s = from to s = to, through waypoints
 * (world positions in the infield), each a corner. An end on a straight
 * gets one more corner a little way (lead) along the oval from it; an end in
 * a turn is a corner itself, easing in from (or out to) the turn's own
 * curvature, so the road peels off the apron as the turn tightens (Daytona's
 * turn 1) and the lap's curvature runs on unbroken. Null if the corners
 * don't fit between the waypoints even at their tightest.
 */
export function infieldSection(cl: Centerline, from: number, to: number, waypoints: Array<[number, number]>, lead: [number, number], rng: Rng, width: number): Array<[number, number, number]> | null {
  return poseSection(ovalPose(cl, from), ovalPose(cl, to), waypoints, lead, rng, width);
}

/** The oval's pose at s: on its centerline, its heading and curvature there. */
export function ovalPose(cl: Centerline, s: number): Pose {
  const [x, y] = cl.toWorld(s, 0);
  return { x, y, h: headingAt(cl, s), k: cl.curvatureAt(s) };
}

/**
 * A course road from one pose to another through waypoints (each a corner):
 * an end on a straight (k 0) leads in along its heading to one more corner
 * (lead metres); an end in a turn is a corner itself, easing from the turn's
 * curvature. Null if the corners don't fit between the waypoints.
 */
export function poseSection(
  a: Pose, b: Pose, waypoints: Array<[number, number]>, lead: [number, number], rng: Rng, width: number,
  opts: { radiusScale?: number; minStraight?: number; radii?: Array<number | undefined>; floors?: Array<number | undefined> } = {},
): Array<[number, number, number]> | null {
  const scale = opts.radiusScale ?? 1, MIN_STRAIGHT = opts.minStraight ?? MIN_SECTION_STRAIGHT;
  const { x: ax, y: ay, h: ha, k: kA } = a;
  const { x: bx, y: by, h: hb, k: kB } = b;
  const inTurnA = Math.abs(kA) > 1e-6, inTurnB = Math.abs(kB) > 1e-6;
  // Corner vertices: an end in a turn is one; an end on a straight leads in to one.
  const verts: Array<[number, number]> = [
    inTurnA ? [ax, ay] : [ax + lead[0] * Math.cos(ha), ay + lead[0] * Math.sin(ha)],
    ...waypoints,
    inTurnB ? [bx, by] : [bx - lead[1] * Math.cos(hb), by - lead[1] * Math.sin(hb)],
  ];
  const dirTo = (p: [number, number], q: [number, number]) => Math.atan2(q[1] - p[1], q[0] - p[0]);
  const turns = verts.map((v, i) => {
    const hIn = i === 0 ? ha : dirTo(verts[i - 1], v);
    const hOut = i === verts.length - 1 ? hb : dirTo(v, verts[i + 1]);
    return wrapPi(hOut - hIn);
  });
  if (turns.some((t) => Math.abs(t) > (172 * Math.PI) / 180)) return null; // doubling straight back on itself
  // (A waypoint's own radius, if it has one: the vertices of a lead and the oval's ends have none.)
  const own = (i: number) => opts.radii?.[i - 1];
  // (A vertex's least radius, if it has one: a corner taken at a speed it is designed for, never tightened past it.)
  const floor = (i: number) => opts.floors?.[i] ?? MIN_RADIUS;
  const corners: CornerSpec[] = turns.map((t, i) => {
    const radius = Math.max(floor(i), own(i) ?? preferredRadius(rng, t) * scale, width * 1.2);
    return { angle: t, radius, ease: easeFor(radius, t) };
  });
  // Leaving a turn into the infield means turning tighter than it, the same way (and joining one, likewise).
  const tighter = (c: CornerSpec, k: number) => Math.sign(c.angle) === Math.sign(k) && 1 / c.radius > Math.abs(k) * 1.15;
  if (inTurnA && !tighter(corners[0], kA)) return null;
  if (inTurnB && !tighter(corners[corners.length - 1], kB)) return null;
  // Straights between corners (and from an end on a straight to its first corner), first guesses from the vertices.
  const span = (c: CornerSpec) => tangentLength(c);
  const edges: number[] = [];
  if (!inTurnA) edges.push(lead[0] - span(corners[0]));
  for (let i = 0; i + 1 < verts.length; i++) {
    const len = Math.hypot(verts[i + 1][0] - verts[i][0], verts[i + 1][1] - verts[i][1]);
    edges.push(len - (i === 0 && inTurnA ? 2 * span(corners[0]) : span(corners[i])) - (i + 1 === verts.length - 1 && inTurnB ? 2 * span(corners[i + 1]) : span(corners[i + 1])));
  }
  if (!inTurnB) edges.push(lead[1] - span(corners[corners.length - 1]));
  // Tighten corners where a straight comes out too short.
  for (let pass = 0; pass < 12 && edges.some((l) => l < MIN_STRAIGHT); pass++) {
    edges.forEach((l, i) => {
      if (l >= MIN_STRAIGHT) return;
      const ci = inTurnA ? [i, i + 1] : [i - 1, i];
      for (const k of ci) {
        const c = corners[k];
        if (!c) continue;
        const was = span(c);
        c.radius = Math.max(floor(k), c.radius * 0.8);
        c.ease = easeFor(c.radius, c.angle);
        edges[i] += was - span(c);
      }
    });
  }
  if (edges.some((l) => l < MIN_STRAIGHT * 0.5)) return null;
  if (inTurnA && !tighter(corners[0], kA)) return null;
  if (inTurnB && !tighter(corners[corners.length - 1], kB)) return null;
  const parts = corners.map((c, i) => cornerFrom(c, i === 0 && inTurnA ? kA : 0, i === corners.length - 1 && inTurnB ? kB : 0));
  if (parts.some((p) => !p)) return null;
  const build = () => {
    const out: Array<[number, number, number]> = [];
    let e = 0;
    if (!inTurnA) out.push([edges[e++], 0, 0]);
    parts.forEach((p, i) => {
      out.push(...p!);
      if (i + 1 < parts.length) out.push([edges[e++], 0, 0]);
    });
    if (!inTurnB) out.push([edges[e++], 0, 0]);
    return out;
  };
  // Headings the straights run at: after each corner (the lead-in straight at the start's).
  const headings: number[] = [];
  let h = ha;
  if (!inTurnA) headings.push(h);
  corners.forEach((c, i) => {
    h += c.angle;
    if (i + 1 < corners.length || !inTurnB) headings.push(h);
  });
  // The guesses are close, not exact: land the end on the oval by the smallest change to the straights.
  for (let iter = 0; iter < 4; iter++) {
    const { end } = integrate(build(), ax, ay, ha);
    const r = [bx - end.x, by - end.y];
    if (Math.hypot(r[0], r[1]) < 0.02) break;
    let a = 0, b = 0, c = 0;
    edges.forEach((l, i) => {
      const ux = Math.cos(headings[i]), uy = Math.sin(headings[i]), w = Math.max(l, 1);
      a += w * ux * ux; b += w * ux * uy; c += w * uy * uy;
    });
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-9) return null;
    const lx = (c * r[0] - b * r[1]) / det, ly = (a * r[1] - b * r[0]) / det;
    edges.forEach((l, i) => { edges[i] = l + Math.max(l, 1) * (Math.cos(headings[i]) * lx + Math.sin(headings[i]) * ly); });
    if (edges.some((l) => l < MIN_STRAIGHT * 0.5)) return null;
  }
  const sections = build();
  const { end } = integrate(sections, ax, ay, ha);
  if (Math.hypot(bx - end.x, by - end.y) > 0.1 || Math.abs(wrapPi(end.h - hb)) > 1e-6) return null;
  return sections;
}

/**
 * A bus-stop chicane off a straight into the infield: left, right, straight,
 * right, left, back onto the same line. Symmetric, so it ends on the oval's
 * line, parallel to it; returns its sections and how far along the straight
 * it rejoins.
 */
export function chicane(rng: Rng, offset: number, width: number): { sections: Array<[number, number, number]>; length: number } {
  const pick = ([a, b]: [number, number]) => a + rng.next() * (b - a);
  const angle = (pick([35, 55]) * Math.PI) / 180;
  const radius = Math.max(MIN_RADIUS, width * 1.4, pick([16, 28]));
  const ease = easeFor(radius, angle);
  const left: CornerSpec = { angle, radius, ease }, right: CornerSpec = { angle: -angle, radius, ease };
  // How far across one corner takes the line, then the straight between a pair that makes up the offset.
  const one = integrate(cornerSections(left), 0, 0, 0).end;
  const across = Math.max(MIN_STRAIGHT, (offset - 2 * one.y) / Math.sin(angle));
  const mid = pick([25, 60]);
  const sections: Array<[number, number, number]> = [
    ...cornerSections(left), [across, 0, 0], ...cornerSections(right), [mid, 0, 0],
    ...cornerSections(right), [across, 0, 0], ...cornerSections(left),
  ];
  const { end } = integrate(sections, 0, 0, 0);
  return { sections, length: end.x };
}

// ---------- slicing ----------

/** The part of a closed lap's sections between s0 and s1 (0 <= s0 <= s1 <= lap length). */
export function sliceSections(sections: Array<[number, number, number]>, s0: number, s1: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  let acc = 0;
  for (const [len, k0, k1] of sections) {
    const a = Math.max(s0, acc), b = Math.min(s1, acc + len);
    if (b - a > 1e-9) {
      const k = (s: number) => k0 + ((k1 - k0) * (s - acc)) / len;
      out.push([b - a, k(a), k(b)]);
    }
    acc += len;
  }
  return out;
}
