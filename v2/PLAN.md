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

## Track D: later

Rally: A-to-B stages on mixed surfaces with interval starts and a co-driver agent reading pace notes; then open-terrain gate-to-gate rally where route choice is the skill. Car classes with different stats, multi-class racing.

## Status

Ovals: racing, pit stops (scripted or learned), cautions (scripted or learned), fault, fear and nerve, injuries and careers, driving school, events, records. Benchmarks: `scripts/bench.ts` (95% ranges, A vs B), `scripts/season.ts`.
