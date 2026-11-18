# Oval racing: clean first, passing next (2026-10-25/26)

Code: 91c88e5. Oval machine, `dotgp-oval` worktree.

Goal (the user's): oval racing that is consistently clean and fast, with high pass rates and side-by-side racing.

## Baseline: the v3 stable, scripted stops

Learned pit stops are the other session's work, so the stops are scripted here. Source: `incidents.ts`, 40 cars,
2 races per track.

| | out per race | clean passes /100 green car-laps | side by side | damaging contacts /100 |
|---|---|---|---|---|
| stable: short | 22 | 7.2 | 9% | 11.5 |
| stable: speedway | 24 | 53 | 18% | 9.2 |
| stable: flat | 1 | 5.2 | 7% | 2.1 |
| teachers: short | 0 | 0.5 | 5% | 0 |
| teachers: speedway | 0 | 7.8 | 4% | 0 |
| teachers: flat | 0 | 5.0 | 4% | 0 |

On the speedway, about 30 of the stable's 34 traced retirements had a smoking car in them, under green and under
caution alike. Most were a sound car at speed running into a broken one.

## The field's side of a broken car

`brokenDrill(..., 'ahead')`: a car 1-3 places ahead of the student breaks. In 96 drills each (20-car packs), the
teacher in the student's seat hit something in 1, the students in 18.

`brokenCar.ts --ahead 4` trains the racing network on these drills' moments: pack racing, then going round the broken
car. Eight drivers, 6 rounds: students with a hit 18 → 2 of 96.

All 40 drivers (`--rounds 6 --tracks 3 --drills 3 --ahead 4`, 15.9 min; 31 of 40 broken-car licensed), bench against
v3 with scripted stops (7 ovals, 4 seeds, rules on):

| | out per race | cautions | clean passes /100 | side by side | lap (s) |
|---|---|---|---|---|---|
| short | 20.2 → 8.0 ✱ | 9.2 → 3.8 ✱ | 7.7 → 3.1 ✱ | 8.0% → 7.3% | 26.7 → 27.0 |
| speedway | 24.2 → 5.2 ✱ | 7.0 → 1.2 ✱ | 47.5 → 16.4 ✱ | 18.5% → 5.2% | 37.6 → 37.9 ✱ |
| flat | 0.5 → 0 | 0.2 → 0.8 | 6.9 → 5.5 | 7.4% → 5.1% | 43.6 → 43.7 ✱ |
| gen. short | 6.5 → 1.5 ✱ | 3.2 → 1.2 ✱ | 3.1 → 0.7 | 1.7% → 2.4% | 25.6 → 25.6 |
| gen. intermediate | 9.0 → 5.8 | 3.0 → 2.5 | 18.1 → 8.8 ✱ | 11.0% → 4.8% | 47.2 → 47.3 |
| gen. speedway | 33.2 → 4.5 ✱ | 8.0 → 1.0 ✱ | 94.8 → 22.6 ✱ | 21.5% → 5.2% | 40.5 → 40.5 |
| gen. superspeedway | 31.5 → 14.8 | 6.2 → 1.8 ✱ | 123.9 → 41.7 ✱ | 15.1% → 3.7% | 41.6 → 42.0 ✱ |

- **Wrecks:** down 2-7× wherever there were many.
- **Passing and side by side:** down to near the teachers' level. The students learn their teachers' caution, and the
  teachers hardly pass.

## Teacher passing

A probe of 10 minutes of a 40-car teacher race on each oval:

| | pass attempts | completed |
|---|---|---|
| short | 3302 | 2 |
| speedway | 3110 | 25 |
| flat | 1990 | 11 |

On the short oval an attempt lasted 0.8 s on average.

**Kept (91c88e5):**
- A pass under way holds its side while its line isn't more than 1 m/s slower than the car it's passing.
- Making a pass, a car uses 6% more of its grip (up to 95%).

Effect: teachers' clean passes short 0.5 → 3.3, flat 5.0 → 6.6, speedway 7.8 → 7.1. Still 0 out, 0 damaging, the same
lap times.

**Tried and reverted:**
- **The car being passed gives room** (beside it only as near as the road allows). Room failures went, but the speed
  check failed instead.
- **Side lanes judged against the other car's speed there**, not now. Cars sat off the line in "passing" mode without
  getting alongside: side by side 2-3%, laps slower.
- **Progress along the road** instead of speed. No change.
- **The pass threshold ×0.5 and ×0.2.** No change: speedway clean passes 7.0-7.7 throughout.

What limits it: most attempts end with neither side's line working. The side line is the racing line shifted by a car's
width, and through a corner the racing line runs to the wall at the exit and to the inside at the apex.

## The fastest line isn't

A solo lap on a constant lane off the fastest line (`fastestLine(track, 0.6)`, 86% grip):

| | −6 m | −3.5 | line | +3.5 (inside) | +6 |
|---|---|---|---|---|---|
| short | 30.91 | 27.25 | 25.92 | 25.76 | 25.91 |
| speedway | 37.54 | 36.95 | 36.60 | 36.34 | 36.37 |
| flat | 44.52 | 43.38 | 42.85 | 42.49 | 42.22 |

A lane inside the line laps 0.6-1.5% quicker on every preset oval. The line optimiser leaves time and distance on the
table.

## Next

- **Pack racing for the teacher.** Lanes held side by side at about the same speed, rather than single file with short
  pass attempts.
- **A faster line.** It makes everyone faster, but every student was trained on today's line, so they'd need
  retraining.
