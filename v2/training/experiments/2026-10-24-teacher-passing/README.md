# The traffic racer: clean following, and passing that doesn't need a bug (2026-10-24)

Oval machine. Shared teacher code (`src/ai/trafficRacer.ts`, `src/ai/racingLine.ts`): circuit teachers change too.

## What was wrong

Traced every car-to-car hit in 40-car teacher races (short oval, before the box rule):

1. **The speed plan floored it into the car ahead.** `followRacingLine` plans from the speed wanted now and a quarter
   second ahead. The follow cap applied only up to where the followed car is now (`ahead <= followAt`), so a car
   closer than ~7 m dropped out of the "ahead" half of the plan, and the plan saw a speed-up and accelerated. Alone,
   fixing it cut short-oval damage done by fault 10.4 → 2.8 a race.
2. **Cars crossing the road to or from pit road** were obstacles only where they were: diving to the apron (the
   circuit machine's pitter rule covers this now), and **merging out** into the inside lane in turn 1, passed on the
   outside right where they were going. A merging car's path is now the span to the inside lane; it's passed beside it.

## The catch: the bug was how the field passed

With (1) fixed the field ran single file: passes down 80-95%, side by side 10-15% → ~1%, laps 1-2.5% slower.
A pass trace (speedway, 40 cars, 2 races) on the circuit machine's racer (ac64ae0) showed why:

| | their racer (with the bug) | fixed, no bump |
|---|---|---|
| passes | 621 | 110 |
| passes with contact between the pair | **85%** | 17% |
| gap 3 s before the pass (median) | 1.7 m | 13 m |
| closest approach (median) | 0.3 m | 0.8 m |
| following time nose to tail (< 4 m) | 10% | 0% |

**Bump-and-run**, at about the damage threshold (4 m/s): nose to tail inside its own follow gap, a touch, the car
ahead loses speed, past. Real oval racing, but done by a bug.

## What the racer does now

- Follows correctly (the cap at every distance).
- **Passes on its own pace** (or its run): judged on its speed now, a car that followed properly was never "faster".
- **No rule against passing in corners** (user: no prescriptive rules anywhere). Instead a pass starts or carries on
  only **where it pays**: beside the car, all the way past it, the path stays on the road and its arc beats that car's
  speed. Without the judgement: 240 wall hits in 40 laps on a generated speedway; with it, 30.
- **Slingshot:** stays in the tow while closing, pulls out at the last moment it can, and isn't braked back to the car's
  speed while getting beside it if it will be beside in time.
- **Pushing:** closing on a car it means to pass, it plans on its car's real braking, not the gentle following brake.
- **Bump (nerve):** `RacerStyle.bump`, the speed it's willing to touch that car at: 0 below middling nerve, up to 1.5x
  the damage threshold for the boldest. What a touch does is the physics' and the stewards'. (User-approved.)
- **Carry:** `followRacingLine` keeps speed carried above the line's profile (a tow) up to the grip limit (new:
  `LineProfile.limit`), instead of lifting back to the no-draft plan.

Tried and dropped: holding the lane beside a car (more side contact), making a run by hanging back (fewer passes).

## Numbers (teachers, stable-candidate.json, 40 cars capped by boxes, 4 seeds, 150 km)

| | their racer (ac64ae0) | fixed, no bump | **fixed + bump** |
|---|---|---|---|
| passes /100 green car-laps (speedway / flat / gen. int. / gen. speedway / gen. superspeedway) | 19.8 / 15.1 / 17.8 / 23.0 / 28.3 | 3.8 / 7.0 / 3.6 / 4.0 / 4.1 | **7.5 / 5.2 / 5.0 / 9.5 / 3.8** |
| time alongside | 9-13% | 1-3% | **3%** |
| lap time (s) | 37.98 / 43.70 / 47.50 / 40.66 / 41.94 | 38.59 / 44.21 / 47.83 / 41.79 / 42.61 | **38.19 / 43.88 / 47.45 / 41.30 / 42.47** |
| stops for damage | 6.3 / 0.3 / 13.0 / 13.5 / 15.0 | 2.8 / 0.3 / 4.5 / 14.0 / 3.8 | **0.5 / 0.0 / 3.8 / 10.8 / 2.3** |
| cars out | 0 / 0 / 1.8 / 0 / 1.0 | 0 everywhere | **0 everywhere** |

Cleaner than their racer everywhere, nearly its pace, a third of its passing.

## Next (oval machine)

- **The draft as an edge.** On the superspeedway every car is engine-bound nearly all lap, so no driver has a pace
  edge and the trigger never fires (3.8 passes against 28). A car in a tow can go faster than its pace: counting what
  the draft is worth at that gap should unlock pack passing.
- Then readiness on the new teachers, and the stable re-apprenticed to them.

**Circuit machine:** road teachers (`roadStyle`: `pass: Infinity`) never pass, so the pass changes (pace trigger,
pass-where-it-pays, slingshot, push, bump) don't reach them. What does: the follow cap at every distance (no more
flooring it within ~7 m of the car ahead), the carry above the profile (a tow on a straight is kept), and the merge
span. Worth a readiness run on circuits; and if road teachers ever pass, these are the pieces to start from.
