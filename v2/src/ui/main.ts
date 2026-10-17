import type { PracticeRequest, PracticeRound } from '../ai/practice.worker';
import { Rng } from '../ai/rng';
import { EventHost, type EventHandle } from '../events/host';
import type { CarView, EntrantResult, EntrantSpec, RadioLine as SessionRadio, SessionSnapshot, SessionSpec, TimelineEvent } from '../events/session';
import { injuryFrom } from '../events/injury';
import { OFFENCE_NAMES } from '../rules/rulebook';
import { PENALTY_NAMES } from '../rules/desk';
import { LESSONS, type ClassSpec, type LessonId, type RoundReport, type RoundTape } from '../school/classroom';
import { ActivityLog, MemoryActivityStore, type AgentRole, type EventRef } from '../records/activity';
import { IndexedDbActivityStore } from '../records/idbStore';
import { Occupancy } from '../records/occupancy';
import type { Livery } from '../render/livery';
import { Playback } from '../render/playback';
import { Replay } from '../render/replay';
import { Tape, TAPE_HZ, type TapeSegment } from '../events/tape';
import { packTape, unpackTape } from '../events/tapeCodec';
import { enforceCap, IndexedDbReplayStore, MemoryReplayStore, type ReplayMeta, type ReplayStore } from '../records/replayStore';
import { Renderer, type DebugLayers, type DotMode, type RenderCar, type RenderOfficials } from '../render/renderer';
import { SIGNATURE_BINS } from '../sim/car';
import { G, PHYSICS as P } from '../sim/constants';
import { Track } from '../sim/track';
import { generateTrack, PRESETS, presetLayout, presetTrack } from '../trackgen';
import { AgentPage } from './agentPage';
import { Roster, type Role, type TeamEntry } from './roster';
import {
  driverStandings, newSeason, nextTrack, offSeason, pointsFor, recordRace, seasonComplete, type SeasonState,
} from './season';

/**
 * The viewer. Sessions run as events in workers (events/); this page decides
 * what to run, shows whichever event is attached, keeps the roster, the
 * season and the records, and runs practice training.
 */

// ---------- Roster ----------

const STORAGE_KEY = 'dotgp.v2.roster.v3';
const FIELD_SIZES = [4, 8, 12, 16, 24, 32, 40];

const rng = new Rng((Math.random() * 2 ** 32) >>> 0);
let roster = new Roster(rng);

/**
 * Whose drivers are on screen: your own roster (it grows, learns, races the
 * championship, and is saved), or a bundle shipped with the game, exactly as
 * Claude's tests race it (read-only: no learning, classes or points).
 */
interface Bundle { id: string; name: string; file: string; note: string }
let bundles: Bundle[] = [{ id: 'house', name: 'House', file: 'default.json', note: 'The house drivers.' }];
/** 'mine', or a bundle id. */
let source = 'mine';
/** Your roster, kept aside while a bundle is on screen. */
let myRoster: Roster | null = null;
const bundleDrivers = new Map<string, Array<{ weights: number[]; rounds?: number; nerve?: number; cautionLicensed?: boolean }>>();
const readOnly = () => source !== 'mine';
const bundleOf = (id: string) => bundles.find((b) => b.id === id);
let fieldSize = 8;
const field = () => roster.teams.slice(0, fieldSize);

// ---------- Records: who is where, and everything they do ----------

/** The permanent activity log (IndexedDB; in memory where that's unavailable). */
const activity = new ActivityLog(typeof indexedDB !== 'undefined' ? new IndexedDbActivityStore() : new MemoryActivityStore());
/** Which event each agent is in: an agent is in at most one at a time. */
const occupancy = new Occupancy();
let eventCounter = 0;

/** Log every arrival and seat change on the roster. */
function watchRoster(r: Roster): void {
  r.onChange = (c) => {
    if (c.type === 'joined') {
      activity.record({ kind: 'joined', agent: c.agent, role: c.role, data: { name: c.name, origin: c.origin, mentor: c.mentor } });
    } else {
      activity.record({ kind: 'seat', agent: c.agent, role: c.role, event: fieldEvent?.ref, data: { action: c.action, team: c.team, car: c.car } });
    }
  };
}
watchRoster(roster);

function persist(): void {
  if (readOnly()) return; // a bundle is never saved over your roster
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fieldSize, roster: roster.toJSON(), season }));
  } catch { /* storage unavailable: the roster just won't survive a reload */ }
}

function loadPersisted(templates: Float32Array[]): Roster | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.fieldSize === 'number') fieldSize = data.fieldSize;
    if (data.season?.schedule) season = data.season;
    return Roster.load(data.roster, rng, templates);
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url);
    return res.ok && res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  } catch {
    return null;
  }
}

// ---------- Session settings ----------

/** Tracks by name: the presets (the season's calendar), plus any generated this session. */
const TRACKS = new Map<string, Track>(Object.keys(PRESETS).map((id) => [presetTrack(id).name, presetTrack(id)]));
const SEASON_TRACKS = [...TRACKS.keys()];
/** Each track appears this many times per season. */
const ROUNDS_PER_TRACK = 2;
let season: SeasonState = newSeason(SEASON_TRACKS, ROUNDS_PER_TRACK);
/** The track and kind of the next session started (and of the field's current one). */
let trackName = SEASON_TRACKS[0];
let track = TRACKS.get(trackName)!;

/** Generate a track (an oval or a road circuit) and add it to the track list (seed and variant random unless given). */
function addGeneratedTrack(type: 'oval' | 'circuit' = 'oval', seed = Math.floor(Math.random() * 1e9), variant?: string): Track {
  const t = generateTrack({ type, seed, variant });
  const label = `${t.name} (${t.layout.params.variant})`;
  TRACKS.set(label, t);
  trackOptions.push([label, label]);
  return t;
}
const trackOptions: Array<[string, string]> = SEASON_TRACKS.map((k) => [k, k]);
/** race: laps, pits, DNFs. practice: open session, wrecks respawn. ghost: no contact. */
type Mode = 'race' | 'practice' | 'ghost';
let mode: Mode = 'race';
let raceLaps = 50;
/** Race pace: tire wear and fuel burn multiplier. */
let pace = 4;
/** Drivers learn as they race (lap against lap). */
let learnInRaces = true;
/**
 * What happens after a race: another race straight away, a race weekend
 * (practice where drivers and crew chiefs learn, then the next race on the
 * next track), or nothing. A race finishing in the background carries on in
 * the background.
 */
type Loop = 'races' | 'weekend' | 'stop';
let loop: Loop = 'weekend';
/**
 * Whether the field's races are championship rounds (on the calendar's next
 * track) or exhibitions (any track, picked by hand: no points).
 */
let championship = true;
/** Practice rounds (in the trainer) between races in the weekend loop. */
const WEEKEND_PRACTICE_ROUNDS = 9;
let weekendPractice: { roundsLeft: number } | null = null;
const NEXT_RACE_DELAY = 10; // real seconds of results on screen before moving on
let raceDoneAt = NaN;
/** Viewing speed, and paused (the attached event runs at 0 then; the speed is kept for resuming). */
let speed = 1;
let paused = false;
const SPEEDS: Array<[string, number]> = [['0.25×', 0.25], ['0.5×', 0.5], ['1×', 1], ['4×', 4], ['16×', 16], ['64×', 64]];
const speedText = () => (paused ? 'paused' : SPEEDS.find(([, v]) => v === speed)?.[0] ?? `${speed}×`)
  + (replay ? (reverse ? ' backwards · replay' : ' · replay') : '');
let zoom = 1;
let selected: TeamEntry | null = null;
let focus: [number, number] | null = null;

const canvas = document.getElementById('track') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- Events ----------

/** What the page keeps about an event it started. */
interface EventMeta {
  mode: Mode | 'class';
  trackName: string;
  track: Track;
  /** Teams by entrant key (the team id). Empty for classes. */
  teams: Map<number, TeamEntry>;
  recorded: boolean;
  /** Learning steps drivers have taken during this race. */
  learnedSteps?: number;
  /** Driving school: each student's colours and initials, by student key. */
  liveries?: Map<number, Livery>;
  lesson?: LessonId;
  /** A championship round (scores points), not an exhibition. */
  round?: boolean;
}
const metas = new Map<EventHandle, EventMeta>();
/** The event the field is in (on screen or not). */
let fieldEvent: EventHandle | null = null;

/** The attached event's frames, played back smoothly (its marks are stamped as playback reaches them). */
const playback = new Playback();
let playing: EventHandle | null = null;
/**
 * Watching from tape: rewound, or replaying a race that has ended. The event
 * on screen waits (runs at 0) until the playhead is back at live. Null: live.
 */
let replay: Replay | null = null;
/** The replay runs backwards; the timeline is being dragged. */
let reverse = false;
let scrubbing = false;
/** The tape frame at or before the playhead (what the tower and HUD show while replaying). */
let tapeSnap: SessionSnapshot | null = null;
/** Sim time the tire marks on screen run up to; a replay rebuilding them from tape, and the frame it's up to. */
let marksTime = 0;
let marksJob: { next: number } | null = null;

const host = new EventHost({
  frame(handle, snapshot, strokes, radio) {
    if (handle !== playing) { playback.reset(); playing = handle; }
    playback.push(snapshot, strokes);
    addRadio(handle, radio);
  },
  progress() { /* the events panel refreshes on its own timer */ },
  finished(handle) {
    const meta = metas.get(handle)!;
    if (meta.mode === 'class') {
      occupancy.release(handle.ref.id);
      news(`${handle.ref.label}: everyone has a license. Class dismissed.`);
      renderRoster();
      renderSchool();
    }
    if (meta.mode === 'race' && !meta.recorded) {
      finishRace(handle);
      saveRace(handle);
    }
    // Watched: give the result a moment on screen. In the background: straight on.
    if (handle.attachedTo) raceDoneAt = performance.now() / 1000;
    else if (handle === fieldEvent) carryOn(handle);
    renderEvents();
  },
  track(handle, layout) {
    const meta = metas.get(handle)!;
    meta.track = new Track(layout);
    meta.trackName = meta.track.name;
    if (handle.attachedTo) {
      renderer.setTrack(meta.track);
      renderer.clearMarks();
      playback.reset();
      focus = null;
    }
  },
  rounds(handle, reports) {
    lessonRounds(handle, reports);
  },
  roundTapes(handle, tapes) {
    for (const t of tapes) saveRound(handle, t);
  },
  learned(handle, steps) {
    // Drivers learned mid-race: the roster gets their new driving, the log a line each.
    const meta = metas.get(handle);
    if (meta) meta.learnedSteps = (meta.learnedSteps ?? 0) + steps.length;
    for (const st of steps) {
      const d = roster.drivers.get(st.driverId);
      if (!d) continue;
      d.weights.set(st.weights);
      d.rounds++;
      activity.record({
        kind: 'learning', agent: d.id, role: 'driver', event: handle.ref, brain: d.rounds, replay: { id: handle.ref.id, at: st.time },
        data: { source: 'race', track: meta?.trackName ?? '', step: st.steps },
      });
    }
  },
});

/** The event on screen and its latest snapshot. */
const shown = () => host.attached;
const shownMeta = () => { const h = shown(); return h ? metas.get(h) ?? null : null; };
const snap = (): SessionSnapshot | null => tapeSnap ?? shown()?.snapshot ?? null;
const teamOfKey = (key: number) => shownMeta()?.teams.get(key);
const liveryOf = (car: RenderCar) => shownMeta()?.liveries?.get((car as CarView).key) ?? teamOfKey((car as CarView).key)?.livery;
const carOf = (entry: TeamEntry | null, cars = snap()?.cars) => (entry && shownMeta()?.mode !== 'class' ? cars?.find((c) => c.key === entry.id) ?? null : null);
/** Driving school: draw each student's practice variations (faint) too. */
let showVariations = true;

function newEventRef(round: boolean): EventRef {
  const type = mode === 'ghost' ? 'ghost' : mode;
  const label = round
    ? `Season ${season.number} round ${Math.min(season.races.length + 1, season.schedule.length)} · ${trackName}`
    : mode === 'race' ? `Exhibition · ${trackName}`
    : mode === 'practice' ? `Practice · ${trackName}` : `Ghost laps · ${trackName}`;
  return {
    id: `${type}-${Date.now().toString(36)}-${++eventCounter}`, type, label, track: trackName,
    parent: round ? `season-${season.number}` : undefined,
  };
}

/** The championship's next round goes on its calendar track. */
function toNextRound(): void {
  championship = true;
  trackName = nextTrack(season);
  track = TRACKS.get(trackName) ?? TRACKS.get(SEASON_TRACKS[0])!;
}

function entrantSpec(t: TeamEntry): EntrantSpec {
  const driver = roster.driverOf(t), spotter = roster.spotterOf(t), chief = roster.chiefOf(t);
  return {
    key: t.id,
    fill: t.livery.fill,
    number: t.livery.number,
    driver: { id: driver.id, weights: driver.weights, roadWeights: driver.roadCourse?.weights, nerve: driver.nerve, pits: (driver.pitLicensed && driver.pitTrafficLicensed) ?? false, cautions: driver.cautionLicensed ?? false },
    spotter: { id: spotter.id, skill: spotter.skill },
    chief: { id: chief.id, brain: chief.brain },
  };
}

/**
 * Start a session for the field (the field's previous session ends). It
 * claims every agent in the field; if any is busy in another event, nothing
 * starts. Races keep running in the background; open sessions pause there.
 */
function startSession(attach = true, warm = 0): EventHandle | null {
  if (fieldEvent) endEvent(fieldEvent);
  const round = mode === 'race' && championship;
  const ref = newEventRef(round);
  // Injured or retired drivers' seats go to stand-ins; recovered regulars get theirs back.
  for (const line of roster.fillSeats(field(), (id) => occupancy.isFree(id))) news(line);
  const teams = field();
  const conflicts = occupancy.claim(ref, teams.flatMap((t) => [t.driver, t.spotter, t.chief]));
  if (conflicts.length) {
    $('teamsNote').textContent = `Can't start: ${conflicts.length} agents are busy in ${conflicts[0].event.label}.`;
    return null;
  }
  const spec: SessionSpec = {
    kind: mode, layout: track.layout, entrants: teams.map(entrantSpec), laps: raceLaps, pace,
    seed: (rng.next() * 2 ** 32) >>> 0, learn: learnInRaces && !readOnly(),
  };
  const handle = host.start(ref, { what: 'session', spec }, { attach, runDetached: mode === 'race', warm });
  metas.set(handle, { mode, trackName, track, teams: new Map(teams.map((t) => [t.id, t])), recorded: false, round });
  fieldEvent = handle;
  raceDoneAt = NaN;
  if (attach) showEvent(handle);
  renderRoster();
  renderEvents();
  return handle;
}

/** An event is over for the page: its worker stops and its agents are free. */
function endEvent(handle: EventHandle): void {
  host.stop(handle);
  occupancy.release(handle.ref.id);
  if (handle === fieldEvent && metas.get(handle)?.mode === 'practice') {
    weekendPractice = null;
    stopPractice();
  }
}

/** Put an event on screen. */
function showEvent(handle: EventHandle): void {
  host.attach(handle);
  const meta = metas.get(handle)!;
  renderer.setTrack(meta.track);
  renderer.clearMarks();
  playback.reset();
  playing = handle;
  leaveReplay();
  radioFeed.length = 0;
  technique.clear();
  focus = null;
  if (handle.snapshot === null) $('hud').innerHTML = `<b>${meta.trackName}</b> · starting…`;
  // Over, with nothing running: watch it from tape (at the end; scrub or Home to go back).
  if (!handle.alive && handle.tape && handle.tape.length > 1) {
    paused = true;
    toReplay();
  }
}

/** After a race: the next race, or the next weekend, in the background if this one was. */
function carryOn(prev: EventHandle): void {
  const attach = prev.attachedTo;
  raceDoneAt = NaN;
  if (readOnly()) {
    // A bundle doesn't race the championship or practise: another exhibition race where this one was.
    if (loop !== 'stop') { mode = 'race'; startSession(attach); }
  } else if (loop === 'races') {
    mode = 'race';
    toNextRound();
    startSession(attach);
  } else if (loop === 'weekend') {
    startWeekendPractice(attach);
  }
  buttonGroups.forEach((render) => render());
}

// ---------- Team radio ----------

interface RadioLine { time: number; team: TeamEntry | null; text: string }
const radioFeed: RadioLine[] = [];
/** Technique histograms (by team id) from the attached event. */
const technique = new Map<number, number[]>();

function addRadio(handle: EventHandle, lines: SessionRadio[]): void {
  const teams = metas.get(handle)?.teams;
  for (const l of lines) radioFeed.unshift({ time: l.time, team: l.key === null ? null : teams?.get(l.key) ?? null, text: l.text });
  if (radioFeed.length > 2000) radioFeed.length = 2000; // enough to rewind through
}

const news = (text: string) => radioFeed.unshift({ time: snap()?.time ?? 0, team: null, text });
const dotHtml = (l: Livery) => `<span class="dot" style="background:${l.fill};border-color:${l.border}"></span>`;
const carLabel = (t: TeamEntry) => `${dotHtml(t.livery)}#${t.livery.number}`;

function drawRadio(): void {
  const upTo = replay ? replay.time : Infinity; // replaying: what had been said by then
  const lines = radioFeed.filter((l) => l.time <= upTo && (!selected || l.team === selected)).slice(0, 12);
  $('radio').innerHTML = lines.map((l) => {
    const clock = `${Math.floor(l.time / 60)}:${Math.floor(l.time % 60).toString().padStart(2, '0')}`;
    return l.team ? `<div><span class="muted">${clock}</span> ${carLabel(l.team)} ${l.text}</div>`
      : `<div class="news">${l.text}</div>`;
  }).join('') || '<div class="muted">quiet on the radio</div>';
}

// ---------- Main loop: draw whatever is attached ----------

/** ?focusS=<metres from the line> parks the zoomed camera on a spot (e.g. 0 = pit road). */
const fixedFocusS = new URLSearchParams(location.search).get('focusS');

function leaderView(s: SessionSnapshot, cars: CarView[]): CarView | undefined {
  return cars.find((c) => c.id === s.order[0]);
}

/** cars: as drawn this frame (played back between snapshots). */
function updateCamera(s: SessionSnapshot | null, cars: CarView[], t: Track): void {
  if (zoom === 1 || !s) {
    renderer.setView(1, 0, 0);
    return;
  }
  if (fixedFocusS !== null && !selected) {
    const [x, y] = t.toWorld(Number(fixedFocusS), t.innerEdgeAt(Number(fixedFocusS)) + 6);
    renderer.setView(zoom, x, y);
    return;
  }
  const target = carOf(selected, cars) ?? leaderView(s, cars);
  if (!target) return;
  if (!focus) focus = [target.x, target.y];
  focus[0] += (target.x - focus[0]) * 0.2;
  focus[1] += (target.y - focus[1]) * 0.2;
  renderer.setView(zoom, focus[0], focus[1]);
}

let lastFrameAt = NaN;

function frame(): void {
  const now = performance.now();
  const dt = Number.isNaN(lastFrameAt) ? 0 : Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  const h = shown();
  const meta = shownMeta();
  // The tape moved on under the replay (a class's next round): back to live.
  if (replay && replay.tape !== h?.tape) leaveReplay();
  if (h && meta) {
    let cars: CarView[], officials: RenderOfficials | undefined, time: number;
    if (replay) {
      advanceReplay(replay, h, dt);
    }
    if (replay) {
      // From tape, at the playhead.
      const view = replay.view();
      tapeSnap = view.snap;
      cars = view.cars;
      officials = view.officials;
      time = replay.time;
      rebuildMarks(replay);
    } else {
      // Live: between the worker's snapshots where it's streaming; else the last one it sent.
      tapeSnap = null;
      const view = h === playing && !playback.empty ? playback.tick(meta.track) : null;
      for (const strokes of view?.strokes ?? []) renderer.stampStrokes(strokes);
      cars = view?.cars ?? h.snapshot?.cars ?? [];
      officials = view?.officials;
      time = view ? playback.time : h.snapshot?.time ?? 0;
      marksTime = time;
    }
    const s = snap();
    renderer.effectsPaused = !!replay && (reverse || scrubbing);
    updateCamera(s, cars, meta.track);
    renderer.render(showVariations ? cars : cars.filter((c) => !c.variant), liveryOf, carOf(selected, cars), officials ?? {
      paceCar: s?.race?.paceCar ?? null,
      wreckers: s?.race?.wreckers ?? [],
    });
    updateTimeline(s, cars, time, meta.track, h);
    updateMarks(h.timeline, meta, timelineShown.live);
    updateTransport(h);
    // A finished race on screen: after a moment of results, carry on (not while it's being replayed).
    if (h === fieldEvent && !replay && !Number.isNaN(raceDoneAt) && performance.now() / 1000 - raceDoneAt > NEXT_RACE_DELAY) carryOn(h);
  } else {
    renderer.render([], liveryOf);
    updateTimeline(null, [], 0, null, null);
    updateMarks([], null, 0);
    updateTransport(null);
  }
  requestAnimationFrame(frame);
}

// ---------- Replays: watching from tape ----------

/** Watch from tape (at sim time t, or where the view is now). False if there's no tape yet. The event waits meanwhile. */
function toReplay(t?: number): boolean {
  const h = shown(), meta = shownMeta();
  if (!h || !meta || !h.tape || h.tape.length < 2) return false;
  if (!replay || replay.tape !== h.tape) {
    replay = new Replay(h.tape, meta.track);
    replay.seek(h === playing && !playback.empty && !Number.isNaN(playback.time) ? playback.time : replay.end);
  }
  if (t !== undefined) replay.seek(t);
  applySpeed();
  return true;
}

/** Back to live, if the event is still running: the marks catch up to the end of the tape and the event carries on. */
function goLive(): void {
  const h = shown();
  if (!replay || !h?.alive) return;
  if (marksJob) stampTape(replay.tape, replay.tape.end - 1, Infinity);
  playback.dropStrokes(); // already drawn from the tape
  leaveReplay();
}

/** Forget the replay (a new event on screen, or live again). */
function leaveReplay(): void {
  replay = null;
  reverse = false;
  scrubbing = false;
  tapeSnap = null;
  marksJob = null;
  applySpeed();
}

/** Move the playhead on by this much real time; at the end of the tape, live again (or stop, if the event is over). */
function advanceReplay(r: Replay, h: EventHandle, dt: number): void {
  if (paused || scrubbing) return;
  r.seek(r.time + dt * speed * (reverse ? -1 : 1));
  if (!reverse && r.time >= r.end) {
    if (h.alive) goLive();
    else { paused = true; applySpeed(); }
  } else if (reverse && r.time <= r.start) {
    reverse = false;
    paused = true;
    applySpeed();
  }
}

/**
 * Replays: the tire marks as they were at the playhead. Marks showing what
 * hasn't happened yet are wiped and rebuilt from the tape, a few hundred
 * frames per screen frame; playing on, they're laid as the playhead goes.
 * Not while running backwards or scrubbing: once the playhead settles.
 */
function rebuildMarks(r: Replay): void {
  if (scrubbing || reverse) return;
  if (marksTime > r.time + 0.25) {
    renderer.clearMarks();
    marksJob = { next: r.tape.first };
  }
  marksJob ??= { next: r.tape.indexAt(marksTime) };
  stampTape(r.tape, r.index, 6);
}

/** Lay the tape's marks up to frame `to`, for at most this long (ms). */
function stampTape(tape: Tape, to: number, budgetMs: number): void {
  const job = marksJob ?? (marksJob = { next: tape.indexAt(marksTime) });
  const until = performance.now() + budgetMs;
  while (job.next < to && performance.now() < until) {
    const next = Math.min(to, job.next + 100);
    renderer.stampStrokes(tape.strokes(job.next, next));
    job.next = next;
  }
  marksTime = tape.timeAt(job.next);
}

// ---------- Control bar: transport, timeline, speed, camera, display ----------

const clockText = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
/** What the timeline last showed, so the DOM is only touched on a change. */
const timelineShown = { label: '', ticks: '', fill: '', liveFill: '', progress: 0, live: 0 };
/** Driving school: a round's length is the time left when it was first seen. */
let schoolRound = { round: -1, length: 1 };

/**
 * Where a moment sits on the timeline (0..1): races by the leader's share of
 * the distance; classes by the time into the round; open sessions by the time
 * on tape.
 */
function barPosition(s: SessionSnapshot | null, cars: CarView[], time: number, t: Track, h: EventHandle): number {
  const r = s?.race;
  if (s && r) {
    const leader = cars.find((c) => c.id === s.order[0]);
    return r.state !== 'green' ? 1 : r.started && leader ? Math.min(1, (leader.laps + t.wrapS(leader.s) / t.length) / r.laps) : 0;
  }
  const tape = h.tape;
  if (!tape || tape.length < 1) return 0;
  const start = tape.timeAt(tape.first);
  if (metas.get(h)?.mode === 'class') return (time - start) / schoolRound.length;
  const end = tape.timeAt(tape.end - 1);
  return end > start ? (time - start) / (end - start) : 1;
}

/** The timeline: the playhead (as drawn), how far the event has got when rewound, and the lap or round and time. */
function updateTimeline(s: SessionSnapshot | null, cars: CarView[], time: number, t: Track | null, h: EventHandle | null): void {
  let progress = 0, live = 0, label = '', laps = 0;
  const r = s?.race, sc = h?.snapshot?.school;
  if (sc && sc.round !== schoolRound.round) schoolRound = { round: sc.round, length: Math.max(1, sc.remaining) };
  if (s && t && h) {
    progress = barPosition(s, cars, time, t, h);
    live = replay && h.snapshot ? barPosition(h.snapshot, h.snapshot.cars, h.snapshot.time, t, h) : progress;
    if (r) {
      const leader = cars.find((c) => c.id === s.order[0]);
      const lap = leader ? Math.min(r.laps, leader.laps + 1) : 1;
      label = `${!r.started ? 'Start' : r.state !== 'green' ? 'Finish' : `Lap <b>${lap}</b> / ${r.laps}`} · ${clockText(time)}`;
      laps = r.laps;
    } else if (sc) {
      label = `Round <b>${sc.round + 1}</b> · ${clockText(time)}`;
    } else {
      label = `Practice · ${clockText(time)}`;
    }
  }
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  timelineShown.progress = clamp(progress);
  timelineShown.live = clamp(live);
  const fill = `${(timelineShown.progress * 100).toFixed(2)}%`;
  if (fill !== timelineShown.fill) {
    $('tlFill').style.width = timelineShown.fill = fill;
    $('tlHead').style.left = fill;
  }
  const liveFill = replay ? `${(timelineShown.live * 100).toFixed(2)}%` : '0%';
  if (liveFill !== timelineShown.liveFill) $('tlLive').style.width = timelineShown.liveFill = liveFill;
  if (label !== timelineShown.label) $('tlLabel').innerHTML = timelineShown.label = label;
  const tickKey = String(laps);
  if (tickKey !== timelineShown.ticks) {
    timelineShown.ticks = tickKey;
    // Lap marks: every lap on short races, every 5 or 10 on longer ones.
    const every = laps <= 25 ? 1 : laps <= 125 ? 5 : 10;
    const marks: string[] = [];
    for (let lap = every; lap < laps; lap += every) marks.push(`<i style="left:${((lap / laps) * 100).toFixed(3)}%"></i>`);
    $('tlTicks').innerHTML = marks.join('');
  }
}

/**
 * Markers on the timeline: colour, drawn shorter (minor), and rank (events
 * close together share a marker in the top-ranked colour). Cautions also
 * shade the bar until the green.
 */
const MARKS: Partial<Record<TimelineEvent['kind'], { color: string; minor?: boolean; rank: number }>> = {
  caution: { color: '#f5c518', rank: 3 },
  retired: { color: '#ff5a5a', rank: 2 },
  steward: { color: '#ff9f1a', minor: true, rank: 1 },
  lead: { color: '#b9b9c2', minor: true, rank: 0 },
};
/** Events closer than this (share of the race) share a marker. */
const MARK_MERGE = 0.002;
/** The timeline the markers were drawn from, and the caution still out (its shading grows with the race). */
const marksShown: { events: TimelineEvent[] | null; count: number; open: HTMLElement | null; openAt: number } = { events: null, count: 0, open: null, openAt: 0 };

/** Race timelines: a marker per notable event (hover for what happened), and the cautions shaded. */
function updateMarks(events: TimelineEvent[], meta: EventMeta | null, progress: number): void {
  if (events !== marksShown.events || events.length !== marksShown.count) {
    marksShown.events = events;
    marksShown.count = events.length;
    marksShown.open = null;
    const pct = (at: number) => `${(at * 100).toFixed(3)}%`;
    const who = (key: number | null) => {
      const t = key === null ? undefined : meta?.teams.get(key);
      return t ? `#${t.livery.number} ` : '';
    };
    const groups: Array<{ at: number; time: number; style: { color: string; minor?: boolean; rank: number }; minor: boolean; lines: string[] }> = [];
    const spans: string[] = [];
    let cautionAt: number | null = null;
    for (const e of events) {
      if (e.at === undefined) continue; // open sessions: no race distance to place them on
      if (e.kind === 'caution' && cautionAt === null) cautionAt = e.at;
      if ((e.kind === 'green' || e.kind === 'checkered') && cautionAt !== null) {
        spans.push(`<span style="left:${pct(cautionAt)};width:${pct(e.at - cautionAt)}"></span>`);
        cautionAt = null;
      }
      const style = MARKS[e.kind];
      if (!style) continue;
      const line = `Lap ${e.lap} · ${clockText(e.time)} · ${who(e.key)}${e.text}`;
      const last = groups[groups.length - 1];
      if (last && e.at - last.at < MARK_MERGE) {
        last.lines.push(line);
        if (style.rank > last.style.rank) last.style = style;
        last.minor &&= !!style.minor;
      } else groups.push({ at: e.at, time: e.time, style, minor: !!style.minor, lines: [line] });
    }
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const marks = groups.map((g) => `<i class="${g.minor ? 'minor' : ''}" data-t="${g.time}" style="left:${pct(g.at)};--c:${g.style.color}" title="${esc([...g.lines, 'Click to watch'].join('\n'))}"></i>`);
    if (cautionAt !== null) spans.push(`<span data-open style="left:${pct(cautionAt)}"></span>`);
    $('tlMarks').innerHTML = marks.join('');
    $('tlCautions').innerHTML = spans.join('');
    marksShown.open = $('tlCautions').querySelector<HTMLElement>('[data-open]');
    marksShown.openAt = cautionAt ?? 0;
  }
  // A caution still out: shaded up to where the leader is now.
  if (marksShown.open) marksShown.open.style.width = `${(Math.max(0, progress - marksShown.openAt) * 100).toFixed(3)}%`;
}

const PLAY_ICON = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11"/><rect x="9.5" y="2.5" width="3" height="11"/></svg>';

/** Tell the attached event (and playback) the speed it should run at now: none while paused or replaying. */
function applySpeed(): void {
  const run = paused || replay ? 0 : speed;
  host.setSpeed(run);
  playback.setSpeed(run);
  const b = $('playPause');
  b.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
  b.title = paused ? 'Play (Space or K)' : 'Pause (Space or K)';
  b.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  $('reverse').classList.toggle('on', reverse && !paused);
  renderSpeedButtons();
}

/** What the transport last showed. */
let transportShown = '';

/** LIVE (red when live; a way back when rewound; hidden when the event is over), and what can be rewound. */
function updateTransport(h: EventHandle | null): void {
  const canRewind = !!h?.tape && h.tape.length > 1;
  const key = `${!!replay}|${h?.alive}|${canRewind}`;
  if (key === transportShown) return;
  transportShown = key;
  const live = $('goLive');
  live.hidden = !h?.alive;
  live.classList.toggle('live', !replay);
  live.title = replay ? 'Back to live (End)' : 'Live';
  $('tlBar').classList.toggle('replay', !!replay);
  for (const id of ['stepBack', 'reverse']) ($(id) as HTMLButtonElement).disabled = !canRewind;
}

function togglePause(): void {
  paused = !paused;
  applySpeed();
}

/** Play backwards (from where the view is), or forwards again. */
function toggleReverse(): void {
  if (reverse) reverse = false;
  else {
    if (!toReplay()) return;
    reverse = true;
    paused = false;
  }
  applySpeed();
}

/** A tenth of a second back, paused. */
function stepBack(): void {
  paused = true;
  if (toReplay()) replay!.seek(replay!.time - 0.1);
  applySpeed();
}

/** Jump the playhead by this many sim seconds (forward to the end of the tape is live again). */
function jump(seconds: number): void {
  if (seconds < 0) {
    if (toReplay()) replay!.seek(replay!.time + seconds);
  } else if (replay) {
    replay.seek(replay.time + seconds);
    if (replay.time >= replay.end) goLive();
  }
}

/** One step up or down the speed list (resumes if paused). */
function nudgeSpeed(dir: 1 | -1): void {
  const i = SPEEDS.findIndex(([, v]) => v === speed);
  speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + dir))][1];
  paused = false;
  applySpeed();
}

/** A tenth of a second on, paused. */
function stepAhead(): void {
  if (!paused) togglePause();
  if (replay) {
    replay.seek(replay.time + 0.1);
    if (replay.time >= replay.end) goLive();
    return;
  }
  host.step(0.1);
}

const ZOOMS: Array<[string, number]> = [['Full', 1], ['2×', 2], ['4×', 4], ['8×', 8]];
function setZoom(z: number): void {
  zoom = z;
  focus = null;
  renderZoomButtons();
}

$('playPause').onclick = togglePause;
$('stepAhead').onclick = stepAhead;
$('stepBack').onclick = stepBack;
$('reverse').onclick = toggleReverse;
$('goLive').onclick = () => {
  if (!replay) return;
  replay.seek(replay.end);
  goLive();
};

// The timeline: drag to scrub (rewinds; dropped at the end, live again); click a marker to watch it from just before.
{
  const bar = $('tlBar');
  const scrub = (e: PointerEvent) => {
    const h = shown(), meta = shownMeta();
    if (!h || !meta || !toReplay()) return;
    const rect = bar.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    replay!.seek(replay!.timeWhere(p, (f) => barPosition(f, f.cars, f.time, meta.track, h)));
  };
  bar.addEventListener('pointerdown', (e) => {
    const mark = (e.target as HTMLElement).closest<HTMLElement>('#tlMarks i');
    if (mark?.dataset.t) {
      toReplay(Number(mark.dataset.t) - 5);
      return;
    }
    if (!toReplay()) return;
    scrubbing = true;
    bar.setPointerCapture(e.pointerId);
    scrub(e);
  });
  bar.addEventListener('pointermove', (e) => { if (scrubbing) scrub(e); });
  const release = () => {
    if (!scrubbing) return;
    scrubbing = false;
    if (replay && replay.time >= replay.end - 0.05) goLive();
  };
  bar.addEventListener('pointerup', release);
  bar.addEventListener('pointercancel', release);
}

// Display options: a popover from the bar; closes on a click elsewhere or Escape.
{
  const toggle = $('displayToggle'), pop = $('displayPop');
  const show = (open: boolean) => { pop.hidden = !open; toggle.classList.toggle('on', open); toggle.setAttribute('aria-expanded', String(open)); };
  toggle.onclick = () => show(pop.hidden);
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !(e.target as HTMLElement).closest('.popwrap')) show(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(false); });
}

// Keyboard: Space/K pause, J/L slower/faster, R backwards, ←/→ 5 s (Shift: 30 s), ,/. step, Home/End start/live,
// Z camera. Not while typing, or over the history page.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.repeat && e.key === ' ')) return;
  if ((e.target as HTMLElement).closest('input, select, textarea, [contenteditable]')) return;
  if (!$('agentPage').hidden) return;
  switch (e.key.toLowerCase()) {
    case ' ': case 'k': togglePause(); break;
    case 'j': nudgeSpeed(-1); break;
    case 'l': nudgeSpeed(1); break;
    case '.': stepAhead(); break;
    case ',': stepBack(); break;
    case 'r': toggleReverse(); break;
    case 'arrowleft': jump(e.shiftKey ? -30 : -5); break;
    case 'arrowright': jump(e.shiftKey ? 30 : 5); break;
    case 'home': toReplay(-Infinity); break;
    case 'end': if (replay) { replay.seek(replay.end); goLive(); } break;
    case 'z': setZoom(ZOOMS[(ZOOMS.findIndex(([, v]) => v === zoom) + 1) % ZOOMS.length][1]); break;
    default: return;
  }
  e.preventDefault();
});
// Space on a focused button would also click it.
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && (e.target as HTMLElement).closest('button')) e.preventDefault();
});

// ---------- Timing tower & HUD ----------

const fmt = (t: number | null) => (t !== null && Number.isFinite(t) ? t.toFixed(2) : '–');
const pitStatus = (car: CarView) => ({ none: '', in: 'IN', service: `PIT ${car.pitTimer.toFixed(0)}s`, out: 'EXIT' })[car.pitPhase];
const FLAG = '<span class="flag"></span>';
/** Stewards' marks in the tower: a penalty still to serve (DT, SG), seconds added to the race time. */
const penaltyMarks = (car: CarView) => {
  const mark = (text: string, title: string) => ` <span title="${title}" style="color:#e5a00d;font-size:10px;font-weight:600">${text}</span>`;
  return (car.penalty ? mark(car.penalty === 'stop-go' ? 'SG' : 'DT', `${car.penalty} to serve`) : '')
    + (car.timePenalty ? mark(`+${car.timePenalty}s`, 'time penalty') : '');
};

/** Cars in classification order. */
function runningOrder(s: SessionSnapshot): CarView[] {
  const byId = new Map(s.cars.map((c) => [c.id, c]));
  return s.order.map((id) => byId.get(id)!).filter(Boolean);
}

function updateTower(): void {
  const s = snap();
  const meta = shownMeta();
  if (!s || !meta) {
    $('tower').innerHTML = '';
    const running = host.running.length;
    $('hud').innerHTML = `<b>Nothing on screen</b>${running ? ` · ${running} event${running > 1 ? 's' : ''} running in the background (Events: Watch)` : ''}`;
    return;
  }
  if (s.school) {
    schoolTower(s, meta);
    return;
  }
  $('towerHead').innerHTML = TOWER_HEAD;
  const cars = runningOrder(s);
  const leader = cars[0];
  const standings = s.standings;
  const winner = standings?.[0];
  $('tower').innerHTML = cars.map((car, p) => {
    const t = meta.teams.get(car.key)!;
    const st = standings?.[p];
    const finished = st?.status === 'finished';
    let gap: string;
    if (car.retired) gap = car.disqualified ? 'DQ' : 'OUT';
    else if (finished && winner) {
      // At the flag: laps down, or time behind the winner.
      gap = p === 0 ? 'WIN' : st!.laps < winner.laps ? `+${winner.laps - st!.laps}L` : `+${(st!.time - winner.time).toFixed(2)}`;
    } else {
      const lapsDown = Math.floor((leader.dist - car.dist) / meta.track.length);
      // Behind the pace car only the order matters; time gaps would balloon at caution speed.
      gap = pitStatus(car) || (p === 0 ? 'Leader'
        : lapsDown >= 1 ? `+${lapsDown}L`
        : s.race?.pacing ? '–'
        : `+${((leader.dist - car.dist) / Math.max(20, leader.speed)).toFixed(2)}`);
    }
    return `<tr data-team="${t.id}" title="${roster.drivers.get(t.driver)?.name ?? ''}" class="${selected === t ? 'sel' : ''}${car.retired ? ' out' : ''}">
      <td>${p + 1}</td><td>${carLabel(t)}${finished ? FLAG : ''}${penaltyMarks(car)}</td>
      <td>${gap}</td><td>${fmt(car.bestLap)}</td>
      <td>${Math.round(car.tireLife * 100)}</td><td>${Math.round((car.fuel / P.FUEL_CAPACITY) * 100)}</td>
      <td>${car.stops}</td><td>${Math.round(car.health * 100)}</td></tr>`;
  }).join('');
  const followed = (selected && meta.teams.has(selected.id) ? selected : null) ?? meta.teams.get(leader.key)!;
  const following = zoom === 1 ? '' : fixedFocusS !== null && !selected ? ' · camera parked'
    : ` · following #${followed.livery.number} ${roster.drivers.get(followed.driver)?.name ?? ''}`;
  const session = meta.mode === 'race' ? `${meta.round ? 'championship' : 'exhibition'} race · ${pace}× pace` : meta.mode === 'practice' ? `practice · ${pace}× pace` : 'ghosts';
  let status = `leader ${(leader.speed * 3.6).toFixed(0)} km/h · t ${s.time.toFixed(0)}s`;
  const r = s.race;
  if (r) {
    const lap = Math.min(r.laps, Math.max(1, leader.laps + 1));
    const w = meta.teams.get(cars[0].key)!;
    const who = `#${w.livery.number} ${roster.drivers.get(w.driver)?.name ?? ''}`;
    const flagText = r.flag === 'formation' ? '<span class="flagtag pace">FORMATION LAP</span>'
      : r.flag === 'grid' ? (r.lights ? `<span style="color:#e5484d;letter-spacing:2px">${'●'.repeat(r.lights)}</span> lights` : '<span class="flagtag pace">GRID</span> forming up')
      : !r.started ? '<span class="flagtag pace">PACE LAPS</span>'
      : r.flag === 'caution' ? (r.safetyCar ? `<span class="flagtag caution">SAFETY CAR</span>${r.oneToGo ? ' in this lap' : ''}` : `<span class="flagtag caution">CAUTION</span>${r.oneToGo ? ' one to go' : ''}`)
      : r.flag === 'restart' ? '<span class="flagtag caution">RESTART</span> leader to the line'
      : '<span class="flagtag green">GREEN</span>';
    const next = Number.isNaN(raceDoneAt) || loop === 'stop' ? ''
      : ` · ${loop === 'weekend' ? 'practice' : 'next race'} in ${Math.max(0, Math.ceil(NEXT_RACE_DELAY - (performance.now() / 1000 - raceDoneAt)))} s`;
    const learning = (handle: EventHandle | null) => {
      const spec = handle?.event?.what === 'session' ? handle.event.spec : null;
      return spec?.learn ? ` · drivers learning (${meta.learnedSteps ?? 0} steps)` : '';
    };
    status = r.state === 'green' ? `${flagText} <b>Lap ${lap} / ${r.laps}</b> · ${status}${learning(shown())}`
      : r.state === 'checkered' ? `${FLAG} <b>Checkered flag</b> · ${who} wins · others finishing`
      : `${FLAG} <b>Final</b> · ${who} wins${next}`;
  } else if (weekendPractice && shown() === fieldEvent) {
    status = `<b>Practice</b> · ${weekendPractice.roundsLeft} practice rounds until the race · drivers and crew chiefs learning`;
  }
  const drivers = readOnly() ? ` · ${bundleOf(source)?.name} drivers` : '';
  $('hud').innerHTML = `<b>${meta.trackName}</b> · ${meta.track.length.toFixed(0)} m · ${s.cars.length} cars${drivers} · ${session} · ${speedText()}${following}<br>${status}`
    + (renderer.debug.banking || renderer.debug.forces ? `<br>${bankReadout(carOf(followed), meta)}` : '');
}

/**
 * How the banking is working for one car: the angle under it, how much of the
 * turn the banking carries (its push toward the infield) against what the
 * tires add, and the neutral speed where the banking alone would do it.
 */
function bankReadout(car: CarView | null, meta: EventMeta): string {
  if (!car || car.retired) return '';
  const t = meta.track;
  const g = (a: number) => `${(a / G).toFixed(2)} g`;
  const bankDeg = (car.bank * 180) / Math.PI;
  const kappa = t.curvatureAt(car.s) / Math.max(0.2, 1 - t.curvatureAt(car.s) * car.d);
  const neutral = kappa > 1e-5 ? Math.sqrt((G * Math.tan(car.bank)) / kappa) : NaN;
  const turning = car.speed * car.speed * kappa;
  return `#${meta.teams.get(car.key)?.livery.number ?? ''} · banking <b>${bankDeg.toFixed(1)}°</b> · load ${g(car.normalAcc)}`
    + ` · <span style="color:#f5c518">banking pushes ${g(car.bankAcc)}</span>`
    + ` · <span style="color:#4fd1ff">tires ${g(Math.hypot(car.tireLat, car.tireLon))} (${Math.round(car.tireUse * 100)}% of grip)</span>`
    + (Number.isFinite(neutral) ? ` · turn needs ${g(turning)} · neutral ${neutral.toFixed(0)} m/s at ${car.speed.toFixed(0)} m/s` : ' · straight');
}

// ---------- Events panel ----------

function eventStatus(h: EventHandle): string {
  const meta = metas.get(h);
  if (h.state === 'stopped') return h.error ? `failed: ${h.error}` : 'stopped';
  if (h.state === 'finished') {
    const winner = h.results?.[0];
    const t = winner && meta?.teams.get(winner.key);
    return `finished${t ? ` · won by #${t.livery.number}` : ''}`;
  }
  if (h.attachedTo) return 'on screen';
  const p = h.progress;
  if (!h.runDetached) return 'paused (open sessions run while watched)';
  if (!p) return 'starting…';
  if (p.round !== null) return `round ${p.round}`;
  return p.lap !== null ? `lap ${p.lap} / ${p.laps}${p.flag && p.flag !== 'green' ? ` · ${p.flag}` : ''}` : `${p.time.toFixed(0)} s`;
}

function renderEvents(): void {
  const rows = host.events.map((h, i) => {
    const buttons = [
      !h.attachedTo && (h.state === 'running' || h.snapshot) ? `<button data-ev="${i}" data-act="watch">Watch</button>` : '',
      h.attachedTo && h.state === 'running' ? `<button data-ev="${i}" data-act="background" title="Keep it running off screen${h.runDetached ? ' at full speed' : ''}">Background</button>` : '',
      h.state === 'running' ? `<button data-ev="${i}" data-act="stop">Stop</button>` : '',
    ].join('');
    return `<tr class="${h.attachedTo ? 'sel' : ''}"><td class="name">${h.ref.label}</td><td class="muted">${eventStatus(h)}</td><td class="act">${buttons}</td></tr>`;
  }).join('');
  $('events').innerHTML = rows || '<tr><td class="muted">No events</td></tr>';
  // What's on tape (as far as the page has it): sim time and memory.
  const tapes = host.events.flatMap((h) => [...(h.tape ? [h.tape] : []), ...h.roundTapes.map((r) => r.tape)]);
  const bytes = tapes.reduce((a, t) => a + ('frameBytes' in t ? t.bytes : t.bytes.byteLength), 0);
  const seconds = tapes.reduce((a, t) => a + ('frameBytes' in t ? t.length : t.count), 0) / TAPE_HZ;
  $('tapeNote').textContent = tapes.length ? `On tape: ${clockText(seconds)} of sim time, ${(bytes / 1e6).toFixed(1)} MB` : '';
}

$('events').onclick = (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-ev]');
  if (!b) return;
  const h = host.events[Number(b.dataset.ev)];
  if (!h) return;
  if (b.dataset.act === 'watch') showEvent(h);
  else if (b.dataset.act === 'background') host.detach(h);
  else if (b.dataset.act === 'stop') endEvent(h);
  renderEvents();
  renderRoster();
};
$('clearEvents').onclick = () => {
  for (const h of host.events) if (h.state !== 'running' && !h.attachedTo) metas.delete(h);
  host.prune();
  renderEvents();
};

// ---------- Saved replays ----------

const replays: ReplayStore = typeof indexedDB !== 'undefined' ? new IndexedDbReplayStore() : new MemoryReplayStore();
const REPLAY_CAP_KEY = 'dotgp.v2.replayCapMB';
const REPLAY_CAPS: Array<[string, number]> = [['100 MB', 100], ['250 MB', 250], ['500 MB', 500], ['1 GB', 1000]];
let replayCapMB = (() => { try { return Number(localStorage.getItem(REPLAY_CAP_KEY)) || 250; } catch { return 250; } })();
/** The saved replays' descriptions, newest first (refreshed after every change). */
let savedReplays: ReplayMeta[] = [];

/** Pack and keep a replay, then trim to the cap. */
async function keepReplay(meta: Omit<ReplayMeta, 'saved' | 'duration' | 'bytes' | 'pinned'>, seg: TapeSegment): Promise<void> {
  try {
    const packed = await packTape(seg);
    await replays.save({ ...meta, saved: Date.now(), duration: seg.count / TAPE_HZ, bytes: packed.byteLength, pinned: false }, packed);
    await enforceCap(replays, replayCapMB * 1e6);
  } catch (e) {
    console.warn('could not save the replay', e);
  }
  await refreshReplays();
}

const replayTeams = (meta: EventMeta) => [...meta.teams.values()].map((t) => ({
  id: t.id, livery: t.livery, driver: t.driver, spotter: t.spotter, chief: t.chief, driverName: roster.drivers.get(t.driver)?.name ?? '',
}));

/** A finished race: kept as a replay. */
function saveRace(handle: EventHandle): void {
  const meta = metas.get(handle);
  if (!meta || !handle.tape || handle.tape.length < 2) return;
  void keepReplay({
    id: handle.ref.id, label: handle.ref.label, event: handle.ref, kind: 'race', track: meta.trackName, layout: meta.track.layout,
    teams: replayTeams(meta), timeline: handle.timeline, results: handle.results ?? undefined,
  }, handle.tape.segment());
}

/** A driving-school round that was watched or earned a license: kept as a replay. */
function saveRound(handle: EventHandle, t: RoundTape): void {
  const meta = metas.get(handle);
  if (!meta) return;
  void keepReplay({
    id: `${handle.ref.id}:r${t.round}`, label: `${handle.ref.label} · round ${t.round + 1}`, event: handle.ref, kind: 'class',
    track: t.track, layout: t.layout, teams: [], liveries: [...(meta.liveries ?? new Map())], timeline: [],
    round: t.round, graduated: t.graduated,
  }, t.tape);
}

/** Open a saved replay like an event, and play it from the start (or from just before `at`). */
async function watchSaved(m: ReplayMeta, at?: number): Promise<void> {
  const packed = await replays.tape(m.id);
  if (!packed) { news('That replay has been cleared.'); await refreshReplays(); return; }
  const tape = Tape.from(await unpackTape(packed));
  const handle = host.open(m.event, tape, m.timeline, m.results ?? null);
  const track = new Track(m.layout);
  metas.set(handle, {
    mode: m.kind === 'class' ? 'class' : 'race', trackName: m.track, track, recorded: true, round: !!m.event.parent,
    teams: new Map(m.teams.map((t) => [t.id, { id: t.id, livery: t.livery, driver: t.driver, spotter: t.spotter, chief: t.chief }])),
    liveries: m.liveries ? new Map(m.liveries) : undefined,
  });
  showEvent(handle);
  if (replay) replay.seek(at === undefined ? replay.start : at - 5);
  if (at !== undefined) speed = 1; // a moment is watched at real speed
  paused = false;
  applySpeed();
  showView('watch');
  renderEvents();
}

async function refreshReplays(): Promise<void> {
  try { savedReplays = await replays.list(); } catch { savedReplays = []; }
  renderReplays();
}

/** Settings → Replays: space used against the cap, and every saved replay (watch, pin to keep, delete). */
function renderReplays(): void {
  const used = savedReplays.reduce((a, m) => a + m.bytes, 0);
  $('replayUsage').textContent = `${savedReplays.length} saved · ${(used / 1e6).toFixed(1)} MB of ${replayCapMB >= 1000 ? `${replayCapMB / 1000} GB` : `${replayCapMB} MB`}`;
  ($('replayUsageBar') as HTMLElement).style.width = `${Math.min(100, (used / (replayCapMB * 1e6)) * 100).toFixed(1)}%`;
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('replayList').innerHTML = savedReplays.map((m, i) => {
    const winner = m.results?.[0], team = winner && m.teams.find((t) => t.id === winner.key);
    const what = m.kind === 'race'
      ? (team ? `won by #${team.livery.number} ${team.driverName ?? ''}` : 'race')
      : `${m.graduated?.length ? `${m.graduated.length} licensed` : 'watched'}`;
    return `<tr><td class="name">${m.pinned ? '<span title="Pinned: kept past the cap">●</span> ' : ''}${m.label}<div class="muted">${m.track} · ${what} · ${clockText(m.duration)} · ${(m.bytes / 1e6).toFixed(1)} MB · ${when(m.saved)}</div></td>`
      + `<td class="act"><button data-rp="${i}" data-act="watch">Watch</button><button data-rp="${i}" data-act="pin">${m.pinned ? 'Unpin' : 'Pin'}</button>`
      + `<button data-rp="${i}" data-act="delete" title="Delete this replay">×</button></td></tr>`;
  }).join('') || '<tr><td class="muted">Finished races are saved here, and driving-school rounds that were watched or earned a license.</td></tr>';
}

$('replayList').onclick = async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-rp]');
  const m = b && savedReplays[Number(b.dataset.rp)];
  if (!b || !m) return;
  if (b.dataset.act === 'watch') await watchSaved(m);
  else if (b.dataset.act === 'pin') { await replays.setPinned(m.id, !m.pinned); await refreshReplays(); }
  else if (b.dataset.act === 'delete') { await replays.remove(m.id); await refreshReplays(); }
};

// ---------- Teams panel (mix and match) ----------

function agentOptions(role: Role, current: string): string {
  const owner = new Map(roster.teams.map((t) => [t[role], t]));
  const describe = (id: string): string => {
    const team = owner.get(id);
    const where = team ? ` · #${team.livery.number}` : ' · free';
    if (role === 'driver') {
      const d = roster.drivers.get(id)!;
      return `${d.name} (${d.rounds}r)${where}`;
    }
    if (role === 'spotter') {
      const s = roster.spotters.get(id)!;
      return `${s.name} (sees ${Math.round(s.skill.aheadRange)} m / wrecks ${Math.round(s.skill.hazardRange)} m)${where}`;
    }
    const c = roster.chiefs.get(id)!;
    return `${c.name} (${c.brain.kind === 'neural' ? `learned, ${c.rounds}r` : 'scripted'})${where}`;
  };
  const pool = role === 'driver' ? roster.drivers : role === 'spotter' ? roster.spotters : roster.chiefs;
  return [...pool.keys()].map((id) => `<option value="${id}"${id === current ? ' selected' : ''}>${describe(id)}</option>`).join('');
}

function renderTeams(): void {
  $('teams').innerHTML = field().map((t) => `<tr data-team="${t.id}">
    <td>${carLabel(t)}</td>
    <td><select data-role="driver">${agentOptions('driver', t.driver)}</select></td>
    <td><select data-role="spotter">${agentOptions('spotter', t.spotter)}</select></td>
    <td><select data-role="chief">${agentOptions('chief', t.chief)}</select></td></tr>`).join('');
}

$('teams').onchange = (e) => {
  const sel = e.target as HTMLSelectElement;
  const row = sel.closest('tr');
  const team = roster.teams.find((t) => t.id === Number(row?.dataset.team));
  if (!team) return;
  roster.assign(team, sel.dataset.role as Role, sel.value);
  persist();
  renderTeams();
  $('teamsNote').textContent = 'Changes take effect at the next start (Series: Restart applies them now).';
};

// ---------- Technique roses ----------

const TECHNIQUE_SLOTS = 6;

/** Technique roses for the selected team's driver and the front of the field. */
function drawTechniques(): void {
  const s = snap();
  const meta = shownMeta();
  for (const [key, h] of s?.technique ?? []) technique.set(key, h);
  const host = $('techniques');
  const shownTeams: TeamEntry[] = [];
  if (selected && meta?.teams.has(selected.id)) shownTeams.push(selected);
  if (s && meta && meta.mode !== 'class') {
    for (const car of runningOrder(s)) {
      const t = meta.teams.get(car.key)!;
      if (shownTeams.length >= TECHNIQUE_SLOTS) break;
      if (!shownTeams.includes(t)) shownTeams.push(t);
    }
  }
  const key = shownTeams.map((t) => `${t.id}:${t.driver}`).join(',');
  if (host.dataset.key !== key) {
    host.dataset.key = key;
    host.innerHTML = shownTeams.map(() => '<div class="tech"><canvas width="240" height="240"></canvas><div></div></div>').join('');
  }
  host.querySelectorAll<HTMLCanvasElement>('canvas').forEach((cv, i) => {
    const t = shownTeams[i];
    const driver = roster.drivers.get(t.driver);
    const h = technique.get(t.id);
    const ctx = cv.getContext('2d')!;
    const W = cv.width, c = W / 2, R = W * 0.44;
    ctx.clearRect(0, 0, W, W);
    ctx.strokeStyle = '#2c2c32';
    ctx.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) { ctx.beginPath(); ctx.arc(c, c, R * f, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.stroke();
    ctx.fillStyle = '#6a6a72';
    ctx.font = `${W * 0.06}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('drive', c, W * 0.05);
    ctx.fillText('brake', c, W * 0.99);
    ctx.textAlign = 'left';
    ctx.fillText('inside', 2, c - 4);
    let caption = 'no data yet';
    if (h) {
      const total = h.reduce((a, b) => a + b, 0) || 1;
      const max = Math.max(...h) / total || 1;
      ctx.fillStyle = t.livery.fill;
      ctx.strokeStyle = t.livery.border;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      const width = (2 * Math.PI) / SIGNATURE_BINS;
      for (let b = 0; b < SIGNATURE_BINS; b++) {
        const share = h[b] / total;
        if (share <= 0) continue;
        const r = R * Math.sqrt(share / max);
        const a0 = -Math.PI + b * width;
        // Travel direction points up; positive lateral (toward the infield) points left.
        ctx.beginPath();
        ctx.moveTo(c, c);
        for (let k = 0; k <= 8; k++) {
          const a = a0 + (width * k) / 8;
          ctx.lineTo(c - Math.sin(a) * r, c - Math.cos(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      let wx = 0, wy = 0;
      h.forEach((v, b) => { const a = -Math.PI + (b + 0.5) * width; wx += Math.cos(a) * v; wy += Math.sin(a) * v; });
      caption = `${((Math.atan2(wy, wx) * 180) / Math.PI).toFixed(0)}°`;
    }
    const lineage = driver?.mentor ? ` · from ${driver.mentor}` : '';
    (cv.nextElementSibling as HTMLElement).innerHTML =
      `${carLabel(t)} ${driver?.name ?? ''}<br>${caption} · ${driver?.rounds ?? 0}r${lineage}`;
  });
}

// ---------- Controls ----------

/** Re-render callbacks for every button group, so state loaded at boot shows correctly. */
const buttonGroups: Array<() => void> = [];

function buttonGroup<T>(hostId: string, options: Array<[string, T]>, current: () => T | null, onPick: (v: T) => void): () => void {
  const hostEl = $(hostId);
  const render = () => {
    hostEl.innerHTML = '';
    for (const [label, value] of options) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = current() === value ? 'on' : '';
      b.onclick = () => { onPick(value); render(); };
      hostEl.appendChild(b);
    }
  };
  render();
  buttonGroups.push(render);
  return render;
}

/** Every track races to its own rulebook (ovals: rolling start, pace car; circuits: standing start, safety car). */
const racesOn = (_t: Track) => true;

function selectTrack(name: string): void {
  championship = false;
  trackName = name;
  track = TRACKS.get(name)!;
  if (mode === 'race' && !racesOn(track)) mode = 'practice';
  startSession();
  buttonGroups.forEach((render) => render());
}
const renderTrackButtons = buttonGroup('trackButtons', trackOptions, () => (championship ? null : trackName), selectTrack);
const newTrack = (type: 'oval' | 'circuit') => {
  const t = addGeneratedTrack(type);
  selectTrack(trackOptions[trackOptions.length - 1][0]);
  renderTrackButtons();
  news(`New track: ${t.name}, ${t.length.toFixed(0)} m (${type}, seed ${t.layout.seed}). Open it again with ?track=${type}:${t.layout.seed}`
    + (type === 'circuit' ? ". Drivers without a road-course license (Academy: Road courses) haven't learned circuits' tight corners yet: expect wrecks." : ''));
};
$('newTrack').onclick = () => newTrack('oval');
$('newCircuit').onclick = () => newTrack('circuit');
buttonGroup('fieldButtons', FIELD_SIZES.map((n) => [String(n), n] as [string, number]), () => fieldSize, (n) => {
  const practising = !!trainer;
  fieldSize = n;
  if (readOnly()) roster = Roster.fromBundle(bundleOf(source)!, bundleDrivers.get(source)!, n, rng)!;
  else roster.ensureTeams(n);
  if (selected && !field().includes(selected)) selected = null;
  persist();
  renderTeams();
  startSession();
  if (practising && mode === 'practice') startPractice();
});
const renderSpeedButtons = buttonGroup('speedButtons', SPEEDS, () => (paused ? null : speed), (s) => { speed = s; paused = false; applySpeed(); });
const renderZoomButtons = buttonGroup('zoomButtons', ZOOMS, () => zoom, setZoom);
// Settings → Replays: how much to keep.
buttonGroup('replayCapButtons', REPLAY_CAPS, () => replayCapMB, async (mb) => {
  replayCapMB = mb;
  try { localStorage.setItem(REPLAY_CAP_KEY, String(mb)); } catch { /* the cap holds for this visit */ }
  await enforceCap(replays, mb * 1e6);
  await refreshReplays();
});
buttonGroup('dotButtons', [['Real size', 'real'], ['Legible', 'legible']] as Array<[string, DotMode]>,
  () => renderer.dotMode, (m) => { renderer.dotMode = m; });
buttonGroup('effectButtons', [['Show', true], ['Hide', false]] as Array<[string, boolean]>,
  () => renderer.effects, (v) => { renderer.effects = v; });
buttonGroup('variationButtons', [['Show', true], ['Hide', false]] as Array<[string, boolean]>,
  () => showVariations, (v) => { showVariations = v; });
buttonGroup('modeButtons', [['Race', 'race'], ['Practice', 'practice'], ['Ghosts', 'ghost']] as Array<[string, Mode]>,
  () => (championship ? null : mode), (m) => {
    if (m === 'race' && !racesOn(track)) { news(`No races on road circuits yet (standing starts and the safety car come with the circuit rulebook): practice or ghosts.`); return; }
    mode = m;
    championship = false;
    weekendPractice = null;
    startSession(); // ends the field's previous session (and its practice training)
  });
buttonGroup('lapButtons', [['20', 20], ['50', 50], ['100', 100], ['200', 200]], () => raceLaps, (n) => {
  raceLaps = n;
  if (mode === 'race') startSession();
});
buttonGroup('paceButtons', [['Real', 1], ['4×', 4], ['8×', 8]], () => pace, (p) => { pace = p; startSession(); });
buttonGroup('learnButtons', [['On', true], ['Off', false]] as Array<[string, boolean]>, () => learnInRaces, (v) => { learnInRaces = v; });
buttonGroup('autoButtons', [['Race weekend', 'weekend'], ['Next round', 'races'], ['Stop', 'stop']] as Array<[string, Loop]>,
  () => loop, (l) => { loop = l; });
$('nextRound').onclick = () => {
  if (readOnly()) { news('The championship is for your own roster: switch back to it under Paddock.'); return; }
  weekendPractice = null;
  mode = 'race';
  toNextRound();
  startSession();
  buttonGroups.forEach((render) => render());
};
// Debug overlays: independent toggles.
{
  const hostEl = $('debugButtons');
  const layers: Array<[string, keyof DebugLayers, string]> = [
    ['Inputs', 'inputs', 'Each driver\'s acceleration request'],
    ['Forces', 'forces', 'Banking push toward the infield (amber) and tire force (cyan), 1 g = 26 px'],
    ['Banking', 'banking', 'Banking heatmap, inside → outside angles, and a readout for the followed car'],
  ];
  // ?debug=banking,forces switches layers on from the URL.
  const fromUrl = new URLSearchParams(location.search).get('debug')?.split(',');
  for (const [label, layer, title] of layers) {
    if (fromUrl) renderer.setDebug(layer, fromUrl.includes(layer));
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.className = renderer.debug[layer] ? 'on' : '';
    b.onclick = () => {
      renderer.setDebug(layer, !renderer.debug[layer]);
      b.className = renderer.debug[layer] ? 'on' : '';
    };
    hostEl.appendChild(b);
  }
}
$('clearMarks').onclick = () => renderer.clearMarks();
$('restart').onclick = () => { $('teamsNote').textContent = ''; startSession(); };
$('tower').onclick = (e) => {
  const row = (e.target as HTMLElement).closest('tr');
  if (!row) return;
  const t = roster.teams.find((x) => x.id === Number(row.dataset.team)) ?? null;
  selected = selected === t ? null : t;
  focus = null;
};

// ---------- Races: results, records, the championship ----------

/** Championship bookkeeping and records when a race ends; runs the off-season after the final round. */
function finishRace(handle: EventHandle): void {
  const meta = metas.get(handle)!;
  const results = handle.results!;
  meta.recorded = true;
  const laps = (handle.event!.spec as SessionSpec).laps;
  const round = !!meta.round;
  if (round) {
    recordRace(season, meta.trackName, laps, results.map((r) => ({
      team: r.key, driver: r.driver, chief: r.chief, spotter: r.spotter, position: r.position, status: r.status, laps: r.laps,
    })));
  }
  // Every agent in the race gets its result in the log: drivers, crew chiefs and spotters alike.
  for (const r of results) {
    const data = {
      track: meta.trackName, raceLaps: laps, starters: results.length, position: r.position, status: r.status, laps: r.laps,
      bestLap: r.bestLap, avgLap: r.avgLap, stops: r.stops, wallHits: r.wallHits, health: r.health,
      penalties: r.penalties.filter((p) => p.penalty !== 'none').map((p) => `${PENALTY_NAMES[p.penalty]} for ${OFFENCE_NAMES[p.offence]}`),
      disqualified: r.disqualified,
      ...(round ? { points: pointsFor(r.position, results.length, r.status), season: season.number, round: season.races.length } : {}),
    };
    const replay = { id: handle.ref.id };
    activity.record({ kind: 'race', agent: r.driver, role: 'driver', event: handle.ref, brain: roster.drivers.get(r.driver)?.rounds, data, replay });
    activity.record({ kind: 'race', agent: r.chief, role: 'chief', event: handle.ref, brain: roster.chiefs.get(r.chief)?.rounds, data, replay });
    activity.record({ kind: 'race', agent: r.spotter, role: 'spotter', event: handle.ref, data, replay });
  }
  recordInjuries(handle, meta.trackName, results);
  if (round && seasonComplete(season)) {
    recordSeasonActivity();
    const lines = offSeason(season, roster, field());
    lines.reverse().forEach(news);
    season = newSeason(SEASON_TRACKS, ROUNDS_PER_TRACK, season);
    renderTeams();
  }
  occupancy.release(handle.ref.id);
  persist();
  renderSeason();
  renderRoster();
}

/**
 * After a race: injured drivers are a race nearer recovery, then everyone's
 * hardest hit in this one is rolled for an injury (injury.ts).
 */
function recordInjuries(handle: EventHandle, trackName: string, results: EntrantResult[]): void {
  for (const d of roster.raceRun()) {
    activity.record({ kind: 'recovered', agent: d.id, role: 'driver', data: {} });
    news(`${d.name} has recovered from injury and is fit to race`);
  }
  for (const r of results) {
    const d = roster.drivers.get(r.driver);
    const injury = d ? injuryFrom(r.worstHit, () => rng.next()) : null;
    if (!d || !injury) continue;
    const kmh = Math.round(r.worstHitSpeed * 3.6);
    activity.record({
      kind: 'injury', agent: d.id, role: 'driver', event: handle.ref, replay: { id: handle.ref.id, at: r.worstHitTime ?? undefined },
      data: { severity: injury.severity, races: injury.races, track: trackName, hit: r.worstHit, speed: r.worstHitSpeed },
    });
    if (injury.severity === 'career') {
      d.careerOver = { season: season.number, track: trackName };
      news(`${d.name}'s career is over after a ${kmh} km/h crash at ${trackName}`);
    } else {
      d.injury = { severity: injury.severity, racesLeft: injury.races };
      news(`${d.name} is hurt (${injury.severity}) after a ${kmh} km/h crash at ${trackName}: out for ${injury.races} race${injury.races === 1 ? '' : 's'}`);
    }
  }
}

/** Final championship positions for drivers and crew chiefs. */
function recordSeasonActivity(): void {
  driverStandings(season).forEach((e, i) => activity.record({
    kind: 'season', agent: e.driver, role: 'driver', data: { season: season.number, position: i + 1, points: e.points, champion: i === 0 },
  }));
  Object.entries(season.chiefPoints).sort((a, b) => b[1] - a[1]).forEach(([chief, points], i) => activity.record({
    kind: 'season', agent: chief, role: 'chief', data: { season: season.number, position: i + 1, points, champion: i === 0 },
  }));
}

function renderSeason(): void {
  const done = season.races.length;
  const standings = driverStandings(season).filter((e) => roster.drivers.has(e.driver)).slice(0, 10);
  const teamOf = (driverId: string) => roster.teams.find((t) => t.driver === driverId);
  const rows = standings.map((e, i) => {
    const d = roster.drivers.get(e.driver)!;
    const t = teamOf(e.driver);
    const c = season.careers[e.driver];
    return `<tr><td>${i + 1}</td><td>${t ? carLabel(t) : ''}</td><td class="name">${d.name}</td><td>${e.points}</td><td>${c?.wins ?? 0}</td></tr>`;
  }).join('');
  const champs = season.champions.slice(-3).reverse().map((c) => `S${c.season}: #${c.number} ${c.driver}`).join(' · ');
  $('season').innerHTML = `<div class="muted">Season ${season.number} · round ${Math.min(done + 1, season.schedule.length)} of ${season.schedule.length} · next: ${nextTrack(season)}</div>
    <table class="standings"><thead><tr><th>P</th><th></th><th>Driver</th><th>Pts</th><th>Wins</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No races yet</td></tr>'}</tbody></table>
    ${champs ? `<div class="muted">Champions: ${champs}</div>` : ''}`;
}

// ---------- Practice: the field learns (in its practice session) ----------

/** Race weekend: practice on the season's next track, then race there. */
function startWeekendPractice(attach: boolean): void {
  toNextRound();
  mode = 'practice';
  if (!startSession(attach)) return;
  weekendPractice = { roundsLeft: WEEKEND_PRACTICE_ROUNDS };
  startPractice();
}

function finishWeekendPractice(): void {
  const attach = fieldEvent?.attachedTo ?? true;
  weekendPractice = null;
  stopPractice();
  mode = 'race';
  startSession(attach);
  buttonGroups.forEach((render) => render());
}

/** The trainer: practice heats in a worker. Improved weights reach the roster and the cars in the practice session. */
let trainer: Worker | null = null;
let lastPersist = 0;

function startPractice(): void {
  stopPractice();
  const teams = field();
  const drivers = teams.map((t) => roster.driverOf(t));
  const chiefs = teams.map((t) => roster.chiefOf(t));
  const practiceEvent = fieldEvent;
  trainer = new Worker(new URL('../ai/practice.worker.ts', import.meta.url), { type: 'module' });
  const trackNames = Object.keys(PRESETS).map((id) => presetTrack(id).name);
  trainer.onmessage = (e: MessageEvent<PracticeRound>) => {
    const r = e.data;
    const event = practiceEvent?.ref;
    const updates: Array<{ id: string; weights: Float32Array }> = [];
    const lines = r.drivers.map((d) => {
      const driver = drivers[d.index];
      driver.weights.set(d.weights);
      driver.rounds = d.rounds;
      driver.licensed = d.licensed;
      updates.push({ id: driver.id, weights: d.weights });
      activity.record({
        kind: 'practice', agent: driver.id, role: 'driver', event, brain: d.rounds,
        data: {
          tracks: trackNames, bestLaps: d.bestLaps.map((t) => (Number.isFinite(t) ? t : null)), fitness: d.fitness,
          rookie: d.rookie, walls: d.rookie ? r.damageScale : 1,
        },
      });
      if (d.graduated) {
        activity.record({ kind: 'licensed', agent: driver.id, role: 'driver', event, brain: d.rounds, data: { lessons: d.rounds } });
        news(`${driver.name} (#${teams[d.index].livery.number}) earned a license after ${d.rounds} lessons`);
      }
      const school = d.rookie ? ` <span class="muted">rookie school, lesson ${d.rounds}, walls ×${r.damageScale.toFixed(2)}</span>` : '';
      return `${carLabel(teams[d.index])} ${driver.name}: ${d.bestLaps.map((t) => fmt(t)).join(' / ')}${school}`;
    });
    if (practiceEvent) host.updateDrivers(practiceEvent, updates);
    for (const c of r.chiefs) {
      const chief = chiefs[c.index];
      if (chief.brain.kind !== 'neural') continue;
      chief.brain.weights.set(c.weights);
      chief.rounds = c.rounds;
      activity.record({ kind: 'strategy', agent: chief.id, role: 'chief', event, brain: c.rounds, data: { relativeTime: c.relativeTime } });
      lines.push(`${carLabel(teams[c.index])} crew chief ${chief.name}: strategy race ${((c.relativeTime - 1) * 100).toFixed(1)}% off the best`);
    }
    $('practiceStatus').innerHTML = `round ${r.round} · walls ×${r.damageScale.toFixed(2)} · ${(r.elapsedMs / 1000).toFixed(1)}s/round<br>`
      + `practising now (best laps ${trackNames.join(' / ')}):<br>${lines.join('<br>')}`;
    if (performance.now() - lastPersist > 5000) {
      persist();
      lastPersist = performance.now();
      renderRoster();
      agentPage.refresh();
    }
    if (weekendPractice && --weekendPractice.roundsLeft <= 0) finishWeekendPractice();
  };
  const msg: PracticeRequest = {
    type: 'start',
    seed: (Math.random() * 2 ** 32) >>> 0,
    traffic: true,
    drivers: drivers.map((d) => ({ weights: Array.from(d.weights), rounds: d.rounds, licensed: d.licensed })),
    chiefs: chiefs.flatMap((c, index) => (c.brain.kind === 'neural' ? [{ index, weights: Array.from(c.brain.weights), rounds: c.rounds }] : [])),
  };
  trainer.postMessage(msg);
  $('practice').textContent = 'Stop practice';
  $('practice').className = 'on';
}

function stopPractice(): void {
  if (!trainer) return;
  trainer.terminate();
  trainer = null;
  persist();
  $('practice').textContent = 'Start practice';
  $('practice').className = '';
}

$('practice').onclick = () => {
  if (readOnly()) { news(`The ${bundleOf(source)?.name} drivers are read-only (as tested): practice is for your own roster.`); return; }
  weekendPractice = null; // manual control takes over from the weekend loop
  if (trainer) { stopPractice(); return; }
  // Training happens in a practice session (the field can't practise and race at once).
  if (mode !== 'practice' || metas.get(fieldEvent!)?.mode !== 'practice' || fieldEvent?.state !== 'running') {
    mode = 'practice';
    if (!startSession()) return;
    buttonGroups.forEach((render) => render());
  }
  startPractice();
};
$('newDrivers').onclick = () => {
  if (readOnly()) { news('Switch to your own roster (Paddock) to replace its drivers.'); return; }
  if (!confirm(`Replace all ${fieldSize} drivers in the field with raw rookies? The current drivers are deleted.`)) return;
  stopPractice();
  roster.freshDriversForAll();
  technique.clear();
  persist();
  renderTeams();
  startSession();
};
$('saveFile').onclick = () => {
  const blob = new Blob([JSON.stringify({ fieldSize, roster: roster.toJSON(), season })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dotgp-roster.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$<HTMLInputElement>('loadFile').onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (readOnly()) { $('dataNote').textContent = 'Switch to your own roster (Paddock) before loading one over it.'; (e.target as HTMLInputElement).value = ''; return; }
  (e.target as HTMLInputElement).value = ''; // the same file can be loaded again
  let data: { roster?: unknown; season?: SeasonState };
  try { data = JSON.parse(await file.text()); } catch { data = {}; }
  const loaded = Roster.load(data.roster ?? data, rng, roster.chiefTemplates);
  if (!loaded) { $('dataNote').textContent = `${file.name} isn't a roster file.`; return; }
  $('dataNote').textContent = `Loaded ${file.name}.`;
  if (data.season?.schedule) season = data.season;
  renderSeason();
  const wasPracticing = !!trainer;
  stopPractice();
  if (fieldEvent) endEvent(fieldEvent);
  roster = loaded;
  watchRoster(roster);
  roster.ensureTeams(fieldSize);
  selected = null;
  technique.clear();
  persist();
  renderTeams();
  startSession();
  if (wasPracticing && mode === 'practice') startPractice();
};

// ---------- Roster: everyone in the organisation, seated or in the academy ----------

const agentPage = new AgentPage({
  roster: () => roster, occupancy, log: activity,
  replays: () => new Set(savedReplays.map((m) => m.id)),
  watch: (id, at) => {
    const m = savedReplays.find((x) => x.id === id);
    if (m) void watchSaved(m, at);
  },
});
let rosterRole: AgentRole = 'driver';

function renderRoster(): void {
  const hostEl = document.getElementById('roster');
  if (!hostEl) return;
  const pool = rosterRole === 'driver' ? roster.drivers : rosterRole === 'spotter' ? roster.spotters : roster.chiefs;
  const rows = [...pool.values()].map((a) => {
    const team = roster.teamOf(rosterRole, a.id);
    const busy = occupancy.of(a.id);
    let detail = '';
    if (rosterRole === 'driver') {
      const d = roster.drivers.get(a.id)!;
      detail = `${d.careerOver ? 'retired · ' : d.injury ? `injured (${d.injury.racesLeft}) · ` : ''}${d.licensed ? '' : 'school · '}${d.rounds}r`;
    } else if (rosterRole === 'chief') {
      const c = roster.chiefs.get(a.id)!;
      detail = c.brain.kind === 'neural' ? `${c.rounds}r` : 'scripted';
    }
    return { a, team, busy, detail };
  }).sort((x, y) => (x.team ? x.team.livery.number : 1e4) - (y.team ? y.team.livery.number : 1e4));
  hostEl.innerHTML = rows.map(({ a, team, busy, detail }) => `<tr>
    <td>${team ? carLabel(team) : '<span class="muted">academy</span>'}</td>
    <td class="name"><a data-agent="${a.id}" data-role="${rosterRole}">${a.name}</a></td>
    <td class="muted">${busy ? busy.type : 'free'}</td>
    <td class="muted">${detail}</td></tr>`).join('');
  renderSchool(); // who is free to take a class changes with the roster
}

buttonGroup('rosterTabs', [['Drivers', 'driver'], ['Chiefs', 'chief'], ['Spotters', 'spotter']] as Array<[string, AgentRole]>,
  () => rosterRole, (r) => { rosterRole = r; renderRoster(); });
$('roster').onclick = (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('[data-agent]');
  if (link) void agentPage.open(link.dataset.agent!, link.dataset.role as AgentRole);
};
$('recruitRookie').onclick = () => {
  const d = roster.freshDriver();
  persist();
  renderRoster();
  renderTeams();
  renderSchool();
  news(`${d.name} joins the academy as a raw rookie (driving school first)`);
};
$('recruit').onclick = () => {
  const a = rosterRole === 'driver' ? roster.recruitDriver() : rosterRole === 'chief' ? roster.newChief() : roster.newSpotter();
  persist();
  renderRoster();
  renderTeams();
  renderSchool();
  news(`${a.name} joins the academy`);
};
// Double-click a driver in the timing tower for their history.
$('tower').ondblclick = (e) => {
  const row = (e.target as HTMLElement).closest('tr');
  const t = row ? roster.teams.find((x) => x.id === Number(row.dataset.team)) : undefined;
  if (t) void agentPage.open(t.driver, 'driver');
};

// ---------- Driving school: classes of drivers taking lessons ----------

/** Student colours (categorical, dark steps) and how many students a class takes. */
const STUDENT_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767', '#4fd1ff'];
const MAX_STUDENTS = STUDENT_COLORS.length;
/** Student keys start here, clear of team ids. */
const STUDENT_KEY = 10000;
let lesson: LessonId = 'rookie';
const picked = new Set<string>();
let lastSchoolPersist = 0;

const initials = (name: string) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** Free drivers the lesson is for. */
function eligible(id: string): boolean {
  const d = roster.drivers.get(id)!;
  return occupancy.isFree(id) && !d.careerOver && LESSONS[lesson].eligible({ ...d, roadLicensed: d.roadCourse?.licensed });
}

function renderSchool(): void {
  const L = LESSONS[lesson];
  $('lessonNote').textContent = L.description;
  const free = [...roster.drivers.values()].filter((d) => eligible(d.id));
  for (const id of [...picked]) if (!eligible(id)) picked.delete(id);
  $('studentPicker').innerHTML = free.length
    ? free.map((d) => `<label class="pick"><input type="checkbox" data-student="${d.id}"${picked.has(d.id) ? ' checked' : ''}> ${d.name} <span class="muted">${d.rounds}r${roster.teamOf('driver', d.id) ? '' : ' · academy'}</span></label>`).join('')
    : `<div class="muted">No free ${L.audience}. ${L.id === 'rookie' ? 'Recruit a raw rookie under Paddock: Roster.' : 'Drivers in a running session are busy: stop it, or recruit to the academy.'}</div>`;
  ($('startClass') as HTMLButtonElement).disabled = picked.size === 0;
}

buttonGroup('lessonButtons', Object.values(LESSONS).filter((l) => !l.withdrawn).map((l) => [l.name, l.id] as [string, LessonId]), () => lesson, (l) => {
  lesson = l;
  picked.clear();
  renderSchool();
});
$('studentPicker').onchange = (e) => {
  const box = e.target as HTMLInputElement;
  const id = box.dataset.student;
  if (!id) return;
  if (box.checked && picked.size >= MAX_STUDENTS) { box.checked = false; return; }
  if (box.checked) picked.add(id); else picked.delete(id);
  renderSchool();
};
$('startClass').onclick = () => startClass();

/** Start a class with the picked students, on screen (whatever was there goes to the background). */
function startClass(): void {
  if (readOnly()) { news(`The ${bundleOf(source)?.name} drivers are read-only (as tested): classes are for your own roster.`); return; }
  const L = LESSONS[lesson];
  const students = [...picked].map((id) => roster.drivers.get(id)!).slice(0, MAX_STUDENTS);
  if (!students.length) return;
  const ref: EventRef = {
    id: `school-${Date.now().toString(36)}-${++eventCounter}`, type: 'school',
    label: `${L.name} · ${students.map((d) => d.name.split(' ')[0]).join(', ')}`,
  };
  const conflicts = occupancy.claim(ref, students.map((d) => d.id));
  if (conflicts.length) { news(`Can't start the class: ${conflicts.length} students are busy in ${conflicts[0].event.label}`); return; }
  const spec: ClassSpec = {
    lesson,
    // Road courses trains the road-course skill (starting as a copy of the driver's oval driving); everything else the driver.
    students: students.map((d, i) => ({
      key: STUDENT_KEY + i, id: d.id, name: d.name,
      weights: lesson === 'circuits' ? (d.roadCourse?.weights ?? d.weights).slice() : d.weights,
      rounds: lesson === 'circuits' ? d.roadCourse?.rounds ?? 0 : d.rounds,
      licensed: d.licensed, pitLicensed: d.pitLicensed, pitTrafficLicensed: d.pitTrafficLicensed, cautionLicensed: d.cautionLicensed,
      roadLicensed: d.roadCourse?.licensed, roadRadius: d.roadCourse?.radius, nerve: d.nerve,
    })),
    presets: Object.keys(PRESETS).map(presetLayout),
    seed: (rng.next() * 2 ** 32) >>> 0,
  };
  const handle = host.start(ref, { what: 'class', spec }, { attach: true, runDetached: true });
  const first = presetTrack(Object.keys(PRESETS)[0]);
  metas.set(handle, {
    mode: 'class', trackName: first.name, track: first, teams: new Map(), recorded: false, lesson,
    liveries: new Map(students.map((d, i) => [STUDENT_KEY + i, { number: i + 1, fill: STUDENT_COLORS[i], border: '#f8f9fa', label: initials(d.name) }])),
  });
  showEvent(handle);
  picked.clear();
  renderSchool();
  renderRoster();
  renderEvents();
  news(`${L.name} starts: ${students.map((d) => d.name).join(', ')}`);
}

/** A round of a class ended: the students' new driving goes to the roster and their records. */
function lessonRounds(handle: EventHandle, reports: RoundReport[]): void {
  const meta = metas.get(handle);
  for (const r of reports) {
    const d = roster.drivers.get(r.id);
    if (!d) continue;
    if (meta?.lesson === 'circuits') {
      // The road-course skill learned; the driver's oval driving is untouched.
      d.roadCourse = { weights: r.weights.slice(), rounds: r.rounds, licensed: r.roadLicensed, radius: r.roadRadius };
    } else {
      d.weights.set(r.weights);
      d.rounds = r.rounds;
    }
    d.licensed = r.licensed;
    d.pitLicensed = r.pitLicensed;
    d.pitTrafficLicensed = r.pitTrafficLicensed;
    d.cautionLicensed = r.cautionLicensed;
    const variations = 2 * LESSONS[meta?.lesson ?? 'rookie'].pairs;
    const replay = { id: `${handle.ref.id}:r${r.round}` };
    activity.record({
      kind: 'lesson', agent: d.id, role: 'driver', event: handle.ref, brain: r.rounds, replay,
      data: { lesson: meta?.lesson ?? 'rookie', track: r.track, fitness: r.fitness, laps: r.laps, bestLap: r.bestLap, health: r.health, walls: r.walls, beaten: r.beaten, variations },
    });
    if (r.graduated) {
      const license = meta?.lesson === 'pits' ? 'pit' : meta?.lesson === 'pitTraffic' ? 'pitTraffic' : meta?.lesson === 'cautions' ? 'caution'
        : meta?.lesson === 'circuits' ? 'roadCourse' : 'driving';
      activity.record({ kind: 'licensed', agent: d.id, role: 'driver', event: handle.ref, brain: r.rounds, replay, data: { lessons: r.rounds, license } });
      news(license === 'pit' ? `${d.name} passed the pit stop lesson: next, pit road in traffic`
        : license === 'pitTraffic' ? `${d.name} passed pit road in traffic: does their own stops in races from now on`
        : license === 'caution' ? `${d.name} passed the caution lesson: drives their own cautions and restarts from now on`
        : license === 'roadCourse' ? `${d.name} earned a road-course license`
        : `${d.name} earned a license after ${r.rounds} lessons`);
    }
  }
  if (performance.now() - lastSchoolPersist > 5000) {
    lastSchoolPersist = performance.now();
    persist();
    renderRoster();
    agentPage.refresh();
  }
}

/** How a student's own pit stop went, for the class table. */
const stopText = (st: { serviced: boolean; completed: boolean; speeding: number; harm?: number }) =>
  !st.serviced ? 'no stop' : !st.completed ? "stopped, didn't merge" : st.speeding >= 1 ? 'speeding'
    : (st.harm ?? 0) >= 0.05 ? 'stopped, with contact' : 'clean stop';

/** How a student's own racecraft drill went, for the class table. */
const packText = (p: { harm: number; gained: number }) =>
  `${p.gained > 0 ? `+${p.gained}` : p.gained} place${Math.abs(p.gained) === 1 ? '' : 's'}${p.harm >= 0.02 ? ', caused contact' : ''}`;

/** How a student's own caution drill went, for the class table. */
const cautionText = (c: { placeError: number; passes: number; harm: number }) =>
  `${c.placeError.toFixed(0)} m off${c.passes ? `, ${c.passes} pass${c.passes > 1 ? 'es' : ''}` : ''}${c.harm >= 0.05 ? ', contact' : ''}`;

const TOWER_HEAD = '<tr><th>P</th><th>Driver</th><th>Gap</th><th>Best</th><th>Tire</th><th>Fuel</th><th>Pit</th><th>Hlth</th></tr>';
const SCHOOL_HEAD = '<tr><th>P</th><th>Student</th><th>Lessons</th><th>Last round</th><th>Best</th><th>Beaten by</th><th>Tests</th><th></th></tr>';

/** The timing tower during a class: students ranked by their last round, and the HUD for the lesson. */
function schoolTower(s: SessionSnapshot, meta: EventMeta): void {
  const sc = s.school!;
  const L = LESSONS[sc.lesson];
  $('towerHead').innerHTML = SCHOOL_HEAD;
  const ranked = [...sc.students].sort((a, b) => (b.last?.fitness ?? -Infinity) - (a.last?.fitness ?? -Infinity));
  const variations = 2 * L.pairs;
  $('tower').innerHTML = ranked.map((st, p) => {
    const lv = meta.liveries?.get(st.key);
    const last = st.last;
    return `<tr><td>${p + 1}</td><td><span class="dot" style="background:${lv?.fill};border-color:${lv?.fill}"></span><a data-agent="${st.id}" data-role="driver">${st.name}</a></td>
      <td>${st.rounds}</td><td>${!last ? '–' : last.stop ? stopText(last.stop) : last.caution ? cautionText(last.caution) : last.pack ? packText(last.pack) : `${last.laps} laps`}</td><td>${fmt(last?.bestLap ?? null)}</td>
      <td>${last ? `${last.beaten}/${variations}` : '–'}</td><td>${sc.lesson === 'variety' ? '–' : `${st.passed.length}/3`}</td>
      <td>${sc.lesson === 'circuits' ? (st.roadLicensed ? 'road' : '') : sc.lesson === 'pits' ? (st.pitLicensed ? 'pits' : '') : sc.lesson === 'pitTraffic' ? (st.pitTrafficLicensed ? 'pit road' : '') : sc.lesson === 'cautions' ? (st.cautionLicensed ? 'cautions' : '') : st.licensed ? 'licensed' : ''}</td></tr>`;
  }).join('');
  const students = sc.students.length;
  $('hud').innerHTML = `<b>Driving school</b> · ${L.name} · ${students} student${students > 1 ? 's' : ''} · ${speedText()}<br>`
    + `round ${sc.round + 1} · <b>${meta.trackName}</b> · ${Math.ceil(sc.remaining)} s left in the round`
    + (sc.walls < 1 ? ` · walls ×${sc.walls.toFixed(2)} (soft)` : '')
    + ` · ${showVariations ? `faint dots: each student's ${variations} variations` : 'variations hidden'}`;
}
$('tower').addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('[data-agent]');
  if (link) void agentPage.open(link.dataset.agent!, 'driver');
});

// ---------- Roster source: yours, or a bundle as tested ----------

async function useRoster(next: string): Promise<void> {
  if (next === source) return;
  try { localStorage.setItem('dotgp.v2.source', next); } catch { /* remembered for this visit only */ }
  if (next !== 'mine' && !bundleDrivers.has(next)) {
    const b = bundleOf(next);
    const data = b && await fetchJson(`/drivers/${b.file}`) as { drivers?: Array<{ weights: number[] }> } | null;
    if (!data?.drivers?.length) { news(`Couldn't load the ${b?.name ?? next} drivers.`); return; }
    bundleDrivers.set(next, data.drivers);
  }
  stopPractice();
  weekendPractice = null;
  if (fieldEvent) endEvent(fieldEvent);
  if (source === 'mine') myRoster = roster;
  source = next;
  if (next === 'mine') {
    roster = myRoster ?? roster;
    myRoster = null;
    roster.ensureTeams(fieldSize);
  } else {
    roster = Roster.fromBundle(bundleOf(next)!, bundleDrivers.get(next)!, fieldSize, rng)!;
    championship = false;
    if (mode === 'race' || !racesOn(track)) mode = racesOn(track) ? 'race' : 'practice';
  }
  selected = null;
  technique.clear();
  renderRosterSource();
  renderTeams();
  renderRoster();
  renderSeason();
  renderSchool();
  startSession();
  buttonGroups.forEach((render) => render());
}

function renderRosterSource(): void {
  const host = $('rosterSource');
  host.innerHTML = '';
  for (const [label, id] of [['My roster', 'mine'], ...bundles.map((b) => [`${b.name} drivers`, b.id])]) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = source === id ? 'on' : '';
    btn.onclick = () => void useRoster(id);
    host.appendChild(btn);
  }
  $('recruit').hidden = readOnly();
  $('recruitRookie').hidden = readOnly();
  $('rosterSourceNote').textContent = readOnly()
    ? bundleOf(source)?.note ?? ''
    : 'Your own drivers: they learn, race the championship and are saved in this browser.';
}

// ---------- Views ----------

const VIEW_KEY = 'dotgp.v2.view';

function showView(view: string): void {
  document.querySelectorAll<HTMLElement>('aside section[data-view]').forEach((el) => { el.hidden = el.dataset.view !== view; });
  document.querySelectorAll<HTMLElement>('#views button').forEach((b) => { b.className = b.dataset.view === view ? 'on' : ''; });
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* remembered for this visit only */ }
}
$('views').onclick = (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-view]');
  if (b) showView(b.dataset.view!);
};
showView((() => { try { return localStorage.getItem(VIEW_KEY) ?? 'watch'; } catch { return 'watch'; } })());

// ---------- Boot ----------

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // Bundled trained crew chiefs: new teams' chiefs descend from them.
  const chiefData = await fetchJson('/chiefs/default.json') as { chiefs?: Array<{ weights: number[] }> } | null;
  const templates = (chiefData?.chiefs ?? []).map((c) => Float32Array.from(c.weights));
  roster = loadPersisted(templates)
    // Ship with a trained field if one is bundled; otherwise start with rookies.
    ?? Roster.load(await fetchJson('/drivers/default.json'), rng, templates)
    ?? new Roster(rng);
  roster.chiefTemplates = templates;
  const index = await fetchJson('/drivers/index.json') as { bundles?: Bundle[] } | null;
  if (index?.bundles?.length) bundles = index.bundles;
  renderRosterSource();
  // Rosters saved before trained crew chiefs existed: bring their chiefs up to date.
  const upgraded = roster.upgradeScriptedChiefs();
  if (upgraded) news(`${upgraded} crew chiefs switched to learned strategy (descended from the trained chiefs)`);
  if (params.has('field')) fieldSize = Number(params.get('field'));
  if (params.has('zoom')) zoom = Number(params.get('zoom'));
  if (params.has('laps')) raceLaps = Number(params.get('laps'));
  if (params.has('pace')) pace = Number(params.get('pace'));
  if (params.has('speed')) speed = Number(params.get('speed'));
  // ?track=oval:<seed>[:<variant>] or ?track=circuit:<seed>[:club|gp] opens a generated track.
  const [kind, seedText, variant] = (params.get('track') ?? '').split(':');
  if ((kind === 'oval' || kind === 'circuit') && seedText) {
    addGeneratedTrack(kind, Number(seedText), variant || undefined);
    championship = false;
    trackName = trackOptions[trackOptions.length - 1][0];
    track = TRACKS.get(trackName)!;
    if (!racesOn(track)) mode = 'practice';
  } else {
    toNextRound();
  }
  watchRoster(roster);
  roster.ensureTeams(fieldSize);
  persist();
  applySpeed();
  // ?warm=N fast-forwards the first session N seconds (handy for screenshots and jumping in).
  startSession(true, Number(params.get('warm') ?? 0));
  // ?roster=house (or the last choice) puts a bundle's drivers on track: exactly what the tests race.
  const savedSource = (() => { try { return localStorage.getItem('dotgp.v2.source'); } catch { return null; } })();
  const wanted = params.get('roster') ?? savedSource ?? 'mine';
  if (wanted !== 'mine' && bundleOf(wanted)) await useRoster(wanted);
  buttonGroups.forEach((render) => render());
  renderTeams();
  renderSeason();
  renderSchool();
  drawTechniques();
  drawRadio();
  void refreshReplays();
  // The view follows the stage's size on screen (window, sidebar, browser zoom) and keeps the track out from under the HUD.
  const hud = $('hud');
  const fitView = () => {
    renderer.setInsets({ top: hud.offsetHeight ? hud.offsetTop + hud.offsetHeight : 0 });
    renderer.resize();
  };
  const sizes = new ResizeObserver(fitView);
  try { sizes.observe(canvas, { box: 'device-pixel-content-box' }); } catch { sizes.observe(canvas); } // also sees display scale changes
  sizes.observe(hud);
  window.addEventListener('resize', fitView);
  setInterval(updateTower, 200);
  setInterval(() => {
    // A finished race whose results were on screen, but you looked away: the season carries on.
    if (fieldEvent?.state === 'finished' && !fieldEvent.attachedTo && !Number.isNaN(raceDoneAt)) carryOn(fieldEvent);
    renderEvents();
  }, 500);
  // The log buffers records; write them out every couple of seconds and when the page is hidden or closed.
  setInterval(() => void activity.flush(), 2000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) void activity.flush(); });
  window.addEventListener('pagehide', () => void activity.flush());
  setInterval(drawTechniques, 500);
  setInterval(drawRadio, 250);
  requestAnimationFrame(frame);
}
void boot();
