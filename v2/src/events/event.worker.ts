/// <reference lib="webworker" />
import { PHYSICS as P } from '../sim/constants';
import type { EventProgress, FromEvent, ToEvent } from './protocol';
import type { StrokeCollector } from '../render/marks';
import { Classroom } from '../school/classroom';
import { Session, type RadioLine, type SessionSnapshot, type TimelineEvent } from './session';
import type { Tape } from './tape';

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
  /** What happened, in order (sessions; classes have none yet). */
  readonly timeline?: TimelineEvent[];
  /** The event on tape (sessions; classes have none yet). */
  readonly tape?: Tape;
}

/** Watched, a frame goes to the page this often (ms), on a steady beat (the page plays between frames). */
const FRAME_MS = 1000 / 60;
/**
 * Watched, step for at most this long (ms) per frame. A field too heavy to
 * run at the asked speed then runs as fast as it can, still at full frame
 * rate, instead of falling behind and catching up in ever bigger lumps.
 */
const STEP_BUDGET_MS = 12;
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
/** Watched: when the next frame is due, and timeline events the page has. */
let nextFrame = 0;
let timelineSent = 0;
/** Watched: the tape being sent (a class starts a new one each round) and its next frame to send. */
let tapeSending: Tape | null = null;
let tapeSent = 0;
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
        classroom.startTaping();
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
    case 'step':
      if (attached) simDebt += msg.seconds;
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
  nextFrame = lastReal;
  timelineSent = 0; // a page that (re)attaches gets the whole timeline, and the tape
  tapeSent = 0;
}

/** Driving school: a new track goes to the page, finished rounds' results too. */
function classNews(): void {
  if (!classroom) return;
  if (classroom.trackChanged) {
    classroom.trackChanged = false;
    post({ type: 'track', layout: classroom.track.layout });
  }
  const reports = classroom.takeReports(), tapes = classroom.takeTapes();
  if (reports.length || tapes.length) {
    post({ type: 'rounds', reports, tapes }, [...reports.map((r) => r.weights.buffer), ...tapes.map((t) => t.tape.bytes)]);
  }
}

/** Races: learning steps drivers took go to the page as they happen. */
function learnedNews(): void {
  if (!(session instanceof Session)) return;
  const steps = session.takeLearned();
  if (steps.length) post({ type: 'learned', steps }, steps.map((st) => st.weights.buffer));
}

function loop(): void {
  const s = session;
  if (!s) return;
  const now = performance.now();
  classNews();
  learnedNews();
  if (attached) {
    // Real time x speed, as much of it as the step budget allows.
    simDebt += Math.min(0.1, (now - lastReal) / 1000) * speed;
    lastReal = now;
    const until = now + STEP_BUDGET_MS;
    while (simDebt >= P.DT) {
      s.step();
      simDebt -= P.DT;
      if (classroom?.trackChanged) break; // send the new track before frames on it
      if (performance.now() > until) { simDebt = 0; break; } // can't keep up: drop the rest
    }
    const strokes = s.strokes.drain();
    const timeline = s.timeline ?? [];
    const news = { from: timelineSent, events: timeline.slice(timelineSent) };
    timelineSent = timeline.length;
    if (s.tape !== tapeSending) {
      tapeSending = s.tape ?? null;
      tapeSent = 0;
    }
    const tape = s.tape ? s.tape.segment(tapeSent) : null;
    if (tape && s.tape) tapeSent = s.tape.end;
    post({ type: 'frame', snapshot: s.snapshot(), strokes, radio: s.takeRadio(), timeline: news, tape },
      tape ? [strokes.buffer, tape.bytes] : [strokes.buffer]);
    reportFinish(s);
    // On the beat, not a frame after this one finished; a beat already missed starts a new one.
    const after = performance.now();
    nextFrame = Math.max(nextFrame + FRAME_MS, after);
    setTimeout(loop, nextFrame - after);
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
  learnedNews();
  const tape = s.tape?.segment() ?? null;
  post({ type: 'finished', results: s instanceof Session ? s.results() : [], snapshot: s.snapshot(), timeline: s.timeline ?? [], tape },
    tape ? [tape.bytes] : []);
  if (s.tape) tapeSent = s.tape.end;
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
    // Standings without a race: qualifying.
    runs: !snap.race && snap.standings
      ? { done: snap.standings.filter((st) => st.status === 'finished' || st.status === 'out').length, total: snap.standings.length }
      : null,
    qualifying: snap.qualifying ?? null,
  };
}
