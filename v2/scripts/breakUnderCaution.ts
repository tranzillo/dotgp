// Preload: a car breaks in the line under caution, over and over. After every BREAK_EVERY s of green a debris caution,
// and once the pace car has the field (picked up), a car in the middle of the running order is broken (health just past
// sound, smoking). With cautionHits.ts: what the field does about a smoking car under caution (teachers' fields have
// next to no cautions of their own).
//   DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/cautionHits.ts --import ./scripts/breakUnderCaution.ts \
//     scripts/incidents.ts teacher:public/drivers/stable-candidate-v5.json --tracks short --seeds 2 --field 40 --rules 1
import { DAMAGE2 } from '../src/sim/damage';
import { World } from '../src/sim/world';

const BREAK_EVERY = 60;
const state = new WeakMap<World, { greenSince: number; broke: boolean }>();
let breaks = 0;
const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  const ctl = this.control;
  if (!ctl) return;
  const s = state.get(this) ?? { greenSince: NaN, broke: true };
  state.set(this, s);
  if (ctl.flag !== 'green') s.greenSince = NaN;
  else if (Number.isNaN(s.greenSince)) s.greenSince = this.time;
  else if (this.time - s.greenSince > BREAK_EVERY) { ctl.debrisCaution(); s.broke = false; }
  if (!s.broke && ctl.flag === 'caution' && ctl.pickedUp) {
    const order = this.cars.filter((c) => !c.retired && c.pit.phase === 'none' && c.health > DAMAGE2.SOUND_ABOVE).sort((a, b) => b.dist - a.dist);
    const car = order[Math.floor(order.length / 2)];
    if (car) { car.health = DAMAGE2.SOUND_ABOVE - 0.1; breaks++; }
    s.broke = true;
  }
};
process.on('exit', () => console.error(`BREAKS ${breaks} cars broken in the line under caution`));
