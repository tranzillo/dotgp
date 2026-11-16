# The second air model with close following (2026-11-16)

PACK-RACING.md, "back to the goal". Pack racing needs a reason first: a lane faster now than the one a car is in. The
second air model (`?draft=2`: a line takes draft and push both and pushes its leader; `?wake=1`: a car right behind
loses downforce) was within noise on 2026-11-04 because teachers never raced close enough to feel it. `?follow=3` now
lets them follow close and safely, so: the scorecard with it on.

Teachers of v8sp, `?spec=cup&lines=2&follow=3` against `...&follow=3&draft=2&wake=1`, `--rules 1`, 40 cars (36 on the
superspeedway), 4 races a track. Probes: `probes/f3-*` and `probes/air-*` (packCard.ts and passWhere.ts).

## Results

Short / speedway / gen. intermediate / gen. superspeedway, `?follow=3` -> with the air:

| | `?follow=3` | with the air |
|---|---|---|
| position changes a car-lap | 0.145 / 0.300 / 0.208 / 0.235 | 0.166 / 0.285 / 0.206 / 0.253 |
| clean passes a 100 green car-laps | 9.7 / 32.1 / 18.6 / 22.8 | 10.8 / 29.9 / 18.1 / 24.6 |
| damaging car contacts a 100 car-laps | 1.3 / 1.3 / 1.4 / 0.9 | 1.6 / 1.3 / 1.3 / 1.0 |
| in a tow (drag cut there) | 50% (14%) / 26% (15%) / 31% (14%) / 48% (17%) | 54% (15%) / 27% (16%) / 31% (15%) / 52% (19%) |
| closing built in the tow before a pull-out (m/s) | -0.17 / -0.63 / -0.09 / -0.07 | -0.15 / -0.64 / -0.11 / -0.08 |
| held up: the lane beside open / faster | 78% / 11%, 82% / 5%, 91% / 3%, 95% / 1% | 78% / 11%, 83% / 5%, 90% / 3%, 95% / 1% |

Within noise again, close following or not. Why: there's rarely a second lane for the air to work on. Held up, the lane
beside is empty 78-95% of the time (95% on the superspeedway, where cars are held up 35% of green time): the field runs
single file. Under the second air model a line outruns a car alone, so a car pulling out alone into the empty lane is
slower than the line it left: staying is right, and they mostly stay (21% move over on the superspeedway). Real packs
get a second line going when a car pulls out and the car behind goes with it to push; nothing here does that, or sees
it happening. That's the lane view (step 3: whether the other lane is moving, and how many cars are in it) and a
teacher that goes with a car pulling out beside it.

## Commands

```sh
B=public/drivers/stable-candidate-v8sp-lines.json
DOTGP_EXPERIMENT='?spec=cup&lines=2&follow=3&draft=2&wake=1' npx tsx --import ./scripts/packCard.ts \
  --import ./scripts/passWhere.ts scripts/incidents.ts teacher:$B --tracks short --seeds 4 --field 40 --rules 1
# also speedway, oval:3850048323:intermediate, oval:774865359:superspeedway (--field 36); without &draft=2&wake=1
```
