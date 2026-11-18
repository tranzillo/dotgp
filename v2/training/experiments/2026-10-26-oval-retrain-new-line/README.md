# The stable on the new line and lanes (2026-10-26)

Code: be29502 (the other session's faster line and lane racing for the teachers), 6b47349 (solo drives on more ovals).
Oval machine, `dotgp-oval` worktree. Bench: classic car, 40 cars, 7 ovals (short, speedway, flat, `ovals:4`), 4 seeds,
rules on. "Scripted stops" = the bundle with its pit licences off (the pit maneuver drives the stops, as the teachers'
do), to see the racing alone.

## v5 on the new line

The line is a driver input, and every v5 student learned the old one. Teachers → v5 (learned stops):

| | out | clean passes /100 | damaging contacts /100 | side by side | lap (s) |
|---|---|---|---|---|---|
| short | 0 → 5.0 | 4.2 → 3.1 | 0.6 → 3.0 | 8.4% → 7.2% | 26.80 → 27.12 |
| speedway | 0 → 22.2 | 23.5 → 30.9 | 0.1 → 2.3 | 4.2% → 7.8% | 37.19 → 38.20 |
| flat | 0 → 6.5 | 8.3 → 6.4 | 0.1 → 0.7 | 3.5% → 5.9% | 43.68 → 43.77 |

## Retrain: v6

`stable.ts --from v5 --rounds 8 --group 4`, then `brokenCar.ts --ahead 4 --rounds 6 --tracks 3 --drills 3`.
Against v5 (scripted stops): clean passes 2-4×, but green wall hits 3-6× and laps slower on most ovals. Eight more
rounds didn't change it.

## Why: solo driving on unseen ovals

A wall probe put the hits at the front of the field, in clean air, all on the outside wall. Solo laps (40 drivers,
4 laps, from a rolling start) on a generated short oval with long tight corners:

| | lap (s) | drivers touching the wall | health lost |
|---|---|---|---|
| teachers | 27.45 | 0 | 0 |
| v5 | 28.02 | 25 | 0.21 |
| v6 before the drills | 28.28 | 25 | 1.53 |

A student arrived at the long corner 3-6 m/s over the line's speed, slid to the wall and crawled round it. Without
its human limits it did the same (1.24), so it's what the network learned. Neither latency nor noise correlated with
the gap (0.0); talent did a little (0.3).

One round of DAgger on solo drives of that oval alone (1600 moments) had each of four students at its teacher's pace
(driver 4: 33.3 → 26.8 s, its teacher 26.9). The network can drive it; it hadn't been shown enough ovals alone: a
round races one oval, and its solo drives were on that oval only.

**`--solo-tracks N`** (ovalApprentice `soloTracks`): solo drives on N more generated ovals each round. From v5, 8
rounds, N = 4 (v7, before drills):

| solo | v6 before drills | v7 before drills | teachers |
|---|---|---|---|
| gen. short A: lap, health lost | 28.28, 1.53 | 27.68, 0.14 | 27.45, 0 |
| gen. short B | 27.41, 0.78 | 26.38, 0.00 | 26.10, 0 |
| short | 26.09, 0.01 | 25.99, 0.00 | 25.86, 0 |
| flat | 42.91, 0 | 42.82, 0 | 42.71, 0 |

**The ahead drills undid it.** They trained the racing network on pack moments only: gen. short A health lost
0.14 → 0.57. Half their racing training is now solo drives on the round's tracks (v7b): 0.31, and the drills still
teach going round a broken car (round 5: 54 hits in 480 drills, 46 before).

## v7b vs v5

Scripted stops:

| | out | wall hits /100 | clean passes /100 | damaging contacts /100 | lap (s) |
|---|---|---|---|---|---|
| short | 10.8 → 9.5 | 0.4 → 3.4 ✱ | 3.7 → 8.0 ✱ | 3.7 → 3.9 | 26.88 → 27.07 |
| speedway | 4.5 → 9.5 | 0.2 → 0.1 | 12.9 → 30.8 | 1.8 → 1.6 | 37.95 → 38.31 |
| flat | 0 → 0 | 0.1 → 0.3 | 5.4 → 9.5 | 0.2 → 0.3 | 43.66 → 43.59 ✱ |
| gen. 1885224635 | 12.8 → 12.0 | 6.2 → 7.7 | 21.5 → 23.9 | 14.5 → 5.9 ✱ | 50.94 → 48.70 |
| gen. 1868447016 | 0.8 → 0.5 | 12.5 → 7.4 ✱ | 2.2 → 3.8 | 6.3 → 3.4 ✱ | 32.36 → 31.99 ✱ |
| gen. 1918779873 | 3.0 → 3.2 | 1.6 → 2.8 | 1.8 → 3.3 ✱ | 2.9 → 2.2 | 28.61 → 28.24 ✱ |
| gen. 1902002254 | 15.0 → 17.8 | 3.8 → 5.7 | 6.3 → 10.0 | 5.4 → 5.3 | 27.45 → 27.57 |

Learned stops (as the app races): short out 5.0 → 10.0 ✱, cautions 2.2 → 6.0 ✱, wall hits 0.5 → 3.2 ✱; clean passes
up on all 7 (short 3.1 → 7.3 ✱, gen. 1885224635 18.5 → 40.9 ✱); laps quicker on 6 of 7; pit-cycle contacts 23-105 a
race in both.

## What still retires cars

- **The pit maneuver merging** (scripted stops, short oval: 7 of 18 out were "pit hit wall", out past the blend). In
  the teachers' fields the same maneuver makes no contact. Pit work: the other session's area.
- **Contact under caution** (gen. short, 2 races: 11 of 28 out). 184 car hits under caution, 142 of them into a car
  under 15 m/s; 10 of 14 caution retirements were a smoking car being hit. The broken-car skill drives only under
  green, so under caution a broken car has the caution network.
- **Short-oval wall hits**, in traffic as well as solo.

Raw (oval machine scratch): v5-newline, v5-v6(-sp), v5-v7(-sp), v5-v7b(-sp), v7s-v7b-sp (.json/.txt), wall-*.txt,
solo probes (soloprobe.mts, solofit.mts).
