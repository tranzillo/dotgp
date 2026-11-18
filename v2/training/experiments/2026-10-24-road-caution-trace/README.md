# Road cautions traced: what students do under the safety car, and a field that ran dry after the flag

2026-10-24, circuit machine, on the new pit roads (1496d0e). Candidate bundle `public/drivers/stable-candidate.json`.

## Readiness on the new pit roads (@1496d0e, before any fix)

| Where | Cars | km | Out (teachers / students) | Repairs | Teachers clean |
|---|---|---|---|---|---|
| club + GP | 20 | 150 | 0.0 / 17.9 | 0.6% / 45.9% | yes |
| club + GP | 40 | 150 | **2.9** / 37.9 | 2.0% / 70.7% | **no** |
| club + GP (sprint) | 20 | 25 | 0.0 / 8.2 | 0.0% / 84.3% | yes |

Circuits now take up to 47 cars (more boxes), so the 40-car cell races 40.

## Students under the safety car (4 races, 20 cars, 150 km; each car's own teacher labelling from where it is)

| Where its place in line is | Share | Off track | Crawling (< 3 m/s) | Throttle / steering error vs teacher |
|---|---|---|---|---|
| in place (20 m) | 20-23% | 5-9% | 42-57% | 0.26-0.34 / 0.10-0.16 |
| 20-120 m away | 9-23% | 9-18% | 6-19% | 0.40-0.50 / 0.17-0.26 |
| 120+ m ahead | 57-68% | **21-30%** | 0-6% | 0.40-0.41 / 0.16-0.21 |

Mean throttles match the teacher's; moment by moment they don't. Stopped cars: on track or in the run-off with the
place far ahead and nothing near ahead, the teacher at +0.7 and the student braking to a stop. At most 1 of 20 finished
in any of the four races, and two of them ran out of time.

## What the caution skill learns from (one round of apprenticeRoadCautions, students driving)

Classroom race: 72% of pacing moments have the place 120+ m ahead (the teacher's throttle there averages +0.24: half
going, half braking). Start drills are a third of all pacing moments, mostly waiting on the grid. Coverage isn't the
problem.

## Perception before capacity (64-64 networks, 4 classroom races to fit, 1 held out; variance explained, throttle / steering)

| Inputs | All | In place (12%) | Place 120+ m ahead (80%) |
|---|---|---|---|
| student's inputs | 59% / 79% | 17% / 68% | 61% / 79% |
| + safety-car speed here and 60 m on, picked up | 57% / 81% | 48% / 72% | 57% / 81% |
| + car in the path to 220 m, wreck | 57% / 82% | 28% / 77% | 62% / 82% |
| + all | 59% / 79% | 45% / 73% | 63% / 78% |

Before the pickup the teacher (`SmoothFormation`) ignores the slot and drives to `paceSpeedAt(car.s)` plus its
eagerness, which no input shows; the safety-car speed helps cars in place, but no one missing input makes the caution
teacher copyable (eight personalities pooled: some of what's left is their eagerness). With the earlier proportional
caution teacher (copy error 0.29 → 0.16, races no cleaner), copy fidelity isn't what limits readiness.

## The teachers at 40 cars: a field that ran dry after the flag

One of eight traced races (Bramville, seed 1) lost 39 of 40 teachers in 36 s on the last lap: all had **finished**. Crews
fuel to the flag; the first finishers ran dry on the slowing-down lap, race control's stall rule retired them as wrecks
and called a safety car, and every car still finishing queued behind them (road teachers never pass) and was retired in
turn. The other seven races lost 0-3. The same cascade happens mid-race: a teacher stops behind a wreck under green, is
retired after 5 s, and becomes the next wreck (a GP race with teachers driving lost 10 healthy cars this way in 37 s).

Fixes:
- Race control: a car that has finished isn't a wreck (no stall retirement, no safety car for it).
- circuits.ts: a car out after taking the flag finished; it isn't counted out.
- Traffic racer: a stopped car (retired, or under 5 m/s while it comes up on it) is gone round by every driver,
  wherever it is, whatever its passing style (road teachers' `pass` is Infinity).
- `wreckAhead` returns the nearest wreck (it returned the first in the list; the formation goes round that one).

Circuit readiness with them (candidate, teachers / students out): 20 cars 0.0 / 17.5, **40 cars 0.3 / 37.7** (was 2.9),
sprint 0.0 / 6.8. Teachers clean in all three. Students unchanged: they learned from the old teachers.

Ovals (same teacher code; oval readiness on 1496d0e with and without the fixes): teachers clean in 12 of 14 both ways,
students identical; one cell moved, the generated intermediate at 20 cars (teachers 1.8 → 2.5 out, already failing; 4
seeds).

## Next

- Retrain road cautions (and road racing in full fields) on the fixed teachers: students copied teachers that queued
  behind wrecks.
- Pit skills on the new pit roads (`pitRoute` changed in 1496d0e): retrain.
- The caution teacher's lane before the pickup is "where you are", clamped to ±6 m: the edge of a club circuit. Students
  are off track 21-30% of the catch-up. Keep it inside the track (minus a margin) on circuits.
