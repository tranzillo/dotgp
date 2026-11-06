import type { SessionSnapshot } from '../events/session';
import type { Tape } from '../events/tape';
import type { Track } from '../sim/track';
import { between, type PlaybackView } from './playback';

/**
 * Watching from tape: a playhead (sim time) anywhere on an event's tape,
 * moved by the viewer at any speed, either way. Draws the cars between the
 * two frames either side of it, the same way live playback does, so a
 * replay looks like the race did.
 */
export class Replay {
  /** The playhead (sim s). */
  time: number;
  /** Decoded frames, by index (the two either side of the playhead, and a few recent). */
  private readonly cache = new Map<number, SessionSnapshot>();

  constructor(readonly tape: Tape, private readonly track: Track) {
    this.time = this.end;
  }

  /** The first and last moments on tape. */
  get start(): number {
    return this.tape.timeAt(this.tape.first);
  }

  get end(): number {
    return this.tape.timeAt(this.tape.end - 1);
  }

  /** Move the playhead (kept on the tape). */
  seek(t: number): void {
    this.time = Math.max(this.start, Math.min(this.end, t));
  }

  /** The frame at or before the playhead. */
  get index(): number {
    return this.tape.indexAt(this.time);
  }

  frame(i: number): SessionSnapshot {
    let f = this.cache.get(i);
    if (!f) {
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      f = this.tape.frame(i, this.track);
      this.cache.set(i, f);
    }
    return f;
  }

  /** What's on screen at the playhead: the cars and officials in between frames, and the frame for the tower and HUD. */
  view(): PlaybackView & { snap: SessionSnapshot } {
    const i = this.index;
    const a = this.frame(i);
    const b = i + 1 < this.tape.end ? this.frame(i + 1) : a;
    return { ...between(this.track, a, b, this.time), snap: a };
  }

  /**
   * The first moment at which `position` (monotone along the tape, e.g. the
   * leader's share of the race distance) reaches p.
   */
  timeWhere(p: number, position: (frame: SessionSnapshot) => number): number {
    let lo = this.tape.first, hi = this.tape.end - 1;
    if (hi < lo) return this.time;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (position(this.frame(mid)) >= p) hi = mid;
      else lo = mid + 1;
    }
    return this.tape.timeAt(lo);
  }
}
