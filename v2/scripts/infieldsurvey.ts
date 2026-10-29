// Infield survey: generated ovals of every size: does the infield lay out, what's in it (escape roads, service road,
// links, lots, inner oval, skidpad), does a scripted car lap cleanly, does every way off the oval reach a garage.
// npx tsx scripts/infieldsurvey.ts [seeds per size]
import { ScriptedDriver } from '../src/ai/drivers';
import { Car } from '../src/sim/car';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { generateLayout, rovalLayouts, type ShapedOvalParams } from '../src/trackgen';
const seeds = Number(process.argv[2] ?? 8);
const tally = { gen: 0, err: 0, lapFail: 0, inner: 0, cRing: 0, unreach: 0, rovals: 0, rovalLapFail: 0 };
for (const variant of ['short', 'intermediate', 'speedway', 'superspeedway']) {
  for (let seed = 1; seed <= seeds; seed++) {
    const t0 = performance.now();
    let layout;
    try { layout = generateLayout({ type: 'oval', seed, variant }); } catch (e) { tally.err++; console.log(`${variant} ${seed} ERROR ${(e as Error).message.split('\n').slice(1, 3).join(' | ')}`); continue; }
    const ms = performance.now() - t0;
    tally.gen++;
    const t = new Track(layout);
    const roads = t.roads.roads;
    const esc = roads.filter((r) => r.grade === 'escape').length;
    const full = roads.some((r) => r.id === 'garage-back');
    if (!full) tally.cRing++;
    const links = roads.filter((r) => r.id.startsWith('link')).length;
    const lots = roads.filter((r) => r.id.startsWith('lot-lane')).length;
    const inner = layout.neighbours?.[0];
    if (inner) tally.inner++;
    const unreachable = t.roads.accesses.filter((n) => !t.roads.pathToGarage(n.id)).length;
    tally.unreach += unreachable;
    const world = new World(t, { collisions: false });
    const car = new Car(0);
    car.placeOnTrack(t, t.length - 20, 0);
    world.addCar(car, new ScriptedDriver(0, 0.9));
    while (car.lapsCompleted < 1 && world.time < 300) world.step();
    const lapOk = car.lapsCompleted === 1 && car.health === 1;
    if (!lapOk) tally.lapFail++;
    // Each road course through the infield: a scripted car laps it cleanly too.
    const rovalNotes: string[] = [];
    for (const roval of rovalLayouts(layout)) {
      tally.rovals++;
      const rt = new Track(roval);
      const w = new World(rt, { collisions: false });
      const c = new Car(0);
      c.placeOnTrack(rt, rt.length - 20, 0);
      w.addCar(c, new ScriptedDriver(0, 0.9));
      while (c.lapsCompleted < 1 && w.time < 400) w.step();
      const ok = c.lapsCompleted === 1 && c.health > 0.95;
      if (!ok) tally.rovalLapFail++;
      rovalNotes.push(`${roval.name} ${rt.length.toFixed(0)}m(${(rt.length / t.length).toFixed(2)})${ok ? '' : ` LAP FAIL(laps=${c.lapsCompleted} h=${c.health.toFixed(2)} t=${w.time.toFixed(0)})`}`);
    }
    console.log(`${variant} ${seed} ${(layout.params as unknown as ShapedOvalParams).shape} try=${layout.params.attempt} ${ms.toFixed(0)}ms esc=${esc} ring=${full ? 'full' : 'C'} links=${links} lots=${lots} inner=${inner ? `${inner.name} ${new Track(inner).length.toFixed(0)}m${inner.placement?.angle ? " turned" : ""}` : "-"} skidpad=${layout.surfaces.some((r) => r.id === "skidpad") ? "yes" : "-"} ${lapOk ? '' : 'LAP FAIL'} ${rovalNotes.join(', ')} ${unreachable ? `UNREACHABLE ${unreachable}` : ''}`);
  }
}
console.log(tally);
