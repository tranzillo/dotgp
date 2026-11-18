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

## v8: v7 retrained under wall scraping's cost, teachers holding the car's line

```sh
export DOTGP_EXPERIMENT='?spec=cup&lines=2'
npx tsx scripts/stable.ts --from public/drivers/stable-candidate-v7-lines.json --rounds 8 --group 4 --solo-tracks 4 --jobs 10 --out stable.json
npx tsx scripts/brokenCar.ts --in stable.json --out v8.json --ahead 4 --rounds 6 --tracks 3 --drills 3 --group 4
T=short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway
npx tsx scripts/bench.ts public/drivers/stable-candidate-v7-lines.json v8.json --tracks $T --seeds 4 --field 40 --rules 1 --json v7-v8.json
```

Trained at b477b56 (after c07cbfd: scraping costs health and tyres; and b477b56: a two-line teacher labelling a student
holds the line the car is on). 2.2 hours here (92 min apprenticeship, 41 min broken-car drills; v7's 21 hours were
mostly waiting on other jobs). 28 of 40 broken-car licences (v7 22). Tactics loss 0.61-0.82 at the end: no better, as
expected (`scripts/tacticsFit.ts`: the teacher's side rests on memory the student doesn't see). Kept as
`public/drivers/stable-candidate-v8-lines.json`. Logs `v8-stable-log.txt`, `v8-broken-log.txt`.

Bench (`v7-v8.json`; Cup, two lines, rules, 40 cars, 4 seeds, both at b477b56; * past noise):

| | out | cautions | green wall damage | damage stops | green car hits | clean passes | lap (s) |
|---|---|---|---|---|---|---|---|
| short | 9.8 -> 4.2 | 4.0 -> 1.2 | 1.8 -> 1.4 | 17.0 -> 6.8 | 10.8 -> 4.7 * | 6.2 -> 6.6 | 23.67 -> 23.47 * |
| speedway | 26.5 -> 24.2 * | 2.0 -> 2.8 | 0.3 -> 0.4 | 5.5 -> 7.0 | 12.3 -> 5.2 | 30.0 -> 48.3 | 33.85 -> 32.43 |
| flat | 8.2 -> 17.2 * | 3.5 -> 1.5 * | 0.4 -> 0.3 | 3.5 -> 6.0 | 7.5 -> 3.2 * | 9.5 -> 16.1 * | 36.82 -> 36.39 * |
| gen. short | 2.8 -> 1.0 | 2.0 -> 0.5 | 11.0 -> 1.7 * | 32.2 -> 3.0 * | 5.6 -> 2.7 | 2.1 -> 2.1 | 22.56 -> 22.30 |
| gen. intermediate | 12.5 -> 17.2 | 1.0 -> 2.2 * | 1.1 -> 0.7 | 4.2 -> 7.2 | 8.3 -> 6.9 | 7.1 -> 22.2 * | 40.90 -> 40.47 |
| gen. speedway | 35.5 -> 33.5 | 2.8 -> 3.0 | 0.8 -> 1.1 | 8.2 -> 7.8 | 16.0 -> 14.1 | 46.7 -> 57.3 | 36.59 -> 36.59 |
| gen. superspeedway | 33.0 -> 27.2 * | 2.0 -> 2.0 | 0.3 -> 1.6 * | 4.0 -> 8.5 * | 9.9 -> 4.8 * | 47.8 -> 56.8 | 44.44 -> 44.90 |

Racing under green is better nearly everywhere (contact down, passing up, the gen. short's wall scraping gone), and
the lane spread wider (1.5-1.7 m more on flat and superspeedway: the field uses both lines). Retirements are still
mostly under caution, and on the flat oval worse.

## Under caution: what the probes show (for the caution work)

Notes from probing caution incidents with v7 and v8, for whoever takes cautions on next.

- **Most retirements on the big ovals are under caution, not racing.** v7, preset speedway, 2 races: 40 of 52
  retirements under caution; 212 of 337 damaging caution hits while pacing in line (car behind at a median 24 m/s into
  one at 10), 59 as the caution forms, 56 at starts and restarts but under 1 health between them.
- **v8 brings sound cars to a stop in the pacing line, and the car behind runs into them.** Flat oval, 4 races
  (`caution-flat-v7.txt`, `caution-flat-v8.txt`): retirements under caution v7 14, v8 57 (of 69). v8's caution hits are
  into cars at a median 0.0 m/s ahead (v7 18-26), at impacts up to 26 m/s (p90; v7 7.5); caution forming costs 22
  health a race (v7 6), pacing 37 (v7 11). `scripts/cautionStalls.ts` (2 races): v8 stopped 2.3% of its running car-time
  under caution (59 stops, median 0.5 s, p90 5.2 s, a median 4 m behind the car ahead: it closes up and stops dead);
  v7 0.3%, two stops, both smoking cars stopped about 50 s. Sound cars stopping is new in v8.
- **Not from the caution network's own fit, by its loss:** caution loss at the end of training v8 0.032-0.043, v7
  0.048-0.058. It copies its teachers' caution driving at least as well; the stops show up only in races (its own
  states, the student driving the line). Between v7's training and v8's: more rounds, c07cbfd (scrape costs), e89e7e8
  (pit network inputs only), b477b56 (racing line choice only: under caution the teacher drives the formation, which
  that doesn't touch). Which of these, or the extra rounds, I haven't pinned down.
- **Teachers don't do this.** In the same probes teachers pace with almost no contact (10-28: 0.00 hits a car-minute
  pacing in line, against students' 0.7); the gap is the student's, so a DAgger look at the caution line (teacher's
  label against the student's command when it brakes to a stop 4 m behind) is where I'd look first.
- **Probes:** `scripts/cautionHits.ts` (contact by phase, who into whom, smoking or not, what was driving each) and
  `scripts/cautionStalls.ts` (cars stopped in line) both preload into `scripts/incidents.ts`
  (`npx tsx --import ./scripts/<probe>.ts scripts/incidents.ts <bundle> --tracks flat --seeds 2 --field 40 --rules 1`);
  set `DOTGP_EXPERIMENT` to the bundle's experiment (`?spec=cup&lines=2` for v7 and v8). Bench numbers swing widely at
  4 seeds (the speedway's out 26 +- 5); the flat oval is the cheapest place to see the stops.
