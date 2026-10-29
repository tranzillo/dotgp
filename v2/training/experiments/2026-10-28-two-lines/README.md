# Ovals raced in two lines (2026-10-28)

The user's call: the one fastest line ran against the wall wherever banking steepens toward it, and drivers drifted
into the wall holding it. Ovals get two lines, low and high, off the wall, with banking set so they lap alike; drivers
race them. All behind `?lines=2` (with `?spec=cup`: the banking is balanced for the Cup car) until the stable is
retrained on them. Code: 42708b0 (tracks), the next commit (teachers and students).

## The tracks

`ovalLines`: the fastest line in the inside half of the road (low) and the outside half, `WALL_BUFFER` 1.5 m further
off the wall (high). `balanceBanking` sets each corner's progression at build time so they lap alike, its mean banking
as designed (TRACK-CHANGES.md 5). `scripts/twoLines.ts`:

```sh
DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/twoLines.ts speedway short flat oval:894715320:short \
  oval:3850048323:intermediate oval:3148308672:speedway oval:774865359:superspeedway
```

12 of 13 ovals lap their lines within 0.35%; the high line at least 1.6 m off the wall (the one fastest line came within
0.1-0.3 m on 9). The generated superspeedway: flat out all round, banking can't move the lines (low 1.6% quicker), kept
as designed.

## Teachers

A traffic racer races the line it's nearer at its first look; it passes on the other line (the track's lanes are its two
lines) and keeps that line when the pass is done. A student's track knowledge is the line of its lane plan, or the line
it's on.

Bench, Cup teachers (`teacher:` v6's roster), rules on, 40 cars, 4 seeds, today -> two lines (`teachers.json`):

```sh
T=short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway
npx tsx scripts/bench.ts teacher:public/drivers/stable-candidate-v6.json --experiments '?spec=cup|?spec=cup&lines=2' \
  --tracks $T --seeds 4 --field 40 --rules 1 --json teachers.json
```

| | green wall damage | green car hits /100 | damage stops | clean passes /100 | lap (s) |
|---|---|---|---|---|---|
| short | 9.9 -> 0 ✱ | 11.2 -> 0.9 ✱ | 16.5 -> 1.0 ✱ | 6.2 -> 8.7 ✱ | 23.35 -> 23.45 ✱ |
| speedway | 0 -> 0 | 1.0 -> 0.6 | 0 -> 0 | 26.0 -> 25.7 | 32.30 -> 32.76 ✱ |
| flat | 0.6 -> 0 ✱ | 4.6 -> 0.6 ✱ | 0 -> 0 | 11.6 -> 17.7 ✱ | 36.15 -> 36.37 ✱ |
| gen. short | 1.4 -> 0 ✱ | 4.1 -> 0.2 ✱ | 0.25 -> 0 | 2.5 -> 2.5 | 21.51 -> 22.17 ✱ |
| gen. intermediate | 1.8 -> 0 ✱ | 3.9 -> 0.8 ✱ | 0.25 -> 0 | 10.0 -> 16.5 | 40.17 -> 40.52 ✱ |
| gen. speedway | 0 -> 0 | 2.2 -> 1.2 ✱ | 0 -> 0 | 30.2 -> 33.9 | 36.70 -> 37.12 ✱ |
| gen. superspeedway | 0 -> 0 | 1.3 -> 0.1 ✱ | 0 -> 0 | 24.4 -> 15.4 ✱ | 44.25 -> 44.23 |

Out per race 0-0.5 -> 0-0.8 (short 0.2 -> 0.8). The bench's "alongside" fell (short 6.2% -> 3.5%), but it counts a car
within 6 m across, and the two lines are 6-7 m apart. `scripts/lineSplit.ts` (one race each, another car within 2 m along):

| | within 6 m across | within 12 m | on the high line | two wide on the two lines |
|---|---|---|---|---|
| short: today -> two lines | 9.5% -> 4.5% | 10.9% -> 10.5% | 43% | 12.7% |
| flat | 5.7% -> 1.5% | 7.1% -> 8.8% | 50% | 11.5% |
| speedway | 9.9% -> 6.4% | 13.1% -> 8.0% | 41% | 3.7% |

Side by side about as often on the short and flat ovals, less on the speedway; much of today's was rubbing in one lane.
Laps 0.1-0.66 s slower: each line has half the road, and the high one a wall buffer.

## Next

Retrain the stable on two lines (`DOTGP_EXPERIMENT='?spec=cup&lines=2'`, `stable.ts --from` v6), its tactics' low and
high now the track's lines; then bench against v6 on today's tracks and against its teachers.
