# v6b and v7: Cup retrains, and teachers that move across at their crossing rate (2026-10-30)

## v6b

v6b is v5 retrained in the Cup car. Compared with v6 it adds:
- the eased caution teachers and the launch moments from 075a5a9
- more restarts in lesson races (`--debris 0.15`)

It was trained before the wall-scrape costs (c07cbfd) and is kept as `public/drivers/stable-candidate-v6b.json`.

```sh
export DOTGP_EXPERIMENT='?spec=cup'
npx tsx scripts/stable.ts --from public/drivers/stable-candidate-v5.json --rounds 8 --group 4 --solo-tracks 4 --debris 0.15 \
  --out lab/cup-retrain-b/stable.json > lab/cup-retrain-b/stable.log 2>&1
npx tsx scripts/brokenCar.ts --in lab/cup-retrain-b/stable.json --out lab/cup-retrain-b/v6b.json \
  --ahead 4 --rounds 6 --tracks 3 --drills 3 > lab/cup-retrain-b/broken.log 2>&1
```

## The teacher fix

Teachers taking over a student's car now ask to move across at their crossing rate. Students learn from teachers that
take over their car (DAgger), and the old labels at the wall barely asked the car to come down.

`scripts/wallLabels.ts` measured this: in v6's speedway race, a teacher answering for a student riding the wall through
a corner kept nearly the student's throttle (0.37 vs 0.42) and lifted 7% of the time. The cause was in
`TrafficRacer.takeOver`, which set the teacher's offset to the car's own position. The plan then moved that offset
toward the line at `CROSS_RATE` (3 m/s), but `followRacingLine` asked only for the line's own sideways speed, never that
rate. Its push down off the wall was about 0.3 m/s^2.

Now the offset's rate is part of the sideways speed it wants (`offsetRate`). In the same race, its throttle on the wall
is 0.20, it lifts 36% of the time and steers down 2.5 times harder. The fix is in `teacher.diff`; v7 trained on it.

### Teacher bench

Cup car, rules on, 40 cars, 4 seeds, 7 ovals. Compared with the teachers under the scrape costs alone
(`training/experiments/2026-10-29-wall-scrape-costs/teachers-scrape.json`):

| | green wall damage | damage stops | green car hits | lap (s) |
|---|---|---|---|---|
| short | 10.9 -> 2.3 | 23.0 -> 0.3 | 11.3 -> 4.9 | 23.42 -> 23.34 |
| flat | 2.7 -> 0.4 | 0 -> 0 | 5.3 -> 1.8 | 36.14 -> 36.24 |
| gen. short | 1.8 -> 0.6 | 0.3 -> 0 | 5.1 -> 3.8 | 21.50 -> 21.57 |
| gen. intermediate | 3.6 -> 0.4 | 0.3 -> 0 | 3.9 -> 1.8 | 40.23 -> 40.30 |

- The speedways stay at 0 wall damage, with laps 0.1-0.2 s slower.
- The gen. speedway had 1 retirement in 4 races, against none before.
- `teachers.json` is the 7-oval bench. Three of its races (gen. short seeds 3-4, gen. intermediate seed 1) started on
  the old code, so those two tracks were rerun cleanly in `teachers-gen-rerun.json`; the table uses the rerun.

## v7

v7 is v6b retrained under the scrape costs and the teacher fix, kept as `public/drivers/stable-candidate-v7.json`. In
its drills, 19 of 40 drivers earned broken-car licences.

```sh
export DOTGP_EXPERIMENT='?spec=cup'
npx tsx scripts/stable.ts --from lab/cup-retrain-b/v6b.json --rounds 8 --group 4 --solo-tracks 4 --debris 0.15 \
  --out lab/cup-retrain-c/stable.json > lab/cup-retrain-c/stable.log 2>&1
npx tsx scripts/brokenCar.ts --in lab/cup-retrain-c/stable.json --out lab/cup-retrain-c/v7.json \
  --ahead 4 --rounds 6 --tracks 3 --drills 3 > lab/cup-retrain-c/broken.log 2>&1
```

Three groups' logs show one round of about 65,700 s. The machine slept overnight; their other rounds took 3-18 min.

### Bench

Cup car, rules on, 40 cars, 4 seeds, 7 ovals, all with the scrape costs (`v5.json`, `v6.json`, `v6b.json`, `v7.json`).

```sh
T=short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway
DOTGP_EXPERIMENT='?spec=cup' npx tsx scripts/bench.ts lab/cup-retrain-c/v7.json \
  --tracks $T --seeds 4 --field 40 --rules 1 --jobs 4 --json v7.json
```

| v6 / v6b / v7 | out | green wall damage | damage stops | lap (s) | green car hits | clean passes /100 |
|---|---|---|---|---|---|---|
| short | 16.5 / 16.8 / 14.3 | 29.9 / 23.6 / 12.8 | 130 / 96 / 95 | 24.38 / 24.07 / 23.85 | 22.7 / 20.7 / 37.0 | 10.4 / 15.9 / 8.8 |
| speedway | 25.8 / 25.3 / 23.5 | 2.8 / 4.1 / 3.6 | 11 / 10 / 15 | 32.21 / 32.63 / 33.84 | 10.5 / 13.7 / 32.4 | 98.6 / 109.4 / 55.2 |
| flat | 9.8 / 15.0 / 12.3 | 4.1 / 3.8 / 1.4 | 9 / 10 / 8 | 36.40 / 37.37 / 36.55 | 7.2 / 7.9 / 24.8 | 28.1 / 40.9 / 15.3 |
| gen. short | 4.8 / 4.3 / 4.3 | 32.8 / 29.2 / 18.1 | 107 / 91 / 54 | 22.89 / 22.58 / 22.05 | 11.0 / 6.4 / 11.1 | 3.1 / 2.2 / 1.2 |
| gen. intermediate | 19.8 / 17.0 / 15.0 | 6.2 / 12.6 / 4.4 | 17 / 36 / 19 | 40.67 / 41.63 / 41.65 | 15.9 / 19.0 / 35.9 | 51.4 / 47.9 / 14.1 |
| gen. speedway | 32.8 / 31.8 / 35.3 | 1.5 / 4.0 / 0.5 | 9 / 14 / 10 | 36.89 / 38.15 / 37.48 | 20.3 / 14.9 / 39.4 | 176.5 / 142.7 / 72.6 |
| gen. superspeedway | 27.8 / 31.3 / 32.5 | 0.9 / 1.8 / 1.2 | 3 / 6 / 7 | 44.98 / 45.61 / 44.65 | 9.6 / 13.3 / 36.7 | 101.7 / 165.2 / 73.8 |

**v6b against v6:**
- On the short ovals: less wall damage, fewer damage stops, quicker laps.
- Under caution and at restarts (short preset, `probes/ch-s-*`): caution-period hits 571 -> 381 and jumped restarts
  20 -> 11. Those v6 probe counts are from the 2026-10-29 run, which isn't in `probes/`.
- On the bigger ovals: slower laps and more wall damage.

**v7 against v6b:**
- It rides the wall much less. In the speedway corners it rides in 7.7k decisions instead of 21.5k and holds 0.3-1 m
  off instead (`probes/lab-*`).
- Green wall damage falls on 6 of 7 ovals.
- But green car-to-car contact is 2-3 times v6b's on every oval except the gen. short, and clean passes are about half.

### The new contact

`scripts/greenContacts.ts` (`probes/gc-*`, 2 races per track) breaks each green contact down by its angle, the closing
speeds and who was moving across.

| v6b -> v7 | short | speedway |
|---|---|---|
| contacts | 529 -> 1529 | 94 -> 272 |
| closing across at 3+ m/s | 166 -> 606 | 11 -> 135 |
| beside, both moving toward each other | 63 -> 294 | 10 -> 93 |

In those "both moving" contacts, each car is moving across at about 2 m/s, a median of 4.2 m/s together.

The fix applies to every lane change, not only coming off the wall. The teachers check for room before they move
across, and their own contact fell. The students copied the brisk move, but not that check, so two of them now cross
into the same space at once.
