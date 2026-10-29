# The breaking curve, and what a broken car does to the students (2026-10-25)

Code: 167b978 (the curve), 935e18c (the training guard). Oval machine, `dotgp-oval` worktree.

## The curve

Damage model 2 (`src/sim/damage.ts`) after the user's brief: a little pace lost down to half health, then the car
breaks. It goes over the limit at once and is barely moving by a tenth of its health.

- Above 0.5 health: power 1 − 0.08·worn², grip 1 − 0.04·worn², where worn = (1 − health) / 0.5.
- Below 0.5, with c = (0.5 − health) / 0.5: power 0.1·(1 − c)², grip 0.75 − 0.25·c.

A Speedway teacher's lap, by health:

| health | 100% | 75% | 60% | 50% | 49% | 40% | 30% | 20% | 10% | 5% |
|---|---|---|---|---|---|---|---|---|---|---|
| lap (s) | 36.6 | 37.0 | 37.1 | 37.6 | 63.7 | 74.4 | 93.8 | 134 | 301 | never finishes |

## A/B: model 1 against the breaking curve

`bench.ts <drivers> --experiments '?damage=1|' --tracks <7 ovals> --seeds 4 --field 40 --rules 1`. Each cell is
model 1 → model 2. ✱ = outside noise.

**Teachers** (`teacher:stable-candidate`):

| track | out | cautions | damage stops | damaging contacts /100 | clean passes /100 | lap |
|---|---|---|---|---|---|---|
| short | 0 → 0 | 0 → 0 | 0 → 0 | 0.8 → 0 ✱ | 0.4 → 0.6 | 27.0 → 26.9 |
| speedway | 0 → 0 | 0 → 0 | 0.8 → 0 | 0.8 → 0 ✱ | 7.0 → 6.1 | 38.2 → 38.1 |
| flat | 0.5 → 0 | 0.2 → 0 | 0.5 → 0 | 0.5 → 0 | 5.1 → 4.6 | 43.9 → 43.8 |
| gen. short | 0 → 0 | 0 → 0 | 0 → 0 | 0.8 → 0 | 0.6 → 0.5 | 25.4 → 25.4 |
| gen. intermediate | 0 → 0 | 0 → 0.2 | 0.2 → 0 | 0.3 → 0.1 | 4.5 → 4.6 | 47.3 → 47.3 |
| gen. speedway | 0 → 0 | 0 → 0.2 | 2.8 → 0.2 | 1.5 → 0.1 ✱ | 7.6 → 7.2 | 41.0 → 41.2 |
| gen. superspeedway | 0 → 0 | 0 → 0 | 1.0 → 0.2 | 0.7 → 0.1 | 3.7 → 3.9 | 42.5 → 42.5 |

The curve costs clean drivers nothing. They rarely break, though, so this doesn't test a sudden break in traffic.

**Stable** (`stable-candidate`): retirements per race (of 40) and damage stops.

| track | out | damage stops |
|---|---|---|
| short | 23.5 → 20.0 | 42 → 0 ✱ |
| speedway | 25.8 → 23.5 | 23.5 → 0 ✱ |
| flat | 21.2 → 20.5 | 32 → 0 ✱ |
| gen. short | 7.8 → 7.8 | 5.8 → 0 ✱ |
| gen. intermediate | 21.8 → 19.8 | 8.5 → 0 ✱ |
| gen. speedway | 35.5 → 31.2 ✱ | 21.8 → 0 ✱ |
| gen. superspeedway | 31.2 → 30.2 | 16.5 → 0 ✱ |

**House** (`default.json`, four old brains with no pit or caution licence, so scripts drive their stops and cautions):

| track | out | cautions | damage stops |
|---|---|---|---|
| short | 16.2 → 20.8 | 9.0 → 14.8 | 135 → 47 ✱ |
| speedway | 12.0 → 21.8 ✱ | 6.8 → 9.2 | 79 → 18.5 ✱ |
| flat | 5.5 → 10.8 ✱ | 2.8 → 6.5 ✱ | 192 → 15.8 ✱ |
| gen. short | 7.2 → 8.0 | 11.8 → 14.2 | 46.8 → 4.2 ✱ |
| gen. intermediate | 13.2 → 17.2 | 6.0 → 10.0 ✱ | 115 → 26.2 ✱ |
| gen. speedway | 20.8 → 30.8 ✱ | 9.2 → 10.0 | 86 → 19.8 ✱ |
| gen. superspeedway | 19.5 → 24.5 | 9.5 → 8.2 | 54.5 → 13.2 ✱ |

## Why the house drivers wreck more

A probe sorted every car-to-car hit (house drivers, model 2, 2 races each). On the speedway, all 36 contact
retirements had a smoking car in them:

- In 19, a healthy car ran into the smoking one. In 17, the smoking car itself was hit.
- 34 of the 36 smoking cars were on the racing surface, not the apron.
- 22 of the hits closed at 30+ m/s.
- Most of those cars had broken 3 to 30+ s earlier: they weren't just caught at the moment of breaking.

The flat oval showed the same: 18 of 18. The house and stable drivers have zero weights on the damage input. A broken
car keeps to the line at a tenth of its power, and the field runs into it. Under model 1 a damaged car kept most of
its pace and was never an obstacle like this.

## Tried and dropped: a scripted "limp low"

A takeover, like the pit and formation scripts, that drove any learned driver's broken car to the middle of the apron.

- The first version wrecked broken cars on the pit wall's nose. The pit wall stands on the apron, and the track's own
  approach to it was too short at limping speed.
- Fixed, it cut house retirements a lot (2 races each):

| | model 1 | model 2 | model 2 + limp |
|---|---|---|---|
| speedway | 16 | 19.5 | 10 |
| flat | 6.5 | 13 | 3 |
| short | 18 | 21 | 11.5 |

It wasn't committed. It took the wheel from every learned driver, the stable included, so it went against the point of
learned drivers. The agreed direction instead is a lesson: drivers learn general car mastery, including what to do with
a broken car.

On the short track, the house drivers' wall hits come from the pit maneuver: 17 in 2 races under model 1. That isn't the
damage model.

## Save-the-car through the apprenticeship: no effect

`stable.ts --from stable-candidate --rounds 6`: the apprenticeship with every damaged moment kept (up to a quarter of
the racing set), against the candidate.

- **First run:** one driver of 40 came back with NaN weights in the last round. The commit 935e18c now drops moments
  with a non-finite input or label and names them in the round log. A step that leaves weights non-finite is undone.
- **Re-run:** clean, with no non-finite moments. Retirements didn't move: short 21.5 → 21.5, speedway 26.5 → 26.5, flat
  21.8 → 22.2, gen. speedway 33.5 → 34.5.
- **Why:** damaged moments are 1-6% of examples, and they come from whatever damage the race happens to deal. Six
  rounds didn't teach it.

## Also seen

- A teacher that breaks mid-corner on the short oval slid into the outside wall (health 0.4 → 0.12). Grip drops at
  the instant of the break, 0.96 → 0.70, at a corner speed set for the old grip. It may be worth making grip fall
  gradually below 0.5 and letting power carry the cliff. Not measured yet.

Raw (oval machine scratch): curve-{teachers,stable,house}.json/.txt, save-train2.txt, save-bench2.json,
hp-*.txt (the hit probe), house-limp2-2.txt.
