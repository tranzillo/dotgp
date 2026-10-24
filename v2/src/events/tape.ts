import { PHYSICS as P } from '../sim/constants';
import type { Surface } from '../sim/layout';
import type { Flag } from '../sim/raceControl';
import type { Track } from '../sim/track';
import type { QualifyingView } from '../sim/qualifying';
import type { CarView, RaceView, SessionSnapshot, StandingView } from './session';

/**
 * A session on tape: what the viewer draws, 10 times a sim second, packed
 * small enough to keep a whole race (rewind, replays).
 *
 * Every frame is the same size (a header, the running order, then one fixed
 * record per car), so frame i is found by arithmetic: seeking is instant.
 * Frames live in chunks of CHUNK_FRAMES; open sessions, which never end,
 * drop their oldest chunks past a cap.
 *
 * What goes in is a SessionSnapshot and what comes out is one (without the
 * technique histograms, which are live only), so the viewer draws a frame
 * from tape exactly as it draws one streamed live. Positions, distance and
 * times are kept at full float precision; the rest is scaled into small
 * integers at well under what the eye could tell apart.
 */

export const TAPE_HZ = 10;
/** Physics steps between frames. */
export const TAPE_STEPS = Math.round(1 / (TAPE_HZ * P.DT));
/** Frames per chunk (30 s of sim time). */
export const CHUNK_FRAMES = 300;
/** Open sessions keep this much of the latest (frames: 30 min). */
export const OPEN_SESSION_FRAMES = 30 * 60 * TAPE_HZ;

/** What doesn't change over a tape: which tape of its event, who's on it, and the race distance. */
export interface TapeHeader {
  /** 0 for a session; a class tapes each round (the round + 1). */
  id: number;
  cars: Array<{ id: number; key: number; color: string; variant?: boolean }>;
  /** Races: laps. */
  laps: number | null;
}

/** Frames from index `first` on, packed (what the worker sends the page; what a stored replay holds). */
export interface TapeSegment {
  header: TapeHeader;
  first: number;
  count: number;
  bytes: ArrayBuffer;
}

const SURFACES: Surface[] = ['track', 'apron', 'pit', 'garage', 'road', 'grass', 'kerb', 'runoff', 'gravel'];
const PIT_PHASES: Array<CarView['pitPhase']> = ['none', 'in', 'service', 'out'];
const PENALTIES: Array<CarView['penalty']> = [null, 'drive-through', 'stop-go'];
const STATUSES: Array<StandingView['status']> = ['running', 'finished', 'out', 'pit'];
const FLAGS: Flag[] = ['pace', 'restart', 'green', 'caution', 'formation', 'grid'];
const STATES: Array<RaceView['state']> = ['green', 'checkered', 'finished'];
const WRECKER_PHASES = ['drive', 'hook', 'tow', 'done'];
const MAX_WRECKERS = 4;
/** No mark across a jump this long between frames (m): a car put back on track, not driving. */
const STROKE_TELEPORT = 30;

// Frame header: time, race state, pace car, wreckers.
const H_TIME = 0, H_BITS = 8, H_STATE = 9, H_FLAG = 10, H_LIGHTS = 11, H_PACE = 12, H_NWRECK = 20, H_WRECK = 21;
const WRECK_BYTES = 9;
const HEADER_BYTES = H_WRECK + MAX_WRECKERS * WRECK_BYTES; // 57
const BIT_RACE = 1, BIT_STARTED = 2, BIT_ONE_TO_GO = 4, BIT_PACING = 8, BIT_SAFETY = 16, BIT_PACE_CAR = 32, BIT_STANDINGS = 64, BIT_QUALI = 128;
/**
 * Qualifying (never in a race) reuses the race's header fields: round, rounds,
 * phase (and format), the round's clock, progress (x 10^4, so storage keeps
 * it fine), and the cut.
 */
const Q_ROUND = H_STATE, Q_ROUNDS = H_FLAG, Q_PHASE = H_LIGHTS, Q_CLOCK = H_PACE, Q_PROGRESS = H_PACE + 4, Q_CUT = H_NWRECK;
const Q_PHASES: Array<QualifyingView['phase']> = ['pits', 'green', 'checkered', 'finished'];
const Q_GROUP = 0x80;

// Car record.
const C_X = 0, C_Y = 4, C_S = 8, C_D = 12, C_DIST = 16, C_SPEED = 20, C_BEST = 24, C_STIME = 28;
const C_HEADING = 32, C_TLON = 34, C_TLAT = 36, C_BANK = 38, C_BANKACC = 40, C_NORMAL = 42, C_CAP = 44, C_FUEL = 46;
const C_LAPS = 48, C_SLAPS = 50;
const C_INX = 52, C_INY = 53, C_TUSE = 54, C_GROOVE = 55, C_SKID = 56, C_TLIFE = 57, C_HEALTH = 58, C_PTIMER = 59;
const C_STOPS = 60, C_SURFACE = 61, C_FLAGS = 62, C_ENUMS = 63, C_TPEN = 64;
export const CAR_BYTES = 66;
const F_RETIRED = 1, F_CLEARED = 2, F_TOWED = 4, F_PARKED = 8, F_FINISHED = 16, F_DQ = 32;

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
const u8 = (v: number, scale: number) => clampInt(v * scale, 0, 255);
const i8 = (v: number, scale: number) => clampInt(v * scale, -127, 127);
const i16 = (v: number, scale: number) => clampInt(v * scale, -32767, 32767);
const u16 = (v: number, scale: number) => clampInt(v * scale, 0, 65535);

export const frameBytes = (cars: number) => HEADER_BYTES + cars + cars * CAR_BYTES;

/**
 * One field of a frame, for storage (tapeCodec.ts): where it is, its type,
 * how finely it's kept (floats as round(v * scale); whole numbers as
 * round(v / scale) when scale > 1, coarser than in memory), and how smooth
 * it runs (order 2: positions and times, which change at a near steady
 * rate; 1: everything else, which mostly holds still).
 */
export interface FrameField {
  at: number;
  type: 'f64' | 'f32' | 'i16' | 'u16' | 'i8' | 'u8';
  scale: number;
  order: 1 | 2;
}

/** Every field of a frame with this many cars, in storage order. */
export function frameFields(cars: number): FrameField[] {
  const f = (at: number, type: FrameField['type'], scale = 1, order: 1 | 2 = 1): FrameField => ({ at, type, scale, order });
  const out: FrameField[] = [
    f(H_TIME, 'f64', 1e4, 2), f(H_BITS, 'u8'), f(H_STATE, 'u8'), f(H_FLAG, 'u8'), f(H_LIGHTS, 'u8'),
    f(H_PACE, 'f32', 100, 2), f(H_PACE + 4, 'f32', 100, 2), f(H_NWRECK, 'u8'),
  ];
  for (let k = 0; k < MAX_WRECKERS; k++) {
    const o = H_WRECK + k * WRECK_BYTES;
    out.push(f(o, 'f32', 100), f(o + 4, 'f32', 100), f(o + 8, 'u8'));
  }
  for (let p = 0; p < cars; p++) out.push(f(HEADER_BYTES + p, 'u8'));
  const car: Array<[number, FrameField['type'], number, 1 | 2]> = [
    [C_X, 'f32', 100, 2], [C_Y, 'f32', 100, 2], [C_S, 'f32', 100, 2], [C_D, 'f32', 100, 2], [C_DIST, 'f32', 100, 2],
    // Kept coarser than in memory, still finer than anything shows: speed to 0.1 m/s, heading to a
    // thousandth of a radian, tire and banking forces to 0.1 m/s², fuel to 10 g.
    [C_SPEED, 'f32', 10, 1], [C_BEST, 'f32', 1000, 1], [C_STIME, 'f32', 1000, 1],
    [C_HEADING, 'i16', 10, 1], [C_TLON, 'i16', 10, 1], [C_TLAT, 'i16', 10, 1], [C_BANK, 'i16', 10, 1], [C_BANKACC, 'i16', 10, 1],
    [C_NORMAL, 'i16', 10, 1], [C_CAP, 'i16', 10, 1], [C_FUEL, 'u16', 10, 1], [C_LAPS, 'u16', 1, 1], [C_SLAPS, 'u16', 1, 1],
    [C_INX, 'i8', 1, 1], [C_INY, 'i8', 1, 1], [C_TUSE, 'u8', 1, 1], [C_GROOVE, 'u8', 1, 1], [C_SKID, 'u8', 1, 1],
    [C_TLIFE, 'u8', 1, 1], [C_HEALTH, 'u8', 1, 1], [C_PTIMER, 'u8', 1, 1], [C_STOPS, 'u8', 1, 1], [C_SURFACE, 'u8', 1, 1],
    [C_FLAGS, 'u8', 1, 1], [C_ENUMS, 'u8', 1, 1], [C_TPEN, 'u8', 1, 1],
  ];
  // Field by field, car by car: each car's run of a field is one smooth series.
  for (const [at, type, scale, order] of car) {
    for (let slot = 0; slot < cars; slot++) out.push(f(HEADER_BYTES + cars + slot * CAR_BYTES + at, type, scale, order));
  }
  return out;
}

/** Pack a snapshot into frame `view` (its cars in the header's order). */
function encode(snap: SessionSnapshot, header: TapeHeader, index: Map<number, number>, v: DataView, at: number): void {
  const n = header.cars.length;
  v.setFloat64(at + H_TIME, snap.time, true);
  const r = snap.race;
  let bits = 0;
  if (r) {
    bits |= BIT_RACE | (r.started ? BIT_STARTED : 0) | (r.oneToGo ? BIT_ONE_TO_GO : 0) | (r.pacing ? BIT_PACING : 0)
      | (r.safetyCar ? BIT_SAFETY : 0) | (r.paceCar ? BIT_PACE_CAR : 0);
    v.setUint8(at + H_STATE, STATES.indexOf(r.state));
    v.setUint8(at + H_FLAG, FLAGS.indexOf(r.flag));
    v.setUint8(at + H_LIGHTS, r.lights);
    v.setFloat32(at + H_PACE, r.paceCar?.x ?? 0, true);
    v.setFloat32(at + H_PACE + 4, r.paceCar?.y ?? 0, true);
    const wreckers = r.wreckers.slice(0, MAX_WRECKERS);
    v.setUint8(at + H_NWRECK, wreckers.length);
    wreckers.forEach((w, k) => {
      const o = at + H_WRECK + k * WRECK_BYTES;
      v.setFloat32(o, w.x, true);
      v.setFloat32(o + 4, w.y, true);
      v.setUint8(o + 8, Math.max(0, WRECKER_PHASES.indexOf(w.phase)));
    });
  }
  const q = snap.qualifying;
  if (q && !r) {
    bits |= BIT_QUALI;
    v.setUint8(at + Q_ROUND, q.round);
    v.setUint8(at + Q_ROUNDS, q.rounds);
    v.setUint8(at + Q_PHASE, Q_PHASES.indexOf(q.phase) | (q.format === 'group' ? Q_GROUP : 0));
    v.setFloat32(at + Q_CLOCK, q.clock, true);
    v.setFloat32(at + Q_PROGRESS, q.progress * 1e4, true);
    v.setUint8(at + Q_CUT, q.cut);
  }
  if (snap.standings) bits |= BIT_STANDINGS;
  v.setUint8(at + H_BITS, bits);

  // Running order, as car slots (of the cars on tape).
  const orderAt = at + HEADER_BYTES;
  snap.order.filter((id) => index.has(id)).forEach((id, p) => { if (p < n) v.setUint8(orderAt + p, index.get(id)!); });

  const standing = new Map(snap.standings?.map((st) => [st.id, st]) ?? []);
  for (const car of snap.cars) {
    const slot = index.get(car.id);
    if (slot === undefined) continue;
    const o = orderAt + n + slot * CAR_BYTES;
    const st = standing.get(car.id);
    v.setFloat32(o + C_X, car.x, true);
    v.setFloat32(o + C_Y, car.y, true);
    v.setFloat32(o + C_S, car.s, true);
    v.setFloat32(o + C_D, car.d, true);
    v.setFloat32(o + C_DIST, car.dist, true);
    v.setFloat32(o + C_SPEED, car.speed, true);
    v.setFloat32(o + C_BEST, car.bestLap ?? NaN, true);
    v.setFloat32(o + C_STIME, st?.time ?? NaN, true);
    v.setInt16(o + C_HEADING, i16(Math.atan2(car.frameY, car.frameX), 10000), true);
    v.setInt16(o + C_TLON, i16(car.tireLon, 100), true);
    v.setInt16(o + C_TLAT, i16(car.tireLat, 100), true);
    v.setInt16(o + C_BANK, i16(car.bank, 10000), true);
    v.setInt16(o + C_BANKACC, i16(car.bankAcc, 100), true);
    v.setInt16(o + C_NORMAL, i16(car.normalAcc, 100), true);
    v.setInt16(o + C_CAP, i16(car.capacity, 100), true);
    v.setUint16(o + C_FUEL, u16(car.fuel, 1000), true);
    v.setUint16(o + C_LAPS, u16(car.laps, 1), true);
    v.setUint16(o + C_SLAPS, u16(st?.laps ?? 0, 1), true);
    v.setInt8(o + C_INX, i8(car.inputX, 127));
    v.setInt8(o + C_INY, i8(car.inputY, 127));
    v.setUint8(o + C_TUSE, u8(car.tireUse, 100));
    v.setUint8(o + C_GROOVE, u8(car.groove, 255));
    v.setUint8(o + C_SKID, u8(car.skid, 255));
    v.setUint8(o + C_TLIFE, u8(car.tireLife, 255));
    v.setUint8(o + C_HEALTH, u8(car.health, 255));
    v.setUint8(o + C_PTIMER, u8(car.pitTimer, 4));
    v.setUint8(o + C_STOPS, u8(car.stops, 1));
    v.setUint8(o + C_SURFACE, Math.max(0, SURFACES.indexOf(car.surface)));
    v.setUint8(o + C_FLAGS, (car.retired ? F_RETIRED : 0) | (car.cleared ? F_CLEARED : 0) | (car.towed ? F_TOWED : 0)
      | (car.parked ? F_PARKED : 0) | (car.finished ? F_FINISHED : 0) | (car.disqualified ? F_DQ : 0));
    v.setUint8(o + C_ENUMS, PIT_PHASES.indexOf(car.pitPhase) | (PENALTIES.indexOf(car.penalty) << 2)
      | (Math.max(0, STATUSES.indexOf(st?.status ?? 'running')) << 4));
    v.setUint8(o + C_TPEN, u8(car.timePenalty, 1));
  }
}

/** Unpack frame bytes into the snapshot the viewer draws (trackIdx from the track, if given). */
function decode(header: TapeHeader, v: DataView, at: number, track?: Track): SessionSnapshot {
  const n = header.cars.length;
  const bits = v.getUint8(at + H_BITS);
  const orderAt = at + HEADER_BYTES;
  const cars: CarView[] = header.cars.map((hc, slot) => {
    const o = orderAt + n + slot * CAR_BYTES;
    const heading = v.getInt16(o + C_HEADING, true) / 10000;
    const flags = v.getUint8(o + C_FLAGS), enums = v.getUint8(o + C_ENUMS);
    const s = v.getFloat32(o + C_S, true);
    const best = v.getFloat32(o + C_BEST, true);
    return {
      id: hc.id, key: hc.key, ...(hc.variant ? { variant: true } : {}), color: hc.color,
      x: v.getFloat32(o + C_X, true), y: v.getFloat32(o + C_Y, true), s, d: v.getFloat32(o + C_D, true),
      dist: v.getFloat32(o + C_DIST, true), speed: v.getFloat32(o + C_SPEED, true),
      retired: !!(flags & F_RETIRED), cleared: !!(flags & F_CLEARED), towed: !!(flags & F_TOWED),
      parked: !!(flags & F_PARKED), finished: !!(flags & F_FINISHED),
      inputX: v.getInt8(o + C_INX) / 127, inputY: v.getInt8(o + C_INY) / 127,
      frameX: Math.cos(heading), frameY: Math.sin(heading), trackIdx: track ? track.indexAt(s) : 0,
      tireLon: v.getInt16(o + C_TLON, true) / 100, tireLat: v.getInt16(o + C_TLAT, true) / 100,
      tireUse: v.getUint8(o + C_TUSE) / 100, capacity: v.getInt16(o + C_CAP, true) / 100,
      bank: v.getInt16(o + C_BANK, true) / 10000, bankAcc: v.getInt16(o + C_BANKACC, true) / 100,
      normalAcc: v.getInt16(o + C_NORMAL, true) / 100,
      surface: SURFACES[v.getUint8(o + C_SURFACE)] ?? 'track',
      groove: v.getUint8(o + C_GROOVE) / 255, skid: v.getUint8(o + C_SKID) / 255,
      tireLife: v.getUint8(o + C_TLIFE) / 255, fuel: v.getUint16(o + C_FUEL, true) / 1000, health: v.getUint8(o + C_HEALTH) / 255,
      pitPhase: PIT_PHASES[enums & 3], pitTimer: v.getUint8(o + C_PTIMER) / 4, stops: v.getUint8(o + C_STOPS),
      laps: v.getUint16(o + C_LAPS, true), bestLap: Number.isNaN(best) ? null : best,
      penalty: PENALTIES[(enums >> 2) & 3] ?? null, timePenalty: v.getUint8(o + C_TPEN), disqualified: !!(flags & F_DQ),
    };
  });
  const order = Array.from({ length: n }, (_, p) => header.cars[v.getUint8(orderAt + p)].id);
  const standings: StandingView[] | null = bits & BIT_STANDINGS
    ? order.map((id, p) => {
      const slot = header.cars.findIndex((c) => c.id === id);
      const o = orderAt + n + slot * CAR_BYTES;
      return {
        id, position: p + 1, laps: v.getUint16(o + C_SLAPS, true), time: v.getFloat32(o + C_STIME, true),
        status: STATUSES[(v.getUint8(o + C_ENUMS) >> 4) & 3],
      };
    })
    : null;
  let race: RaceView | null = null;
  if (bits & BIT_RACE) {
    const nw = v.getUint8(at + H_NWRECK);
    race = {
      laps: header.laps ?? 0,
      state: STATES[v.getUint8(at + H_STATE)],
      started: !!(bits & BIT_STARTED),
      flag: FLAGS[v.getUint8(at + H_FLAG)],
      oneToGo: !!(bits & BIT_ONE_TO_GO),
      pacing: !!(bits & BIT_PACING),
      lights: v.getUint8(at + H_LIGHTS),
      safetyCar: !!(bits & BIT_SAFETY),
      paceCar: bits & BIT_PACE_CAR ? { x: v.getFloat32(at + H_PACE, true), y: v.getFloat32(at + H_PACE + 4, true) } : null,
      wreckers: Array.from({ length: nw }, (_, k) => {
        const o = at + H_WRECK + k * WRECK_BYTES;
        return { x: v.getFloat32(o, true), y: v.getFloat32(o + 4, true), phase: WRECKER_PHASES[v.getUint8(o + 8)] };
      }),
    };
  }
  let qualifying: QualifyingView | undefined;
  if (bits & BIT_QUALI) {
    const phase = v.getUint8(at + Q_PHASE);
    qualifying = {
      format: phase & Q_GROUP ? 'group' : 'solo', phase: Q_PHASES[phase & 3],
      round: v.getUint8(at + Q_ROUND), rounds: v.getUint8(at + Q_ROUNDS),
      clock: v.getFloat32(at + Q_CLOCK, true), progress: v.getFloat32(at + Q_PROGRESS, true) / 1e4, cut: v.getUint8(at + Q_CUT),
    };
  }
  return { time: v.getFloat64(at + H_TIME, true), cars, order, standings, race, technique: [], ...(qualifying ? { qualifying } : {}) };
}

/**
 * Frames in chunks. The worker records into one; the page keeps a copy
 * (appending what the worker sends), and reads frames back out of it.
 */
export class Tape {
  readonly header: TapeHeader;
  readonly frameBytes: number;
  /** Index of the oldest frame kept (open sessions drop old chunks). */
  first = 0;
  /** Frames recorded (counting dropped ones): the next frame's index. */
  end = 0;
  private chunks: ArrayBuffer[] = [];
  private readonly index: Map<number, number>;

  constructor(header: TapeHeader, private readonly maxFrames = Infinity) {
    this.header = header;
    this.frameBytes = frameBytes(header.cars.length);
    this.index = new Map(header.cars.map((c, k) => [c.id, k]));
  }

  get length(): number {
    return this.end - this.first;
  }

  /** Bytes held. */
  get bytes(): number {
    return this.chunks.length * CHUNK_FRAMES * this.frameBytes;
  }

  /** Where frame i lives: its chunk (relative to the first kept) and offset. */
  private locate(i: number): [DataView, number] {
    const firstChunk = Math.floor(this.first / CHUNK_FRAMES);
    const c = Math.floor(i / CHUNK_FRAMES) - firstChunk;
    while (c >= this.chunks.length) this.chunks.push(new ArrayBuffer(CHUNK_FRAMES * this.frameBytes));
    return [new DataView(this.chunks[c]), (i % CHUNK_FRAMES) * this.frameBytes];
  }

  record(snap: SessionSnapshot): void {
    const [v, at] = this.locate(this.end);
    encode(snap, this.header, this.index, v, at);
    this.end++;
    this.trim();
  }

  /** Frames from another copy of this tape (index `from` on). Earlier frames are overwritten; a gap restarts the tape. */
  append(from: number, count: number, bytes: ArrayBuffer): void {
    if (from > this.end || from + count <= this.first) {
      this.chunks = [];
      this.first = this.end = from;
    }
    const src = new Uint8Array(bytes);
    for (let k = 0; k < count; k++) {
      const i = from + k;
      if (i < this.first) continue;
      const [v, at] = this.locate(i);
      new Uint8Array(v.buffer, at, this.frameBytes).set(src.subarray(k * this.frameBytes, (k + 1) * this.frameBytes));
      this.end = Math.max(this.end, i + 1);
    }
    this.trim();
  }

  /** Frames `from` on, copied out (to send). */
  segment(from = this.first): TapeSegment {
    from = Math.max(from, this.first);
    const count = Math.max(0, this.end - from);
    const out = new Uint8Array(count * this.frameBytes);
    for (let k = 0; k < count; k++) {
      const [v, at] = this.locate(from + k);
      out.set(new Uint8Array(v.buffer, at, this.frameBytes), k * this.frameBytes);
    }
    return { header: this.header, first: from, count, bytes: out.buffer };
  }

  static from(seg: TapeSegment): Tape {
    const tape = new Tape(seg.header);
    tape.append(seg.first, seg.count, seg.bytes);
    return tape;
  }

  timeAt(i: number): number {
    const [v, at] = this.locate(i);
    return v.getFloat64(at + H_TIME, true);
  }

  frame(i: number, track?: Track): SessionSnapshot {
    const [v, at] = this.locate(i);
    return decode(this.header, v, at, track);
  }

  /** The last frame at or before sim time t (the first kept, if t is earlier). */
  indexAt(t: number): number {
    let lo = this.first, hi = this.end - 1;
    if (hi < lo || this.timeAt(lo) >= t) return lo;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.timeAt(mid) <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Tire-mark strokes for frames (from, to]: each car from where it was a
   * frame before, marked as it was at the frame (the same strokes the live
   * collector lays, a tenth of a second long instead of half a metre).
   */
  strokes(from: number, to: number): Float32Array {
    from = Math.max(from, this.first);
    to = Math.min(to, this.end - 1);
    const n = this.header.cars.length;
    const out: number[] = [];
    for (let i = from + 1; i <= to; i++) {
      const [pv, pat] = this.locate(i - 1);
      const [v, at] = this.locate(i);
      for (let slot = 0; slot < n; slot++) {
        const po = pat + HEADER_BYTES + n + slot * CAR_BYTES, o = at + HEADER_BYTES + n + slot * CAR_BYTES;
        const x0 = pv.getFloat32(po + C_X, true), y0 = pv.getFloat32(po + C_Y, true);
        const x1 = v.getFloat32(o + C_X, true), y1 = v.getFloat32(o + C_Y, true);
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 0.05 || len > STROKE_TELEPORT) continue;
        // A stroke here stands for len / 0.5 of the live collector's: as likely to lay rubber as they all were.
        const groove = Math.min(1, (v.getUint8(o + C_GROOVE) / 255) * (len / 0.5));
        const skid = v.getUint8(o + C_SKID) / 255;
        if (groove <= 0 && skid < 0.02) continue;
        const surface = SURFACES[v.getUint8(o + C_SURFACE)];
        out.push(x0, y0, x1, y1, groove, skid, surface === 'grass' ? 1 : surface === 'gravel' ? 2 : 0);
      }
    }
    return Float32Array.from(out);
  }

  /** Open sessions: drop whole chunks older than the cap. */
  private trim(): void {
    while (this.end - this.first > this.maxFrames + CHUNK_FRAMES) {
      const chunkStart = this.first - (this.first % CHUNK_FRAMES);
      this.chunks.shift();
      this.first = chunkStart + CHUNK_FRAMES;
    }
  }
}
