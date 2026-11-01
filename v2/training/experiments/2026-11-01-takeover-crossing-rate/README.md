# How far v8ra is from its teachers, and the takeover crossing rate (2026-11-01)

Oval machine. `?spec=cup&lines=2`, 40 cars, `--rules 1`, 4 seeds, the bench's seven ovals. Bundle:
`stable-candidate-v8ra-lines` (v8ra: v8 with race-labelled caution networks, from the circuit machine's caution work).
Probe outputs are in `probes.txt`, numbered as below.

## v8ra against its own teachers

`teachers-v8ra.json`: each driver's own teacher (`teacher:` the bundle) against the bundle, same seeds. The standard
for the first milestone is no worse than the teachers.

| teachers / v8ra | out | green wall damage | green car damage | damaging contacts /100 | pit-cycle contacts | pit-cycle damage | lap (s) |
|---|---|---|---|---|---|---|---|
| short | 0.8 / 2.5 | 0.00 / 1.45 | 0.72 / 6.39 | 1.7 / 5.0 | 5.5 / 119.8 | 0.33 / 4.01 | 23.49 / 23.48 |
| speedway | 1.0 / 13.5 | 0.02 / 1.16 | 1.23 / 3.89 | 0.8 / 8.7 | 2.3 / 112.3 | 0.05 / 7.86 | 32.71 / 32.95 |
| flat | 0.0 / 4.5 | 0.00 / 0.48 | 0.39 / 2.25 | 1.4 / 4.7 | 1.3 / 72.0 | 0.06 / 5.77 | 36.40 / 36.49 |
| gen. short | 0.0 / 0.5 | 0.00 / 1.92 | 0.12 / 1.02 | 0.8 / 2.2 | 0.0 / 28.8 | 0.00 / 0.76 | 22.18 / 22.34 |
| gen. intermediate | 3.3 / 6.0 | 0.07 / 1.39 | 1.09 / 5.39 | 1.0 / 6.1 | 1.5 / 160.8 | 0.03 / 6.33 | 40.52 / 40.62 |
| gen. speedway | 0.0 / 18.3 | 0.00 / 1.65 | 1.64 / 3.96 | 2.2 / 16.9 | 3.0 / 168.0 | 0.15 / 11.90 | 37.24 / 37.12 |
| gen. superspeedway | 0.0 / 14.8 | 0.00 / 1.87 | 0.28 / 2.04 | 0.4 / 7.9 | 2.3 / 148.8 | 0.05 / 9.83 | 44.19 / 45.11 |

- Pace is the teachers' (within 0.2 s) except on the gen. superspeedway (+0.9 s).
- The widest gap is pit cycles: 30-170 contacts a race against the teachers' 0-6 (their stops are the scripted
  maneuver, 6-16% of their driving). On the short oval (`probes.txt` 2) the damage is spread along pit road: pitting
  cars into each other along the wall and at the exit, and into racing cars at the blend. For the pit work.
- Under green: 3-10x the teachers' damaging contacts, and wall damage where they have none.

## Before green contacts

`scripts/greenLabels.ts` (`probes.txt` 1): each green step, every sound car its racing network drives is also driven
by its own teacher from where the car is (as DAgger labels it), then put back; at each damaging car contact, the
seconds before it. On the short oval nose-to-tail contacts outnumber side-by-side ones 279 to 101. Before either kind,
the student pushes toward the other car no more than its teacher would. What differs is braking: in the last 2 s the
teacher's pedal is -0.21 to -0.37, the student's -0.04 to -0.20, and the teacher brakes while the student doesn't
13-17% of the time (2.8% over all green racing). Over all green racing the push across differs by 0.35 on average,
which led to the next part.

## The takeover crossing rate (the fix)

Since 08c033d a teacher taking over a car asks for sideways speed `move / dt`, so that its label gets a car down off
the wall. But `takeOver` sets the offset to where the car is every decision, so `move` is the whole gap to where the
teacher wants the car, capped at one step (3 m/s x 1/30 s = 0.1 m). Any gap over 0.1 m asked for the full 3 m/s: a car
0.2 m off its target, not moving across, was asked for about 9 m/s^2 sideways, where the teacher's own steering asks
about 0.4. `scripts/takeoverGaps.ts` (`probes.txt` 3; preset short, 8 v8ra students in a field of teachers): the
offset moved a full step in 91.3% of green takeovers (under 0.5 m/s: 2.2%). Students were taught to swing across at
full rate almost all the time; that fits the other machine's v7 finding (contacts closing across at 3+ m/s 166 -> 606
on the short oval, both cars moving across at about 2 m/s).

The fix (`TrafficRacer`, `SETTLE_RATE`): taken over, the rate is no more than two thirds of the gap a second (what its
steering's own gains settle at), up to the crossing rate as before. Driving itself the teacher is unchanged.

- Wall labels (`scripts/wallLabels.ts`, `probes.txt` 4; v8ra, speedway): riding a corner on the wall the teacher still
  asks for throttle 0.14 (0.13 before the fix), steers down +0.227 (+0.230) and lifts 28% of the time (29%): 08c033d's
  push off the wall is kept. Off the wall, its extra steering against the student falls from -0.017 / +0.073 to
  -0.001 / +0.014 (corner / straight).
- v8ra's racing networks against their teachers in race-labelled races (`probes.txt` 5-6, two held-out ovals): steering
  error 0.341 on labels before the fix, 0.133 after. The students already steer close to how the teacher would; the gap
  was the labels.
- Tests: all 321 pass.

## Race labelling the racing network

The caution work found that students pace well among teachers and badly among students (the apprenticeship races 4-8
students in a field of teachers). The same may hold for racing. `scripts/raceLabels.ts --race-only` records the
stable racing itself (8 races on the apprenticeship's ovals 2000-2007, `--sample 0.1`, debris cautions, half of them
leaving wrecks; `probes.txt` 7), and `scripts/racingFit.ts` fine-tunes each racing network on races 2000-2005 and
scores it on 2006-2007: on its own moments, on the field's (labels from other drivers' teachers), or mixed (its own and
as many of the field's).

| held out | labels before the fix: pedal / braking missed / steer | after the fix |
|---|---|---|
| v8ra's racing networks | 0.117 / 22% / 0.341 | 0.110 / 20% / 0.133 |
| trained on its own moments | 0.137 / 19% / 0.205 | 0.136 / 17% / 0.108 |
| on the field's | 0.116 / 20% / 0.144 | 0.114 / 17% / 0.089 |
| mixed | 0.114 / 19% / 0.163 | 0.114 / 17% / 0.093 |

Its own moments alone (about 10k a driver) overfit the pedal; the field's carry from one oval to the next.

### v8rr: before the fix (not bundled)

Field moments, labels before the fix (`v8ra-v8rr.json`): green wall damage short 1.45 -> 15.49, flat 0.48 -> 6.81,
gen. short 1.92 -> 9.30 (all past noise), damaging contacts short 5.0 -> 13.1, laps 0.15-1.2 s slower. It learned the
full-rate swing.

### v8rf: after the fix (bundled as a candidate)

Mixed moments, labels after the fix (`v8ra-v8rf.json`; * past noise):

| v8ra / v8rf | out | green wall damage | green car damage | damaging contacts /100 | clean passes /100 | time alongside | lap (s) |
|---|---|---|---|---|---|---|---|
| short | 2.5 / 1.8 | 1.45 / 0.16 * | 6.39 / 4.04 * | 5.0 / 6.2 | 6.6 / 7.4 | 0.046 / 0.056 | 23.48 / 23.56 * |
| speedway | 13.5 / 11.3 | 1.16 / 0.42 | 3.89 / 4.90 | 8.7 / 8.9 | 37.2 / 27.1 * | 0.059 / 0.033 * | 32.95 / 33.51 * |
| flat | 4.5 / 5.3 | 0.48 / 0.07 * | 2.25 / 1.00 | 4.7 / 4.9 | 18.2 / 17.5 | 0.029 / 0.024 | 36.49 / 36.58 |
| gen. short | 0.5 / 0.5 | 1.92 / 1.89 | 1.02 / 0.33 * | 2.2 / 2.7 | 1.9 / 1.5 | 0.017 / 0.025 * | 22.34 / 22.36 |
| gen. intermediate | 6.0 / 6.8 | 1.39 / 0.38 * | 5.39 / 1.97 | 6.1 / 6.7 | 16.3 / 15.2 | 0.031 / 0.023 | 40.62 / 40.74 |
| gen. speedway | 18.3 / 18.5 | 1.65 / 0.13 * | 3.96 / 2.17 | 16.9 / 9.2 | 49.7 / 16.2 * | 0.068 / 0.032 * | 37.12 / 37.58 |
| gen. superspeedway | 14.8 / 10.0 * | 1.87 / 0.00 * | 2.04 / 1.31 | 7.9 / 4.8 | 57.5 / 39.3 * | 0.061 / 0.024 * | 45.11 / 45.47 |

Green wall damage falls on every oval, to near the teachers' zero, and green car damage on most. But the speedways race
less side by side, with fewer clean passes (gen. speedway 16.2, below the teachers' 32.6) and slower laps (speedway
0.8 s off the teachers). Retirements on the big ovals are still mostly cautions and pit cycles, which this doesn't
touch. Pit-cycle damage moved within noise (gen. intermediate 6.3 -> 9.8 *).

Bundled as `public/drivers/stable-candidate-v8rf-lines.json` (candidate): v8ra with only its racing networks replaced.

## Next

- Pace and passing: v8rf trained on race moments only. The apprenticeship gives half its moments to solo laps (the
  fast line); a race-labelling stage for the racing network should mix them in as well, and run more than one round
  (the caution stage's moving target).
- Any oval training from here uses the fixed labels, including the caution race labelling, which mixes in as many
  racing moments as caution ones (v8ra's caution networks trained on labels before the fix).
- Pit cycles are the widest gap to the teachers on every oval (pit work).
- Tactics: still guessing the side (2026-10-31, `scripts/tacticsFit.ts`).

## Commands

```sh
export DOTGP_EXPERIMENT='?spec=cup&lines=2'
T=short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway
B=public/drivers/stable-candidate-v8ra-lines.json
# the teachers' gap
npx tsx scripts/bench.ts teacher:$B $B --tracks $T --seeds 4 --field 40 --rules 1 --jobs 9 --json teachers-v8ra.json
# probes 1-4
npx tsx --import ./scripts/greenLabels.ts scripts/incidents.ts $B --tracks short --seeds 1 --field 40 --rules 1
npx tsx --import ./scripts/pitCycleHits.ts scripts/incidents.ts teacher:$B --tracks short --seeds 2 --field 40 --rules 1
npx tsx --import ./scripts/pitCycleHits.ts scripts/incidents.ts $B --tracks short --seeds 2 --field 40 --rules 1
npx tsx scripts/takeoverGaps.ts short 6
npx tsx --import ./scripts/wallLabels.ts scripts/incidents.ts $B --tracks speedway --seeds 1 --field 40 --rules 1
# labelled races (8, about 5 min each), then v8rf
for i in 2000 2001 2002 2003 2004 2005 2006 2007; do
  npx tsx scripts/raceLabels.ts --in $B --race-only $i --out r$i.bin --km 80 --sample 0.1 --debris 0.03 --wrecks 0.5 --seed 1
done
npx tsx scripts/racingFit.ts $B --train r2000.bin,r2001.bin,r2002.bin,r2003.bin,r2004.bin,r2005.bin \
  --test r2006.bin,r2007.bin --out mixed --bundle v8rf.json
npx tsx scripts/bench.ts $B v8rf.json --tracks $T --seeds 4 --field 40 --rules 1 --jobs 10 --json v8ra-v8rf.json
```

v8rr was the same with labels recorded before the fix and `--out pooled`.
