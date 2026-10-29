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

## The stable on two lines: v7

```sh
export DOTGP_EXPERIMENT='?spec=cup&lines=2'
npx tsx scripts/stable.ts --from public/drivers/stable-candidate-v6.json --rounds 8 --group 4 --solo-tracks 4 --out stable.json
npx tsx scripts/brokenCar.ts --in stable.json --out v7.json --ahead 4 --rounds 6 --tracks 3 --drills 3 --group 4
```

About 21 hours here (the other machine's Cup retrain took 4); 22 of 40 broken-car licences. Logs: `stable-log.txt`,
`broken-log.txt`; tactics loss 0.62-0.74 at the end, as high as before. Kept as `public/drivers/stable-candidate-v7-lines.json`.
Trained at fdf28e5, before wall scraping cost health (c07cbfd).

Bench, `?spec=cup&lines=2`, rules, 40 cars, 4 seeds (`v6-v7.json`: v6 untrained on two lines -> v7), beside v6 on today's
ovals (`../2026-10-28-cup-retrain-v6/v6.json`) and the teachers on two lines (`teachers.json`):

| | v6 today | v6 two lines | v7 two lines | teachers two lines |
|---|---|---|---|---|
| short: out / green wall damage / damage stops | 12.8 / 25.6 / 108 | 8.0 / 6.4 / - | 5.2 / 1.8 / 11.5 | 0.8 / 0 / 1.0 |
| gen. short | 4.5 / 32.7 / 107 | 0.2 / 3.3 / - | 0.5 / 10.3 / 27.5 | 0 / 0 / 0 |
| speedway: out | 23.8 | 21.5 | 25.0 | 0 |
| gen. speedway: out | 31.8 | 30.5 | 35.2 | 0 |
| gen. superspeedway: out | 28.8 | 26.8 | 30.2 | 0 |

- **Short ovals:** the wall problem mostly gone (green wall damage 25.6 -> 1.8, damage stops 108 -> 11.5, laps 0.4 s
  quicker), but v6 on two lines untrained scraped the gen. short less than v7 (3.3 vs 10.3).
- **Clean passes** v6 -> v7 on two lines: speedway 93.5 -> 33.9, flat 34.8 -> 9.6 (the teachers' 25.7 and 17.7): the
  students race as their teachers do.
- **Speedways: still 25-35 out a race, nearly all under caution** (`scripts/cautionHits.ts`, speedway, 2 races): 40 of
  52 retirements under caution; 212 of 337 caution hits while pacing in line (behind 24 m/s into a car at 10, 39.8
  health a race), 59 as the caution forms; starts and restarts 56 hits, under 1 health. The caution skill (v6b's work).
