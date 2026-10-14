import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptWeights } from '../src/ai/drivers';
import { LESSONS } from '../src/school/classroom';
import { cleanTrafficStop, PitTrafficTrial, trafficBaseline } from '../src/school/pitTrafficLesson';
import { presetTrack } from '../src/trackgen';

const bundled: Array<{ weights: number[] }> = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers;
const veteran = () => adaptWeights(Float32Array.from(bundled[0].weights));

describe('pit road in traffic', () => {
  it('the veteran maneuver makes a clean stop in traffic: the bar students are measured against', () => {
    const r = trafficBaseline(presetTrack('speedway'), veteran());
    expect(cleanTrafficStop(r)).toBe(true);
    expect(r.laps).toBeGreaterThan(1);
  });

  it('gives every candidate its own drill in a field, and shows one student\'s', () => {
    const w = veteran();
    const per = 3;
    const trial = new PitTrafficTrial(presetTrack('short'), [w, w.slice(), w.slice(), w.slice(), w.slice(), w.slice()], per, 1);
    expect(trial.drills).toHaveLength(6);
    expect(trial.world).toBe(trial.drills[3].world);
    expect(trial.world.cars).toHaveLength(7); // the student, two pitting, four racing
    expect(trial.shownStudent.pit.phase).toBe('in'); // its stop is called
    for (let k = 0; k < 120; k++) trial.step();
    expect(trial.results()).toHaveLength(6);
  });

  it('is for drivers with a solo pit license, until they pass it', () => {
    const { eligible } = LESSONS.pitTraffic;
    expect(eligible({ licensed: true, pitLicensed: false })).toBe(false);
    expect(eligible({ licensed: true, pitLicensed: true })).toBe(true);
    expect(eligible({ licensed: true, pitLicensed: true, pitTrafficLicensed: true })).toBe(false);
  });
});
