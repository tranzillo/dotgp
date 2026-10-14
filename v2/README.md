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
| `src/sim/raceControl.ts` | Race control: flags, pace car, formation slots (under pacing, cars only swap places in line once one is clearly ahead), caution triggers (wrecks, debris), wrecker crew (tow to garage) |
| `src/ai/drivers.ts` | `Team` (spotter + driver), `NeuralDriver` (raw travel-frame acceleration), `ScriptedDriver` (baseline only), weight migration |
| `src/ai/pitting.ts` | Crew chief contract + `StrategistCrewChief` (scripted veteran), scripted `PitAutopilot` |
| `src/ai/neuralChief.ts` | Learned crew chief (observations, guardrail: never run dry), apprentice recorder |
| `src/ai/chiefTraining.ts` | Strategy races (ghost races, full distance) and ES for crew chiefs |
| `src/ai/formation.ts` | Formation driver (double file, stopping-distance following, wreck avoidance) and pace car driver |
| `src/ai/lineFollower.ts` | Hand-written path follower used by the scripted baseline and the pit maneuver |
| `src/ai/spotter.ts` | The radio contract (16 channels) and `TowerSpotter`: global view, calls traffic alongside/ahead/behind and wrecks anywhere ahead |
| `src/ai/online.ts` | Learning while racing: lap-against-lap evolution strategies (a small variation one lap, its opposite on another, coin-toss order), stepping toward the faster, cleaner direction |
| `src/ai/es.ts` | Evolution strategies: each lineage is one persistent driver improving through practice |
| `src/ai/practice.worker.ts` | Live practice in a Web Worker for the viewer |
| `src/render/renderer.ts` | Track layers, permanent groove and skid layers, follow camera, numbered livery dots |
| `src/render/marks.ts` | How cars mark the track: a faint, capped groove from tire work, and skids only from real slides (shared with the benchmark) |
| `src/render/livery.ts` | Random contrasting fill/border pairs and unique numbers |
| `src/ui/roster.ts` | Agent pools (drivers, spotters, crew chiefs), teams, mix and match, persistence and migration |
| `src/ui/season.ts` | Seasons, points, careers, off-season (relegated seats go to rookies from the top) |
| `src/events/session.ts` | One session (race, practice, ghost laps) as a DOM-free object: world, race control, respawns, radio, technique, standings; snapshots for the viewer, results for the records |
| `src/events/event.worker.ts`, `host.ts`, `protocol.ts` | Events in workers: one per event, attached (on screen, real time × speed, streaming snapshots and tire-mark strokes) or in the background (races flat out, open sessions paused) |
| `src/school/pitLesson.ts` | The pit stop lesson: pit trials (in-lap with the stop called, scored on distance with credit for progress through the stop and a drive-through for speeding) and the apprenticeship (DAgger imitation of the scripted maneuver) |
| `src/school/drill.ts` | Drill trials: every candidate drives its own small world (a field around it), one student's shown |
| `src/school/pitTrafficLesson.ts` | Pit road in traffic: drills with two cars pitting ahead and four racing around the student (driving as the student races), scored as the pit stop lesson plus damage done to others, with the veteran's own drill as the license bar; a DAgger refresher in traffic |
| `src/school/cautionLesson.ts` | The caution lesson: caution drills (a small calm pack, green, a debris caution, the restart; scored on place and lane in the line, passes under caution, contact) and the apprenticeship (DAgger imitation of the formation script), with the script's own drill as the license bar |
| `src/school/classroom.ts` | Driving school: a class of drivers taking a lesson round by round on a watchable track (rookie school, track variety), each student with its ES variations as ghosts |
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

Sessions run as **events**, each in its own worker. One event is on screen (attached): it runs in real time × the viewing speed and streams snapshots and tire-mark strokes to the renderer. The rest run in the background: races flat out (a 10-lap race finishes in a second or two), open sessions paused, since they exist to be watched and their learning happens in the trainer. The Events panel lists them with Watch / Background / Stop. When a race finishes in the background, the weekend loop carries on in the background (practice, then the next race), so a season can run unwatched.

Every agent (driver, spotter, crew chief) belongs to the organisation: seated in a team's car, or in the **academy** with no seat (released drivers land there; *Recruit* signs new ones). Whatever is on screen is an **event** (a race, a practice session, ghost laps) that claims its participants: an agent takes part in one event at a time, and may learn during any of them. Practice training runs only inside the practice session, so the field never practises and races at once.

Everything agents do goes into a permanent **activity log** (IndexedDB): arrivals, signings and releases, every practice round with best laps per track, licenses, crew chiefs' strategy rounds, race results (position, laps, best/average lap, stops, wall hits, points) and season standings, each tagged with the event and the agent's brain version. Click a name in the Roster panel (or double-click a driver in the timing tower) for their history page.

## Learning in races

On by default (*Learn* in the Session panel). In a race each driver drives a small variation of itself for a lap and its opposite for another (which goes first is a coin toss, so tire wear and fuel burn can't fake a signal), and every three pairs steps toward the better direction. Only clean green-flag laps count: a lap with a caution, a pit stop or a wreck is run again with the same variation, and damage taken on a lap is charged 120 s per unit of health, so contact never pays. Learning is slow and steady (a few steps per driver per race; drivers improve their solo lap times ~0.5-1.5% over a dozen races in testing) and races stay as clean as without it. Each step reaches the roster as it happens and is logged in the driver's history; the HUD counts the steps taken this race.

**Fault.** Every car-to-car contact is judged on the velocities going in: closing on a car from behind is the follower's fault, moving across into a car is the mover's, and neither (touching side by side at the same speed) is shared. Each car keeps the damage it did to others times its share of the fault (`harmDone`), and the damage it did itself (walls, plus its share of contact: `selfInflicted`). Race learning charges a lap 120 s per unit of harm done, as for damage taken, and a lap the driver spoiled itself (it did itself or others harm) counts against its last clean lap time instead of being run again, even when it ends in a wreck: being wrecked by someone else still doesn't count. The caution and pit-traffic drills charge harm by fault too. The incidents benchmark reports contact retirements at fault vs hit by another, and the damage done by fault per race.

## Driving school

Pick a lesson and free drivers (academy or anyone not in a running session) in the Driving school panel and start a class: it's an event like any other, on screen or in the background. Each round every student drives as a ghost alongside its 32 slightly varied copies (faint dots in its colour; *Variants: Hide* to declutter) and then moves toward the copies that did better: the same evolution-strategies training as practice, one visible track per round. **Rookie school** rotates the three presets with soft walls hardening over the first 60 lessons; a student earns a license with a clean lap at full walls on each preset, and the class ends when everyone has one. **Track variety** puts licensed drivers on a new generated oval every round. Every round goes into each student's history (lesson, track, laps, best lap, how many variations beat them, wall softness). *Raw rookie* in the Roster panel signs an unlicensed driver for the academy.

## Drivers doing their own pit stops

The goal is no scripted driving: the pit maneuver and formation laps are scripts only until drivers learn them. Drivers see the pit stop in progress as network inputs (in-lap / out-lap, where the painted pit route runs at 0-100 m ahead, distance to the box, the speed limit zone and how far off the limit they are, the spotter's clear-to-merge), added with zero weights so racing is unchanged. The **Pit stops** lesson (Driving school, for licensed drivers) first has each student copy the scripted maneuver (DAgger: watch the script, then drive under its eye and learn its answers from wherever your own mistakes put you; a sample of the student's original racing is kept so learning to pit doesn't overwrite how it races), then practise: ghost pit stops scored on distance covered, with credit for getting onto pit road and slowing at the box before ever completing a stop, a drive-through's worth of penalty for speeding, and a penalty for not merging back. A clean stop on every preset earns the pit license, and from then on the driver drives its own stops in races. Students that stop making progress (no stop completed for a while) go back for a refresher with the script; three of the four bundled drivers earn the pit license within ~150 rounds.

The pit license is solo; races are not. **Pit road in traffic** (for drivers with a pit license) puts the stop in a race: two cars just ahead pit too (the veteran's maneuver), so there's a queue on pit road, and four more race around the student, two closing from behind as it slows. The racers drive as the student races, so it's a race's traffic. Students first go over the veteran's stop in traffic (DAgger, three starting lanes per preset), then practise; a student that settles into skipping the stop goes back for a refresher. The license takes a stop in traffic on every preset that is completed, unhurt, hurts nobody, never speeds, and scores at least as well as the veteran's maneuver driving the same drill. Drivers need both licenses to do their own stops in races. Two bundled drivers both earned it within 33 rounds (~5 minutes headless). Still scripted: pit stops for drivers without both licenses.

## Drivers doing their own cautions

Same plan for formation laps, cautions and restarts. Drivers see a caution as more network inputs (pacing, restart coming, how far ahead or behind their place in the line is, which lane it's in, the line's speed, the gap and closing speed to the car ahead in their file), zero under green and added with zero weights. The **Cautions** lesson (for licensed drivers) runs drills in an 8-car field: a short green, a caution for debris, a caution lap, the restart, a short green. The rest of the pack is calm and scripted so the drill tests the student, not the pack. Each student first copies the formation script (DAgger, keeping a sample of its own green-flag racing), then practises: every variation drives its own drill from the same grid slot, scored on green-flag distance minus place and lane error under caution, passes under caution and damage done to others. The license takes a drill on every preset with no damage taken or done that scores at least as well as the formation script driving the same drill; from then on the driver drives its own cautions and restarts in races. Two bundled drivers both earned it within 45 rounds (~8 minutes headless). Under pacing, cars only swap places in line once one is clearly (8 m) ahead: re-sorting by distance every step swapped cars side by side in a row, and their files with them. (Freezing the order outright was worse: a car that really had got ahead had to drop back through a crawling pack, and the field gridlocked.)

## Rookie school

Brand-new drivers (random wiring, plus an instinct to accelerate and no attention to the radio yet) can't drive, and traffic practice teaches them nothing. Until they hold a license they practise solo as ghosts, with soft walls that harden over their own first 60 lessons, a damage penalty that starts gentle (so driving and crashing beats sitting still) and ramps to the race value over the next 60 lessons (learn to drive, then learn to drive clean), 16 variation pairs and 80 s trials, and they get first call on practice slots. They earn the license by lapping every track cleanly (90%+ health) at full damage, then practise in traffic like everyone else. Drivers descended from a trained mentor are licensed from the start. `npx tsx scripts/rookies.ts --field 8` checks how fast a fresh field graduates.
