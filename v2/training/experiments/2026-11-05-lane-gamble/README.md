# Held up with a lane open: do teachers weigh going against staying? (2026-11-05)

PACK-RACING.md, "the lane choice is a judgement". Held up behind a slower car with room on the other line, a real driver
judges in a blink whether to sit in the draft or gamble on the other line, from what it can tell of that car's pace and
of what the other line would give it. Today's teachers go when their own line's speed at one spot beats the car ahead's
speed that instant by a fixed margin (`pass`, trafficRacer.ts). This measures what that gives.

## The probe

`scripts/laneGamble.ts` (preload for incidents.ts). A chance: a teacher in line behind a car within 30 m, closing under
1 m/s, a lane 2.5-6 m across open (as packCard.ts), at most one a car every 5 s. It went if it moved 3.5 m across
within 3 s. Over the next 15 s: metres gained on the car it was behind, places gained among sound cars, whether it
passed that car. Grouped by how slow that car really was: its mean speed over its last lap against the field's median.
(A first version used the mean over the last 10 s, which mostly said whether those 10 s were in a corner: `probes` are
the lap version.)

Teachers of v8sp, `?spec=cup&lines=2&follow=3`, `--rules 1`, 40 cars (36 superspeedway), 4 races a track.

## Results (`probes/l-*`)

How often it went, by how much slower the car ahead was than the field (under 0.5 / 0.5-1.5 / 1.5-3 / 3+ m/s):

| | chances | went | places gained in 15 s, stayed / went (car ahead under 0.5 m/s slower) |
|---|---|---|---|
| short | 22616 | 42% / 45% / 39% / 43% | 0.18 / 0.20 |
| speedway | 8111 | 12% / 13% / 16% / 24% | 0.40 / 0.49 |
| gen. intermediate | 8830 | 31% / 29% / 38% / 32% | 0.18 / 0.22 |
| gen. superspeedway | 20262 | 10% / 10% / 10% / 17% | 0.27 / 0.50 |

- **The choice doesn't depend on how slow the car ahead is.** On the short oval and the generated intermediate it's
  flat; on the two big ovals it rises a little only for cars 3 m/s or more off the pace (most of them cars with a
  trouble lap behind them).
- **Most chances are behind a car running the field's pace** (60-80%): a pack, not a slow car.
- **Going gains more places on the big ovals** (superspeedway 0.50 vs 0.27, speedway 0.49-0.81 vs 0.40-0.70) and
  passes the car ahead about twice as often; on the short oval it gains nothing.
- **Staying costs ground too**: speedway followers lose 7-13 m on the car ahead in 15 s.
- Caveat: who goes isn't random (they go when the pass test says their line is faster there), so the "went" outcomes
  lean favourable. It says what the teachers' choices led to, not what the other choice would have.

Next: the driver's estimate of the car ahead's pace and of each lane's for its own car, and the choice by expected time
(PACK-RACING.md).

## Commands

```sh
B=public/drivers/stable-candidate-v8sp-lines.json
DOTGP_EXPERIMENT='?spec=cup&lines=2&follow=3' npx tsx --import ./scripts/laneGamble.ts scripts/incidents.ts teacher:$B \
  --tracks short --seeds 4 --field 40 --rules 1
# also speedway, oval:3850048323:intermediate, oval:774865359:superspeedway (--field 36)
```
