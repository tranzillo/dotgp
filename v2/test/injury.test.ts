import { describe, expect, it } from 'vitest';
import { Rng } from '../src/ai/rng';
import { injuryFrom } from '../src/events/injury';
import { Roster } from '../src/ui/roster';

describe('injuries', () => {
  it('nobody is hurt by small hits; the harder the hit, the likelier and the worse', () => {
    const rng = new Rng(9);
    const roll = (hit: number, n = 4000) => Array.from({ length: n }, () => injuryFrom(hit, () => rng.next()));
    expect(roll(0.35).every((x) => x === null)).toBe(true);
    const mid = roll(0.6), big = roll(1.2);
    const rate = (xs: ReturnType<typeof roll>) => xs.filter(Boolean).length / xs.length;
    expect(rate(mid)).toBeGreaterThan(0.05);
    expect(rate(big)).toBeGreaterThan(rate(mid));
    expect(mid.every((x) => !x || x.severity === 'minor')).toBe(true);
    expect(big.some((x) => x?.severity === 'career')).toBe(true);
    expect(big.some((x) => x?.severity === 'serious')).toBe(true);
  });

  it('a stand-in takes an injured driver\'s seat, and the regular gets it back once recovered', () => {
    const r = new Roster(new Rng(4));
    r.ensureTeams(2);
    const academy = r.recruitDriver();
    academy.licensed = true;
    const team = r.teams[0];
    const regular = r.driverOf(team);
    regular.injury = { severity: 'minor', racesLeft: 1 };
    const lines = r.fillSeats(r.teams, () => true);
    expect(team.driver).toBe(academy.id);
    expect(team.regular).toBe(regular.id);
    expect(lines[0]).toMatch(/stands in/);
    expect(r.raceRun()).toEqual([regular]);
    r.fillSeats(r.teams, () => true);
    expect(team.driver).toBe(regular.id);
    expect(team.regular).toBeUndefined();
  });

  it('a career-ending crash gives the seat away for good', () => {
    const r = new Roster(new Rng(5));
    r.ensureTeams(1);
    const team = r.teams[0];
    const gone = r.driverOf(team);
    gone.careerOver = { season: 1, track: 'Short track' };
    r.fillSeats(r.teams, () => true);
    expect(team.driver).not.toBe(gone.id);
    expect(team.regular).toBeUndefined();
    expect(r.drivers.has(gone.id)).toBe(true); // history kept
  });
});
