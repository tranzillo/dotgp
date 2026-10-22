# DotGP v2: development plan

Agreed 2026-10-15. Two tracks run side by side: **driver training** as a continuous background job in the lab, and **feature development** in the main tree. Training no longer blocks features.

## Track A: driver training (continuous, in the lab)

The lab is a second checkout of the repo where long experiments run on a pinned commit, so feature work in the main tree never disturbs them (see `scripts/lab.ts` and the README's Lab section).

- **Queue, don't wait.** Training changes are committed, then experiments are queued: a class, a season, a benchmark. The lab works through the queue and logs results; they're read at natural breakpoints.
- **Promotion gate.** Trained drivers become the house drivers only when the benchmark (8+ races per track, paired) says they are no worse on any track and better on at least one. Driver quality only ratchets up.
- **Budget.** The lab gets about 6 of 8 cores; dev, tests and the viewer keep the rest.
- **Rules for every lesson** (learned the hard way): lessons must not cost drivers their racing. Mask training to a skill's own inputs where possible; otherwise anchor to the pre-class driver. Measure pace by distance. Validate in full races, never on drill scores alone.

Open training work (queued in the lab, in no hurry):

- **Cautions:** the short track is still worse than the formation script (15.4 vs 11.6 retirements a race); speedway and flat are within the noise.
- **Racecraft:** pace now holds; drivers cause less damage on the short track but aren't a clear win anywhere. Next: dense packs like a 24-car short track.
- **Pit stops:** both pit lessons are withdrawn from the school: in the lab they cost drivers their racing (lap times 7-10 s slower, retirements doubled or worse). Masking to the pit inputs failed (too little control). Next: **skill networks**, a driver made of several networks; a pit-stop network that only drives during stops starts as a copy of the driver's racing and learns to pit without touching it. Cautions may move to their own skill network too.
- **Seasons** with race learning, fear and nerve on, to see whether they move the field.

## Track B: stewards, rules and penalties (next feature)

A framework that isn't oval-specific: other disciplines come in as new rulebooks and track features, not rewrites.

1. **Rulebook (data per discipline/series):** start procedure (rolling, standing, interval), caution procedure (pace car, safety car, VSC, local yellows, red flag), pit rules (limit, lines, blend line, unsafe release, mandatory stops, windows), track limits, racing rules (no passing under yellow, blue flags, defending, contact), scoring and classes.
2. **Detection (objective, from the sim):** pit speeding, line crossings, passing under caution, jumped starts and restarts, track limits, unsafe release; contact incidents from the fault model (fault share, severity).
3. **Stewards (judgement):** rule tables plus severity and consequence decide: no action, warning, time, drive-through, stop-go, give back the place, back of the line, grid penalty, black flag. Stewards are agents with personality (strictness, consistency, benefit of the doubt) inside the tables; rule-based, not learned, so drivers learn against consistent rules.
4. **Enforcement and record:** penalties are served (a drive-through is driven), time lands in results, penalty points on the license lead to bans (ties into injuries and careers); history pages, news, tower.
5. **Behaviour:** penalties enter the drivers' learning (race learning, drills); drivers perceive rule state through new inputs that are zero when irrelevant (yellow in my sector, blue flag, warnings, start state), trained masked; nerve interacts with strictness; crew chiefs decide when to serve, spotters call warnings.

Order: the framework on ovals first, with rules ovals can already detect (pit speeding, passing under caution, restart jumps, avoidable contact, blend line, apron track limits) and the UI; then penalties in learning and strategy, measured in the lab.

## Track C: road courses and GP circuits (started 2026-10-16)

Track generation is designed with every discipline in view: closed circuits, point-to-point street stages (the same corner vocabulary, open-ended) and open cross-country rally (terrain plus checkpoints, no road: a world-frame driver input, later). Lessons from v1: organic shapes are good; scale must be real (features sized to 3 m cars, longer tracks get more corners); variety across short and long tracks.

1. Done: the sim has no handedness (right turns, mirrored layouts, scripted line follower); circuit surfaces (kerbs, run-off, gravel).
2. Done (first version): circuit generator, club and GP classes, three characters; viewable in practice and ghosts.
3. Next: drivers learn right-handers. Lessons on mirrored and mixed tracks (the drivers see signed curvature), anchored so oval racing is kept; a lab job.
4. Then the circuit rulebook: standing starts, safety car and VSC, local yellows, track limits by corner, blue flags, pit etiquette. Pit lanes on either side; sectors.

## Track D: viewer controls and replays (planned 2026-10-17)

Video-style control of what's on screen (pause, slow motion, rewind, a scrubber marked with the race's events) and, in the end, agent history that links to the moment it happened so it can be watched.

**What's recorded.** Per event, two things:

- **Event log:** every `world.announce` (flags, pit in/out, retirements, steward calls) stamped with its sim time, plus derived events (lead changes, contacts, laps). Tiny; always kept; the timeline's markers and what history links point at.
- **Tape** (`src/events/tape.ts`, built): 10 frames a sim second, each a fixed-size record per car with everything the viewer draws (position, heading, speed, inputs, tire/fuel/health, pit state, laps, penalties, standings) plus race control's state; frames in 30 s chunks, so any frame is found by arithmetic. A frame reads back as the same snapshot the viewer draws live. The worker records whether or not anyone is watching (under 2% of sim speed); the page gets the backlog on attach, then new frames with each frame it draws, and the whole tape when a race finishes. Open sessions keep their latest 30 minutes. Driving school tapes each round, students' own cars only, and keeps the rounds that were on screen or earned a license. Tire marks are to be regenerated from the tape rather than stored.

No recipe (spec + seed + inputs to re-simulate): the sim is deterministic on one build and engine, but recipes break with every code change and don't carry across browser engines. Tapes play regardless of code version and can leave the browser later if replays are ever shared. Recipes can come back if what-ifs or training from races become goals.

**Size (measured).** In memory: 66 B per car per frame, about 720 B per car per sim second; gzip alone only gets that to about 430 (floats that change every frame). An 8-car race of ~2000 s is ~11 MB in memory. Storage needs its own codec (step 5): quantise and store each value as its change from the frame before, so gzip has small repeating integers to work with (expect ~10×). A total cap (start at 250 MB, adjustable in Settings, usage shown) with the oldest unpinned replays evicted first.

**Decisions (user, 2026-10-17):**

- Rewinding the race on screen **pauses it** until the playhead is back at live (a DVR, nothing missed). Races in the background keep running.
- Driving school: tape only the round on screen and the round that earned a license (every round is taped in memory; the rest are dropped).
- Retention is a size cap, nothing cleverer for now.

**Order:**

1. **Control bar under the track** (done): speed and camera move out of the aside, display options into a popover; pause, 0.25×, 0.5×; keyboard (Space, J/K/L, ←/→, `,`/`.`); a progress timeline.
2. **Event log** (done): `Session.timeline`, streamed to the page; markers on the timeline as they happen.
3. **Tape** (done): recorder in the worker; the page keeps a copy (backlog on attach, then streamed); handed to the page when a race finishes, before its worker goes; driving-school round tapes.
4. **Rewind** (done): a playhead apart from the live edge; reverse at 1-64×, scrubbing, LIVE; tower, HUD and radio follow the playhead; tire marks rebuilt on seek; exhaust trails from the recorded path.
5. **Storage** (done): replays in IndexedDB (their own database), packed by `tapeCodec.ts` to ~87 B per car per sim second (an 8-car race of ~2000 s is ~1.4 MB, so 250 MB holds ~180); the cap and eviction; pin to keep; Settings → Replays.
6. **History links** (done): activity records carry `replay: { id, at }`; agent pages get a watch link (an injury opens at the hit, a penalty at the incident, a license at its round, a race result at the start with its markers); a stored replay opens like an event.

## Track F: crew chiefs that matter (started 2026-10-17)

The first learned chief was a placeholder: it saw only its own stint (fuel, tires, health, laps left), decided once a lap, and learned in ghost races on the oval presets (no contact, no cautions, no rivals). It couldn't see a flag, its place or a gap, so it couldn't learn the calls that decide races. The chief's main job, race strategy, comes first; qualifying runs and team radio come after.

**Rules first (user's call, 2026-10-17):** the first measurement found pitting under caution barely mattered (a caution-aware veteran was within ±1-2 places of the plain one), partly because race control had no lapped cars: a lead-lap car that pitted under caution rejoined behind every lapped car. Now lead-lap cars line up ahead of lapped cars and pitting cars rejoin at the back of their own lap's group (NASCAR). A wave-around was tried and dropped (user, 2026-10-17): it left the field strung out at restarts. Even so, a scripted veteran that takes due stops under caution (at 30%, 50% or 65% of a tank gone, at 4x and 2x race pace) is no better than the plain veteran: from 0 to 1.5 places worse, within the noise. The house drivers' pace differs by up to 30% and wrecks void many comparisons, which also mutes strategy.

**Caution outcomes (measured 2026-10-17, 18 races, house drivers, 4x pace):** a lead-lap car that pits under caution restarts 3.4 places back, then gains 3.5 in the next 10 laps on fresher tires (0.92 against 0.80): passing works. One that stays out gains 2.6 at the restart and gives back 1.7. A green-flag stop costs only 2.5 places (the field is spread out: driver pace differs by up to 30%, and everyone's pit windows run in step). Restarting 19th or worse doubles the wreck risk (12% out within 5 laps against 6%). So a caution stop is worth about 1.6 places when it saves a later stop and costs about one when it adds one; a veteran that pits under caution only when it doesn't add a stop (`cautionSavesStop`) is +0.1 ±1.9 places (short) and +0.5 ±1.0 (speedway) against the plain veteran: a small lever, within the noise. Strategy will matter more as fields get closer.

**Levers the sim already has (measured):** fresh tires are worth 4-6% a lap against tires at 60% life and 7-11% at 45% (the undercut is real). Under caution the running order freezes and a car that pits rejoins at the back of the line: it loses places, not a lap. Races are noisy (a wreck reshuffles the order by several places), so strategy can only be judged car against car in the same race.

1. **The chief reads the race** (done): flag (caution, one to go, safety car), its place and laps down, gaps either side (green only), how old the tires either side are against its own, how many of the cars ahead are pitting now, caution laps run, laps on its tires. Old chiefs are widened with these inputs at zero weight (same calls until trained).
2. **Strategy training in real races** (done, first version: `src/ai/strategyTraining.ts`, `scripts/strategy.ts train`): ES per lineage; each antithetic pair races in the same race with the same driver, and a mirrored race swaps their grid slots; scored on the places between the twins (a race where either was wrecked out doesn't count). The rest of the field: the lineages' current chiefs and scripted veterans of every temperament, half of them taking due stops under caution (`cautionStop`), so no single habit is the only thing to beat.
3. **Benchmark** (done: `scripts/strategy.ts bench`): any two sets of chiefs head to head, paired the same way, with 95% ranges. The promotion gate for chiefs, as `bench.ts` is for drivers.
4. Next: run training in the lab; promote chiefs that beat the shipped ones (and the veteran) into `public/chiefs/default.json`. Circuits too, with road-skilled drivers (safety car instead of pace car).
5. Then: chief → driver instructions (push, save fuel, save tires, cool down) as masked driver inputs; then qualifying runs (go out / stay in, another lap / come in) with track evolution and red flags to make timing matter.

## Track G: venues and the mega complex (started 2026-10-17)

The default track becomes a sporting mega complex: an extreme tri-oval superspeedway, an Indy-style rectangle speedway in its infield, a short-track bowl inside that, and a dirt bullring on its own in an end zone; long sweeping roads join the rings into many road-course layouts. Different series race the same complex on different layouts, one event at a time.

1. Done: generating is separate from racing. Venues (one or more layouts), series (layout kinds + rulebook), and the Exhibition flow: venue, series (locked to the venue's), layout, session, Start.
2. Done: one general oval builder (corners and straights, closed exactly) with seven shapes in random generation: classic, egg, tri-oval, D, quad-oval, rectangle, triangle; banking by each corner's design speed; width per straight.
3. Done: venues with nested rings. Placement in a venue frame, the other rings as neighbours (drawn, drivable, walls solid from either side), service roads round infields that hold a track, clearance checks, the Mega Complex (superspeedway, rectangle speedway, short-track bowl, bullring) as the Exhibition default. Each ring has its own pit road and garage; a shared paddock in the free turn 1-2 end comes with the road network.
   Notes: the drivers have never seen a 90-degree rectangle corner or 33-degree banking (add the complex to practice and the variety lesson); scenery is flat (banking only on the raced layout).
   Side task first (2026-10-18): procedural infields, since complexes need real infield networks. A road network per track (junctions, graded roads, the oval part of it), course roads first then services, inner ovals as an infield feature (one level deep in random generation). Steps: A network model and wreckers on it (done); B variable pit complex and garage (done: set-back pit roads with laid lanes, garage set back with lanes, set-back stops in the pit lesson); C escape roads, service links, infield features incl. inner ovals (done: service road full or C, 1-5 escape roads, links, lots, skidpads, inner ovals placed variously, as two-layout venues); D course roads, junction curves, layout search, closures (walls; physical cones later) (first version done: infield sections and bus-stop chicanes as curvature, rovals compiled into one closed lap pinned to the oval's start line, barriers closing the oval, road racing on them; still to come: richer sections reaching across the whole infield, junctions in the middle of turns, course roads joined to the service network, physical cones, drivers trained on rovals); E back to the complex connectors.
   Redesign agreed 2026-10-18 after studying real complexes (feedback/infield layouts/: Daytona, Kansas, Charlotte, Iowa, Las Vegas, Pocono, Pikes Peak, iRacing Superspeedway, Behrend, Not Richmond and others). The principles:
   - layouts share one hub (front stretch, start/finish, pit road, paddock) and reuse the oval's banked turns and straights
   - they leave the oval at turn entries and apexes
   - a trunk with Y-branches yields many nested layouts
   - infields are mostly paved with grass islands, and layouts are track limits drawn on that pavement
   - service roads are few and come last
   The new order replaces C/D's service-road-first infield:
   - R1 (done 2026-10-18): sim foundations (pavement polygons with an index, mid-turn curvature-continuous splices, every layout's lines painted with the selected one bright, wreckers crossing pavement)
   - R2 (done 2026-10-18): the hub, with pit styles front-stretch and tri-oval chord (pit position as a profile along the lap: a refactor of the pit consumers)
   - R3: the racing network (junction sites on the oval, trunk, 1-3 branches, a hub loop, an optional inner oval sharing a straight)
   - R4: layouts (enumerate routes through the hub, keep as many distinct ones as possible, compile, close unused branch mouths)
   - R5: pavement plates and grass (paving style random per track)
   - R6: services and features last
   User decisions: every layout shares the oval's pit road and start for now (infield pit lanes later); the chord pit is in from the start; paving style is random; maximise layout diversity; departures at turn entries and apexes are essential; all layouts' lines are painted.
   R3 attempt and rethink (2026-10-18): the racing network (trunk, Y-forks, branches, lattice paths) was built and then dropped. Its pieces were narrow, uniform lanes, nothing like the generated circuits, and every layout came out about the oval's length. Second attempt: each road course a full circuit, with an organic polygon and circuit.ts's cross-section. It flowed better but read as terrain (kinks, walls, run-off fields), which an infield, a flat manicured site, isn't.
   Prototypes 1 and 2 (2026-10-18/19): the walk-based courses (axis-aligned legs, 90-degree corners, derived layouts that cut across the Grand Prix) were rejected as connecting straight paths with right angles, and their layouts as offset clones. The user's model is Iowa: a speedway, a bullring in its infield, a road course that keeps part of the speedway and shares road with the bullring, and a short course that is a cross-section of the two.
   **Where we stopped (2026-10-19): road courses as one interlinked road network, `trackgen/roval.ts`.**
   - The network:
     - ways: the speedway (one way only), an inner oval in one half of the infield (along or across it, flat, no walls), and the roads
     - roads meet a way at a junction (heading either way along it), at turn entries and exits on the ovals and partway along a road's long straight
   - Roads, in order:
     - loops round the outside of the inner oval's ends
     - the Grand Prix's two roads (speedway turn entry to an inner turn exit, an inner turn entry to a speedway turn exit), sharing a straight or a straight, a turn and a straight of the inner oval, either way round
     - 0 to 2 more roads between the tracks
     - 1 to 3 shortcuts between road straights (or a road and an oval)
   - Without an inner oval (small infields: all intermediates so far), one road across the infield plus shortcuts.
   - Each road is routed, not drawn:
     - off the track at a slant (25 to 60 degrees)
     - a cheapest path over a 6 m grid of free ground, dearer near its edge, by way of 0 to 2 points in the emptiest ground
     - simplified (Douglas-Peucker), then corners from the circuit vocabulary fitted by `poseSection`
   - Layouts: every route round the network over a front stretch (`routes`).
     - cut from the speedway (on it once) or from the inner oval (never touching the speedway)
     - closed exactly by the smallest change to the straights (`closeLap`)
     - near-duplicates dropped (88% of either on the other's road)
     - named by length: Grand Prix, National, Club...; Short course, Infield... for the inner oval's
     - the best of 5 networks kept (more layouts first, then how much of the infield it spreads over)
   - Kept from before: `compileRoval` (now with closures wherever a course parts from its host and meets it again), the open-infield cross-section, every layout the others' scenery.
   - The garage keep-out keeps courses nearer the front stretch than the garage's back edge (validation asks that); ground tests are cached on 2 m grids (generation went from about 40 s to about 2 s a venue).
   - Numbers (10 seeds a class): every venue that plans a course gets one (4 intermediates, 7 speedways, 5 superspeedways); 1 to 4 layouts, about 2 per speedway; about 2 s a venue.
   - Next:
     - in-app look and lapping (the earlier short course had a junction where cars crashed)
     - the generation time
     - roads that run along the oval's edge
     - more short courses
     - drivers trained on these courses
   - Tools: `scripts/_rovalshapes.ts out.json [seed] [count]` writes each venue's network and layouts for plots.
   Then the real rebuild of pits, garage, services and features (R5/R6), done properly this time.
   **Junctions and infield cleanup (agreed 2026-10-21).** An audit of 18 venues (seeds 1-6 a class, 22 courses) found: other layouts' walls (solid from either side) standing on the racing surface of 6 ovals and 5 courses; kerbs on the speedway's pavement for all 18 courses that leave it (a course's corners still on the oval were dressed); course surface and lines painted over the oval; 17 of 19 speedway courses with a corner under 40 m radius within 200 m of leaving or rejoining the oval (often a 14 m hairpin straight off the banking).
   - Phase 1 (done 2026-10-21): an oval's pavement is the oval's. No kerbs or run-off of a course on any oval's pavement (a kerb goes whole or not at all); every layout's walls cut back (padded ends) wherever they would stand on another layout's racing surface or apron (`venueWithCourses`); the renderer paints road layouts with the ovals' pavement clipped out (and scenery courses' lines). Tested in roval.test.ts.
   - Raised by the user (2026-10-21): infield walls read as random (proximity concrete, hairpin tyre walls, Phase 1 stubs). Resolved in Phase 3 below: a wall only where it protects something.
   - Phase 2 (first version done 2026-10-21): each ring carries a speed profile (banking, tyres, engine, drag: racingLine's model on the centerline). A road off or onto a ring takes a design speed as a share of what the field carries there (a sweep 40-55%, shallow 12-30 degrees; a braked bend 22-38%, 25-55 degrees), its bend's radius what the tyres hold at that speed (poseSection keeps it as a floor), fitted to the straight room before the track turns (shallower, then slower, if it must); junctions sit 8-150 m from the turns. Accepted only if paced: out of the departure bend's apex nothing later forces braking below its speed, and the merge bend's apex is reached at its own speed. Closures across another layout's road go only where clear of the raced one's surface (none rather than one across it). Numbers (seeds 1-10 a class): junction bends median 62 m radius, least 24 m (were often 14 m), 9 of 42 under 40 m (junctions within 25 m of a turn have no straight to design a bend on and are laid as before); venues with a speedway course unchanged (16 of 30); layouts a little fewer (seeds 1-6: 15 speedway + 4 short courses, were 18 + 4); 1.2 s a venue. All 37 layouts of seeds 1-6 lapped by a scripted driver at full health. Layouts guaranteed cross-sections of one network (user, 2026-10-21): each shares more than 30% of the shorter lap with another (a short course mostly on the Grand Prix's road is a small share of the Grand Prix's, as at Iowa), measured on the other's line at 1 m (`linkShare`); one that doesn't is left out, the least linked first. At HEAD 4 of 6 multi-layout speedways (seeds 1-12) broke it and the test held by luck of seed; now 0 of 13 multi-layout venues across the classes, none left out, tested over speedway and superspeedway seeds 1-8. Sweeps rarely fit yet (the slant point must clear the oval's pavement, so a shallow one runs long beside it): more variety needs junction sites chosen for the style, not styles fitted to sites.
   - Phase 3, first steps (2026-10-21): `trackgen/paving.ts`: an infield's roads, lots and pads paved as one area (each piece a distance field, joined by a smooth minimum so junctions and crossings are filleted, the edge traced by marching squares into even-odd rings, slivers under 40 m^2 dropped; one `polygon` surface outlined once), and `roundPolyline` (a road's corners as arcs). The service ring, escape roads, links, lots (rounded) and skidpad are paved so; escape roads (and the presets' fallback escape lane) rounded. Services are laid round road courses now (they dropped out before): lots, pads kept clear of the courses and the inner oval, no escape road where a course leaves or rejoins the oval, roads free to cross courses; where they don't fit, the course without them. 21 of 22 course venues (seeds 1-12 a class) have services; 2.3 s a venue (was 1.7).
     Done next (2026-10-21): where the service road would run beside a course for longer than a crossing (closer than the grass a lot needs between them: the smallest lot and its clearance), it turns onto the course and off again, the course its road there (a `course`-grade road in the network, wreckers take it; not paved again); courses' stretches on the oval's pavement never count. With a course, a missing escape road isn't fatal (the course's own roads and pit road are ways off). 22 of 22 course venues have services; tests for it (one network to the garage, no service road beside a course 100 m, lots off courses).
     Done next: the garage lot (corners rounded, its own tone on top) and its lanes from pit road paved with the roads as one area; the service road runs against the lot's back (no sliver of grass between); inner ovals' services (escape lane rounded, lane and lot paved as one) the same, wherever the inner oval comes from. Presets untouched.
     Done next: lots' bays clear of their rounded corners (the garage's buildings already sat inside its rounding); lots and pads placed on one occupancy map of everything laid (roads, courses, the ring, each lot and pad as it goes in), clear of all of it, in place of each kind tested against a few others (36 venues: 68 lots, 7 pads, no road through a lot; without the map a link road ran through one).
     Done next (agreed 2026-10-21): infield walls from what each protects (`trackgen/walls.ts`), in place of the courses' concrete wherever the oval was near and tyre walls round long-leg hairpins (the gravel there stays). A car running off a bend goes on along its heading from the outside edge at the speed it was doing (each layout's speed profile) and slides to a stop on grass (its grip and rolling drag, and the air's: about 200 m from 50 m/s); if on the way it would reach another layout's track (apron and pit road included) or a garage or parking lot, a wall stands at that thing's edge there (padded, 10 m past either way). Not where the track's own wall stops the car, not between layouts where they share road (100 m either side of where one runs on the other), no stub under 20 m once cut back. Tested on two open tracks 25 m apart (walls facing each other) and 400 m apart (none).
     Found: today's generated infields need none (14 course venues, seeds 1-8 a class: no wall). Roads are kept a field's width apart and infield corners are slow (12-30 m/s: 30-70 m to stop); the fast corners are the ovals' own, shared road. The rule will lay walls as infields get denser (closer roads, buildings, the mega complex's rings).
   - Still open: sweeps rarely fit (junction sites chosen for the style, not styles fitted to sites); junctions within 25 m of a turn laid as before; full races on the new rovals (drivers untrained on them); service roads as fitted curvature centerlines with a least radius from the wrecker's turning circle (now rounded polylines); paddock and buildings on the occupancy map; validation that features never overlap and roads meet only at junctions.
4. Connector roads and road-course layouts through the rings (a route compiler; gates in walls a layout doesn't use; unused asphalt as run-off), and venue recipes for Generate at every scale: a local dirt bullring, a speedway with dirt in the infield, a tri-oval with a bullring, the mega complex (the new default).
5. Dirt: a surface, its grip, a dirt series.
6. Later: figure-8 and crossover layouts (routes that cross themselves) for demolition derby races. The road network allows X crossings from the start.

## Track E: later

Rally: A-to-B stages on mixed surfaces with interval starts and a co-driver agent reading pace notes; then open-terrain gate-to-gate rally where route choice is the skill. Car classes with different stats, multi-class racing.

## Status

Ovals: racing, pit stops (scripted or learned), cautions (scripted or learned), fault, fear and nerve, injuries and careers, driving school, events, records. Benchmarks: `scripts/bench.ts` (95% ranges, A vs B), `scripts/season.ts`.
