# The pack-racing scorecard, and the second air model (2026-11-04)

Steps 1 and 2 of [PACK-RACING.md](../../PACK-RACING.md). Every run here is the Cup car on two-line ovals
(`?spec=cup&lines=2`), rules on, 40 cars (36 on the generated superspeedway, a car to a pit box), 2 races per track. The
drivers are `stable-candidate-v8sp-lines.json`, and `teacher:` races its teachers.

## The scorecard: `scripts/packCard.ts`

A preload for `incidents.ts` that measures green-flag racing among sound cars (none in a pit cycle, none smoking). The
probe file's header has the exact definitions. In short:

- **Runs.** A pull-out is a car in line behind another (within 30 m, under 2.5 m across) that moves a lane over (3.5 m
  across) while still behind it. For each one: the closing speed it built in the tow over the 3 s before, its closing
  at the pull-out, and whether it got 5 m ahead of that car within 10 s. A run is closing at 1 m/s or more.
- **Held up.** Time following without closing (under 1 m/s), and the better lane beside the car (2.5-6 m across, on the
  road):
  - *open*: no car in it for 80 m ahead
  - *faster*: its nearest car ahead is faster than ours by 1 m/s or more
  - *no faster*: its nearest car ahead is not
  - *taken*: a car is beside us in it

  Plus the share of open-or-faster chances where the car moved over within 3 s.
- **Pack.** Position changes per car-lap, time with a car alongside, time in a tow and the drag cut there, and damaging
  green car contacts per 100 car-laps.

```sh
B=public/drivers/stable-candidate-v8sp-lines.json
DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/packCard.ts scripts/incidents.ts teacher:$B \
  --tracks speedway --seeds 2 --field 40 --rules 1
# the students: $B instead of teacher:$B; the new air: '?spec=cup&lines=2&draft=2&wake=1'
```

## Baseline: today's physics

Teachers (t) and v8sp (s):

| | short t / s | speedway t / s | gen. intermediate t / s | gen. superspeedway t |
|---|---|---|---|---|
| pull-outs with a run (closing 1+ m/s) | 24% / 27% | 18% / 20% | 25% / 22% | 3% |
| closing built in the tow, 3 s before a pull-out (m/s) | -0.32 / -0.71 | -0.23 / -0.42 | -0.04 / -0.50 | -0.05 |
| pull-outs that pass within 10 s: with a run / without | 8% / 5%; 13% / 8% | 35% / 8%; 25% / 7% | 13% / 3%; 20% / 7% | 25% / 4% |
| held up (share of green time) | 31% / 30% | 18% / 17% | 17% / 17% | 33% |
| ...with the lane beside open | 79% / 77% | 86% / 72% | 91% / 83% | 97% |
| moved over within 3 s, when it could | 52% / 47% | 32% / 25% | 44% / 42% | 19% |
| position changes a car-lap | 0.152 / 0.151 | 0.238 / 0.226 | 0.149 / 0.156 | 0.113 |
| alongside (share of green time) | 5% / 6% | 3% / 4% | 2% / 3% | 1% |
| in a tow (drag cut there) | 56% (15%) / 51% (14%) | 23% (13%) / 24% (11%) | 30% (13%) / 26% (13%) | 39% (14%) |
| damaging car contacts a 100 car-laps | 1.8 / 5.8 | 0.6 / 5.2 | 1.2 / 5.3 | 0.3 |

What it says:

- **Nobody builds a run.** Closing speed falls in the tow before a pull-out, for teachers and students alike. A drag cut
  of 13-15% in the tow means following about 25 m back.
- **But runs work when they happen.** A pull-out with a run passes 2-4 times as often (speedway teachers 35% against 8%;
  superspeedway 25% against 4%).
- **Drivers sit behind cars with the lane beside them open.** The superspeedway is the starkest: a third of green time
  is spent following, the lane beside is open 97% of that time, and cars move over 19% of the time. Cars are alongside
  1% of the time; a real superspeedway race is two and three wide.
- **Students race their teachers' way,** but with 3-17 times the contact (5.2-5.8 damaging contacts a 100 car-laps,
  against the teachers' 0.3-1.8).

## The second air model (`?draft=2`, `?wake=1`)

Behind experiment switches; nothing changes without them. In `computeDraft` (src/sim/collisions.ts):

- **`?draft=2`: a car in a line takes its draft and its push both.** The first model took the larger. And a line pushes
  its leader along: a car passes `DRAFT_TRAIN` (0.5) of the push it gets from behind on to the car ahead, up to
  `DRAFT_PUSH_MAX` (12%).
- **`?wake=1`: the wake ahead costs downforce.** A follower loses up to `WAKE_MAX` (15%) of its downforce right behind a
  car, fading as the draft does (`Car.wakeFactor`). At 75 m/s that is about 2 m/s of corner speed close behind.

Top speed on a long straight for the Cup car (500 kW, CdA 1.33), with the line closed up nose to tail at about 5 m:

| | first model | second |
|---|---|---|
| a single car | 85.0 m/s | 85.0 |
| a pair (the leader sets the pace) | 86.5 | 86.5 (+1.8%) |
| 5 cars nose to tail | 86.5 | 88.0 (+3.5%) |
| 10 cars | 86.5 | 88.2 (+3.8%) |

A car in the middle of a line could reach 97-99 m/s pulled out, so the speed for a run is there. The constants are a
first guess in the range of real superspeedway packs (a few percent over a single car); they want checking against real
race data.

### With today's teachers

Teachers, old against new air (`ta`):

| | short | speedway | gen. intermediate | gen. superspeedway |
|---|---|---|---|---|
| pull-outs with a run | 24% -> 26% | 18% -> 19% | 25% -> 20% | 3% -> 3% |
| held up | 31% -> 28% | 18% -> 17% | 17% -> 17% | 33% -> 33% |
| position changes a car-lap | 0.152 -> 0.147 | 0.238 -> 0.238 | 0.149 -> 0.176 | 0.113 -> 0.103 |
| damaging car contacts a 100 car-laps | 1.8 -> 1.7 | 0.6 -> 0.9 | 1.2 -> 1.2 | 0.3 -> 0.4 |
| retirements a race | 1.0 -> 0 | 2.0 -> 0 | 0.5 -> 0 | 0 -> 0 |
| superspeedway green laps, fresh tyres | | | | 44.14 -> 44.13 s |

Within noise everywhere, and no harm. The new air does nothing to today's teachers because they never use it: they
follow about 25 m back, where the draft is weak and the wake weaker, and no line closes up nose to tail. The physics can
only matter once the teachers race close (step 4). Kept off by default until then. Step 4 is tested with it on and off.
