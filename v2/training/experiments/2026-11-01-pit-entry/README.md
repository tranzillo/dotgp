# Pit entry: who hits the pit wall's nose, and why

Cup, two lines (`?spec=cup&lines=2`), `--rules 1`, 40 cars, v8ra (`public/drivers/stable-candidate-v8ra-lines.json`),
code at 17b1bc4 (in the lab). Probe: `scripts/pitEntryHits.ts`, a preload for `incidents.ts`: every wall hit from 150 m
before the pit wall's nose to 80 m past it, by what was hit, who drove, the approach (speed and angle before the hit),
and each pitting car's way in (how far short of pit road's fast lane it was 60, 30 and 10 m before the nose, and
whether a car was beside it on pit road's side).

## What gets hit

Seven ovals, two races each (`probes.txt` 1): 48.4 health lost to walls round the way in, 44 of it (91%) pitting cars
driven by the pit skill into the nose. The rest is small: racing cars scraping the outer wall and a few into the nose.

The nose is 3 m inside the racing surface's edge on every oval but the gen. speedway (pit road set back, its nose 36 m
in): a car's width and a metre (`stages.ts noseClearance`), the middle of a 6-9.5 m apron.

## How

Three ovals (speedway, gen. intermediate, gen. superspeedway), two races each (`probes.txt` 2): 61 of 725 ways in (8%)
end on the nose. They aren't crossing late or fast: they come in straight (1-3 degrees to the track), at pit speed
(21-22 m/s), and hold 3-5 m short of the fast lane from 60 m out to the nose (it's 3-4 m from the fast lane to the
wall's line). Not traffic: 28 of the 725 had a car beside them on pit road's side. One hit costs 0.8-1.0 health.

| 10 m before the nose | ways in | hit the nose |
|---|---|---|
| under 1 m short of the fast lane | 523 | 1 |
| 1-2.5 m short | 150 | 19 |
| 2.5 m or more short | 52 | 41 |

## The same races with the pit maneuver driving every stop

`pitTrafficLicensed` off for every driver, so the pit maneuver (the script the pit skill was taught by) drives each
stop; everything else as before (`probes.txt` 3):

| | pit skill | pit maneuver |
|---|---|---|
| ways in that hit the nose | 61 of 725 | 0 of 838 |
| ways in 2.5 m or more short at 10 m | 52 | 0 |
| pit-cycle health lost a race: speedway / gen. int. / gen. superspeedway | 9.38 / 7.06 / 8.98 | 1.17 / 1.59 / 0.56 |
| out a race: speedway / gen. int. / gen. superspeedway | 16.5 / 5.5 / 22.5 | 1.5 / 1.0 / 17.0 |
| cautions a race: same | 5.5 / 1.5 / 4.0 | 1.0 / 1.0 / 1.5 |

With the same walls the maneuver never meets the nose: the geometry gives enough room to a car that follows the route.
The pit skill doesn't, and its crashes on the way in (and the pit cycles' contacts) start cautions that the caution
skill then turns into many cars out: on the speedway 33 out in two races with the skill, 3 with the maneuver. On the
gen. superspeedway one race still lost 25 under caution with the maneuver pitting.

## Which pit skill: every Cup bundle drives v4's

Each driver's pit network in v8s (and v6 through v8ra, v8rf) is the same as v4's, by lineage: trained 2026-10-25 in the
classic car, before the pit limiter, the stop-only-in-the-box rule, the racing-line approach and the pit skill's own
inputs (RESULTS 2026-10-26, 2026-10-29). The Cup retrains (`stable.ts`) train racing, cautions and tactics; the pit
skill rides along. v5p's pit skill (36 more rounds through those changes, classic car) never reached the Cup stable.

## Giving up a stop that isn't lined up

The maneuver gives up a stop when the car is still on the track side of the pit wall's line in the last stretch before
its nose (`pitting.ts notLinedUp`, now a function of its own) and backs it out; the pit skill never does. It never
learned to: in the drills the maneuver labels every moment of a stop, and when it gives the stop up the stop is over,
so the pit network never sees itself short of its lane near the nose. In races nothing calls the maneuver while the
pit skill drives, and a car that's short goes on into the nose.

v8s at 34442f5, the same three ovals and seeds (`probes.txt` 4-6), a race:

| | v8s | v8s, stops given up as the maneuver does | v8s with v5p's pit skills |
|---|---|---|---|
| ways in that hit the nose | 57 of 782 | 21 of 601, and 154 stops given up | 14 of 840 |
| 2.5 m or more short at 10 m | 38 | 6 | 13 |
| pit-cycle health lost: speedway / gen. int. / gen. superspeedway | 6.20 / 9.52 / 9.96 | 0.96 / 5.82 / 4.42 | 3.73 / 2.91 / 7.32 |
| out: same | 9.0 / 10.5 / 14.5 | 19.5 / 10.5 / 19.0 | 7.0 / 2.0 / 11.0 |
| cautions: same | 4.0 / 3.0 / 2.5 | 4.0 / 4.0 / 3.5 | 2.0 / 0.5 / 4.0 |
| blend-line drive-throughs, gen. int. (two races) | 85 | 60 | 28 |

Giving up stops (`scripts/pitSkillAborts.ts`) takes most of the pit-cycle damage away, but at one stop in five, and
not the cars out (two races a track: within the caution snowball's noise). The nose hits it leaves are cars past the
wall's line but still 1-2.5 m short of the fast lane, which the maneuver doesn't give up either. Not made a rule.
v5p's pit skill does better on nearly everything with no training in the Cup car: the starting point for the Cup pit
skill.

## Race labelling the pit skill: v8sp

`scripts/raceLabels.ts --skill stops` (the caution stage's races, `src/school/raceLabels.ts`, with the Recorder's
`stops`, as the pit drills record: the pit skill's own inputs too): each round the stable races itself on 8 of the
apprenticeship's ovals, presets and generated (debris cautions 0.1 a lap), every car's pit skill driving its stops and
the pit maneuver saying from where the car is what it would do (its throttle in proportion, as in the drills); a
quarter of the stops' moments kept; every pit network trains on the field's, pooled over the last 3 rounds (60,000 a
driver, 4 epochs). The round's last race is held out and scores the pit networks before and after. From v8s with
v5p's pit skills; 4 rounds, 21 min. Only the pit networks change (oval-only: the Cup bundles race only ovals).

| round | held-out race | before: pedal err, steer err, hard steering missed | after |
|---|---|---|---|
| 0 | 3946 m | 0.285, 0.081, 41% | 0.200, 0.064, 17% |
| 1 | 901 m | 0.217, 0.088, 9% | 0.211, 0.077, 8% |
| 2 | 4767 m | 0.416, 0.235, 79% | 0.368, 0.176, 66% |
| 3 | 3283 m | 0.268, 0.119, 30% | 0.257, 0.114, 29% |

("Hard steering": the maneuver steering over 0.3 either way, as a car short of its lane does; missed if the network
steers less than half as hard.) Round 2's held-out race had 127,000 stop moments where a race that size has 50,000:
the same race again (`--race-only 23`, `probes.txt` 8) with v5p's pit skills, 5 of 56 ways in hit the nose and its
stops ran to 160,000 moments; with v8sp, none of 60 and 53,000. Its 29-33 cars out are the racing and cautions.

The three ovals (`probes.txt` 7), a race:

| | v8s | v8s with v5p's pit skills | v8sp |
|---|---|---|---|
| ways in that hit the nose | 57 of 782 | 14 of 840 | 4 of 1078 |
| out: speedway / gen. int. / gen. superspeedway | 9.0 / 10.5 / 14.5 | 7.0 / 2.0 / 11.0 | 1.0 / 3.0 / 8.0 |
| cautions: same | 4.0 / 3.0 / 2.5 | 2.0 / 0.5 / 4.0 | 0.5 / 0.5 / 2.5 |

Bench against v8s (`v8s-v8sp.json`: Cup, two lines, `--rules 1`, 40 cars, 4 seeds; * past noise):

| | out | cautions | pit-cycle damage | lap (s) | clean passes /100 |
|---|---|---|---|---|---|
| short | 2.0 -> 0.3 | 0.8 -> 0.3 | 2.70 -> 0.81 | -0.04 * | 8.1 -> 8.8 |
| speedway | 8.5 -> 0.8 * | 4.5 -> 0.5 * | 6.97 -> 1.78 * | -0.58 * | 32.1 -> 23.4 * |
| flat | 3.0 -> 0.0 | 2.3 -> 0.0 | 4.10 -> 0.54 * | -0.13 | 19.3 -> 14.9 |
| gen. short | 0.8 -> 0.5 | 0.0 -> 0.5 | 0.31 -> 0.54 | -0.01 | 1.6 -> 1.9 |
| gen. intermediate | 9.5 -> 2.3 * | 3.0 -> 0.5 * | 9.43 -> 5.88 * | +0.22 | 19.6 -> 13.5 * |
| gen. speedway | 17.5 -> 0.5 * | 6.3 -> 0.5 * | 10.80 -> 1.58 * | -0.75 * | 28.3 -> 18.4 |
| gen. superspeedway | 11.3 -> 5.5 * | 2.8 -> 2.0 | 8.53 -> 2.63 * | -0.57 * | 35.7 -> 25.2 * |

Out over the seven, 52.6 -> 9.9 a race (v8ra's teachers: 5.1). Most of v8s's outs were cautions the pit skill started
and the caution skill snowballed; without them there's little to snowball. Pit stops on the speedways went up (115 ->
189, 125 -> 216): not penalties (`probes.txt` 10: speedway, 1% of stops for a penalty), green tire stops (89% called
for tires, against 54% with v8s's cautions to stop under), about what the maneuver's races had (178). Fewer clean
passes on the bigger ovals, with the same racing networks: fewer restarts, most likely.

Worse: gen. intermediate's blend line (`scripts/blendCrossings.ts`, `probes.txt` 9). Its pit road is set back 36 m
across the grass, and its exit swings back to the apron 110 m before the merge zone starts; the pit skill comes across
at 40 m/s and 5-10 degrees and goes on onto the racing surface, 30-100 m early (a drive-through from 30 m). A
drive-through is another way out, so they chain: v8s 89 crossings of 252 ways out, 57 of them on a penalty's stop;
v8sp 259 of 416, 215 (60% of its stops there are penalties). The maneuver: one in two races. Bundled as
`stable-candidate-v8sp-lines.json` (candidate) all the same: the rest is the biggest step the Cup stable's had.

## Next

- Gen. intermediate's pit exit: the pit skill overshoots the apron coming back from a set-back pit road. Either the
  exit path meets the apron straight before the pit road's exit ends (geometry: a car coming across to a lane 3 m
  from the racing surface at 40 m/s overshoots it), or more set-back pit roads in the stage (the apprenticeship's
  generated ovals have few). And a penalty's stop can earn another of the same: worth asking whether the rule wants that.
- The pit wall's nose: 4 of 1078 left, at 40+ m/s on the gen. superspeedway (late onto pit road, over the limit:
  18 stop-and-gos for pit speeding in two races there).
- Absorbing attenuators on the nose, as insurance.
- The caution snowball is still there when something starts it (gen. superspeedway 5.5 out); red for any wreck
  (`scripts/redForWrecks.ts`, experiments/2026-10-31-caution-race-labels) is the next thing for it.

## Commands

```sh
export DOTGP_EXPERIMENT='?spec=cup&lines=2'
B=public/drivers/stable-candidate-v8ra-lines.json
npx tsx --import ./scripts/pitEntryHits.ts scripts/incidents.ts $B --tracks speedway,oval:3850048323:intermediate,oval:774865359:superspeedway --seeds 2 --field 40 --rules 1
# the maneuver driving every stop: the bundle with pitTrafficLicensed off for every driver
python -c "import json; d=json.load(open('$B')); [x.update(pitTrafficLicensed=False) for x in d['drivers']]; json.dump(d, open('scriptpits.json','w'))"
npx tsx --import ./scripts/pitEntryHits.ts scripts/incidents.ts scriptpits.json --tracks speedway,oval:3850048323:intermediate,oval:774865359:superspeedway --seeds 2 --field 40 --rules 1
# at 34442f5: v8s, and with stops given up as the maneuver gives them up
S=public/drivers/stable-candidate-v8s-lines.json
T=speedway,oval:3850048323:intermediate,oval:774865359:superspeedway
npx tsx --import ./scripts/pitEntryHits.ts scripts/incidents.ts $S --tracks $T --seeds 2 --field 40 --rules 1
npx tsx --import ./scripts/pitSkillAborts.ts --import ./scripts/pitEntryHits.ts scripts/incidents.ts $S --tracks $T --seeds 2 --field 40 --rules 1
# v8s with v5p's pit skills, by lineage
python -c "import json; p={x['lineage']:x['pit'] for x in json.load(open('public/drivers/stable-candidate-v5p.json'))['drivers']}; b=json.load(open('$S')); [x.update(pit=p[x['lineage']]) for x in b['drivers']]; json.dump(b, open('v8s-p5p.json','w'))"
npx tsx --import ./scripts/pitEntryHits.ts scripts/incidents.ts v8s-p5p.json --tracks $T --seeds 2 --field 40 --rules 1
# the stage (12 cores)
npx tsx scripts/raceLabels.ts --skill stops --in v8s-p5p.json --out v8sp.json --rounds 4 --races 8 --sample 0.25 --debris 0.1 --keep 3 --epochs 4 --moments 60000 --jobs 11
V=public/drivers/stable-candidate-v8sp-lines.json
npx tsx --import ./scripts/pitEntryHits.ts scripts/incidents.ts $V --tracks $T --seeds 2 --field 40 --rules 1
npx tsx --import ./scripts/pitEntryHits.ts scripts/raceLabels.ts --skill stops --in v8s-p5p.json --race-only 23 --out r23.bin --sample 0.25 --debris 0.1
npx tsx --import ./scripts/pitEntryHits.ts scripts/raceLabels.ts --skill stops --in $V --race-only 23 --out r23.bin --sample 0.25 --debris 0.1
npx tsx scripts/bench.ts $S $V --tracks short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway --seeds 4 --field 40 --rules 1 --json v8s-v8sp.json
for b in $S $V; do npx tsx --import ./scripts/blendCrossings.ts scripts/incidents.ts $b --tracks oval:3850048323:intermediate --seeds 2 --field 40 --rules 1; done
for b in $S $V; do npx tsx --import ./scripts/blendCrossings.ts scripts/incidents.ts $b --tracks speedway --seeds 2 --field 40 --rules 1; done
```
