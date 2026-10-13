import type { ClassSpec, RoundReport } from '../school/classroom';
import type { TrackLayout } from '../sim/layout';
import type { EntrantResult, RadioLine, SessionSnapshot, SessionSpec } from './session';

/** What an event runs: a session on track, or a driving-school class. */
export type EventSpec = { what: 'session'; spec: SessionSpec } | { what: 'class'; spec: ClassSpec };

/**
 * Messages between the page and an event worker. One worker hosts one event.
 *
 * Attached (on screen), the event runs in real time x the viewing speed and
 * streams a snapshot every frame, with the tire-mark strokes laid since the
 * last one. Detached, it either runs flat out (races: a result is a result,
 * watched or not) or idles (open sessions, which exist to be watched; their
 * learning happens in the trainer), and reports progress a couple of times
 * a second.
 */
export type ToEvent =
  | { type: 'start'; event: EventSpec; attached: boolean; speed: number; runDetached: boolean; warm: number }
  | { type: 'attach'; speed: number }
  | { type: 'detach' }
  | { type: 'speed'; speed: number }
  | { type: 'drivers'; updates: Array<{ id: string; weights: Float32Array }> };

export interface EventProgress {
  time: number;
  /** Leader's lap, race distance (races). */
  lap: number | null;
  laps: number | null;
  flag: string | null;
  leaderKey: number | null;
  /** Classes: the round under way. */
  round: number | null;
}

export type FromEvent =
  | { type: 'frame'; snapshot: SessionSnapshot; strokes: Float32Array; radio: RadioLine[] }
  | { type: 'progress'; progress: EventProgress; radio: RadioLine[] }
  | { type: 'finished'; results: EntrantResult[]; snapshot: SessionSnapshot }
  /** The event moved to another track (driving school rotates tracks between rounds). */
  | { type: 'track'; layout: TrackLayout }
  /** A driving-school round ended: each student's result and improved weights. */
  | { type: 'rounds'; reports: RoundReport[] };
