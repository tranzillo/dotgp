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
