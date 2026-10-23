import type { ClassSpec, RoundReport, RoundTape } from '../school/classroom';
import type { TrackLayout } from '../sim/layout';
import type { QualifyingView } from '../sim/qualifying';
import type { EntrantResult, LearnedStep, RadioLine, SessionSnapshot, SessionSpec, TimelineEvent } from './session';
import type { TapeSegment } from './tape';

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
  /** experiment: the page's experiment switches (sim/experiment.ts), to apply before anything is built. */
  | { type: 'start'; event: EventSpec; attached: boolean; speed: number; runDetached: boolean; warm: number; experiment?: string }
  | { type: 'attach'; speed: number }
  | { type: 'detach' }
  | { type: 'speed'; speed: number }
  /** Run this much sim time now, whatever the speed (stepping while paused). */
  | { type: 'step'; seconds: number }
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
  /** Qualifying: cars that have run, of the field (solo); where the session is. */
  runs: { done: number; total: number } | null;
  qualifying: QualifyingView | null;
}

/** Timeline events from index `from` on (everything from 0 after an attach). */
export interface TimelineNews {
  from: number;
  events: TimelineEvent[];
}

export type FromEvent =
  | { type: 'frame'; snapshot: SessionSnapshot; strokes: Float32Array; radio: RadioLine[]; timeline: TimelineNews; tape: TapeSegment | null }
  | { type: 'progress'; progress: EventProgress; radio: RadioLine[] }
  | { type: 'finished'; results: EntrantResult[]; snapshot: SessionSnapshot; timeline: TimelineEvent[]; tape: TapeSegment | null }
  /** The event moved to another track (driving school rotates tracks between rounds). */
  | { type: 'track'; layout: TrackLayout }
  /** Driving-school rounds ended: each student's result and improved weights, and the rounds kept on tape. */
  | { type: 'rounds'; reports: RoundReport[]; tapes: RoundTape[] }
  /** Drivers learned while racing. */
  | { type: 'learned'; steps: LearnedStep[] };
