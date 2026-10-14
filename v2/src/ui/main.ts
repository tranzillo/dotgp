import type { PracticeRequest, PracticeRound } from '../ai/practice.worker';
import { Rng } from '../ai/rng';
import { EventHost, type EventHandle } from '../events/host';
import type { CarView, EntrantResult, EntrantSpec, RadioLine as SessionRadio, SessionSnapshot, SessionSpec } from '../events/session';
import { injuryFrom } from '../events/injury';
import { LESSONS, type ClassSpec, type LessonId, type RoundReport } from '../school/classroom';
import { ActivityLog, MemoryActivityStore, type AgentRole, type EventRef } from '../records/activity';
import { IndexedDbActivityStore } from '../records/idbStore';
import { Occupancy } from '../records/occupancy';
import type { Livery } from '../render/livery';
import { Renderer, type DebugLayers, type DotMode, type RenderCar } from '../render/renderer';
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

/** Generate an oval and add it to the track list (seed and variant random unless given). */
function addGeneratedTrack(seed = Math.floor(Math.random() * 1e9), variant?: string): Track {
  const t = generateTrack({ type: 'oval', seed, variant });
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
/** Practice rounds (in the trainer) between races in the weekend loop. */
const WEEKEND_PRACTICE_ROUNDS = 9;
let weekendPractice: { roundsLeft: number } | null = null;
const NEXT_RACE_DELAY = 10; // real seconds of results on screen before moving on
let raceDoneAt = NaN;
let speed = 1;
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
}
const metas = new Map<EventHandle, EventMeta>();
/** The event the field is in (on screen or not). */
let fieldEvent: EventHandle | null = null;

const host = new EventHost({
  frame(handle, _snapshot, strokes, radio) {
    renderer.stampStrokes(strokes);
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
    if (meta.mode === 'race' && !meta.recorded) finishRace(handle);
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
      focus = null;
    }
  },
  rounds(handle, reports) {
    lessonRounds(handle, reports);
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
      activity.record({ kind: 'learning', agent: d.id, role: 'driver', event: handle.ref, brain: d.rounds, data: { source: 'race', track: meta?.trackName ?? '', step: st.steps } });
    }
  },
});

/** The event on screen and its latest snapshot. */
const shown = () => host.attached;
const shownMeta = () => { const h = shown(); return h ? metas.get(h) ?? null : null; };
const snap = (): SessionSnapshot | null => shown()?.snapshot ?? null;
const teamOfKey = (key: number) => shownMeta()?.teams.get(key);
const liveryOf = (car: RenderCar) => shownMeta()?.liveries?.get((car as CarView).key) ?? teamOfKey((car as CarView).key)?.livery;
const carOf = (entry: TeamEntry | null) => (entry && shownMeta()?.mode !== 'class' ? snap()?.cars.find((c) => c.key === entry.id) ?? null : null);
/** Driving school: draw each student's practice variations (faint) too. */
let showVariations = true;

function newEventRef(): EventRef {
  const type = mode === 'ghost' ? 'ghost' : mode;
  const label = mode === 'race'
    ? `Season ${season.number} round ${Math.min(season.races.length + 1, season.schedule.length)} · ${trackName}`
    : mode === 'practice' ? `Practice · ${trackName}` : `Ghost laps · ${trackName}`;
  return {
    id: `${type}-${Date.now().toString(36)}-${++eventCounter}`, type, label, track: trackName,
    parent: mode === 'race' ? `season-${season.number}` : undefined,
  };
}

function entrantSpec(t: TeamEntry): EntrantSpec {
  const driver = roster.driverOf(t), spotter = roster.spotterOf(t), chief = roster.chiefOf(t);
  return {
    key: t.id,
    fill: t.livery.fill,
    driver: { id: driver.id, weights: driver.weights, nerve: driver.nerve, pits: (driver.pitLicensed && driver.pitTrafficLicensed) ?? false, cautions: driver.cautionLicensed ?? false },
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
  const ref = newEventRef();
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
    seed: (rng.next() * 2 ** 32) >>> 0, learn: learnInRaces,
  };
  const handle = host.start(ref, { what: 'session', spec }, { attach, runDetached: mode === 'race', warm });
  metas.set(handle, { mode, trackName, track, teams: new Map(teams.map((t) => [t.id, t])), recorded: false });
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
  radioFeed.length = 0;
  technique.clear();
  focus = null;
  if (handle.snapshot === null) $('hud').innerHTML = `<b>${meta.trackName}</b> · starting…`;
}

/** After a race: the next race, or the next weekend, in the background if this one was. */
function carryOn(prev: EventHandle): void {
  const attach = prev.attachedTo;
  raceDoneAt = NaN;
  if (loop === 'races') {
    mode = 'race';
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
  if (radioFeed.length > 80) radioFeed.length = 80;
}

const news = (text: string) => radioFeed.unshift({ time: snap()?.time ?? 0, team: null, text });
const dotHtml = (l: Livery) => `<span class="dot" style="background:${l.fill};border-color:${l.border}"></span>`;
const carLabel = (t: TeamEntry) => `${dotHtml(t.livery)}#${t.livery.number}`;

function drawRadio(): void {
  const lines = (selected ? radioFeed.filter((l) => l.team === selected) : radioFeed).slice(0, 12);
  $('radio').innerHTML = lines.map((l) => {
    const clock = `${Math.floor(l.time / 60)}:${Math.floor(l.time % 60).toString().padStart(2, '0')}`;
    return l.team ? `<div><span class="muted">${clock}</span> ${carLabel(l.team)} ${l.text}</div>`
      : `<div class="news">${l.text}</div>`;
  }).join('') || '<div class="muted">quiet on the radio</div>';
}

// ---------- Main loop: draw whatever is attached ----------

/** ?focusS=<metres from the line> parks the zoomed camera on a spot (e.g. 0 = pit road). */
const fixedFocusS = new URLSearchParams(location.search).get('focusS');

function leaderView(s: SessionSnapshot): CarView | undefined {
  return s.cars.find((c) => c.id === s.order[0]);
}

function updateCamera(s: SessionSnapshot | null, t: Track): void {
  if (zoom === 1 || !s) {
    renderer.setView(1, 0, 0);
    return;
  }
  if (fixedFocusS !== null && !selected) {
    const [x, y] = t.toWorld(Number(fixedFocusS), t.innerEdgeAt(Number(fixedFocusS)) + 6);
    renderer.setView(zoom, x, y);
    return;
  }
  const target = carOf(selected) ?? leaderView(s);
  if (!target) return;
  if (!focus) focus = [target.x, target.y];
  focus[0] += (target.x - focus[0]) * 0.2;
  focus[1] += (target.y - focus[1]) * 0.2;
  renderer.setView(zoom, focus[0], focus[1]);
}

function frame(): void {
  const h = shown();
  const meta = shownMeta();
  const s = snap();
  if (h && meta) {
    updateCamera(s, meta.track);
    const cars = s?.cars ?? [];
    renderer.render(showVariations ? cars : cars.filter((c) => !c.variant), liveryOf, carOf(selected), {
      paceCar: s?.race?.paceCar ?? null,
      wreckers: s?.race?.wreckers ?? [],
    });
    // A finished race on screen: after a moment of results, carry on.
    if (h === fieldEvent && !Number.isNaN(raceDoneAt) && performance.now() / 1000 - raceDoneAt > NEXT_RACE_DELAY) carryOn(h);
  } else {
    renderer.render([], liveryOf);
  }
  requestAnimationFrame(frame);
}

// ---------- Timing tower & HUD ----------

const fmt = (t: number | null) => (t !== null && Number.isFinite(t) ? t.toFixed(2) : '–');
const pitStatus = (car: CarView) => ({ none: '', in: 'IN', service: `PIT ${car.pitTimer.toFixed(0)}s`, out: 'EXIT' })[car.pitPhase];
const FLAG = '<span class="flag"></span>';

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
    if (car.retired) gap = 'OUT';
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
      <td>${p + 1}</td><td>${carLabel(t)}${finished ? FLAG : ''}</td>
      <td>${gap}</td><td>${fmt(car.bestLap)}</td>
      <td>${Math.round(car.tireLife * 100)}</td><td>${Math.round((car.fuel / P.FUEL_CAPACITY) * 100)}</td>
      <td>${car.stops}</td><td>${Math.round(car.health * 100)}</td></tr>`;
  }).join('');
  const followed = (selected && meta.teams.has(selected.id) ? selected : null) ?? meta.teams.get(leader.key)!;
  const following = zoom === 1 ? '' : fixedFocusS !== null && !selected ? ' · camera parked'
    : ` · following #${followed.livery.number} ${roster.drivers.get(followed.driver)?.name ?? ''}`;
  const session = meta.mode === 'race' ? `race · ${pace}× pace` : meta.mode === 'practice' ? `practice · ${pace}× pace` : 'ghosts';
  let status = `leader ${(leader.speed * 3.6).toFixed(0)} km/h · t ${s.time.toFixed(0)}s`;
  const r = s.race;
  if (r) {
    const lap = Math.min(r.laps, Math.max(1, leader.laps + 1));
    const w = meta.teams.get(cars[0].key)!;
    const who = `#${w.livery.number} ${roster.drivers.get(w.driver)?.name ?? ''}`;
    const flagText = !r.started ? '<span class="flagtag pace">PACE LAPS</span>'
      : r.flag === 'caution' ? `<span class="flagtag caution">CAUTION</span>${r.oneToGo ? ' one to go' : ''}`
      : r.flag === 'restart' ? '<span class="flagtag caution">RESTART</span> leader to the line'
      : '<span class="flagtag green">GREEN</span>';
    const next = Number.isNaN(raceDoneAt) || loop === 'stop' ? ''
      : ` · ${loop === 'weekend' ? 'practice' : 'next race'} in ${Math.max(0, Math.ceil(NEXT_RACE_DELAY - (performance.now() / 1000 - raceDoneAt)))} s`;
    const learning = (handle: EventHandle | null) => {
      const spec = handle?.event.what === 'session' ? handle.event.spec : null;
      return spec?.learn ? ` · drivers learning (${meta.learnedSteps ?? 0} steps)` : '';
    };
    status = r.state === 'green' ? `${flagText} <b>Lap ${lap} / ${r.laps}</b> · ${status}${learning(shown())}`
      : r.state === 'checkered' ? `${FLAG} <b>Checkered flag</b> · ${who} wins · others finishing`
      : `${FLAG} <b>Final</b> · ${who} wins${next}`;
  } else if (weekendPractice && shown() === fieldEvent) {
    status = `<b>Practice</b> · ${weekendPractice.roundsLeft} practice rounds until the race · drivers and crew chiefs learning`;
  }
  $('hud').innerHTML = `<b>${meta.trackName}</b> · ${meta.track.length.toFixed(0)} m · ${s.cars.length} cars · ${session} · ${speed}×${following}<br>${status}`
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
  $('teamsNote').textContent = 'Changes take effect at the next start (Restart applies them now).';
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

function buttonGroup<T>(hostId: string, options: Array<[string, T]>, current: () => T, onPick: (v: T) => void): () => void {
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

function selectTrack(name: string): void {
  trackName = name;
  track = TRACKS.get(name)!;
  startSession();
}
const renderTrackButtons = buttonGroup('trackButtons', trackOptions, () => trackName, selectTrack);
$('newTrack').onclick = () => {
  const t = addGeneratedTrack();
  selectTrack(trackOptions[trackOptions.length - 1][0]);
  renderTrackButtons();
  news(`New track: ${t.name}, ${t.length.toFixed(0)} m (oval, seed ${t.layout.seed}). Open it again with ?track=oval:${t.layout.seed}`);
};
buttonGroup('fieldButtons', FIELD_SIZES.map((n) => [String(n), n] as [string, number]), () => fieldSize, (n) => {
  const practising = !!trainer;
  fieldSize = n;
  roster.ensureTeams(n);
  if (selected && !field().includes(selected)) selected = null;
  persist();
  renderTeams();
  startSession();
  if (practising && mode === 'practice') startPractice();
});
buttonGroup('speedButtons', [['1×', 1], ['4×', 4], ['16×', 16], ['64×', 64]], () => speed, (s) => { speed = s; host.setSpeed(s); });
buttonGroup('zoomButtons', [['Full', 1], ['2×', 2], ['4×', 4], ['8×', 8]], () => zoom, (z) => { zoom = z; focus = null; });
buttonGroup('dotButtons', [['Real size', 'real'], ['Legible', 'legible']] as Array<[string, DotMode]>,
  () => renderer.dotMode, (m) => { renderer.dotMode = m; });
buttonGroup('effectButtons', [['Show', true], ['Hide', false]] as Array<[string, boolean]>,
  () => renderer.effects, (v) => { renderer.effects = v; });
buttonGroup('variationButtons', [['Show', true], ['Hide', false]] as Array<[string, boolean]>,
  () => showVariations, (v) => { showVariations = v; });
buttonGroup('modeButtons', [['Race', 'race'], ['Practice', 'practice'], ['Ghosts', 'ghost']] as Array<[string, Mode]>,
  () => mode, (m) => {
    mode = m;
    weekendPractice = null;
    startSession(); // ends the field's previous session (and its practice training)
  });
buttonGroup('lapButtons', [['20', 20], ['50', 50], ['100', 100], ['200', 200]], () => raceLaps, (n) => {
  raceLaps = n;
  if (mode === 'race') startSession();
});
buttonGroup('paceButtons', [['Real', 1], ['4×', 4], ['8×', 8]], () => pace, (p) => { pace = p; startSession(); });
buttonGroup('learnButtons', [['On', true], ['Off', false]] as Array<[string, boolean]>, () => learnInRaces, (v) => { learnInRaces = v; });
buttonGroup('autoButtons', [['Weekends', 'weekend'], ['Race after race', 'races'], ['Stop', 'stop']] as Array<[string, Loop]>,
  () => loop, (l) => { loop = l; });
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
  const laps = (handle.event.spec as SessionSpec).laps;
  recordRace(season, meta.trackName, laps, results.map((r) => ({
    team: r.key, driver: r.driver, chief: r.chief, spotter: r.spotter, position: r.position, status: r.status, laps: r.laps,
  })));
  // Every agent in the race gets its result in the log: drivers, crew chiefs and spotters alike.
  for (const r of results) {
    const data = {
      track: meta.trackName, raceLaps: laps, starters: results.length, position: r.position, status: r.status, laps: r.laps,
      bestLap: r.bestLap, avgLap: r.avgLap, stops: r.stops, wallHits: r.wallHits, health: r.health,
      points: pointsFor(r.position, results.length, r.status), season: season.number, round: season.races.length,
    };
    activity.record({ kind: 'race', agent: r.driver, role: 'driver', event: handle.ref, brain: roster.drivers.get(r.driver)?.rounds, data });
    activity.record({ kind: 'race', agent: r.chief, role: 'chief', event: handle.ref, brain: roster.chiefs.get(r.chief)?.rounds, data });
    activity.record({ kind: 'race', agent: r.spotter, role: 'spotter', event: handle.ref, data });
  }
  recordInjuries(handle, meta.trackName, results);
  if (seasonComplete(season)) {
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
      kind: 'injury', agent: d.id, role: 'driver', event: handle.ref,
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
  trackName = nextTrack(season);
  track = TRACKS.get(trackName) ?? TRACKS.get(SEASON_TRACKS[0])!;
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
      + `practising now (best laps speedway / short / flat):<br>${lines.join('<br>')}`;
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
  stopPractice();
  roster.freshDriversForAll();
  technique.clear();
  persist();
  renderTeams();
  startSession();
};
$('saveFile').onclick = () => {
  const blob = new Blob([JSON.stringify({ fieldSize, roster: roster.toJSON() })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dotgp-roster.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$<HTMLInputElement>('loadFile').onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const data = JSON.parse(await file.text());
  const loaded = Roster.load(data.roster ?? data, rng, roster.chiefTemplates);
  if (!loaded) return;
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

const agentPage = new AgentPage({ roster: () => roster, occupancy, log: activity });
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
  return occupancy.isFree(id) && !d.careerOver && LESSONS[lesson].eligible(d);
}

function renderSchool(): void {
  const L = LESSONS[lesson];
  $('lessonNote').textContent = L.description;
  const free = [...roster.drivers.values()].filter((d) => eligible(d.id));
  for (const id of [...picked]) if (!eligible(id)) picked.delete(id);
  $('studentPicker').innerHTML = free.length
    ? free.map((d) => `<label class="pick"><input type="checkbox" data-student="${d.id}"${picked.has(d.id) ? ' checked' : ''}> ${d.name} <span class="muted">${d.rounds}r${roster.teamOf('driver', d.id) ? '' : ' · academy'}</span></label>`).join('')
    : `<div class="muted">No free ${L.audience}. ${L.id === 'rookie' ? 'Recruit a raw rookie in the Roster panel.' : 'Drivers in a running session are busy: stop it, or recruit to the academy.'}</div>`;
  ($('startClass') as HTMLButtonElement).disabled = picked.size === 0;
}

buttonGroup('lessonButtons', Object.values(LESSONS).map((l) => [l.name, l.id] as [string, LessonId]), () => lesson, (l) => {
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
    students: students.map((d, i) => ({ key: STUDENT_KEY + i, id: d.id, name: d.name, weights: d.weights, rounds: d.rounds, licensed: d.licensed, pitLicensed: d.pitLicensed, pitTrafficLicensed: d.pitTrafficLicensed, cautionLicensed: d.cautionLicensed })),
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
    d.weights.set(r.weights);
    d.rounds = r.rounds;
    d.licensed = r.licensed;
    d.pitLicensed = r.pitLicensed;
    d.pitTrafficLicensed = r.pitTrafficLicensed;
    d.cautionLicensed = r.cautionLicensed;
    const variations = 2 * LESSONS[meta?.lesson ?? 'rookie'].pairs;
    activity.record({
      kind: 'lesson', agent: d.id, role: 'driver', event: handle.ref, brain: r.rounds,
      data: { lesson: meta?.lesson ?? 'rookie', track: r.track, fitness: r.fitness, laps: r.laps, bestLap: r.bestLap, health: r.health, walls: r.walls, beaten: r.beaten, variations },
    });
    if (r.graduated) {
      const license = meta?.lesson === 'pits' ? 'pit' : meta?.lesson === 'pitTraffic' ? 'pitTraffic' : meta?.lesson === 'cautions' ? 'caution' : 'driving';
      activity.record({ kind: 'licensed', agent: d.id, role: 'driver', event: handle.ref, brain: r.rounds, data: { lessons: r.rounds, license } });
      news(license === 'pit' ? `${d.name} passed the pit stop lesson: next, pit road in traffic`
        : license === 'pitTraffic' ? `${d.name} passed pit road in traffic: does their own stops in races from now on`
        : license === 'caution' ? `${d.name} passed the caution lesson: drives their own cautions and restarts from now on`
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
      <td>${sc.lesson === 'pits' ? (st.pitLicensed ? 'pits' : '') : sc.lesson === 'pitTraffic' ? (st.pitTrafficLicensed ? 'pit road' : '') : sc.lesson === 'cautions' ? (st.cautionLicensed ? 'cautions' : '') : st.licensed ? 'licensed' : ''}</td></tr>`;
  }).join('');
  const students = sc.students.length;
  $('hud').innerHTML = `<b>Driving school</b> · ${L.name} · ${students} student${students > 1 ? 's' : ''} · ${speed}×<br>`
    + `round ${sc.round + 1} · <b>${meta.trackName}</b> · ${Math.ceil(sc.remaining)} s left in the round`
    + (sc.walls < 1 ? ` · walls ×${sc.walls.toFixed(2)} (soft)` : '')
    + ` · ${showVariations ? `faint dots: each student's ${variations} variations` : 'variations hidden'}`;
}
$('tower').addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('[data-agent]');
  if (link) void agentPage.open(link.dataset.agent!, 'driver');
});

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
  // Rosters saved before trained crew chiefs existed: bring their chiefs up to date.
  const upgraded = roster.upgradeScriptedChiefs();
  if (upgraded) news(`${upgraded} crew chiefs switched to learned strategy (descended from the trained chiefs)`);
  if (params.has('field')) fieldSize = Number(params.get('field'));
  if (params.has('zoom')) zoom = Number(params.get('zoom'));
  if (params.has('laps')) raceLaps = Number(params.get('laps'));
  if (params.has('pace')) pace = Number(params.get('pace'));
  if (params.has('speed')) speed = Number(params.get('speed'));
  // ?track=oval:<seed>[:<variant>] opens a generated track.
  const [kind, seedText, variant] = (params.get('track') ?? '').split(':');
  if (kind === 'oval' && seedText) {
    addGeneratedTrack(Number(seedText), variant || undefined);
    trackName = trackOptions[trackOptions.length - 1][0];
    track = TRACKS.get(trackName)!;
  }
  watchRoster(roster);
  roster.ensureTeams(fieldSize);
  persist();
  host.setSpeed(speed);
  // ?warm=N fast-forwards the first session N seconds (handy for screenshots and jumping in).
  startSession(true, Number(params.get('warm') ?? 0));
  buttonGroups.forEach((render) => render());
  renderTeams();
  renderSeason();
  renderSchool();
  drawTechniques();
  drawRadio();
  window.addEventListener('resize', () => renderer.resize());
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
