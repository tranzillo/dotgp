// Preload for incidents.ts: wrecks under caution in any field (a field of teachers never makes its own). Every
// WRECK_EVERY seconds of green (default 150) a debris caution, and once the field is in line one or two of its cars
// wrecked across the track somewhere clear of traffic (src/school/wreckDrill.ts), as the wreck drills do. With
// cautionWrecks.ts, how the field goes by them.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/wreckDrops.ts --import ./scripts/cautionWrecks.ts \
//     scripts/incidents.ts teacher:public/drivers/stable-candidate-v8-lines.json --tracks speedway --seeds 2 --field 40 --rules 1
import { Rng } from '../src/ai/rng';
import { PHYSICS as P } from '../src/sim/constants';
import { World } from '../src/sim/world';
import { wreckInLine } from '../src/school/wreckDrill';

const every = Number(process.env.WRECK_EVERY ?? 150);
const state = new WeakMap<World, { green: number; due: boolean; rng: Rng }>();
const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  const ctl = this.control;
  if (!ctl) return;
  const s = state.get(this) ?? state.set(this, { green: 0, due: false, rng: new Rng(Math.round(this.track.length) * 7919 + this.cars.length) }).get(this)!;
  if (ctl.flag === 'green' && this.time > 60) {
    s.green += P.DT;
    if (s.green >= every) { s.green = 0; ctl.debrisCaution(); s.due = true; }
  }
  if (s.due && ctl.flag === 'caution' && ctl.pickedUp) { s.due = false; wreckInLine(this, s.rng, () => true); }
};
