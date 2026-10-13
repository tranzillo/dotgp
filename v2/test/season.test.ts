import { describe, expect, it } from 'vitest';
import { Rng } from '../src/ai/rng';
import { Roster } from '../src/ui/roster';
import { driverStandings, newSeason, offSeason, pointsFor, recordRace, seasonComplete } from '../src/ui/season';

function setup(teams = 6) {
  const roster = new Roster(new Rng(5));
  roster.ensureTeams(teams);
  for (const d of roster.drivers.values()) d.rounds = 100; // experienced, so rookies descend from them
  return roster;
}

function race(roster: Roster, order: number[]) {
  return order.map((teamIndex, i) => {
    const t = roster.teams[teamIndex];
    return { team: t.id, driver: t.driver, chief: t.chief, spotter: t.spotter, position: i + 1, status: 'finished' as const, laps: 20 };
  });
}

describe('season', () => {
  it('scores winners most, everyone something, and DNFs half', () => {
    expect(pointsFor(1, 10, 'finished')).toBeGreaterThan(pointsFor(2, 10, 'finished') + 1);
    expect(pointsFor(10, 10, 'finished')).toBeGreaterThanOrEqual(1);
    expect(pointsFor(3, 10, 'out')).toBeLessThan(pointsFor(3, 10, 'finished'));
  });

  it('tracks standings and careers across rounds', () => {
    const roster = setup();
    const s = newSeason(['A', 'B'], 1);
    recordRace(s, 'A', 20, race(roster, [0, 1, 2, 3, 4, 5]));
    recordRace(s, 'B', 20, race(roster, [0, 2, 1, 3, 4, 5]));
    expect(seasonComplete(s)).toBe(true);
    expect(driverStandings(s)[0].driver).toBe(roster.teams[0].driver);
    expect(s.careers[roster.teams[0].driver].wins).toBe(2);
    expect(s.careers[roster.teams[0].chief].starts).toBe(2);
  });

  it('crowns a champion and refreshes the weakest seats in the off-season', () => {
    const roster = setup();
    const s = newSeason(['A'], 1);
    recordRace(s, 'A', 20, race(roster, [0, 1, 2, 3, 4, 5]));
    const bottomDrivers = [roster.teams[4].driver, roster.teams[5].driver];
    const worstChief = roster.teams[5].chief;
    const spotterBefore = roster.spotterOf(roster.teams[0]).skill.aheadRange;
    const news = offSeason(s, roster, roster.teams);

    expect(s.champions[0].driver).toBe(roster.driverOf(roster.teams[0]).name);
    expect(s.careers[roster.teams[0].driver].titles).toBe(1);
    // Bottom two drivers replaced by rookies from the top three.
    expect(bottomDrivers).not.toContain(roster.teams[4].driver);
    expect(bottomDrivers).not.toContain(roster.teams[5].driver);
    expect(roster.driverOf(roster.teams[5]).mentor).not.toBeNull();
    expect(roster.drivers.has(bottomDrivers[0])).toBe(true); // released, not deleted
    // Worst crew chief replaced by a protégé of the best.
    expect(roster.teams[5].chief).not.toBe(worstChief);
    expect(roster.chiefOf(roster.teams[5]).mentor).toBe(roster.chiefOf(roster.teams[0]).name);
    // Spotters improve.
    expect(roster.spotterOf(roster.teams[0]).skill.aheadRange).toBeGreaterThanOrEqual(spotterBefore);
    expect(news.length).toBeGreaterThanOrEqual(4);

    const next = newSeason(['A'], 1, s);
    expect(next.number).toBe(2);
    expect(next.careers).toBe(s.careers); // careers carry over
    expect(Object.keys(next.driverPoints)).toHaveLength(0);
  });
});
