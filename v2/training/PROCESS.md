# The training process (both machines)

Agreed 2026-10-23. Both machines train the same 40 individuals toward the first milestone (ROADMAP.md: clean, unscripted house drivers for any condition). Until now each machine grew its own process. This is the one process both follow: the same stages, the same gates, shared code, and a clear owner for each skill. PLAYBOOK.md says *why* each rule is here.

## Where the two processes stood

| Stage | Ovals (oval machine) | Circuits (circuit machine) |
|---|---|---|
| Teacher | traffic racer from personality (`racerStyle`), own cautions (smooth formation), draft-aware | traffic racer from personality (`roadTeacherOf`), the computed fastest line, never passes |
| Where students copy | full 40-car classroom races with debris cautions, plus solo drives from three lanes | solo drives from lanes, 12-car pack drills of 50 s, speed knocks; road cautions in 20-car classroom races with start drills; pits in drills, half in traffic |
| Practice | ES and PPO caution drills (flat); PPO race practice anchored to the teacher (moved practice races, not the benchmark) | PPO solo practice (works); ES racecraft in 12-car packs (works: valid laps 75% → 96%) |
| Measure | bench at 40 cars, 150 km; readiness | circuits.ts at 20 cars, 25 km (the easy case: 40 cars breaks students); readiness |

What the comparison says:
- **Every failure in the first combined bundle was traffic:** caution lines, safety cars, pit road, restarts (readiness v1: 0 of 17 cells). Each machine treated it as its own problem; it's one problem.
- **Each machine has a working piece the other lacks.**
  - Ovals: full-field classroom races and solo moments.
  - Circuits: track knowledge, knocks, PPO solo practice, ES racecraft.
- **Teachers aren't clean everywhere.**
  - Oval teachers lose cars on big generated ovals.
  - Circuit teachers lose 2.7-8.6 cars over 150 km.
  - The pit maneuver hits the wall on superspeedways.

  A student can't be cleaner than its teacher, and "no worse than the teacher" means little where the teacher wrecks.

## The process: one pipeline per skill, the same for every skill

Skills: `oval.racing`, `oval.cautions`, `road.racing`, `road.cautions`, `pits`. Every skill goes through the same five stages, each with a gate. A skill doesn't move on until its gate passes, and a failed gate sends work back to the stage it points at.

1. **Teacher.** A scripted teacher for the skill, built from the driver's personality (`styleOf(personality, discipline)` once it exists; `racerStyle` / `roadTeacherOf` today).
   - *Copyable:* no on/off control, no threshold rules, labels from where the car is (`takeOver`), steering mirrored with the student's view.
   - *Gate:* a field of teachers is clean in every readiness cell the skill drives in. Measured by readiness's "teachers clean" column:
     - at most 5% of the field out on average
     - **at most 10% of pit stops called for damage**
     - no wall hits by the maneuver

     Retirements alone passed teachers that trade paint all race. On a 40-car short oval, teachers lost nobody but did 9.3 units of damage by fault, and 70% of their stops were repairs.
   - Readiness reports damage done by fault per car per 100 km, and stops by reason (fuel, tyres, damage, caution, penalty), so a clean-but-bruising field shows as one.
2. **Apprenticeship.** DAgger: the teacher drives the first round, then the students drive through their own human limits while the teacher labels from where they are. The mix is the same on both disciplines:
   - **Solo moments**, about half: lanes, worn tyres, speed knocks.
   - **Full-field classroom races** (40 cars, full rules, debris cautions or safety cars), so traffic, cautions, restarts and pit road appear as often as in real races.
   - **Targeted drills** where races are too sparse: start drills (grid boxes), pit drills (alone and in traffic).
   - Each skill network trains on its own moments plus as many racing moments, so it can't forget how to race.
   - *Gate:* copy fidelity on held-out, student-driven moments, by situation (green alone, green in traffic, caution, pit). Each situation at 85% explained or more, or the gap understood (perception before capacity).
3. **Practice.** Outcome-scored, in seconds, anchored to the teacher (a small supervised step toward its labels after each update).
   - **PPO solo** for racing pace: proven on circuits.
   - **ES racecraft in full fields** for traffic: proven on circuits in 12-car packs; to be tried at 40 cars on both disciplines.
   - Practice that doesn't move readiness is dropped, however its own drills look.
   - *Gate:* readiness doesn't get worse in any cell, and gets better in the cells it targets.
4. **Bundle.** The skill goes into the shared candidate bundle (`public/drivers/`, one file, the 40 individuals by lineage, an `index.json` note naming each skill's version and the machine that trained it).
   - The other machine builds on the latest candidate. Never on a private copy.
5. **Readiness.** The whole matrix, the candidate against its own teachers, logged in RESULTS.md with its table under `experiments/`.
   - *Ready:*
     - no worse than the teachers (paired, race by race) on retirements **and on damage done by fault**
     - within 3% of their pace
     - no scripted driving (under 1% of car-time)
     - at most 10% of the field out (the absolute cap: user-approved 2026-10-23)
     - **at most 10% of pit stops called for damage** (user-approved 2026-10-23)
   - *Two tiers* (`scripts/readiness.ts --tier`):
     - **quick:** 2 seeds, 20 cars, 2 circuits; about 10 minutes for ovals. For iterating.
     - **full** (the default): 4 seeds, 20 and 40 cars, 4 circuits; about an hour for the whole matrix. For gates and bundles.
   - *Copy fidelity* (stage 2's gate) gets one tool, `scripts/fidelity.ts` (to come, oval machine): any skill and either discipline, held-out student-driven moments fitted by situation, with the share of the teacher's answers explained.

## Shared code, one copy

Where both machines need the same thing, there is one implementation, and a change to it is a line in RESULTS.md (it changes both funnels' results).

- **The recorder:** one DAgger recorder for every skill (today `OvalApprentice` and the pit recorder; the road apprenticeship's own to merge in). It handles takeOver, mirroring, latency and sampling.
- **The classroom race:** one function, parameterised by discipline (track source, rules, teacher style, debris rate). Today `ovalApprentice.classroomRace` and `roadCautions.classroomRace` are near copies.
- **The traffic lesson:** ES racecraft in full fields, one module for both disciplines (today `roadcraftLesson` for 12-car packs on circuits, `racecraftLesson` for ovals).
- **Teachers:** `TrafficRacer`, the formation and smooth formation, the pit maneuver. A fix by either machine is a fix for both (the passing fix 73288c2 changed both readiness baselines).
- **Measures:** readiness, the oval bench, circuits.ts. A change to what they count is announced (e.g. 5f2e2e7: a driver's own stops are no longer counted as scripted).

## Who owns what

| | Oval machine | Circuit machine |
|---|---|---|
| Skills | `oval.racing`, `oval.cautions` | `road.racing`, `road.cautions`, `pits` |
| Teachers | big-oval traffic racer, oval cautions | road traffic racer in 40-car and 150 km races; road cautions; the pit maneuver as a teacher (its superspeedway walls) |
| Shared code | readiness, the oval bench, the classroom race | circuits.ts, the recorder, the traffic lesson |

Both machines train onto the latest candidate bundle. Each run is a lab spec, recorded in RESULTS.md.

## Order of work (both machines)

1. **Clean teachers** for every skill, in every readiness cell. This is the ceiling and the yardstick.
2. **Shared code:** one recorder and one classroom race, before more student work, so fixes land once.
3. **Apprenticeships to the gate:** every skill copied in full-field classroom races and its drills. Measure fidelity by situation.
4. **Practice in traffic:** ES racecraft at full field, on both disciplines. Then readiness.
5. Iterate on the cells readiness still fails, by the stage its failure points at.

## Rules of the road

- Long runs in the lab (pinned worktree), never from the main tree.
- Pull before starting a run. Push the RESULTS line and any shared-code change when it lands.
- Bundles are exchanged only through `public/drivers/` and its `index.json`. Experiments name the candidate they started from.
- A result is a readiness table or a named benchmark with seeds and its 95% ranges, never a single race.
