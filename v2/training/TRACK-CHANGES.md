# Coming track changes that affect training (from the track-generation work)

Agreed with the user on 2026-10-23. These change geometry that trained skills
depend on, pit stops most of all. Each lands in its own commits with a
`pitsurvey` / `realtracks` report, so the training machines can pick when to
retrain on them. Several respond to `feedback/pit-layout.md`.

## 1. Pit lanes (landing in stages, 2026-10-23)

Landed:
- b5e0676: the nose clearance (4 m with today's cars).
  - `PitLane.fastD`/`boxD` are read through `pitFastD`/`pitBoxD`.
  - Ovals have an inside pit wall and crews' strip (`crewD`).
  - The pace car is released earlier by the extra distance it has to cross.
- The next commit: placement along the lap.
  - At most 40 boxes, centred on a longer pit road.
  - The ovals' blend ends at most 250 m past the exit taper.
  - Circuit pit road sits where there's room round the start line, with 250 m entry lanes (into the last corner where its inside has room) and paddocks sized to the space.
  - The 420 m main-straight rule is gone.
- The next commit: pit stops that work on the new pit roads (`npx tsx scripts/pitsurvey.ts 10 --real`).
  - Circuit stops were hitting things since b5e0676: the scripted entry route ran off the paving, and the merge
    could start across from the pit wall. Now every generated kind gets 10/10 clean stops (club 9/10 and GP 7/10 before).
  - The entry paving flares out to the fast lane over its first 60 m (`pitEntryFlare`), a deceleration lane.
  - The scripted route (`PitAutopilot`, `pitRoute`) starts as far in as the paving allows. It calls an entry off
    only in the last 60 m before the nose (it was 140 m). The merge never starts before the exit taper.
  - Pit-trained drivers learned the old route; `pitRoute` is their target, so retrain them on the new one.
- The commit after: the entry lane stays one lane wide (out past the fast lane) until 40 m before the wall
  (`PIT_ROAD_FLARE`), then widens to pit road. Every generated kind still gets 10/10 clean stops.
  - Real tracks' pit lanes from OpenStreetMap (`public/tracks/pits.json`, `scripts/osmpits.ts`). They're
    opt-in for now (`?pits=mapped`, `--mapped`) and don't change anything by default.
- The presets changed with each; their fingerprints in `test/trackgen.test.ts` are updated.
- The commit after (2026-10-24): laid pit lanes on circuits, `pit.entryRoute`/`exitRoute` like the ovals' set-back pits.
  - Generated circuits whose last corner is a left-hander get an entry across its inside, with a grass island between it
    and the track, where it fits (about 1 in 4: 12 of the first 50 seeds). Pit road may start a little further on for it.
  - Real tracks with `?pits=mapped` follow the real lane's line in and out where it fits; mapped stops are 23/29 clean
    (15/29 before), level with our own placement.
  - These count as set-back pit roads for learned drivers (`setBackPits`): without it, the script drives the stop.
  - The script on a road circuit's laid lane: the call 500 m before the entry (ovals keep 700), moving over from the call
    on instead of holding its lane through the corners. `followLine` in sweep mode now adds the lane's bend
    (feed-forward), which also changes the ovals' set-back lanes a little. Retrain set-back pit skills on it.
  - The presets (ovals) didn't change.
- The commit after (2026-10-24): real circuits use their mapped pit lanes by default (`?pits=placed`, `--placed`
  for our own placement).
  - Mapped: Catalunya, Monza, Bahrain, Mexico City, Hungaroring, Interlagos, Sepang, Silverstone, Red Bull Ring,
    Zandvoort. The rest have no mapped lane, or ours won't fit theirs, or the ovals (their mapped lanes aren't used).
  - Where the mapped entry comes out shorter than pit road's 40 m flare (`PIT_ROAD_FLARE`), our own placement is used
    if its entry is longer and it holds as many boxes. Austin falls back this way (18 m mapped, 98 m ours). Zandvoort
    keeps its mapped lane (24 m entry): ours there holds 3 boxes and doesn't lay out.
  - `pitsurvey.ts 10 --real`: real stops 23/29 clean (23/28 with `--placed`; Zandvoort lays out only mapped).
    Failing: Austin and Norisring (the car never pits), Moscow, Sochi, Zandvoort and Martinsville (it hits something).
    Every generated kind still gets 10/10.
  - Every mapped one has a laid lane (`pit.entryRoute`), so it counts as a set-back pit road (`setBackPits`). That's
    new at Hungaroring, Monza, Interlagos, Sepang, Silverstone and Zandvoort.

- The commit after (2026-10-24): **short ovals' pit road down both straights** (Bristol, Martinsville): from the
  straight before the last turn, round its inside, along the front stretch, boxes on both straights 10.5 m apart,
  on a short oval (a lap under 1600 m) whose front stretch holds fewer than 20 boxes.
  - Boxes: generated short ovals 15/29/38 (were 1/10/24), the short preset 26 (9), Bristol 11 (2), Martinsville 23 (7).
    Short-oval fields are about three times bigger under the one-car-a-box rule.
  - **The short preset changed** (fingerprint in `test/trackgen.test.ts`). Readiness and bench numbers on the short
    oval aren't comparable across this commit.
  - Pit-lane s runs past the half-lap point there (`entryStart` < -L/2), and the way in can be more than a lap (a car
    with a front-stretch box drives round to the entry first). Code comparing signed s with pit-lane s uses
    `Track.pitInR`/`pitInAt` (a called car's way in, counted from the call), `pitOutAt` (from its box), `pitInS`/`pitOutS`
    (the pace car). They return signed s exactly on every other track. The pit observation's box distance uses them.
  - The call on such a track is 300 m before the entry (on the front stretch), and the scripted way in is eased and
    followed matching its slope and bend. Pit-trained drivers haven't seen this layout: the user's caveat is that boxes
    on two straights may be hard to learn; if so, it's reconsidered.

Known: `test/pitdriving.test.ts` "a team with a pit-trained driver hands it the whole stop" fails with or without these changes.

The plan:

One pit module for every track: generated ovals and circuits, rovals, and
real tracks. Every generated track will pass these as hard checks:

- **The nose clear of the racing surface.** The pit wall's face sits at
  least a car's width plus 1 m inside the track edge, with an attenuator on
  the nose. A painted pit-entry line runs before it and counts as a track
  limit for cars not pitting.
- **Room to slow off the racing line.**
  - Circuits: an entry lane of at least 200 m. Where the last corner turns
    towards pit road, the lane splits off on its inside before that corner.
  - Ovals: the lane leaves the apron after the last turn.
- **Pit road can run alongside corners, on the inside.** It isn't limited
  to the main straight any more: it can start before the last corner and
  end past turn 1, as real pit lanes do. `entryStart..blendEnd` may span
  corners, so code that assumed a straight pit lane should check.
- **Boxes sized to pit road,** up to 40. Short ovals still race smaller
  fields (`Track.maxField`) until pit road on both straights arrives.
- **A bounded blend:** a few seconds at track speed after the exit, not
  down the next straight.
- **Cross-sections** in real proportions:
  - Ovals: a travel lane, boxes, then an inside pit wall with a crew strip
    behind it.
  - Circuits: the pit wall on the track side, a fast lane, then the boxes
    with garages facing them.
- **The paddock** sized to the room actually there.

The pit lane stays on the left (positive d). Clockwise real tracks stay
mirrored in the sim and are only drawn the right way round. Pit lanes on
either side are a later milestone.

## 2. Real tracks as benchmarks (in now)

`src/trackgen/realtrack.ts` lays out real tracks from survey data
(`public/tracks/`): 24 circuits (TUMFTM) and 6 NASCAR ovals
(OpenStreetMap).

- In the app: `?track=real:<id>`.
- `npx tsx scripts/realtracks.ts` reports fit, layout and best lap for
  each.
- Real lap times to calibrate against: Daytona pole 49.465 s (we're 45.2),
  Indianapolis pole 49.469 s (we're 58.2).

Calibrating to a Cup car needs per-track power packages and more cornering
grip. That's a physics change, to be planned with both machines.

## 3. Car width (decided in principle, not scheduled)

- Cars 2 m wide instead of 3 m (`PHYSICS.CAR_RADIUS` 1.5 to 1.0), with
  track widths brought down to real ones (3- to 5-wide racing).
- Try it by eye: `?car=2&widths=0.75` (`src/sim/experiment.ts`).
- It changes every trained driver's sense of room. The plan is to land it
  together with the calibration above, as one retrain.
- 2026-10-24: pit road 1.33x wider made no difference to crowded pit lanes, but 2 m cars cut pit-cycle contacts by a
  third to two thirds (RESULTS.md, "pit road width vs car size").

## 4. A Cup car (proposal: built behind a switch, not landed)

`?spec=cup` (app; `--experiment '?spec=cup'` in incidents.ts and bench.ts) races a NASCAR Next Gen Cup car
(`src/sim/carSpec.ts`), 2 m wide. The default car is untouched (its spec returns PHYSICS's numbers exactly).

- **New physics:** downforce (0.5 rho ClA v^2 on the tires' load, so more grip and more braking at speed), per-track
  engine packages (670 hp; 510 hp on ovals over 3.2 km banked 20 degrees or more: Daytona, Talladega), a tire grip
  factor, mass 1625 kg. The racing line (`racingLine.ts`) knows all of it.
- **Calibration** (`npx tsx scripts/calibrate.ts [--fit]`, against 2024 poles): best laps within 0.5% at Daytona and
  Talladega, 2-3% slow at Indianapolis and Michigan, 4-6% fast at Charlotte and Bristol, 7% slow at Martinsville.
  Fast on steep banks, slow on flat tracks: tires that grip less per unit of load as the load grows (load
  sensitivity) are the likely next step.
- **First race** (speedway preset, 25 laps, house drivers): laps 3-7 s quicker than today's car, retirements 8
  against 5 (drivers trained on today's car), pit-cycle contacts 5 against 23.
- **Not done yet:** the scripted drivers and teachers (`lineFollower`, `trafficRacer`, race control's pace speeds)
  still judge corners on grip alone, without downforce, so they drive the Cup car conservatively. Before any retrain
  they need the spec's downforce and grip.
- **Proposed landing, one retrain:** 2 m cars, real track widths, and the Cup car together; teachers updated first,
  then the stable retrained on them. Both machines should agree the date.
