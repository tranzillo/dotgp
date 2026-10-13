import { NeuralDriver, Team } from '../ai/drivers';
import { PaceCarDriver } from '../ai/formation';
import { NeuralCrewChief } from '../ai/neuralChief';
import { StrategistCrewChief, type CrewChief } from '../ai/pitting';
import type { PracticeRequest, PracticeRound } from '../ai/practice.worker';
import { Rng } from '../ai/rng';
import { describeRadio, RADIO_SIZE, TowerSpotter } from '../ai/spotter';
import type { Livery } from '../render/livery';
import { Renderer, type DotMode } from '../render/renderer';
import { Car, SIGNATURE_BINS } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { placeOnGrid, ROLLING_START_SPEED } from '../sim/grid';
import { Race } from '../sim/race';
import { FLAT_TRACK, SHORT_TRACK, SPEEDWAY, Track, type OvalSpec } from '../sim/track';
import { World } from '../sim/world';
import { Roster, type ChiefAgent, type Role, type TeamEntry } from './roster';
import {
  driverStandings, newSeason, nextTrack, offSeason, recordRace, seasonComplete, type SeasonState,
} from './season';

// ---------- Roster ----------

const STORAGE_KEY = 'dotgp.v2.roster.v3';
const FIELD_SIZES = [4, 8, 12, 16, 24, 32, 40];

const rng = new Rng((Math.random() * 2 ** 32) >>> 0);
let roster = new Roster(rng);
let fieldSize = 8;
const field = () => roster.teams.slice(0, fieldSize);

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

function makeChief(agent: ChiefAgent): CrewChief {
  return agent.brain.kind === 'neural' ? new NeuralCrewChief(agent.brain.weights) : new StrategistCrewChief(agent.brain.traits);
}

// ---------- Session state ----------

const TRACKS: Record<string, OvalSpec> = { Speedway: SPEEDWAY, 'Short track': SHORT_TRACK, 'Flat track': FLAT_TRACK };
/** Each track appears this many times per season. */
const ROUNDS_PER_TRACK = 2;
let season: SeasonState = newSeason(Object.keys(TRACKS), ROUNDS_PER_TRACK);
let raceRecorded = false;
let trackName = 'Speedway';
let track = new Track(TRACKS[trackName]);
/** race: laps, pits, DNFs. practice: open session, wrecks respawn. ghost: no contact. */
type Mode = 'race' | 'practice' | 'ghost';
let mode: Mode = 'race';
let raceLaps = 50;
/** Race pace: tire wear and fuel burn multiplier. */
let pace = 4;
/**
 * What happens after a race: another race straight away, a race weekend
 * (practice where drivers and crew chiefs learn, then the next race on the
 * next track), or nothing.
 */
type Loop = 'races' | 'weekend' | 'stop';
let loop: Loop = 'weekend';
/** Practice rounds (in the worker) between races in the weekend loop. */
const WEEKEND_PRACTICE_ROUNDS = 9;
let weekendPractice: { roundsLeft: number } | null = null;
let race: Race | null = null;
let raceDoneAt = NaN;
const NEXT_RACE_DELAY = 10; // real seconds of results before moving on
let speed = 1;
let zoom = 1;
let world: World;
let carEntry = new Map<Car, TeamEntry>();
let carTeam = new Map<Car, Team>();
let selected: TeamEntry | null = null;
const technique = new Map<string, Float64Array>(); // driver id -> decaying histogram
let focus: [number, number] | null = null;

const canvas = document.getElementById('track') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const liveryOf = (car: Car) => carEntry.get(car)?.livery;
const carOf = (entry: TeamEntry | null) => (entry ? world.cars.find((c) => carEntry.get(c) === entry) ?? null : null);

/** Released at pace speed behind the start line, as on real ovals. */
function rollingRestart(car: Car): void {
  car.placeOnTrack(track, track.length - 20, 0);
  car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
  car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
}

function buildWorld(): void {
  const contact = mode !== 'ghost';
  world = new World(track, { collisions: contact, drafting: contact, wearScale: mode === 'ghost' ? 1 : pace });
  race = null;
  raceDoneAt = NaN;
  raceRecorded = false;
  eventsSeen = 0;
  carEntry = new Map();
  carTeam = new Map();
  // Shuffle the grid so starting order isn't always roster order.
  const entrants = field().map((t) => ({ t, key: rng.next() })).sort((a, b) => a.key - b.key).map((e) => e.t);
  entrants.forEach((entry, k) => {
    const car = new Car(k, entry.livery.fill);
    if (contact) placeOnGrid(car, track, k, true);
    else rollingRestart(car); // ghosts share one spot
    const team = new Team(
      new NeuralDriver(roster.driverOf(entry).weights),
      new TowerSpotter(roster.spotterOf(entry).skill),
      contact ? makeChief(roster.chiefOf(entry)) : null,
    );
    world.addCar(car, team);
    carEntry.set(car, entry);
    carTeam.set(car, team);
  });
  // Races run under race control: pace laps, green at the line, cautions with the wrecker crew.
  if (mode === 'race') race = new Race(world, raceLaps, new PaceCarDriver());
  radioFeed.length = 0;
  prevRadio.clear();
  focus = null;
  renderer.clearMarks();
}

/** Practice/ghosts: a wrecked car returns after a pause. Ghosts get instant top-ups (no crew chief). */
const retiredAt = new Map<Car, number>();
function serviceCars(): void {
  if (mode === 'race') return; // in a race, wrecks are out and the crew chiefs handle stops
  world.cars.forEach((car, k) => {
    if (car.retired) {
      if (!retiredAt.has(car)) retiredAt.set(car, world.time);
      if (world.time - retiredAt.get(car)! < 3) return;
      retiredAt.delete(car);
      const fresh = new Car(car.id, car.color);
      rollingRestart(fresh);
      fresh.lapTimes.push(...car.lapTimes);
      world.replaceCar(k, fresh);
      carEntry.set(fresh, carEntry.get(car)!);
      carEntry.delete(car);
      carTeam.set(fresh, carTeam.get(car)!);
      carTeam.delete(car);
      renderer.forget(car);
      return;
    }
    if (mode === 'ghost' && (car.tireLife < 0.5 || car.fuel < 3)) {
      car.tireLife = 1;
      car.fuel = P.FUEL_CAPACITY;
    }
  });
}

function recordTechnique(): void {
  for (const car of world.cars) {
    const entry = carEntry.get(car);
    if (!entry || car.retired) continue;
    let h = technique.get(entry.driver);
    if (!h) technique.set(entry.driver, (h = new Float64Array(SIGNATURE_BINS)));
    const mag = Math.hypot(car.tireLon, car.tireLat);
    for (let b = 0; b < SIGNATURE_BINS; b++) h[b] *= 0.9997;
    if (mag > 0.1) {
      const ang = Math.atan2(car.tireLat, car.tireLon);
      h[Math.floor(((ang + Math.PI) / (2 * Math.PI)) * SIGNATURE_BINS) % SIGNATURE_BINS] += mag * P.DT;
    }
  }
}

// ---------- Team radio ----------

interface RadioLine { time: number; team: TeamEntry | null; text: string }
const radioFeed: RadioLine[] = [];
const prevRadio = new Map<Car, Float32Array>();
const RADIO_REPEAT = 4; // seconds before the same call from the same team shows again
let eventsSeen = 0;

function pollRadio(): void {
  // Crew chief calls and pit/retirement events go on the same feed.
  for (; eventsSeen < world.events.length; eventsSeen++) {
    const e = world.events[eventsSeen];
    const team = carEntry.get(e.car) ?? null;
    if (e.kind === 'flag') radioFeed.unshift({ time: e.time, team: null, text: e.text });
    else if (team) radioFeed.unshift({ time: e.time, team, text: e.kind === 'crew' ? `Crew: ${e.text}` : e.text });
  }
  for (const car of world.cars) {
    const controller = carTeam.get(car);
    const team = carEntry.get(car);
    if (!controller || !team || car.retired) continue;
    let prev = prevRadio.get(car);
    if (!prev) prevRadio.set(car, (prev = new Float32Array(RADIO_SIZE)));
    for (const text of describeRadio(controller.radio, prev)) {
      const dup = radioFeed.some((l) => l.team === team && l.text === text && world.time - l.time < RADIO_REPEAT);
      if (!dup) radioFeed.unshift({ time: world.time, team, text });
    }
    prev.set(controller.radio);
  }
  if (radioFeed.length > 80) radioFeed.length = 80;
}

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

// ---------- Main loop ----------

const leaderCar = () => world.cars.reduce((a, b) => (b.dist > a.dist && !b.retired ? b : a), world.cars[0]);

/** ?focusS=<metres from the line> parks the zoomed camera on a spot (e.g. 0 = pit road). */
const fixedFocusS = new URLSearchParams(location.search).get('focusS');

function updateCamera(): void {
  if (zoom === 1) {
    renderer.setView(1, 0, 0);
    return;
  }
  if (fixedFocusS !== null && !selected) {
    const [x, y] = track.toWorld(Number(fixedFocusS), track.halfWidth + 6);
    renderer.setView(zoom, x, y);
    return;
  }
  const target = carOf(selected) ?? leaderCar();
  if (!focus) focus = [target.x, target.y];
  focus[0] += (target.x - focus[0]) * 0.2;
  focus[1] += (target.y - focus[1]) * 0.2;
  renderer.setView(zoom, focus[0], focus[1]);
}

let lastFrame = performance.now();
let simDebt = 0;
function frame(now: number): void {
  const realDt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  simDebt += realDt * speed;
  let steps = 0;
  while (simDebt >= P.DT && steps < 4000) {
    simulateStep();
    simDebt -= P.DT;
    steps++;
  }
  if (steps === 4000) simDebt = 0;
  serviceCars();
  if (race?.state === 'finished') {
    if (!raceRecorded) finishRaceForSeason();
    if (Number.isNaN(raceDoneAt)) raceDoneAt = now / 1000;
    else if (now / 1000 - raceDoneAt > NEXT_RACE_DELAY) {
      if (loop === 'races') buildWorld();
      else if (loop === 'weekend') startWeekendPractice();
    }
  }
  updateCamera();
  const ctl = race?.control;
  renderer.render(world.cars, liveryOf, carOf(selected), {
    paceCar: ctl?.paceCarOut ? ctl.paceCar : null,
    wreckers: ctl?.wreckers ?? [],
  });
  requestAnimationFrame(frame);
}

function simulateStep(): void {
  if (race) race.step();
  else world.step();
  recordTechnique();
  renderer.stampMarks(world.cars);
  if (world.tick % P.CONTROL_EVERY === 1) pollRadio();
}

// ---------- Timing tower & HUD ----------

const fmt = (t: number) => (Number.isFinite(t) ? t.toFixed(2) : '–');

/** Classification order: the race's standings, or distance covered in open sessions. */
function runningOrder(): Car[] {
  if (race) return race.standings().map((st) => st.car);
  return [...world.cars].sort((a, b) => Number(a.retired) - Number(b.retired) || b.dist - a.dist);
}

const pitStatus = (car: Car) => ({
  none: '', in: 'IN', service: `PIT ${car.pit.timer.toFixed(0)}s`, out: 'EXIT',
})[car.pit.phase];

const FLAG = '<span class="flag"></span>';

function updateTower(): void {
  const cars = runningOrder();
  const leader = cars[0];
  const standings = race?.standings();
  const winner = standings?.[0];
  $('tower').innerHTML = cars.map((car, p) => {
    const t = carEntry.get(car)!;
    const st = standings?.[p];
    const finished = st?.status === 'finished';
    let gap: string;
    if (car.retired) gap = 'OUT';
    else if (finished && winner) {
      // At the flag: laps down, or time behind the winner.
      gap = p === 0 ? 'WIN' : st!.laps < winner.laps ? `+${winner.laps - st!.laps}L` : `+${(st!.time - winner.time).toFixed(2)}`;
    } else {
      const lapsDown = Math.floor((leader.dist - car.dist) / track.length);
      // Behind the pace car only the order matters; time gaps would balloon at caution speed.
      const pacing = race?.control?.pacing ?? false;
      gap = pitStatus(car) || (p === 0 ? 'Leader'
        : lapsDown >= 1 ? `+${lapsDown}L`
        : pacing ? '–'
        : `+${((leader.dist - car.dist) / Math.max(20, leader.speed)).toFixed(2)}`);
    }
    const best = car.lapTimes.length ? Math.min(...car.lapTimes) : NaN;
    return `<tr data-team="${t.id}" title="${roster.driverOf(t).name}" class="${selected === t ? 'sel' : ''}${car.retired ? ' out' : ''}">
      <td>${p + 1}</td><td>${carLabel(t)}${finished ? FLAG : ''}</td>
      <td>${gap}</td><td>${fmt(best)}</td>
      <td>${Math.round(car.tireLife * 100)}</td><td>${Math.round((car.fuel / P.FUEL_CAPACITY) * 100)}</td>
      <td>${car.pit.stops}</td><td>${Math.round(car.health * 100)}</td></tr>`;
  }).join('');
  const followed = selected ?? carEntry.get(leader)!;
  const following = zoom === 1 ? '' : fixedFocusS !== null && !selected ? ' · camera parked'
    : ` · following #${followed.livery.number} ${roster.driverOf(followed).name}`;
  const session = mode === 'race' ? `race · ${pace}× pace` : mode === 'practice' ? `practice · ${pace}× pace` : 'ghosts';
  let status = `leader ${(leader.speed * 3.6).toFixed(0)} km/h · t ${world.time.toFixed(0)}s`;
  if (race) {
    const lap = Math.min(race.laps, Math.max(1, leader.lapsCompleted + 1));
    const w = carEntry.get(cars[0])!;
    const who = `#${w.livery.number} ${roster.driverOf(w).name}`;
    const flag = race.control?.flag ?? 'green';
    const flagText = !race.started ? '<span class="flagtag pace">PACE LAPS</span>'
      : flag === 'caution' ? `<span class="flagtag caution">CAUTION</span>${race.control!.oneToGo ? ' one to go' : ''}`
      : flag === 'restart' ? '<span class="flagtag caution">RESTART</span> leader to the line'
      : '<span class="flagtag green">GREEN</span>';
    status = race.state === 'green' ? `${flagText} <b>Lap ${lap} / ${race.laps}</b> · ${status}`
      : race.state === 'checkered' ? `${FLAG} <b>Checkered flag</b> · ${who} wins · others finishing`
      : `${FLAG} <b>Final</b> · ${who} wins` + (loop !== 'stop'
        ? ` · ${loop === 'weekend' ? 'practice' : 'next race'} in ${Math.max(0, Math.ceil(NEXT_RACE_DELAY - (performance.now() / 1000 - raceDoneAt)))} s` : '');
  } else if (weekendPractice) {
    status = `<b>Practice</b> · ${weekendPractice.roundsLeft} practice rounds until the race · drivers and crew chiefs learning`;
  }
  $('hud').innerHTML = `<b>${trackName}</b> · ${track.length.toFixed(0)} m · ${world.cars.length} cars · ${session} · ${speed}×${following}<br>${status}`;
}

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
  const host = $('techniques');
  const shown: TeamEntry[] = [];
  if (selected) shown.push(selected);
  for (const car of runningOrder()) {
    const t = carEntry.get(car)!;
    if (shown.length >= TECHNIQUE_SLOTS) break;
    if (!shown.includes(t)) shown.push(t);
  }
  const key = shown.map((t) => `${t.id}:${t.driver}`).join(',');
  if (host.dataset.key !== key) {
    host.dataset.key = key;
    host.innerHTML = shown.map(() => '<div class="tech"><canvas width="240" height="240"></canvas><div></div></div>').join('');
  }
  host.querySelectorAll<HTMLCanvasElement>('canvas').forEach((cv, i) => {
    const t = shown[i];
    const driver = roster.driverOf(t);
    const h = technique.get(driver.id);
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
    const lineage = driver.mentor ? ` · from ${driver.mentor}` : '';
    (cv.nextElementSibling as HTMLElement).innerHTML =
      `${carLabel(t)} ${driver.name}<br>${caption} · ${driver.rounds}r${lineage}`;
  });
}

// ---------- Controls ----------

/** Re-render callbacks for every button group, so state loaded at boot shows correctly. */
const buttonGroups: Array<() => void> = [];

function buttonGroup<T>(hostId: string, options: Array<[string, T]>, current: () => T, onPick: (v: T) => void): () => void {
  const host = $(hostId);
  const render = () => {
    host.innerHTML = '';
    for (const [label, value] of options) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = current() === value ? 'on' : '';
      b.onclick = () => { onPick(value); render(); };
      host.appendChild(b);
    }
  };
  render();
  buttonGroups.push(render);
  return render;
}

buttonGroup('trackButtons', Object.keys(TRACKS).map((k) => [k, k] as [string, string]), () => trackName, (name) => {
  trackName = name;
  track = new Track(TRACKS[name]);
  renderer.setTrack(track);
  buildWorld();
});
buttonGroup('fieldButtons', FIELD_SIZES.map((n) => [String(n), n] as [string, number]), () => fieldSize, (n) => {
  fieldSize = n;
  roster.ensureTeams(n);
  if (selected && !field().includes(selected)) selected = null;
  persist();
  renderTeams();
  buildWorld();
  if (worker) { stopPractice(); startPractice(); }
});
buttonGroup('speedButtons', [['1×', 1], ['4×', 4], ['16×', 16], ['64×', 64]], () => speed, (s) => { speed = s; });
buttonGroup('zoomButtons', [['Full', 1], ['2×', 2], ['4×', 4], ['8×', 8]], () => zoom, (z) => { zoom = z; focus = null; });
buttonGroup('dotButtons', [['Real size', 'real'], ['Legible', 'legible']] as Array<[string, DotMode]>,
  () => renderer.dotMode, (m) => { renderer.dotMode = m; });
buttonGroup('modeButtons', [['Race', 'race'], ['Practice', 'practice'], ['Ghosts', 'ghost']] as Array<[string, Mode]>,
  () => mode, (m) => { mode = m; weekendPractice = null; buildWorld(); });
buttonGroup('lapButtons', [['20', 20], ['50', 50], ['100', 100], ['200', 200]], () => raceLaps, (n) => {
  raceLaps = n;
  if (mode === 'race') buildWorld();
});
buttonGroup('paceButtons', [['Real', 1], ['4×', 4], ['8×', 8]], () => pace, (p) => { pace = p; buildWorld(); });
buttonGroup('autoButtons', [['Weekends', 'weekend'], ['Race after race', 'races'], ['Stop', 'stop']] as Array<[string, Loop]>,
  () => loop, (l) => { loop = l; });
$('toggleInputs').onclick = (e) => {
  renderer.showInputs = !renderer.showInputs;
  (e.target as HTMLElement).className = renderer.showInputs ? 'on' : '';
};
$('clearMarks').onclick = () => renderer.clearMarks();
$('restart').onclick = () => { $('teamsNote').textContent = ''; buildWorld(); };
$('tower').onclick = (e) => {
  const row = (e.target as HTMLElement).closest('tr');
  if (!row) return;
  const t = roster.teams.find((x) => x.id === Number(row.dataset.team)) ?? null;
  selected = selected === t ? null : t;
  focus = null;
};

// ---------- Practice worker ----------

let worker: Worker | null = null;
let lastPersist = 0;

/** Championship bookkeeping when a race ends; runs the off-season after the final round. */
function finishRaceForSeason(): void {
  if (!race) return;
  raceRecorded = true;
  const results = race.standings().map((st) => {
    const t = carEntry.get(st.car)!;
    return { team: t.id, driver: t.driver, chief: t.chief, spotter: t.spotter, position: st.position, status: st.status, laps: st.laps };
  });
  recordRace(season, trackName, race.laps, results);
  if (seasonComplete(season)) {
    const news = offSeason(season, roster, field());
    radioFeed.unshift(...news.reverse().map((text) => ({ time: world.time, team: null, text })));
    season = newSeason(Object.keys(TRACKS), ROUNDS_PER_TRACK, season);
    renderTeams();
  }
  persist();
  renderSeason();
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

/** Race weekend: practice on the season's next track, then race there. */
function startWeekendPractice(): void {
  trackName = nextTrack(season);
  track = new Track(TRACKS[trackName]);
  renderer.setTrack(track);
  mode = 'practice';
  buildWorld();
  buttonGroups.forEach((render) => render());
  weekendPractice = { roundsLeft: WEEKEND_PRACTICE_ROUNDS };
  if (!worker) startPractice();
}

function finishWeekendPractice(): void {
  weekendPractice = null;
  stopPractice();
  mode = 'race';
  buildWorld();
  buttonGroups.forEach((render) => render());
}

function startPractice(): void {
  const drivers = field().map((t) => roster.driverOf(t));
  const teams = field();
  const chiefs = teams.map((t) => roster.chiefOf(t));
  worker = new Worker(new URL('../ai/practice.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<PracticeRound>) => {
    const r = e.data;
    const lines = r.drivers.map((d) => {
      const driver = drivers[d.index];
      driver.weights.set(d.weights);
      driver.rounds = d.rounds;
      driver.licensed = d.licensed;
      if (d.graduated) {
        radioFeed.unshift({ time: world.time, team: null, text: `${driver.name} (#${teams[d.index].livery.number}) earned a license after ${d.rounds} lessons` });
      }
      const school = d.rookie ? ` <span class="muted">rookie school, lesson ${d.rounds}, walls ×${r.damageScale.toFixed(2)}</span>` : '';
      return `${carLabel(teams[d.index])} ${driver.name}: ${d.bestLaps.map(fmt).join(' / ')}${school}`;
    });
    for (const c of r.chiefs) {
      const chief = chiefs[c.index];
      if (chief.brain.kind !== 'neural') continue;
      chief.brain.weights.set(c.weights);
      chief.rounds = c.rounds;
      lines.push(`${carLabel(teams[c.index])} crew chief ${chief.name}: strategy race ${((c.relativeTime - 1) * 100).toFixed(1)}% off the best`);
    }
    $('practiceStatus').innerHTML = `round ${r.round} · walls ×${r.damageScale.toFixed(2)} · ${(r.elapsedMs / 1000).toFixed(1)}s/round<br>`
      + `practising now (best laps speedway / short / flat):<br>${lines.join('<br>')}`;
    if (performance.now() - lastPersist > 5000) { persist(); lastPersist = performance.now(); }
    if (weekendPractice && --weekendPractice.roundsLeft <= 0) finishWeekendPractice();
  };
  const msg: PracticeRequest = {
    type: 'start',
    seed: (Math.random() * 2 ** 32) >>> 0,
    traffic: true,
    drivers: drivers.map((d) => ({ weights: Array.from(d.weights), rounds: d.rounds, licensed: d.licensed })),
    chiefs: chiefs.flatMap((c, index) => (c.brain.kind === 'neural' ? [{ index, weights: Array.from(c.brain.weights), rounds: c.rounds }] : [])),
  };
  worker.postMessage(msg);
  $('practice').textContent = 'Stop practice';
  $('practice').className = 'on';
}

function stopPractice(): void {
  worker?.terminate();
  worker = null;
  persist();
  $('practice').textContent = 'Start practice';
  $('practice').className = '';
}

$('practice').onclick = () => {
  weekendPractice = null; // manual control takes over from the weekend loop
  if (worker) stopPractice(); else startPractice();
};
$('newDrivers').onclick = () => {
  stopPractice();
  roster.freshDriversForAll();
  technique.clear();
  persist();
  renderTeams();
  buildWorld();
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
  const wasPracticing = !!worker;
  stopPractice();
  roster = loaded;
  roster.ensureTeams(fieldSize);
  selected = null;
  technique.clear();
  persist();
  renderTeams();
  buildWorld();
  if (wasPracticing) startPractice();
};

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
  if (upgraded) radioFeed.unshift({ time: 0, team: null, text: `${upgraded} crew chiefs switched to learned strategy (descended from the trained chiefs)` });
  if (params.has('field')) fieldSize = Number(params.get('field'));
  if (params.has('zoom')) zoom = Number(params.get('zoom'));
  if (params.has('laps')) raceLaps = Number(params.get('laps'));
  if (params.has('pace')) pace = Number(params.get('pace'));
  roster.ensureTeams(fieldSize);
  persist();
  renderer.setTrack(track);
  buildWorld();
  // ?warm=N pre-simulates N seconds (handy for screenshots and jumping into a session).
  const warm = Number(params.get('warm') ?? 0);
  for (let k = 0; k < warm / P.DT; k++) {
    simulateStep();
    if (k % 120 === 0) serviceCars();
  }
  buttonGroups.forEach((render) => render());
  renderTeams();
  renderSeason();
  updateCamera();
  updateTower();
  drawTechniques();
  drawRadio();
  window.addEventListener('resize', () => renderer.resize());
  setInterval(updateTower, 200);
  setInterval(drawTechniques, 500);
  setInterval(drawRadio, 250);
  requestAnimationFrame(frame);
}
void boot();
