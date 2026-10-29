# The broken-car skill: first result (2026-10-25)

Code: 32fff25 (the curve keeps grip), 312aa1f (mirrors), d014989 (the skill and its lesson; committed inside another
session's bundle commit). Oval machine, `dotgp-oval` worktree.

## What it is

- **The skill:** `NeuralDriverExtras.broken`, a network of its own that drives a broken car under green. It starts as
  a copy of the racing network, so racing can't change.
- **What it's shown:** its track-knowledge inputs show the apron's route (`observe.ts brokenRoute`) as its line once
  the car is broken: the apron's middle, clear of the pit wall.
- **The lesson** (`src/school/brokenCar.ts`, `scripts/brokenCar.ts`):
  - A 12-car pack of individual teachers races on an oval. The student's car breaks at a random moment, to anywhere
    from just broken to barely moving.
  - Round 0 the teacher drives; after that the student drives and its teacher labels every decision (DAgger).
- **The teacher:** a line follower down the same route, with a proportional throttle. It holds its lane while its
  mirrors show a car arriving below it within 2.5 s.
- **The licence test:** on each preset oval, broken to 0.4 and to 0.1 health, the car reaches the apron within 12 s,
  touches nobody and never stands still on the racing surface. Every teacher passes; every racing network fails.

## What it took

| teacher | steering explained (R²) | licence (3 drivers) |
|---|---|---|
| the traffic racer's own way off the line | 0.42-0.67 | 0 of 3 |
| the route follower | 0.97-0.98 | 3 of 3 |

The traffic racer moves off the line as an offset from the racing line, crossing at its own rate. A student can't see
that offset. Copied, students steered too little and drifted back up the track out of the corners.

None of these helped that teacher: more epochs, more examples, racing moments in the mix, or the route as an input.
Racing moments in the mix are now off by default. They showed the car on its line from nearly the same inputs.

## The stable

`brokenCar.ts --in stable-candidate.json --rounds 6 --tracks 3 --drills 6` (16.8 min): **36 of 40 licensed**. The
four that failed all reached the apron, but were slow or touched someone.

Bench, the candidate → with the skill (7 ovals, 40 cars, 4 seeds, rules on):

| track | out | damage stops |
|---|---|---|
| short | 23.8 → 24.5 | 23.2 → 10.8 ✱ |
| speedway | 29.2 → 27.8 | 7.8 → 6.0 |
| flat | 21.2 → 20.2 | 8.0 → 5.5 |
| gen. short | 8.8 → 8.8 | 24.8 → 4.5 |
| gen. intermediate | 22.5 → 22.8 | 2.2 → 3.5 |
| gen. speedway | 38.2 → 37.2 | 4.2 → 5.2 |
| gen. superspeedway | 33.8 → 33.2 | 4.8 → 3.8 |

**Retirements didn't move.** The hit probe (2 races each, speedway and short) shows why:

| | candidate | with the skill |
|---|---|---|
| contact retirements with the smoking car on the apron (speedway) | 15 of 30 | 28 of 36 |
| contact retirements with the smoking car on the apron (short) | 21 of 36 | 25 of 30 |

Broken cars now get low, but they're hit there. In the apron hits with the skill, the other car was:

- **Pitting:** 26, mostly on its in-lap. Pit road starts from the apron, and the pit skill doesn't slow for a crawler.
- **Another broken car:** 22. The route teacher has no follow cap: it drives the route flat out into whatever is
  ahead, and the drill only ever has one broken car.
- **Racing:** 5.

## Next

- **Teach it traffic on the apron.** The teacher gets a follow cap for cars ahead on its route. The drill gets
  crawlers on the apron ahead of it, and pitters coming through.
- **Teach pitters about crawlers.** The pit skill (and its maneuver teacher) should slow for crawlers on the apron.
  That's the pit work's area.
- **Get the car in sooner.** A broken car crawls most of a lap before the crew's call point: many hits came 30+ s after
  the break.

Raw (oval machine scratch): stable-broken.json/.txt, broken-bench.json/.txt, hpb-*.txt, hpb2-*.txt.
