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
npx tsx scripts/incidents.ts --tracks speedway,short --seeds 2 --field 24 --pace 4   # race benchmark: wrecks, tires, fuel, stops, mark coverage
```

## Layout

| Path | What |
|---|---|
| `src/sim/layout.ts` | `TrackLayout`: a track as plain serialisable data (centerline, cross-section, surface regions, walls, pit lane, infield, markings, decor). The contract between generation and everything else |
| `src/sim/centerline.ts` | Closed centerline integrated from a curvature profile (straights, clothoid easements, arcs); track frame `(s, d)`, O(1) projection |
| `src/sim/track.ts` | Runtime track built from any layout: surface lookup, banking, walls, pit and infield features, ready for per-step queries |
| `src/trackgen/` | Track generation: type registry and seeded pipeline with validation (`generator.ts`), reusable stages (`stages.ts`: pit lane, garage, escape lanes, surfaces, walls, markings), the oval type and its size classes (`oval.ts`), names, presets (`index.ts`) |
| `src/sim/car.ts` | Dot car: friction circle, banking normal load, engine power curve, quadratic drag, direction-weighted tire wear, fuel mass, directional damage |
| `src/sim/collisions.ts` | Analytic walls from the layout (one- or two-sided, solid ends) with Coulomb scrape, car-car impulses, drafting |
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
| `src/render/renderer.ts` | Track layers, permanent groove and skid layers, follow camera, numbered livery dots |
| `src/render/marks.ts` | How cars mark the track: a faint, capped groove from tire work, and skids only from real slides (shared with the benchmark) |
| `src/render/livery.ts` | Random contrasting fill/border pairs and unique numbers |
| `src/ui/roster.ts` | Agent pools (drivers, spotters, crew chiefs), teams, mix and match, persistence and migration |
| `src/ui/season.ts` | Seasons, points, careers, off-season (relegated seats go to rookies from the top) |
| `src/records/activity.ts` | The permanent activity log: one record per agent per thing that happened (joined, signed/released, practice round, license, strategy round, race result, season), with the agent's brain version; career summaries and learning curves derived from it |
| `src/records/idbStore.ts` | Activity records in IndexedDB (in-memory store for tests and scripts) |
| `src/records/occupancy.ts` | Who is busy where: an agent is in at most one running event at a time, claimed all-or-nothing |
| `src/ui/agentPage.ts` | An agent's history page: status, career tiles, best lap per track as they learned, recent races, timeline, mentor and protégés |
| `src/ui/main.ts` | Viewer: race weekends (practice where drivers and chiefs learn, then race), timing tower, championship, teams panel, radio |

## Physics in one paragraph

The driver requests an acceleration in its travel frame (x = along velocity, y = toward the infield), magnitude ≤ 1, where 1 demands 125% of current tire capacity. Tires deliver up to `μ · grip · normalLoad`; forward drive is further capped by `P / (m v)`; demanding more than capacity slides (less force, more wear, darker marks). Banking: the sim is the top-down projection of a car on a banked surface. The surface pushes along its normal with a load that comes from how hard the car is actually cornering, `normalLoad = (g cos(bank) + tires⊥ sin(bank)) / cos²(bank)` (last step's tire force across the track; `g cos(bank) + v²κ sin(bank)` when holding a lane), so diving down the banking loads the tires more and drifting up it less; its horizontal part, `normalLoad · sin(bank)`, pushes toward the infield for free, so at the neutral speed `v² = g tan(bank) / κ` the banking alone carries the car. Tires grip in the banked plane: cornering force lies across the slope and only `cos(bank)` of it is horizontal, so the cornering limit matches the textbook banked curve, `v² = gR (sin b + μ cos b) / (cos b − μ sin b)` (tested from 0° to 30°). Banking is worth ~39% of lap time on the speedway. The Debug → Banking view shows it as a heatmap with inside → outside angles, and Debug → Forces draws each car's banking push (amber) against its tire force (cyan). Tire wear is the energy lost to slip: utilisation² × load × speed, utilisation = force / (μ · normalLoad) with cornering force taken in the banked plane, weighted lateral 1.0 / braking 0.35 / drive 0.2. On a flat track that is just (force / μg)²; banking that loads the tires lets them make the same force with less slip, so banked tracks are easier on tires and, where the banking steepens toward the wall, the high line saves tires (on 14° → 28° banking it wears ~18% less than the middle line at the same lap time). Worn tires fade gently to the cliff (life 0.3, 88% cornering grip), then fall away fast to 50% when corded; braking and drive lose only half as much as cornering, so the friction circle becomes an ellipse and a worn car mostly stops turning.

## Track generation

A track is a `TrackLayout` (plain JSON, ~4 KB): the generator writes it, the runtime `Track` reads it, and physics, drivers, race control and the renderer only see its features (surface regions, walls, pit lane, infield, markings, decor), never the parameters that made it. Adding a track type means adding a generator, not touching the sim or the renderer.

- **Types** register with `registerTrackType({ id, variants, sample, build, validate })`. `sample(rng, variant)` picks parameters; `build(params, ctx)` lays the track out by composing the shared stages.
- **Seeds are stable**: each stage draws from its own random stream (`ctx.rng('stage')`), so adding a stage doesn't change existing seeds' layouts. The same type, seed and variant always give the same track.
- **Validation**: every layout gets generic checks (closure, pit lane order, boxes, garage/buildings staying on their side of the infield, roads clear of buildings) plus the type's own; errors make the generator retry with a derived seed, warnings are kept in `layout.notes`.
- **Presets**: Speedway, Short track and Flat track are fixed-parameter ovals (`presetTrack(id)`), what the drivers train on and the season visits. In the viewer, *New track* generates a random oval; `?track=oval:<seed>[:<variant>]` opens a specific one (variants: short, intermediate, speedway, superspeedway).
- **Width**: the racing surface has an inside and an outside edge, each constant or a profile along the lap, so tracks can widen through the turns (ovals widen to the outside: `turnWidening`), narrow, or widen on one side. Walls, surfaces, banking and the drivers' lane input all follow the local edges.
- **Extending**: new decoration = a `Decoration` kind plus its painter in the renderer; new surface or wall = layout data; new feature = a stage in `stages.ts`; new shape (tri-oval, paperclip, road course) = curvature sections or a new centerline kind.

## Track layout (ovals)

Counterclockwise, start/finish mid front straight. No inner wall: past the apron is grass (45% grip, heavy drag, bumps). Pit entry leaves the apron at turn 4 exit; the pit wall runs along the front straight just inside the racing surface (two-sided, solid ends); pit road behind it (limiter 22 m/s, boxes every 12 m); the exit narrows back to the apron, which is the blend lane through turns 1-2 onto the back straight. Progress only counts distance actually driven, so cutting the infield earns nothing.

## Teams

Drivers, spotters and crew chiefs are separate agents with names and careers; a team is a car with one of each, and any seat can be reassigned in the Teams panel. Spotters differ in how early they call traffic and wrecks (same radio scale, shorter range). Crew chiefs are either scripted veterans or learned (apprenticed to the veteran, then improved by ES in strategy races).


Each car is a team: crew chief (strategy: when to pit, tires/fuel/repairs, once a lap before turn 3), spotter (global tower view, fills the radio), driver (learned network). During a pit cycle a scripted maneuver drives from the call to the blend-lane exit; races use a pace multiplier on tire wear and fuel burn (4x puts the speedway fuel window at ~13 laps). Four tires take 14 s and fuelling (6 kg/s) runs alongside, so tires are a real cost: the veteran chief learns the wear rate and only takes tires that won't last the next run.

## Race control

Races start behind the pace car: the field forms up double file, runs a pace lap, the pace car pulls into pit road at turn 4 exit and the green flies when the leader crosses the line. A wreck (or a car stopped on track) brings out the caution: everyone switches to formation driving (scripted, like the pit maneuver), the pace car comes out from pit road ahead of the leader, and wreckers drive out along the apron, hook the wreck and tow it to the garage via the escape lane or pit road. Once the track is clear (and at least two caution laps have run) it's one to go; the pace car pulls off and the leader takes the field to the green. Pit exit merging waits for the spotter's clear call.

## Infield

Garage lot behind pit road (wrecks are parked there), escape lane from the back-straight apron across the infield. Progress only counts distance driven, so neither is a shortcut.

## Roster, events and records

Every agent (driver, spotter, crew chief) belongs to the organisation: seated in a team's car, or in the **academy** with no seat (released drivers land there; *Recruit* signs new ones). Whatever is on screen is an **event** (a race, a practice session, ghost laps) that claims its participants: an agent takes part in one event at a time, and may learn during any of them. Practice training runs only inside the practice session, so the field never practises and races at once.

Everything agents do goes into a permanent **activity log** (IndexedDB): arrivals, signings and releases, every practice round with best laps per track, licenses, crew chiefs' strategy rounds, race results (position, laps, best/average lap, stops, wall hits, points) and season standings, each tagged with the event and the agent's brain version. Click a name in the Roster panel (or double-click a driver in the timing tower) for their history page.

## Rookie school

Brand-new drivers (random wiring, plus an instinct to accelerate and no attention to the radio yet) can't drive, and traffic practice teaches them nothing. Until they hold a license they practise solo as ghosts, with soft walls that harden over their own first 60 lessons, a damage penalty that starts gentle (so driving and crashing beats sitting still) and ramps to the race value over the next 60 lessons (learn to drive, then learn to drive clean), 16 variation pairs and 80 s trials, and they get first call on practice slots. They earn the license by lapping every track cleanly (90%+ health) at full damage, then practise in traffic like everyone else. Drivers descended from a trained mentor are licensed from the start. `npx tsx scripts/rookies.ts --field 8` checks how fast a fresh field graduates.
