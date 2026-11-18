/**
 * Each car's straight-line performance, from its own physics (stepCar) on a
 * flat 3 km straight: 0-100, 0-200 and 0-300 km/h, top speed, and braking
 * to a stop from 200 and 300 km/h (time and distance), driven at the edge
 * of the tires' grip (no wheelspin, no lock-up), half a tank of fuel.
 *
 *   npx tsx scripts/carperf.ts
 */
import { pathToFileURL } from 'node:url';
import { carSpec } from '../src/sim/carSpec';
import { Car, stepCar } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { applyExperiment, EXPERIMENT } from '../src/sim/experiment';
import type { Track } from '../src/sim/track';
import { ovalTrack } from '../src/trackgen';

const KMH = 1 / 3.6;

/** A flat 3 km straight (an oval of them), as a road course's (the F1 car's package) or an oval's. */
export function testStraight(kind: 'oval' | 'road'): Track {
  const track = ovalTrack({
    straightLength: 3000, turnRadius: 1500, easementLength: 100, width: 20, apronWidth: 8,
    bankInner: 0, bankOuter: 0, bankStraight: 0, name: 'Test straight',
  });
  if (kind === 'road') (track as { kind: string }).kind = 'road';
  return track;
}

export interface StraightLine {
  /** Seconds from a standstill to 100, 200, 300 km/h (Infinity if it never gets there), top speed (km/h). */
  to100: number; to200: number; to300: number; top: number;
  /** Braking to a stop from 200 and 300 km/h: seconds and metres (300: null if it can't reach it). */
  brake200: { t: number; d: number }; brake300: { t: number; d: number } | null;
}

/** The car in use's straight-line performance on a test straight. */
export function straightLine(track: Track): StraightLine {
  const run = (from: number, accelerate: boolean, until: (v: number) => boolean, limit = 120) => {
    const car = new Car(0);
    car.placeOnTrack(track, -1450, 0);
    car.fuel = P.FUEL_CAPACITY / 2;
    car.vx = track.tx[car.trackIdx] * from;
    car.vy = track.ty[car.trackIdx] * from;
    let t = 0, d = 0;
    for (; t < limit && !until(car.speed); t += P.DT) {
      car.inputX = (accelerate ? 1 : -1) / P.OVERDRIVE_MAX;
      car.inputY = 0;
      const v = car.speed;
      stepCar(car, track, P.DT);
      d += ((v + car.speed) / 2) * P.DT;
    }
    return { t, d, v: car.speed };
  };
  const top = run(0, true, () => false, 60).v / KMH;
  const to = (kmh: number) => (top > kmh ? run(0, true, (v) => v >= kmh * KMH).t : Infinity);
  const brake = (kmh: number) => { const r = run(kmh * KMH, false, (v) => v < 0.5); return { t: r.t, d: r.d }; };
  return { to100: to(100), to200: to(200), to300: to(300), top, brake200: brake(200), brake300: top > 300 ? brake(300) : null };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cars: Array<{ name: string; spec: string; kind: 'oval' | 'road' }> = [
    { name: 'classic', spec: '', kind: 'oval' },
    { name: 'cup (670 hp)', spec: 'cup', kind: 'oval' },
    { name: 'f1', spec: 'f1', kind: 'road' },
  ];
  const s = (t: number) => (Number.isFinite(t) ? `${t.toFixed(2)} s` : '  -   ');
  for (const c of cars) {
    EXPERIMENT.spec = '';
    if (c.spec) applyExperiment(`?spec=${c.spec}`);
    const track = testStraight(c.kind);
    const r = straightLine(track);
    console.log(`${c.name.padEnd(13)} ${carSpec(track).name.padEnd(8)} 0-100 ${s(r.to100)}  0-200 ${s(r.to200)}  0-300 ${s(r.to300)}  top ${r.top.toFixed(0)} km/h`
      + `  200-0 ${r.brake200.t.toFixed(2)} s ${r.brake200.d.toFixed(0)} m${r.brake300 ? `  300-0 ${r.brake300.t.toFixed(2)} s ${r.brake300.d.toFixed(0)} m` : ''}`);
  }
}
