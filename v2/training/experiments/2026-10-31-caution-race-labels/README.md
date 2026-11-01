# The caution skill labelled in real races (2026-10-31)

Circuit machine, on the oval caution skill at the user's request. `?spec=cup&lines=2`, 40 cars, `--rules 1`. Bundle:
`stable-candidate-v8-lines` (v8). Follows `../2026-10-31-wrecks-under-caution` (classic car, v5p: copying a teacher
that goes round wrecks, and practice by score, both left the speedway's cars put out by wrecks at 23-25 in two races)
and the v8 notes in `../2026-10-28-two-lines` ("Under caution: what the probes show": teachers pace with almost no
contact, students 0.7 hits a car-minute; look at the teacher's label against the student's command before a hit).

## What the student does that its teacher wouldn't

`scripts/cautionLabels.ts` (a preload for `incidents.ts`): each step under caution, every car its caution skill drives
is also driven by its own teacher (`teacherOf`, reacting at once, as in training) from where the car is, and put back.
At each damaging hit, the seconds before it (`probes.txt` 1-2):

- **Into a slower car** (speedway, both v5p and v8): the teacher brakes from 4 s out (pedal -0.36 to -0.61) and the
  student keeps the throttle on (about +0.05) until the last second: in half the moments the teacher brakes the
  student doesn't (its network's own command the same, before its hands' latency and noise: not the hands).
- **Into a wreck:** v5p's teacher brakes no sooner than its student (pedal -0.13 both, 2-1 s out): the smooth
  formation's follow cap leaves out a wreck it's steering round, and only a gap under 2 m either side slows it. v8's
  teacher brakes a little earlier. Steering apart twice as much as over all pacing.
- **Over all pacing time**, not only before hits: the teacher brakes while the student doesn't 13% (v8) to 24% (v5p)
  of the time, most of it over 35 m/s (the field catching up), mean pedal apart 0.35-0.46.

## Can it learn it?

`scripts/cautionFit.ts` on moments dumped from v8 driving three speedway races (`LABELS_DUMP`; seeds 1-2 to train on,
3 held out; `probes.txt` 3):

| held out | pedal error | teacher brakes, network doesn't |
|---|---|---|
| v8's own caution networks | 0.31 | 57% |
| each driver's copy trained on its own moments (2 races, ~1,400 each) | 0.29 | 32% |
| the same, 3x the braking moments / 3x the epochs / a 64-48 network | 0.29-0.32 | 27-41% |
| one network for the field, from scratch, on everyone's moments (89k) | 0.23 | 24% |
| the same with the teacher's follow cap as inputs | 0.21 | 23% |
| **each driver's copy trained on everyone's moments (v8f)** | **0.235** | **25%** |

Not capacity, not weighting, not the follow cap the student can't see (it adds little). v8's caution networks hadn't
learned from moments like these: the classroom races they trained in (debris cautions, a few wrecks) don't put them
in a full field's states (wrecks across the track, closing on the queue at 45 m/s); and a driver's own share of them
is too few: pooled across the field, they generalise.

## v8f in races

v8f: v8 with each driver's caution network trained 4 epochs on all 31 drivers' moments from the two training races
(nothing else changed; the speedway takes 30 cars, so 9 of the 40 weren't in them and kept v8's). Pacing moments only,
no racing ones.

`cautionWrecks.ts`, seeds 4-5 (not recorded from), two races (`probes.txt` 4):

| | retirements a race | hits into wrecks (out) | into slower cars (out) | caution wall damage |
|---|---|---|---|---|
| speedway v8 / v8f | 21.0 / 13.0 | 76 (16) / 2 (0) | 56 (3) / 17 (1) | 3.17 / 0.85 |
| flat v8 / v8f | 10.5 / 6.5 | 27 (10) / 8 (0) | 12 (0) / 16 (0) | 1.56 / 3.28 |

Bench (`v8-v8f.json`; 7 ovals, 4 seeds; * past noise):

| | out | at fault | cautions | green car damage | pit-cycle damage | lap (s) |
|---|---|---|---|---|---|---|
| short | 5.8 -> 3.5 | 2.0 -> 1.3 | 1.8 -> 0.8 | 5.84 -> 5.82 | 3.65 -> 3.97 | 23.48 -> 23.50 |
| speedway | 20.0 -> 15.8 | 11.0 -> 6.0 | 3.0 -> 5.0 | 2.03 -> 3.19 | 4.81 -> 6.44 | 32.95 -> 32.76 |
| flat | 13.0 -> 8.3 | 8.3 -> 3.0 | 1.8 -> 4.0 * | 0.89 -> 1.93 * | 4.17 -> 6.42 * | 36.43 -> 36.61 * |
| gen. short | 1.3 -> 1.3 | 0.3 -> 0.0 | 0.5 -> 0.5 | 1.14 -> 0.96 | 0.66 -> 0.89 | 22.30 -> 22.33 |
| gen. intermediate | 17.3 -> 9.8 * | 10.3 -> 4.0 * | 2.8 -> 3.0 | 2.69 -> 3.83 | 6.10 -> 7.67 | 41.20 -> 40.91 |
| gen. speedway | 27.3 -> 23.3 | 10.8 -> 7.0 | 5.8 -> 6.3 | 4.84 -> 4.47 | 7.98 -> 11.41 * | 37.12 -> 36.70 |
| gen. superspeedway | 24.8 -> 19.3 | 16.3 -> 9.3 | 2.3 -> 4.0 | 2.54 -> 2.96 | 7.26 -> 9.06 | 44.76 -> 44.71 |

Fewer out on every bigger oval (4-7.5 a race) and fewer at fault everywhere, from one fine-tune on two speedway races.
Worse: pit-cycle damage on most ovals (past noise on flat and gen. speedway), and the flat oval's cautions, green
contact and pace (more cars still running is part of it). The racing network is v8's: green numbers that move are
the field, not the network.

Also (`probes.txt` 5-6): with today's way by a wreck (9658a92) v8's stalls in the pacing line (2.3% of caution
car-time in the v8 notes) were 0.0-0.3%; and capping the speed past a wreck at pace for everyone, without retraining,
changed nothing (v5p 99 -> 52 hits but 24 -> 21 out; v8 43 -> 48, 15 -> 18): the networks don't slow to the speed
their inputs show.

## Commands

```sh
export DOTGP_EXPERIMENT='?spec=cup&lines=2'
B=public/drivers/stable-candidate-v8-lines.json
# the probe (probes.txt 1-2)
npx tsx --import ./scripts/cautionLabels.ts scripts/incidents.ts $B --tracks speedway --seeds 2 --field 40 --rules 1
# the dumps (8% of moments, the follow cap included), one race each
for s in 1 2 3; do LABELS_EXTRA=1 LABELS_SAMPLE=0.08 LABELS_DUMP=x-speedway$s.bin npx tsx --import ./scripts/cautionLabels.ts \
  scripts/incidents.ts $B --tracks speedway --seeds 1 --seed-start $s --field 40 --rules 1; done
# v8f (100 s); the field-network comparison is --extra 2 without --pooled
npx tsx scripts/cautionFit.ts $B --train x-speedway1.bin,x-speedway2.bin --test x-speedway3.bin --skip 2 --pooled 1 --epochs 4 --out v8f.json
npx tsx scripts/bench.ts $B v8f.json --tracks short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway --seeds 4 --field 40 --rules 1 --json v8-v8f.json
```

The dumps sample moments with `Math.random`: v8f isn't reproduced bit for bit (kept outside the repo; not bundled).

## Race labelling as a stage: v8r

`scripts/raceLabels.ts` (`src/school/raceLabels.ts`): each round the whole stable races itself (every car a student
with all its skills, driving its own cautions) on the apprenticeship's ovals (presets and generated, in turn; not the
bench's), each car's own teacher labelling from where it is (the apprenticeship's Recorder, the student always
driving); debris cautions, half of them leaving wrecks. Each driver's caution network trains on the field's caution
moments from the last rounds and as many racing moments; the round's last race is held out and scores it.

Why it differs from the apprenticeship: there a group of 4-8 students races in a field of teachers (`stable.ts
--group`), so a student paces behind cars that pace cleanly and almost never in a field of students.

```sh
DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/raceLabels.ts --in public/drivers/stable-candidate-v8-lines.json   --out v8r.json --rounds 4 --races 10 --km 80 --sample 0.02 --keep 2 --debris 0.03 --wrecks 0.5 --jobs 10 --moments 60000 --epochs 4 --seed 1
```

39 min in the lab (`probes.txt` 7). The held-out race, before and after each round's training: braking missed 57% ->
16%, 72% -> 39%, 72% -> 52%, 65% -> 46% (pedal error 0.29 -> 0.25, 0.33 -> 0.30, 0.31 -> 0.30, 0.23 -> 0.27). Within
a round it learns; the next round's held-out race (another track) is missed as much as ever: it doesn't carry from
one oval to the next the way one speedway's moments carried to other speedway races.

Bench (`v8-v8r.json`; same 7 ovals and seeds as `v8-v8f.json`, so the v8 column is the same):

| out | v8 | v8f | v8r |
|---|---|---|---|
| short | 5.8 | 3.5 | 6.0 |
| speedway | 20.0 | 15.8 | 14.8 |
| flat | 13.0 | 8.3 | 5.3 (at fault 8.3 -> 0.5) |
| gen. short | 1.3 | 1.3 | 0.5 |
| gen. intermediate | 17.3 | 9.8 * | 10.0 (at fault 10.3 -> 3.8 *) |
| gen. speedway | 27.3 | 23.3 | 24.3 |
| gen. superspeedway | 24.8 | 19.3 | 17.8 |
| all seven | 109.5 | 81.3 | 78.7 |

v8r is v8f's equal over all (better on the flat oval, without v8f's slower flat laps or its flat cautions past
noise). Pit-cycle damage is up again (gen. superspeedway past noise), mostly more cars running and stopping (speedway
stops 78 -> 99, gen. intermediate 53 -> 79): damage a stop about the same except on the gen. speedway (102 stops both,
0.078 -> 0.122 a stop). Green car damage up with more cars still running (none past noise).

## The wreck lesson (17b1bc4)

Race control's way by a wreck now holds everyone that asks it (formation, teachers, pace car, a driver's caution
inputs) to pace past a wreck, where before only a gap under 2 m either side slowed them; and the smooth formation's
follow cap counts on moving across half as fast (1.5 m/s) round a wreck before it leaves it out of the path. Two tries
that failed on the way (teachers alone with wrecks dropped into their cautions, `scripts/wreckDrops.ts`; `probes.txt`
9): counting any stopped car as a wreck stopped the queue behind every stopped car (30 of 30 out, 9 hours of caution);
wanting 3 m of room by a wreck instead of 1.5 left cars stopped short of a narrow gap until race control retired them
as stuck. As committed, teachers alone hit no wrecks, as before (13.0 / 11.5 out a race on the speedway / flat with
the drops, 10.5 / 13.0 before).

Race labelling again from v8 under it (v8rw, `probes.txt` 10), benched in the lab at 17b1bc4 (`v8-v8rw.json`,
`v8r-v8rw.json`; the new rule changes every bundle's caution inputs, so v8 and v8r raced again):

| out | v8 | v8r | v8rw |
|---|---|---|---|
| short | 5.3 | 2.8 | 5.0 |
| speedway | 23.5 | 12.0 | 15.5 (v8r better *) |
| flat | 11.0 | 8.5 | 4.3 |
| gen. short | 1.0 | 0.5 | 1.0 |
| gen. intermediate | 18.3 | 9.5 | 15.0 |
| gen. speedway | 32.3 | 21.3 | 24.3 |
| gen. superspeedway | 25.3 | 21.3 | 17.8 |
| all seven | 116.7 | 75.9 | 82.9 |

No better than v8r: the lesson wasn't what held the trained field back. Kept (teachers no worse, and pace past a wreck
is the rule a field under caution would follow).

## Does it carry from one oval to another?

v8 raced on 8 ovals (`raceLabels.ts --race-only 2000-2007`), trained on 6, scored on two generated ovals none of it
saw (`cautionFit.ts --field-layers`, `--pooled`, `--racing`; `probes.txt` 11):

| on two unseen ovals | pedal error | braking missed |
|---|---|---|
| v8's own | 0.333 | 61% |
| one network for the field from scratch: 32-24 / 64-48 / 128-64 / 64-64-32 | 0.26-0.28 | 14-20% |
| each driver's network fine-tuned on the field's caution moments, 4 / 8 epochs | 0.264 / 0.254 | 25% / 23% |
| the same with as many racing moments (as raceLabels.ts trains) | 0.261 | 25% |

It carries, at any size, with or without racing moments. So the stage's held-out race, missed at 57-72% every round,
isn't another oval's states but another policy's: each round's training changes how the field drives, and the next
round's races go where the networks haven't been (DAgger's moving target; offline, training and held-out races were
both driven by v8). Rounds kept only the last 2 rounds' moments.

## Keeping every round: v8ra

The standard answer to a moving target is to train on everything gathered so far, not the last rounds only, and to run
more rounds. From v8 again at 17b1bc4: 8 rounds, `--keep 8` (760k caution moments pooled by the end), 74.5 min
(`probes.txt` 12):

```sh
DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/raceLabels.ts --in public/drivers/stable-candidate-v8-lines.json   --out v8ra.json --rounds 8 --races 10 --km 80 --sample 0.02 --keep 8 --debris 0.03 --wrecks 0.5 --jobs 10 --moments 60000 --epochs 4 --seed 1
```

The held-out race still isn't caught up with: braking missed before each round's training 62, 63, 60, 68, 19, 46, 53,
49%, after 21, 36, 41, 42, 17, 28, 35, 36%. A round's training still halves it, but the field never drives in a way
the pool already knows (one race each round, a few thousand moments: noisy, but no trend).

Bench (`v8r-v8ra.json`; same ovals and seeds as `v8r-v8rw.json`, and v8r's column came out the same to the decimal, so
v8's from `v8-v8rw.json` stands beside it):

| out (at fault) | v8 | v8r | v8ra |
|---|---|---|---|
| short | 5.3 | 2.8 (1.0) | 1.8 (0.8) |
| speedway | 23.5 | 12.0 (3.8) | 14.8 (5.5) |
| flat | 11.0 | 8.5 (2.5) | 5.0 (0.3) |
| gen. short | 1.0 | 0.5 (0.0) | 0.5 (0.0) |
| gen. intermediate | 18.3 | 9.5 (4.3) | 7.0 (2.3) |
| gen. speedway | 32.3 | 21.3 (10.0) | 20.8 (6.0) |
| gen. superspeedway | 25.3 | 21.3 (11.8) | 18.8 (10.0) |
| all seven | 116.7 | 75.9 (33.4) | 68.7 (24.9) |

Fewer out than v8r on five ovals, more on the speedway; no track's retirements past noise. Past noise: gen.
intermediate multi-car wrecks 3.0 -> 1.0 and gen. superspeedway damage done 6.0 -> 4.1 better; speedway damage done
3.2 -> 4.8, flat green wall damage and gen. short green wall and car damage (small) worse. The best of the stage's
runs, by a margin inside the noise of any one track. Bundled: `public/drivers/stable-candidate-v8ra-lines.json`.

## Where v8ra's retirements come from; red for any wreck

`cautionWrecks.ts` on the three ovals with the most out (speedway, gen. speedway, gen. superspeedway; 2 seeds each,
`probes.txt` 13): of 127 retirements, 78 under caution, 29 green, 16 merging or near a merging car, 4 at restarts.
Under caution the biggest cause is cars hitting a wreck (39 out, median 29 m/s: at pace), then the pit skill into
walls (15 out, any flag) and trucks or the pace car (6). They come one at a time minutes into a caution (+128 s,
+296 s, ... +951 s on the gen. superspeedway): the snowball isn't a pileup at the crash but the line filing past a
wreck lap after lap. The red flag almost never comes: a wreck left less than a car's width and a metre to get by
for 117 s of 11,499 s of caution, no red flags.

`scripts/redForWrecks.ts` (a preload, no retraining): red for any wreck stopped on the racing surface or an oval's
apron, so the field stops in line 40 m short of it until it's towed off.

| out a race | v8ra | red for any wreck |
|---|---|---|
| speedway | 16.5 | 12.0 |
| gen. speedway | 24.5 | 18.5 |
| gen. superspeedway | 22.5 | 12.0 |
| under caution (6 races) | 78 | 25 (and 10 under red) |
| into wrecks under caution (6 races) | 39 | 11 |

46 red flags in 6 races, 5,355 s of them (about 15 minutes a race stopped). Under red the formation script stops the
cars (the "formation" rows): the caution skill has never been taught a red flag.

## Next

- Red for any wreck (above): make it race control's rule on ovals, shorten the time stopped, and teach the caution
  skill the stop (race labelling with red flags in the races).
- v8ra is bundled as `public/drivers/stable-candidate-v8ra-lines.json` (candidate, 2026-11-01): v8 with only its caution
  networks replaced. Its pit cycles are no better than v8's (below).
- The held-out race each round: the pool never covers the next round's policy. Smaller steps (fewer epochs a round,
  more rounds), or the field mixed (part v8, part trained) so the states shift less from round to round.
- Pit cycles on the gen. speedway (`scripts/pitCycleHits.ts`, `probes.txt` 8): not the caution skill. Most of it is the
  pitting car itself into the wall at pit entry (pit skill driving: v8 26.2, v8r 29.9 health in 4 races, green and
  caution), then pitting cars into cars wrecked in that entry (8.1 -> 13.6: more cars still running to pit under
  caution). The pit skill's entry on this oval, for the pit work.
