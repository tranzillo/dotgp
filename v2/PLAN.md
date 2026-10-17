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

## Track E: later

Rally: A-to-B stages on mixed surfaces with interval starts and a co-driver agent reading pace notes; then open-terrain gate-to-gate rally where route choice is the skill. Car classes with different stats, multi-class racing.

## Status

Ovals: racing, pit stops (scripted or learned), cautions (scripted or learned), fault, fear and nerve, injuries and careers, driving school, events, records. Benchmarks: `scripts/bench.ts` (95% ranges, A vs B), `scripts/season.ts`.
