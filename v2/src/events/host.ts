import type { EventRef } from '../records/activity';
import type { RoundReport, RoundTape } from '../school/classroom';
import type { TrackLayout } from '../sim/layout';
import type { EventProgress, EventSpec, FromEvent, ToEvent } from './protocol';
import type { EntrantResult, LearnedStep, RadioLine, SessionSnapshot, TimelineEvent } from './session';
import type { EventRef as Ref } from '../records/activity';
import { Tape } from './tape';

/**
 * The page's side of events. Each event runs in its own worker; at most one
 * is attached (on screen) at a time and the rest run in the background. The
 * viewer listens for frames from the attached event; anyone can listen for
 * progress and results.
 */
export interface EventHandle {
  ref: EventRef;
  /** What it runs (null for a saved replay, which only has its tape). */
  event: EventSpec | null;
  /** On screen. */
  attachedTo: boolean;
  state: 'running' | 'finished' | 'stopped';
  snapshot: SessionSnapshot | null;
  progress: EventProgress | null;
  results: EntrantResult[] | null;
  /** What has happened so far (complete while attached, and once finished). */
  timeline: TimelineEvent[];
  /** The event on tape, as far as the page has it (complete while attached, and once finished). Classes: the round under way. */
  tape: Tape | null;
  /** Classes: rounds kept on tape (watched, or a license earned). */
  roundTapes: RoundTape[];
  /** Races keep running when nobody watches; open sessions pause. */
  runDetached: boolean;
  /** Its worker is running (so it can be watched live, not only from tape). */
  alive: boolean;
  /** Why the event stopped, if its worker failed. */
  error?: string;
  worker: Worker | null;
}

export interface HostListener {
  /** A frame from the attached event. */
  frame(handle: EventHandle, snapshot: SessionSnapshot, strokes: Float32Array, radio: RadioLine[]): void;
  /** Progress (and radio) from a background event. */
  progress(handle: EventHandle, radio: RadioLine[]): void;
  finished(handle: EventHandle): void;
  /** The event moved to another track. */
  track(handle: EventHandle, layout: TrackLayout): void;
  /** Driving-school rounds ended. */
  rounds(handle: EventHandle, reports: RoundReport[]): void;
  /** Driving-school rounds kept on tape (watched, or a license earned). */
  roundTapes(handle: EventHandle, tapes: RoundTape[]): void;
  /** Drivers learned while racing. */
  learned(handle: EventHandle, steps: LearnedStep[]): void;
}

export class EventHost {
  readonly events: EventHandle[] = [];
  private speed = 1;

  constructor(private readonly listener: HostListener) {}

  get attached(): EventHandle | null {
    return this.events.find((h) => h.attachedTo) ?? null;
  }

  get running(): EventHandle[] {
    return this.events.filter((h) => h.state === 'running');
  }

  start(ref: EventRef, event: EventSpec, opts: { attach: boolean; runDetached: boolean; warm?: number }): EventHandle {
    if (opts.attach) this.detachAll();
    const worker = new Worker(new URL('./event.worker.ts', import.meta.url), { type: 'module' });
    const handle: EventHandle = {
      ref, event, attachedTo: opts.attach, state: 'running', snapshot: null, progress: null, results: null, timeline: [], tape: null, roundTapes: [], alive: true,
      runDetached: opts.runDetached, worker,
    };
    worker.onmessage = (e: MessageEvent<FromEvent>) => this.receive(handle, e.data);
    worker.onerror = (e) => {
      // A crashed event stops (and says why) rather than sitting there looking busy.
      handle.error = e.message || 'worker error';
      handle.state = 'stopped';
      handle.alive = false;
      handle.attachedTo = false;
      console.error(`event ${handle.ref.label} failed:`, e.message);
    };
    this.events.push(handle);
    this.send(handle, { type: 'start', event, attached: opts.attach, speed: this.speed, runDetached: opts.runDetached, warm: opts.warm ?? 0 });
    return handle;
  }

  /** Put an event on screen (the one there goes to the background). */
  attach(handle: EventHandle): void {
    if (handle.attachedTo || handle.state === 'stopped') return;
    this.detachAll();
    handle.attachedTo = true;
    this.send(handle, { type: 'attach', speed: this.speed });
  }

  /** Send the on-screen event to the background. */
  detach(handle: EventHandle): void {
    if (!handle.attachedTo) return;
    handle.attachedTo = false;
    this.send(handle, { type: 'detach' });
  }

  /** Viewing speed for the attached event. */
  setSpeed(speed: number): void {
    this.speed = speed;
    const h = this.attached;
    if (h) this.send(h, { type: 'speed', speed });
  }

  /** Run the attached event on by this much sim time (stepping while paused). */
  step(seconds: number): void {
    const h = this.attached;
    if (h) this.send(h, { type: 'step', seconds });
  }

  /** A saved replay, as an event: finished, on tape, nothing running. */
  open(ref: Ref, tape: Tape, timeline: TimelineEvent[], results: EntrantResult[] | null): EventHandle {
    const handle: EventHandle = {
      ref, event: null, attachedTo: false, state: 'finished', snapshot: tape.frame(tape.end - 1), progress: null, results,
      timeline, tape, roundTapes: [], runDetached: false, alive: false, worker: null,
    };
    this.events.push(handle);
    return handle;
  }

  /** End an event now (its worker goes away; finished events keep their results). */
  stop(handle: EventHandle): void {
    handle.worker?.terminate();
    handle.alive = false;
    handle.attachedTo = false;
    if (handle.state === 'running') handle.state = 'stopped';
  }

  /** Forget finished and stopped events. */
  prune(): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].state !== 'running') this.events.splice(i, 1);
    }
  }

  /** New weights for drivers in an event (practice made them better). */
  updateDrivers(handle: EventHandle, updates: Array<{ id: string; weights: Float32Array }>): void {
    if (handle.state === 'running') this.send(handle, { type: 'drivers', updates });
  }

  private detachAll(): void {
    for (const h of this.events) this.detach(h);
  }

  private send(handle: EventHandle, msg: ToEvent): void {
    handle.worker?.postMessage(msg);
  }

  private receive(handle: EventHandle, msg: FromEvent): void {
    if (handle.state === 'stopped') return;
    switch (msg.type) {
      case 'frame':
        handle.snapshot = msg.snapshot;
        handle.timeline.length = Math.min(handle.timeline.length, msg.timeline.from);
        handle.timeline.push(...msg.timeline.events);
        if (msg.tape) {
          if (handle.tape?.header.id !== msg.tape.header.id) handle.tape = new Tape(msg.tape.header);
          handle.tape.append(msg.tape.first, msg.tape.count, msg.tape.bytes);
        }
        if (handle.attachedTo) this.listener.frame(handle, msg.snapshot, msg.strokes, msg.radio);
        break;
      case 'progress':
        handle.progress = msg.progress;
        this.listener.progress(handle, msg.radio);
        break;
      case 'finished':
        handle.snapshot = msg.snapshot;
        handle.results = msg.results;
        handle.timeline = msg.timeline;
        if (msg.tape) handle.tape = Tape.from(msg.tape);
        handle.state = 'finished';
        this.listener.finished(handle);
        // A watched race keeps circulating for the cool-down lap; otherwise the worker can go.
        if (!handle.attachedTo) {
          handle.worker?.terminate();
          handle.alive = false;
        }
        break;
      case 'track':
        this.listener.track(handle, msg.layout);
        break;
      case 'rounds':
        handle.roundTapes.push(...msg.tapes);
        if (msg.reports.length) this.listener.rounds(handle, msg.reports);
        if (msg.tapes.length) this.listener.roundTapes(handle, msg.tapes);
        break;
      case 'learned':
        this.listener.learned(handle, msg.steps);
        break;
    }
  }
}
