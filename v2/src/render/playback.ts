import type { CarView, SessionSnapshot } from '../events/session';
import type { Track } from '../sim/track';
import type { RenderOfficials } from './view';

/**
 * Smooth playback of an event's frames.
 *
 * The worker sends a snapshot every ~16 ms of real time, each one speed x that
 * much sim time on from the last; the screen draws on its own clock. Drawing
 * the newest snapshot as it stands shows the beat between the two clocks (a
 * frame shown twice, the next one skipped) and, at 64x, a slideshow of jumps.
 * Instead the viewer plays its own sim clock a little behind the newest
 * snapshot, running at the rate snapshots are actually arriving, and draws
 * each car between the two snapshots either side of it. The in-between is
 * taken along the track (s, d), so a car between frames 100 m apart follows
 * the corner rather than cutting across the infield.
 */

interface Frame {
  snap: SessionSnapshot;
  /** Real time it arrived (ms). */
  arrived: number;
}

export interface PlaybackView {
  cars: CarView[];
  officials: RenderOfficials;
}

/** Snapshots kept to measure the arrival rate over (and to play between). */
const HISTORY = 12;
/** Play this many snapshot gaps behind the newest, to ride out uneven arrivals. */
const DELAY_GAPS = 2;
/** The clock eases back onto its target over about this long (s). */
const EASE_S = 0.25;
/** Further than this many gaps off target (a stall, a hidden tab), jump rather than ease. */
const JUMP_GAPS = 8;

export class Playback {
  private frames: Frame[] = [];
  /** Tire marks waiting for the clock to reach the snapshot they came with. */
  private strokes: Array<{ time: number; strokes: Float32Array }> = [];
  /** The sim time on screen. */
  private clock = NaN;
  private lastTick = NaN;
  /** The speed asked for, and snapshots arrived since: the rate until enough have come in to measure it. */
  private speed = 1;
  private sinceSpeed = 0;

  reset(): void {
    this.frames = [];
    this.strokes = [];
    this.clock = NaN;
    this.lastTick = NaN;
    this.sinceSpeed = 0;
  }

  /** The viewing speed changed (0 = paused): arrivals from before say nothing about the new rate. */
  setSpeed(speed: number): void {
    this.speed = speed;
    this.sinceSpeed = 0;
  }

  get empty(): boolean {
    return this.frames.length === 0;
  }

  /** The sim time on screen (NaN before the first tick). */
  get time(): number {
    return this.clock;
  }

  push(snap: SessionSnapshot, strokes: Float32Array, now = performance.now()): void {
    const last = this.frames[this.frames.length - 1];
    if (last && snap.time < last.snap.time) {
      // Time went backwards (a new event in this worker): start over, but keep the marks.
      const marks = this.strokes;
      this.reset();
      this.strokes = marks.map((m) => ({ ...m, time: -Infinity }));
    }
    if (strokes.length) this.strokes.push({ time: snap.time, strokes });
    if (last && snap.time === last.snap.time) last.snap = snap; // no step since the last one
    else {
      this.frames.push({ snap, arrived: now });
      this.sinceSpeed++;
    }
    if (this.frames.length > HISTORY) this.frames.shift();
  }

  /** Sim seconds between snapshots, and sim seconds per real second, over the history. */
  private arrivals(): { gap: number; rate: number } {
    const f = this.frames;
    const first = f[0], last = f[f.length - 1];
    if (f.length < 2) return { gap: 0, rate: this.speed };
    const sim = last.snap.time - first.snap.time;
    const gap = sim / (f.length - 1);
    // Since the speed changed: measured once a few snapshots are in, the asked-for speed until then.
    const n = Math.min(f.length, this.sinceSpeed);
    if (n < 4) return { gap, rate: this.speed };
    const from = f[f.length - n];
    const real = (last.arrived - from.arrived) / 1000;
    return { gap, rate: real > 0 ? (last.snap.time - from.snap.time) / real : this.speed };
  }

  /**
   * Move the clock on to this screen frame. Returns the cars and officials as
   * they were at the clock, and the tire marks laid by then (to stamp).
   */
  tick(track: Track, now = performance.now()): PlaybackView & { strokes: Float32Array[] } {
    const f = this.frames;
    const newest = f[f.length - 1].snap;
    const { gap, rate } = this.arrivals();
    const target = newest.time - DELAY_GAPS * gap;
    const dt = Number.isNaN(this.lastTick) ? 0 : Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (Number.isNaN(this.clock) || Math.abs(target - this.clock) > JUMP_GAPS * gap) this.clock = target;
    else {
      this.clock += dt * rate;
      this.clock += (target - this.clock) * (1 - Math.exp(-dt / EASE_S));
    }
    this.clock = Math.max(f[0].snap.time, Math.min(newest.time, this.clock));

    // The snapshots either side of the clock (b is the first at or after it).
    let i = f.findIndex((fr) => fr.snap.time >= this.clock);
    if (i < 0) i = f.length - 1;
    const b = f[i].snap;
    const a = i > 0 ? f[i - 1].snap : b;

    const due: Float32Array[] = [];
    while (this.strokes.length && this.strokes[0].time <= this.clock) due.push(this.strokes.shift()!.strokes);
    return { ...between(track, a, b, this.clock), strokes: due };
  }

  /** Forget marks waiting to be stamped (a replay has redrawn the marks up to here). */
  dropStrokes(): void {
    this.strokes = [];
  }
}

/** The cars and officials at sim time `time`, between snapshots a and b (a.time <= time <= b.time). */
export function between(track: Track, a: SessionSnapshot, b: SessionSnapshot, time: number): PlaybackView {
  const t = b.time > a.time ? Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time))) : 1;
  const span = b.time - a.time;
  const before = new Map(a.cars.map((c) => [c.id, c]));
  const cars = b.cars.map((cb) => {
    const ca = before.get(cb.id);
    return ca && t < 1 ? carBetween(track, ca, cb, t, span) : cb;
  });
  const ra = a.race, rb = b.race;
  const paceCar = rb?.paceCar && ra?.paceCar && t < 1 ? { ...rb.paceCar, ...pointBetween(track, ra.paceCar, rb.paceCar, t) } : rb?.paceCar ?? null;
  const wreckers = (rb?.wreckers ?? []).map((w, k) => {
    const wa = ra?.wreckers.length === rb?.wreckers.length ? ra?.wreckers[k] : undefined;
    return wa && t < 1 ? { ...w, ...pointBetween(track, wa, w, t) } : w;
  });
  return { cars, officials: { paceCar, wreckers } };
}

/** Fraction t of the way from a to b along the track: exact at both ends, following the curve between. */
function alongTrack(
  track: Track, a: { x: number; y: number; s: number; d: number }, b: { x: number; y: number; s: number; d: number }, t: number,
): [number, number, number] {
  const L = track.length;
  let ds = b.s - a.s;
  ds -= L * Math.round(ds / L);
  const s = track.wrapS(a.s + ds * t);
  const [x, y] = track.toWorld(s, a.d + (b.d - a.d) * t);
  // Whatever the track frame doesn't capture, shifted over from a's to b's.
  const [ax, ay] = track.toWorld(a.s, a.d);
  const [bx, by] = track.toWorld(b.s, b.d);
  return [x + (a.x - ax) * (1 - t) + (b.x - bx) * t, y + (a.y - ay) * (1 - t) + (b.y - by) * t, s];
}

function carBetween(track: Track, a: CarView, b: CarView, t: number, span: number): CarView {
  // Moved further than it could drive (reset to the grid, a new round): no in-between.
  const reach = Math.max(a.speed, b.speed) * span * 1.5 + 5;
  if (Math.hypot(b.x - a.x, b.y - a.y) > reach) return b;
  const [x, y, s] = alongTrack(track, a, b, t);
  let fx = a.frameX + (b.frameX - a.frameX) * t;
  let fy = a.frameY + (b.frameY - a.frameY) * t;
  const m = Math.hypot(fx, fy);
  if (m > 1e-6) { fx /= m; fy /= m; } else { fx = b.frameX; fy = b.frameY; }
  return {
    ...b, x, y, s, d: a.d + (b.d - a.d) * t,
    dist: a.dist + (b.dist - a.dist) * t,
    speed: a.speed + (b.speed - a.speed) * t,
    frameX: fx, frameY: fy,
  };
}

/** Officials have no track frame of their own: find theirs. */
function pointBetween(track: Track, a: { x: number; y: number }, b: { x: number; y: number }, t: number): { x: number; y: number } {
  if (Math.hypot(b.x - a.x, b.y - a.y) > track.length / 4) return b;
  const pa = track.project(a.x, a.y), pb = track.project(b.x, b.y, pa.idx);
  const [x, y] = alongTrack(track, { ...a, s: pa.s, d: pa.d }, { ...b, s: pb.s, d: pb.d }, t);
  return { x, y };
}
