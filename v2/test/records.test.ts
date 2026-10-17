import { describe, expect, it } from 'vitest';
import { Rng } from '../src/ai/rng';
import { ActivityLog, lapProgression, MemoryActivityStore, summarize, type EventRef } from '../src/records/activity';
import { Occupancy } from '../src/records/occupancy';
import { Roster, type RosterChange } from '../src/ui/roster';

const race = (position: number, track: string, bestLap: number | null, status: 'finished' | 'out' = 'finished') => ({
  kind: 'race' as const, agent: 'D1', role: 'driver' as const,
  data: { track, raceLaps: 50, starters: 8, position, status, laps: 50, bestLap, avgLap: bestLap, stops: 2, wallHits: 0, health: 1, points: 10 },
});

describe('activity log', () => {
  it('buffers records and returns an agent\'s history oldest first', async () => {
    let t = 1000;
    const log = new ActivityLog(new MemoryActivityStore(), () => t++);
    log.record({ kind: 'joined', agent: 'D1', role: 'driver', data: { name: 'Ari Dahl', origin: 'rookie', mentor: null } });
    log.record({ kind: 'joined', agent: 'D2', role: 'driver', data: { name: 'Bex Holm', origin: 'rookie', mentor: null } });
    log.record({ ...race(3, 'Speedway', 35.2), brain: 40 });
    const d1 = await log.forAgent('D1');
    expect(d1.map((r) => r.kind)).toEqual(['joined', 'race']);
    expect(d1[0].time).toBeLessThan(d1[1].time);
    expect(await log.count()).toBe(3);
  });

  it('summarises a career: results, personal bests, license, titles', () => {
    const records = [
      { kind: 'joined', agent: 'D1', role: 'driver', time: 1, data: { name: 'Ari', origin: 'rookie', mentor: null } },
      { kind: 'practice', agent: 'D1', role: 'driver', time: 2, brain: 10,
        data: { tracks: ['Speedway', 'Short track'], bestLaps: [36.4, null], fitness: 2, rookie: true, walls: 0.2 } },
      { kind: 'licensed', agent: 'D1', role: 'driver', time: 3, data: { lessons: 61 } },
      { ...race(1, 'Speedway', 35.1), time: 4 },
      { ...race(6, 'Short track', 25.9, 'out'), time: 5 },
      { kind: 'season', agent: 'D1', role: 'driver', time: 6, data: { season: 1, position: 1, points: 40, champion: true } },
    ] as Parameters<typeof summarize>[0];
    const s = summarize(records);
    expect(s.races).toMatchObject({ starts: 2, wins: 1, top5: 1, dnfs: 1, bestFinish: 1, avgFinish: 3.5, points: 20 });
    expect(s.licensedAfter).toBe(61);
    expect(s.titles).toBe(1);
    expect(s.practice).toEqual({ rounds: 1, rookieRounds: 1 });
    expect(s.bestLaps.Speedway).toMatchObject({ time: 35.1, source: 'race' });
    expect(s.bestLaps['Short track']).toMatchObject({ time: 25.9 });
  });

  it('tracks a running best lap as the agent improves', () => {
    const records = [36.5, 36.1, 36.3, 35.8].map((lap, i) => ({
      kind: 'practice' as const, agent: 'D1', role: 'driver' as const, time: i, brain: i * 10,
      data: { tracks: ['Speedway'], bestLaps: [lap], fitness: 0, rookie: false, walls: 1 },
    }));
    expect(lapProgression(records, 'Speedway').map((p) => p.best)).toEqual([36.5, 36.1, 36.1, 35.8]);
  });
});

describe('occupancy', () => {
  const race1: EventRef = { id: 'race-1', type: 'race', label: 'Race' };
  const school: EventRef = { id: 'class-1', type: 'school', label: 'Clean laps' };

  it('keeps an agent in one event at a time, all or nothing', () => {
    const occ = new Occupancy();
    expect(occ.claim(race1, ['D1', 'D2'])).toEqual([]);
    // D2 is racing, so the class can't take it, and doesn't take D3 either.
    const conflicts = occ.claim(school, ['D2', 'D3']);
    expect(conflicts).toEqual([{ agent: 'D2', event: race1 }]);
    expect(occ.isFree('D3')).toBe(true);
    // Rejoining your own event is fine.
    expect(occ.claim(race1, ['D1'])).toEqual([]);
    occ.release('race-1');
    expect(occ.claim(school, ['D2', 'D3'])).toEqual([]);
    expect(occ.of('D2')?.id).toBe('class-1');
    expect(occ.participants('class-1').sort()).toEqual(['D2', 'D3']);
  });
});

describe('roster changes', () => {
  it('reports arrivals, signings and releases', () => {
    const roster = new Roster(new Rng(3));
    const changes: RosterChange[] = [];
    roster.onChange = (c) => changes.push(c);
    roster.ensureTeams(2);
    expect(changes.filter((c) => c.type === 'joined')).toHaveLength(6);
    expect(changes.filter((c) => c.type === 'seat' && c.action === 'signed')).toHaveLength(6);

    changes.length = 0;
    const reserve = roster.recruitDriver();
    expect(roster.teamOf('driver', reserve.id)).toBeNull(); // academy: no seat
    const [a, b] = roster.teams;
    const aDriver = a.driver, bDriver = b.driver;
    roster.assign(a, 'driver', bDriver); // swap the two seated drivers
    expect(a.driver).toBe(bDriver);
    expect(b.driver).toBe(aDriver);
    const seats = changes.filter((c) => c.type === 'seat');
    expect(seats.map((c) => c.type === 'seat' && `${c.action}:${c.agent}@${c.team}`)).toEqual([
      `released:${aDriver}@${a.id}`, `signed:${bDriver}@${a.id}`, `released:${bDriver}@${b.id}`, `signed:${aDriver}@${b.id}`,
    ]);
  });
});
