import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Track } from '../src/sim/track';
import { circuitCenterline } from '../src/trackgen/circuit';
import { integrate } from '../src/trackgen/course';
import { circuitFromSurvey, fitError, fitSurvey, parseSurvey, REAL_TRACKS, realLayout } from '../src/trackgen/realtrack';
import { validateLayout } from '../src/trackgen/validate';

const csvOf = (id: string) => readFileSync(`public/tracks/${REAL_TRACKS.find((t) => t.id === id)!.file}`, 'utf8');

describe('real tracks from survey data', () => {
  it('lays a circuit on its surveyed line, closed, within a few metres', () => {
    const made = circuitFromSurvey(parseSurvey(csvOf('monza')), { name: 'Monza' })!;
    expect(made).not.toBeNull();
    expect(made.mirrored).toBe(true); // Monza runs clockwise
    const lap = integrate(circuitCenterline(made.params).sections, made.origin.x, made.origin.y, made.origin.h, 4).points;
    const off = lap.map(([x, y]) => Math.sqrt(Math.min(...made.resampled.map(([u, v]) => (x - u) ** 2 + (y - v) ** 2))));
    expect(off.reduce((a, b) => a + b, 0) / off.length).toBeLessThan(4);
    const t = new Track(realLayout(REAL_TRACKS.find((r) => r.id === 'monza')!, csvOf('monza')));
    expect(Math.abs(t.length - 5790)).toBeLessThan(30);
    expect(t.closureError).toBeLessThan(1);
  });

  it('lays an oval from its survey with published banking', () => {
    const daytona = REAL_TRACKS.find((t) => t.id === 'daytona')!;
    expect(fitError(fitSurvey(parseSurvey(csvOf('daytona')), { smooth: daytona.smooth })).mean).toBeLessThan(3);
    const layout = realLayout(daytona, csvOf('daytona'));
    const t = new Track(layout);
    expect(Math.abs(t.length - 4023)).toBeLessThan(40); // 2.5 miles
    expect(validateLayout(layout, t).filter((p) => p.severity === 'error')).toEqual([]);
    // Banked 31 degrees in the turns.
    let steepest = 0;
    for (let s = 0; s < t.length; s += 10) steepest = Math.max(steepest, t.bankAt(t.indexAt(s), 0));
    expect(steepest * 180 / Math.PI).toBeGreaterThan(28);
  });
});
