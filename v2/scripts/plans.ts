// Preload: how long a teacher's lane plan lasts under green, as its intent (passSide) and as the lane it's in (its
// groove), and where and why plans end. Prints PLANS lines at exit. E.g.:
//   DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/plans.ts scripts/incidents.ts \
//     teacher:public/drivers/stable-candidate-v5.json --tracks speedway --seeds 1 --field 40 --rules 1 --laps 40
import { lineAt } from '../src/ai/racingLine';
import { TrafficRacer } from '../src/ai/trafficRacer';
const defs = ['intent', 'groove'] as const;
const st = new Map<TrafficRacer, Record<string, { v: number; since: number }>>();
const whys = new Map<string, number>();
const drops: string[] = [];
const runs: Record<string, number[]> = { intent: [], groove: [] }, changes: Record<string, number> = { intent: 0, groove: 0 };
let carTime = 0;
const decide = TrafficRacer.prototype.decide;
TrafficRacer.prototype.decide = function (this: TrafficRacer, car, world) {
  decide.call(this, car, world);
  if ((world.control && world.control.flag !== 'green') || car.pit.phase !== 'none' || car.retired) return;
  const self = this as any, t = world.time;
  const path = self.path, base = self.lineFor(world.track);
  const groove = path ? Math.sign(lineAt(path, car.s).d - lineAt(base, car.s).d) : 0;
  const now = { intent: this.intent, groove: groove || this.intent };
  let s = st.get(this);
  if (!s) { s = { intent: { v: 0, since: t }, groove: { v: 0, since: t } }; st.set(this, s); }
  for (const k of defs) {
    if (k === 'intent' && now[k] !== s[k].v && s[k].v !== 0) { const w = now[k] === 0 ? (this as any).last.why : (this as any).passOn === (this as any).__on ? 'flip same car' : 'flip new car'; whys.set(w, (whys.get(w) ?? 0) + 1);
      const on = (this as any).__on; if (now[k] === 0 && on) { let ds = on.s - car.s; const L = world.track.length; if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
        const ds5 = ds < -5 ? 'past' : ds < 5 ? 'alongside' : ds < 35 ? 'close' : 'far'; const side = s[k].v * (car.d - on.d) > 0.5 ? 'beside' : Math.abs(car.d - on.d) < 1.5 ? 'inline' : 'wrongside';
        drops.push(`${ds5}/${side}`); } }
    if (now[k] !== s[k].v) { changes[k]++; if (s[k].v !== 0) runs[k].push(t - s[k].since); s[k] = { v: now[k], since: t }; }
  }
  self.__on = self.passOn;
  self.__last ??= t; carTime += Math.min(0.2, t - self.__last); self.__last = t;
};
process.on('exit', () => {
  const m = new Map<string, number>(); for (const d of drops) m.set(d, (m.get(d) ?? 0) + 1);
  console.error('PLANS drop where: ' + [...m].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', '));
  console.error('PLANS dropped because: ' + [...whys].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', '));
  for (const k of defs) {
    const r = runs[k].sort((a, b) => a - b), q = (p: number) => (r[Math.floor(p * (r.length - 1))] ?? 0).toFixed(2);
    console.error(`PLANS ${k}: ${(changes[k] / (carTime / 60)).toFixed(1)} changes a car-minute; plans ${r.length}, median ${q(0.5)} s, p90 ${q(0.9)} s`);
  }
});
