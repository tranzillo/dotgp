import type { Standing } from '../sim/race';
import type { Roster, TeamEntry } from './roster';

/**
 * The idle game's long arc: seasons of race weekends, championship points,
 * careers for every agent, and an off-season where weak seats are refilled
 * by rookies descended from the season's best.
 */
export interface RaceResultEntry {
  team: number;
  driver: string;
  chief: string;
  spotter: string;
  position: number;
  status: Standing['status'];
  laps: number;
}

export interface RaceRecord {
  season: number;
  round: number;
  track: string;
  laps: number;
  results: RaceResultEntry[];
}

export interface Career {
  starts: number;
  wins: number;
  top5: number;
  dnfs: number;
  points: number;
  seasons: number;
  titles: number;
}

export interface SeasonState {
  number: number;
  /** Track for each round, in order. */
  schedule: string[];
  /** Races completed this season. */
  races: RaceRecord[];
  teamPoints: Record<number, number>;
  driverPoints: Record<string, number>;
  chiefPoints: Record<string, number>;
  careers: Record<string, Career>;
  /** Past champions: season number -> driver name and car number. */
  champions: Array<{ season: number; driver: string; number: number; points: number }>;
}

const WIN_BONUS = 5;
const RELEGATED_DRIVERS = 2;
/** How much sharper a spotter gets per season of experience (fraction of the gap to perfect). */
const SPOTTER_GROWTH = 0.15;

export function newSeason(tracks: string[], roundsPerTrack: number, previous?: SeasonState): SeasonState {
  const schedule: string[] = [];
  for (let r = 0; r < roundsPerTrack; r++) schedule.push(...tracks);
  return {
    number: (previous?.number ?? 0) + 1,
    schedule,
    races: [],
    teamPoints: {},
    driverPoints: {},
    chiefPoints: {},
    careers: previous?.careers ?? {},
    champions: previous?.champions ?? [],
  };
}

/** Points for a finishing position: everyone who starts scores, winners most. */
export function pointsFor(position: number, fieldSize: number, status: Standing['status']): number {
  const base = Math.max(1, fieldSize + 3 - position);
  return status === 'out' ? Math.max(1, Math.floor(base / 2)) : base + (position === 1 ? WIN_BONUS : 0);
}

function career(s: SeasonState, id: string): Career {
  return (s.careers[id] ??= { starts: 0, wins: 0, top5: 0, dnfs: 0, points: 0, seasons: 0, titles: 0 });
}

export function recordRace(s: SeasonState, track: string, laps: number, results: RaceResultEntry[]): RaceRecord {
  const record: RaceRecord = { season: s.number, round: s.races.length + 1, track, laps, results };
  s.races.push(record);
  for (const r of results) {
    const pts = pointsFor(r.position, results.length, r.status);
    s.teamPoints[r.team] = (s.teamPoints[r.team] ?? 0) + pts;
    s.driverPoints[r.driver] = (s.driverPoints[r.driver] ?? 0) + pts;
    s.chiefPoints[r.chief] = (s.chiefPoints[r.chief] ?? 0) + pts;
    for (const id of [r.driver, r.chief, r.spotter]) {
      const c = career(s, id);
      c.starts++;
      c.points += pts;
      if (r.position === 1) c.wins++;
      if (r.position <= 5) c.top5++;
      if (r.status === 'out') c.dnfs++;
    }
  }
  return record;
}

export const seasonComplete = (s: SeasonState) => s.races.length >= s.schedule.length;
export const nextTrack = (s: SeasonState) => s.schedule[Math.min(s.races.length, s.schedule.length - 1)];

export function driverStandings(s: SeasonState): Array<{ driver: string; points: number }> {
  return Object.entries(s.driverPoints).map(([driver, points]) => ({ driver, points })).sort((a, b) => b.points - a.points);
}

export function teamStandings(s: SeasonState, teams: TeamEntry[]): Array<{ team: TeamEntry; points: number }> {
  return teams.map((team) => ({ team, points: s.teamPoints[team.id] ?? 0 })).sort((a, b) => b.points - a.points);
}

/**
 * Off-season. Crowns the champion, credits a season to everyone who raced,
 * releases the lowest-scoring drivers in favour of rookies descended from the
 * top drivers, replaces the worst crew chief with a protégé of the best, and
 * lets spotters grow sharper. Returns broadcast lines describing the moves.
 */
export function offSeason(s: SeasonState, roster: Roster, field: TeamEntry[]): string[] {
  const news: string[] = [];
  const standings = driverStandings(s).filter((e) => roster.drivers.has(e.driver));
  if (standings.length) {
    const champ = roster.drivers.get(standings[0].driver)!;
    const team = field.find((t) => t.driver === champ.id);
    career(s, champ.id).titles++;
    s.champions.push({ season: s.number, driver: champ.name, number: team?.livery.number ?? 0, points: standings[0].points });
    news.push(`Season ${s.number} champion: ${champ.name}${team ? ` (#${team.livery.number})` : ''}, ${standings[0].points} pts`);
  }
  for (const t of field) for (const id of [t.driver, t.chief, t.spotter]) career(s, id).seasons++;

  // Drivers: the bottom of the table loses their seats to rookies from the top.
  const ranked = field.map((t) => ({ t, pts: s.driverPoints[t.driver] ?? 0 })).sort((a, b) => b.pts - a.pts);
  const mentors = ranked.slice(0, 3).map((e) => roster.driverOf(e.t));
  for (const { t } of ranked.slice(-RELEGATED_DRIVERS)) {
    if (field.length <= RELEGATED_DRIVERS + 1) break;
    const out = roster.driverOf(t);
    const mentor = roster.pick(mentors);
    const rookie = roster.descendantDriver(mentor);
    roster.seat(t, 'driver', rookie.id);
    news.push(`#${t.livery.number} releases ${out.name}; signs rookie ${rookie.name} (trained in ${mentor.name}'s style)`);
  }

  // Crew chiefs: the worst strategist makes way for a protégé of the best.
  const chiefsRanked = field.map((t) => ({ t, pts: s.chiefPoints[t.chief] ?? 0 })).sort((a, b) => b.pts - a.pts);
  if (chiefsRanked.length >= 4) {
    const best = roster.chiefOf(chiefsRanked[0].t);
    const worstTeam = chiefsRanked[chiefsRanked.length - 1].t;
    const outgoing = roster.chiefOf(worstTeam);
    const protege = roster.protegeChief(best);
    roster.seat(worstTeam, 'chief', protege.id);
    news.push(`#${worstTeam.livery.number} replaces crew chief ${outgoing.name} with ${protege.name}, a protégé of ${best.name}`);
  }

  // Spotters learn the job.
  for (const t of field) roster.seasonedSpotter(roster.spotterOf(t), SPOTTER_GROWTH);
  return news;
}
