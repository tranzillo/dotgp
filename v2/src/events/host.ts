import type { EventRef } from '../records/activity';
import type { EventProgress, FromEvent, ToEvent } from './protocol';
import type { EntrantResult, RadioLine, SessionSnapshot, SessionSpec } from './session';

/**
 * The page's side of events. Each event runs in its own worker; at most one
 * is attached (on screen) at a time and the rest run in the background. The
 * viewer listens for frames from the attached event; anyone can listen for
 * progress and results.
 */
export interface EventHandle {
  ref: EventRef;
  spec: SessionSpec;
  /** Whatever the starter wants to keep with the event (e.g. team ids by entrant key). */
  attachedTo: boolean;
  state: 'running' | 'finished' | 'stopped';
  snapshot: SessionSnapshot | null;
  progress: EventProgress | null;
  results: EntrantResult[] | null;
  /** Races keep running when nobody watches; open sessions pause. */
  runDetached: boolean;
  worker: Worker;
}

export interface HostListener {
  /** A frame from the attached event. */
  frame(handle: EventHandle, snapshot: SessionSnapshot, strokes: Float32Array, radio: RadioLine[]): void;
  /** Progress (and radio) from a background event. */
  progress(handle: EventHandle, radio: RadioLine[]): void;
  finished(handle: EventHandle): void;
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

  start(ref: EventRef, spec: SessionSpec, opts: { attach: boolean; runDetached: boolean; warm?: number }): EventHandle {
    if (opts.attach) this.detachAll();
    const worker = new Worker(new URL('./event.worker.ts', import.meta.url), { type: 'module' });
    const handle: EventHandle = {
      ref, spec, attachedTo: opts.attach, state: 'running', snapshot: null, progress: null, results: null,
      runDetached: opts.runDetached, worker,
    };
    worker.onmessage = (e: MessageEvent<FromEvent>) => this.receive(handle, e.data);
    this.events.push(handle);
    this.send(handle, { type: 'start', spec, attached: opts.attach, speed: this.speed, runDetached: opts.runDetached, warm: opts.warm ?? 0 });
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

  /** End an event now (its worker goes away; finished events keep their results). */
  stop(handle: EventHandle): void {
    handle.worker.terminate();
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
    handle.worker.postMessage(msg);
  }

  private receive(handle: EventHandle, msg: FromEvent): void {
    if (handle.state === 'stopped') return;
    switch (msg.type) {
      case 'frame':
        handle.snapshot = msg.snapshot;
        if (handle.attachedTo) this.listener.frame(handle, msg.snapshot, msg.strokes, msg.radio);
        break;
      case 'progress':
        handle.progress = msg.progress;
        this.listener.progress(handle, msg.radio);
        break;
      case 'finished':
        handle.snapshot = msg.snapshot;
        handle.results = msg.results;
        handle.state = 'finished';
        this.listener.finished(handle);
        // A watched race keeps circulating for the cool-down lap; otherwise the worker can go.
        if (!handle.attachedTo) handle.worker.terminate();
        break;
    }
  }
}
