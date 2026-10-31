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

## Next

Race labelling as a training stage for the caution skill: race the stable (students driving) on every kind of oval,
label from where they are, pool the field's moments, fine-tune each caution network, and go round again with the
improved field (its own states next time). With racing moments mixed in, as the apprenticeship does (the caution
network takes over mid-corner at racing speed), and pit-cycle moments looked at (where v8f got worse).
