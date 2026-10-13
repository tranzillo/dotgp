/// <reference lib="webworker" />
import { PHYSICS as P } from '../sim/constants';
import type { EventProgress, FromEvent, ToEvent } from './protocol';
import type { StrokeCollector } from '../render/marks';
import { Classroom } from '../school/classroom';
import { Session, type RadioLine, type SessionSnapshot } from './session';

/** Hosts one event (a session or a driving-school class): steps it and streams it to the page (see protocol.ts). */

/** What an event worker can host. */
interface Hosted {
  step(): void;
  readonly finished: boolean;
  readonly time: number;
  snapshot(): SessionSnapshot;
  takeRadio(): RadioLine[];
  readonly strokes: StrokeCollector;
  collectStrokes: boolean;
}

const FRAME_MS = 16;
/** Most steps per frame when watched (64x at 120 Hz is ~128 per 16 ms frame). */
const MAX_STEPS_PER_FRAME = 4000;
/** Detached, run in slices this long (ms) between yields, so messages get through. */
const SLICE_MS = 40;
const PROGRESS_MS = 500;

let session: Hosted | null = null;
let classroom: Classroom | null = null;
let attached = false;
let speed = 1;
let runDetached = true;
let lastReal = 0;
let simDebt = 0;
let lastProgress = 0;
let finishedSent = false;

const post = (msg: FromEvent, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<ToEvent>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'start':
      if (msg.event.what === 'session') {
        const s = new Session(msg.event.spec);
        if (msg.warm > 0) s.advance(msg.warm);
        session = s;
      } else {
        classroom = new Classroom(msg.event.spec);
        session = classroom;
      }
      runDetached = msg.runDetached;
      speed = msg.speed;
      setAttached(msg.attached);
      loop();
      break;
    case 'attach':
      speed = msg.speed;
      setAttached(true);
      break;
    case 'detach':
      setAttached(false);
      break;
    case 'speed':
      speed = msg.speed;
      break;
    case 'drivers':
      if (session instanceof Session) for (const u of msg.updates) session.updateDriver(u.id, u.weights);
      break;
  }
};

function setAttached(on: boolean): void {
  if (!session) return;
  attached = on;
  session.collectStrokes = on;
  session.strokes.reset();
  lastReal = performance.now();
  simDebt = 0;
}

/** Driving school: a new track goes to the page, finished rounds' results too. */
function classNews(): void {
  if (!classroom) return;
  if (classroom.trackChanged) {
    classroom.trackChanged = false;
    post({ type: 'track', layout: classroom.track.layout });
  }
  const reports = classroom.takeReports();
  if (reports.length) post({ type: 'rounds', reports }, reports.map((r) => r.weights.buffer));
}

function loop(): void {
  const s = session;
  if (!s) return;
  const now = performance.now();
  classNews();
  if (attached) {
    // Real time x speed, at most a frame's budget of steps.
    simDebt += Math.min(0.1, (now - lastReal) / 1000) * speed;
    lastReal = now;
    let steps = 0;
    while (simDebt >= P.DT && steps < MAX_STEPS_PER_FRAME) {
      s.step();
      simDebt -= P.DT;
      steps++;
      if (classroom?.trackChanged) break; // send the new track before frames on it
    }
    if (steps === MAX_STEPS_PER_FRAME) simDebt = 0;
    const strokes = s.strokes.drain();
    post({ type: 'frame', snapshot: s.snapshot(), strokes, radio: s.takeRadio() }, [strokes.buffer]);
    reportFinish(s);
    setTimeout(loop, FRAME_MS);
    return;
  }
  if (runDetached && !s.finished) {
    // Flat out, in slices.
    const until = now + SLICE_MS;
    while (performance.now() < until && !s.finished && !classroom?.trackChanged) s.step();
  }
  if (performance.now() - lastProgress > PROGRESS_MS) {
    lastProgress = performance.now();
    post({ type: 'progress', progress: progress(s), radio: s.takeRadio() });
  }
  reportFinish(s);
  setTimeout(loop, runDetached && !s.finished ? 0 : 100);
}

function reportFinish(s: Hosted): void {
  if (!s.finished || finishedSent) return;
  finishedSent = true;
  classNews();
  post({ type: 'finished', results: s instanceof Session ? s.results() : [], snapshot: s.snapshot() });
}

function progress(s: Hosted): EventProgress {
  const snap = s.snapshot();
  const leader = snap.cars.find((c) => c.id === snap.order[0]);
  return {
    time: s.time,
    lap: snap.race && leader ? Math.min(snap.race.laps, leader.laps + 1) : null,
    laps: snap.race?.laps ?? null,
    flag: snap.race ? (snap.race.state === 'green' ? (snap.race.started ? snap.race.flag : 'pace') : snap.race.state) : null,
    leaderKey: leader?.key ?? null,
    round: snap.school ? snap.school.round + 1 : null,
  };
}
