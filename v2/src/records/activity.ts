/**
 * The permanent record of everything agents do: an append-only log of
 * activity records, one per agent per thing that happened. Careers, growth
 * curves and (later) statistics pages and telemetry are all derived from it;
 * nothing here is ever edited after the fact.
 *
 * Pure data and logic. Storage is pluggable: IndexedDB in the browser
 * (records/idbStore.ts), in memory for tests and headless scripts.
 */

export type AgentRole = 'driver' | 'spotter' | 'chief';

/** Kinds of event an agent can take part in. */
export type EventType = 'school' | 'practice' | 'race' | 'championship' | 'ghost';

/** The event a record came from. */
export interface EventRef {
  id: string;
  type: EventType;
  label: string;
  /** Track name, for events on one track. */
  track?: string;
  /** Containing event (a championship, for its races). */
  parent?: string;
}

export interface RaceData {
  track: string;
  /** Race distance and field size. */
  raceLaps: number;
  starters: number;
  position: number;
  status: 'finished' | 'running' | 'out' | 'pit';
  /** Laps completed. */
  laps: number;
  /** Best and average lap (s), null without a timed lap. */
  bestLap: number | null;
  avgLap: number | null;
  stops: number;
  wallHits: number;
  /** Health at the end (drivers). */
  health: number;
  points?: number;
  season?: number;
  round?: number;
}

export interface PracticeData {
  /** Tracks practised on and the best lap on each (null: no clean lap). */
  tracks: string[];
  bestLaps: Array<number | null>;
  /** Practice score this round (laps of progress, less damage). */
  fitness: number;
  /** Rookie school round (solo, soft walls) rather than practice in traffic. */
  rookie: boolean;
  /** Wall damage scale this round (1 = full). */
  walls: number;
}

/** A driving-school round. */
export interface LessonData {
  lesson: string;
  track: string;
  /** Lesson score this round (laps of progress, less damage). */
  fitness: number;
  laps: number;
  bestLap: number | null;
  health: number;
  /** Wall damage scale (1 = full). */
  walls: number;
  /** Of the student's practice variations this round, how many beat it. */
  beaten: number;
  variations: number;
}

interface RecordBase {
  /** Store key, assigned when stored. */
  id?: number;
  /** Wall-clock time (ms since epoch). */
  time: number;
  agent: string;
  role: AgentRole;
  event?: EventRef;
  /** The agent's brain version: training rounds it had completed at the time. */
  brain?: number;
}

export type ActivityRecord = RecordBase & (
  | { kind: 'joined'; data: { name: string; origin: 'rookie' | 'descendant' | 'protege' | 'recruit'; mentor: string | null } }
  | { kind: 'seat'; data: { action: 'signed' | 'released'; team: number; car: number } }
  | { kind: 'practice'; data: PracticeData }
  | { kind: 'lesson'; data: LessonData }
  | { kind: 'licensed'; data: { lessons: number } }
  | { kind: 'strategy'; data: { relativeTime: number } }
  /** Learned while racing: one step (several compared lap pairs). */
  | { kind: 'learning'; data: { source: 'race'; track: string; step: number } }
  | { kind: 'race'; data: RaceData }
  | { kind: 'season'; data: { season: number; position: number; points: number; champion: boolean } }
);

export type ActivityKind = ActivityRecord['kind'];

/** Where activity records live. */
export interface ActivityStore {
  append(records: ActivityRecord[]): Promise<void>;
  /** An agent's records, oldest first. */
  forAgent(agent: string): Promise<ActivityRecord[]>;
  count(): Promise<number>;
}

export class MemoryActivityStore implements ActivityStore {
  private readonly records: ActivityRecord[] = [];

  async append(records: ActivityRecord[]): Promise<void> {
    for (const r of records) this.records.push({ ...r, id: this.records.length + 1 });
  }

  async forAgent(agent: string): Promise<ActivityRecord[]> {
    return this.records.filter((r) => r.agent === agent);
  }

  async count(): Promise<number> {
    return this.records.length;
  }
}

type NewRecord = ActivityRecord extends infer R ? R extends ActivityRecord ? Omit<R, 'time' | 'id'> & { time?: number } : never : never;

/**
 * The log callers write to. Recording is synchronous and cheap (records are
 * buffered); flush() hands them to the store, and reads flush first so they
 * always see everything recorded so far.
 */
export class ActivityLog {
  private pending: ActivityRecord[] = [];
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly store: ActivityStore, private readonly now: () => number = () => Date.now()) {}

  record(r: NewRecord): void {
    this.pending.push({ ...r, time: r.time ?? this.now() } as ActivityRecord);
  }

  flush(): Promise<void> {
    if (!this.pending.length) return this.flushing;
    const batch = this.pending;
    this.pending = [];
    this.flushing = this.flushing.then(() => this.store.append(batch)).catch(() => {
      // Storage refused (quota, private mode): keep the records for the next try.
      this.pending.unshift(...batch);
    });
    return this.flushing;
  }

  async forAgent(agent: string): Promise<ActivityRecord[]> {
    await this.flush();
    return this.store.forAgent(agent);
  }

  count(): Promise<number> {
    return this.flush().then(() => this.store.count());
  }
}

// ---------- derived views ----------

export interface AgentSummary {
  joined: ActivityRecord | null;
  licensedAfter: number | null;
  races: { starts: number; wins: number; top5: number; dnfs: number; avgFinish: number | null; bestFinish: number | null; points: number };
  practice: { rounds: number; rookieRounds: number };
  strategy: { rounds: number };
  /** Learning steps taken while racing. */
  raceLearning: number;
  titles: number;
  /** Best lap ever recorded on each track (practice or race), and when. */
  bestLaps: Record<string, { time: number; at: number; source: 'practice' | 'race' }>;
  first: number | null;
  last: number | null;
}

/** Fold an agent's records into career totals and personal bests. */
export function summarize(records: ActivityRecord[]): AgentSummary {
  const s: AgentSummary = {
    joined: null, licensedAfter: null,
    races: { starts: 0, wins: 0, top5: 0, dnfs: 0, avgFinish: null, bestFinish: null, points: 0 },
    practice: { rounds: 0, rookieRounds: 0 },
    strategy: { rounds: 0 },
    raceLearning: 0,
    titles: 0,
    bestLaps: {},
    first: records.length ? records[0].time : null,
    last: records.length ? records[records.length - 1].time : null,
  };
  let finishSum = 0;
  const best = (track: string, time: number | null, at: number, source: 'practice' | 'race') => {
    if (time === null || !Number.isFinite(time)) return;
    const cur = s.bestLaps[track];
    if (!cur || time < cur.time) s.bestLaps[track] = { time, at, source };
  };
  for (const r of records) {
    switch (r.kind) {
      case 'joined': s.joined = r; break;
      case 'licensed': s.licensedAfter = r.data.lessons; break;
      case 'practice':
        s.practice.rounds++;
        if (r.data.rookie) s.practice.rookieRounds++;
        r.data.tracks.forEach((t, i) => best(t, r.data.bestLaps[i], r.time, 'practice'));
        break;
      case 'lesson':
        s.practice.rounds++;
        if (r.data.lesson === 'rookie') s.practice.rookieRounds++;
        best(r.data.track, r.data.bestLap, r.time, 'practice');
        break;
      case 'strategy': s.strategy.rounds++; break;
      case 'learning': s.raceLearning++; break;
      case 'race': {
        const d = r.data;
        s.races.starts++;
        if (d.position === 1) s.races.wins++;
        if (d.position <= 5) s.races.top5++;
        if (d.status === 'out') s.races.dnfs++;
        s.races.points += d.points ?? 0;
        finishSum += d.position;
        s.races.bestFinish = Math.min(s.races.bestFinish ?? Infinity, d.position);
        best(d.track, d.bestLap, r.time, 'race');
        break;
      }
      case 'season': if (r.data.champion) s.titles++; break;
      case 'seat': break;
    }
  }
  if (s.races.starts) s.races.avgFinish = finishSum / s.races.starts;
  return s;
}

/**
 * Best lap on one track as the agent improved: one point per record that
 * set a lap there, as [brain version (or time), lap time, running best].
 */
export function lapProgression(records: ActivityRecord[], track: string): Array<{ x: number; lap: number; best: number }> {
  const out: Array<{ x: number; lap: number; best: number }> = [];
  let best = Infinity;
  for (const r of records) {
    let lap: number | null = null;
    if (r.kind === 'practice') { const i = r.data.tracks.indexOf(track); lap = i >= 0 ? r.data.bestLaps[i] : null; }
    else if (r.kind === 'race' && r.data.track === track) lap = r.data.bestLap;
    else if (r.kind === 'lesson' && r.data.track === track) lap = r.data.bestLap;
    if (lap === null || !Number.isFinite(lap)) continue;
    best = Math.min(best, lap);
    out.push({ x: r.brain ?? r.time, lap, best });
  }
  return out;
}

/** Keep at most n points, evenly spaced, always keeping the last. */
export function downsample<T>(points: T[], n: number): T[] {
  if (points.length <= n) return points;
  const out: T[] = [];
  for (let k = 0; k < n - 1; k++) out.push(points[Math.floor((k * (points.length - 1)) / (n - 1))]);
  out.push(points[points.length - 1]);
  return out;
}
