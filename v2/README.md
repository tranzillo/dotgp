# DotGP v2 — oval racing with learned drivers

Successor to the prototype in the parent folder. Phase 1 spike: physics + track model + drivers that learn raw control.

```bash
npm install
npm run dev          # viewer at http://localhost:5173  (URL options: ?warm=60&field=24&zoom=4&laps=50&pace=4&focusS=0)
npm test             # physics + contact tests
npm run evolve       # headless genetic algorithm (kept for comparison; stalls with honest walls)
npx tsx scripts/practice.ts --rounds 400   # headless ES practice (solo ghosts), saves runs/*.json
npx tsx scripts/practice.ts --traffic 1 --pairs 8 --seconds 60 --lr 0.01 --from <file>   # practice in traffic
npx tsx scripts/race.ts <file> --track short --laps 50 --copies 3 --pace 4   # headless race: contact, pits, crew chiefs
npx tsx scripts/chiefs.ts --apprentice 80 --rounds 200 --sigma 0.05 --lr 0.01   # crew chiefs: imitate a veteran, then learn by ES
npx tsx scripts/inspect.ts runs/<file>.json [--track short]   # how champions drive
npx tsx scripts/trace.ts runs/<file>.json <lineage> <track>   # step-by-step trace
```

## Layout

| Path | What |
|---|---|
| `src/sim/track.ts` | Oval from a curvature profile (straights, clothoid easements, arcs). Track frame `(s, d)`, progressive banking, surfaces (track/apron/pit/grass), pit layout, O(1) projection |
| `src/sim/car.ts` | Dot car: friction circle, banking normal load, engine power curve, quadratic drag, direction-weighted tire wear, fuel mass, directional damage |
| `src/sim/collisions.ts` | Analytic outer wall and two-sided pit wall with solid ends (Coulomb scrape), car-car impulses, drafting |
| `src/sim/world.ts` | Fixed 120 Hz step, drivers decide at 30 Hz, lap timing, pit cycle (box, service, release), event feed |
| `src/sim/race.ts` | Race session: laps, green/checkered flags, classification |
| `src/sim/raceControl.ts` | Race control: flags, pace car, formation slots, caution triggers, wrecker crew (tow to garage) |
| `src/ai/drivers.ts` | `Team` (spotter + driver), `NeuralDriver` (raw travel-frame acceleration), `ScriptedDriver` (baseline only), weight migration |
| `src/ai/pitting.ts` | Crew chief contract + `StrategistCrewChief` (scripted veteran), scripted `PitAutopilot` |
| `src/ai/neuralChief.ts` | Learned crew chief (observations, guardrail: never run dry), apprentice recorder |
| `src/ai/chiefTraining.ts` | Strategy races (ghost races, full distance) and ES for crew chiefs |
| `src/ai/formation.ts` | Formation driver (double file, stopping-distance following, wreck avoidance) and pace car driver |
| `src/ai/lineFollower.ts` | Hand-written path follower used by the scripted baseline and the pit maneuver |
| `src/ai/spotter.ts` | The radio contract (16 channels) and `TowerSpotter`: global view, calls traffic alongside/ahead/behind and wrecks anywhere ahead |
| `src/ai/es.ts` | Evolution strategies: each lineage is one persistent driver improving through practice |
| `src/ai/practice.worker.ts` | Live practice in a Web Worker for the viewer |
| `src/render/renderer.ts` | Track layers, permanent tire-mark layer, follow camera, numbered livery dots |
| `src/render/livery.ts` | Random contrasting fill/border pairs and unique numbers |
| `src/ui/roster.ts` | Agent pools (drivers, spotters, crew chiefs), teams, mix and match, persistence and migration |
| `src/ui/season.ts` | Seasons, points, careers, off-season (relegated seats go to rookies from the top) |
| `src/ui/main.ts` | Viewer: race weekends (practice where drivers and chiefs learn, then race), timing tower, championship, teams panel, radio |

## Physics in one paragraph

The driver requests an acceleration in its travel frame (x = along velocity, y = toward the infield), magnitude ≤ 1, where 1 demands 125% of current tire capacity. Tires deliver up to `μ · grip · normalLoad`; forward drive is further capped by `P / (m v)`; demanding more than capacity slides (less force, more wear, darker marks). Banking adds `normalLoad · sin(bank)` toward the infield for free, and `normalLoad = g cos(bank) + v²κ sin(bank)` grows with cornering speed, so at the neutral speed the banking alone carries the car. Tire wear scales with tire work × speed, weighted lateral 1.0 / braking 0.35 / drive 0.2.

## Track layout

Counterclockwise, start/finish mid front straight. No inner wall: past the apron is grass (45% grip, heavy drag, bumps). Pit entry leaves the apron at turn 4 exit; the pit wall runs along the front straight just inside the racing surface (two-sided, solid ends); pit road behind it (limiter 22 m/s, boxes every 12 m); the exit narrows back to the apron, which is the blend lane through turns 1-2 onto the back straight. Progress only counts distance actually driven, so cutting the infield earns nothing.

## Teams

Drivers, spotters and crew chiefs are separate agents with names and careers; a team is a car with one of each, and any seat can be reassigned in the Teams panel. Spotters differ in how early they call traffic and wrecks (same radio scale, shorter range). Crew chiefs are either scripted veterans or learned (apprenticed to the veteran, then improved by ES in strategy races).


Each car is a team: crew chief (strategy: when to pit, tires/fuel/repairs, once a lap before turn 3), spotter (global tower view, fills the radio), driver (learned network). During a pit cycle a scripted maneuver drives from the call to the blend-lane exit; races use a pace multiplier on tire wear and fuel burn (4x puts the speedway fuel window at ~13 laps).

## Race control

Races start behind the pace car: the field forms up double file, runs a pace lap, the pace car pulls into pit road at turn 4 exit and the green flies when the leader crosses the line. A wreck (or a car stopped on track) brings out the caution: everyone switches to formation driving (scripted, like the pit maneuver), the pace car comes out from pit road ahead of the leader, and wreckers drive out along the apron, hook the wreck and tow it to the garage via the escape lane or pit road. Once the track is clear (and at least two caution laps have run) it's one to go; the pace car pulls off and the leader takes the field to the green. Pit exit merging waits for the spotter's clear call.

## Infield

Garage lot behind pit road (wrecks are parked there), escape lane from the back-straight apron across the infield. Progress only counts distance driven, so neither is a shortcut.

## Rookie school

Brand-new drivers (random wiring, plus an instinct to accelerate and no attention to the radio yet) can't drive, and traffic practice teaches them nothing. Until they hold a license they practise solo as ghosts, with soft walls that harden over their own first 60 lessons, a damage penalty that starts gentle (so driving and crashing beats sitting still) and ramps to the race value over the next 60 lessons (learn to drive, then learn to drive clean), 16 variation pairs and 80 s trials, and they get first call on practice slots. They earn the license by lapping every track cleanly (90%+ health) at full damage, then practise in traffic like everyone else. Drivers descended from a trained mentor are licensed from the start. `npx tsx scripts/rookies.ts --field 8` checks how fast a fresh field graduates.
