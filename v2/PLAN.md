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
   **Where we stopped (2026-10-18): infield-style road courses, `trackgen/roval.ts`, the Grand Prix only.**
   - Measured from the references (`feedback/infield layouts/`):
     - legs run parallel to an oval straight, or follow a turn at a constant offset
     - fingers and hooks: two legs 40 to 90 m apart with a hairpin
     - 90-degree corners
     - legs of 150 to 450 m
     - courses 11 to 14 m wide
     - the course often keeps to one end of the infield
   - Generation:
     - pick the oval's part of the lap: `end` (skip one end, Daytona/Kansas style), `straight`, `turn` or `both`
     - hug the oval's turn concentrically (offset at most half its radius) to where the oval runs square to the front stretch
     - an axis-aligned walk between the two hugs: about 80 candidate walks, scored on hairpins and long legs, no staircases, a plain box 15% of the time
     - the walk's last legs solved to close the loop exactly
     - corners fitted by `poseSection`, with per-waypoint radii (concentric with the turns where it hugs)
   - Cross-section, an open infield (the user's choice):
     - circuit.ts's `dressCourse` with no continuous barriers, verges or run-off
     - kerbs at corners
     - concrete only where the course runs within about 15 m of the oval's pavement
     - tyre walls and a little gravel at hairpins at the end of long legs
   - The layout: `compileRoval` splices the course into the oval's lap with banking ramps, closes the oval across where it leaves and rejoins, and pins the start line.
   - Pits (a placeholder): the oval's pit road when the oval's part takes it in; otherwise a circuit-style pit lane on a course straight of at least 340 m.
   - `RovalSpec` lives in `infield.rovals`.
   - Where a course goes in, the infield's services stay out. They are placeholders, as are pits, garage access and escape roads, all to be rebuilt.
   - Numbers:
     - a course on about 55% of intermediates, 80% of speedways and all superspeedways
     - laps 0.6 to 1.2 times the oval's
     - generation about 30 ms per course; the layout compile about 0.5 s
   - Tools: `scripts/infieldsurvey.ts` (builds, laps every course) and `scripts/_rovalshapes.ts` (writes course shapes as JSON for quick plots).
   Next, in order:
   1. More layouts from the Grand Prix: shortcuts across fingers (Kansas's loops), different departures, a back-straight bus stop. Pavement shared between layouts, and every layout's lines painted.
   2. A longer Grand Prix (the 1.3 to 1.5 times the oval target: take in more of the oval, deeper fingers).
   3. Smooth the small S-wiggles where some slip roads leave the oval.
   4. Raise intermediate success.
   5. Train drivers on these courses.
   Then the real rebuild of pits, garage, services and features (R5/R6), done properly this time.
4. Connector roads and road-course layouts through the rings (a route compiler; gates in walls a layout doesn't use; unused asphalt as run-off), and venue recipes for Generate at every scale: a local dirt bullring, a speedway with dirt in the infield, a tri-oval with a bullring, the mega complex (the new default).
5. Dirt: a surface, its grip, a dirt series.
6. Later: figure-8 and crossover layouts (routes that cross themselves) for demolition derby races. The road network allows X crossings from the start.

## Track E: later

Rally: A-to-B stages on mixed surfaces with interval starts and a co-driver agent reading pace notes; then open-terrain gate-to-gate rally where route choice is the skill. Car classes with different stats, multi-class racing.

## Status

Ovals: racing, pit stops (scripted or learned), cautions (scripted or learned), fault, fear and nerve, injuries and careers, driving school, events, records. Benchmarks: `scripts/bench.ts` (95% ranges, A vs B), `scripts/season.ts`.
