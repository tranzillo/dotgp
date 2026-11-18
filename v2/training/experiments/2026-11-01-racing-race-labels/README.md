# Race labelling as a stage for the oval racing skill: v8s (2026-11-01)

Oval machine. `?spec=cup&lines=2`, 40 cars, `--rules 1`, at 72d0180 (the takeover crossing-rate fix). From
`stable-candidate-v8ra-lines` (v8ra). Follows `../2026-11-01-takeover-crossing-rate`: one fine-tune of the racing
networks on race-labelled moments (v8rf) took green wall damage to near the teachers' zero on every oval, but trained
on race moments alone it was slower on the speedways and raced less side by side.

## The stage

`scripts/racingLabels.ts`. Each round:

- the stable races itself on 8 of the apprenticeship's ovals (`apprenticeTrack(3000 + index)`: presets and generated,
  in turn; not the bench's), every car a student with all its skills, each car's own teacher labelling from where it
  is (`labelledRace`, src/school/raceLabels.ts; debris cautions, half of them leaving wrecks);
- every driver drives solo on 7 of those ovals (all but the held-out race's), 3 lanes each, its teacher answering
  from where the car is (`soloDrives`, as the apprenticeship does);
- each driver's racing network trains 4 epochs on 60,000 moments: half its own solo moments, half racing ones (green,
  sound car), of which half its own and half the field's; pooled over all rounds so far (`--keep 6`; at most 20,000
  racing moments a race and 30,000 solo moments an oval are kept);
- the round's last race is held out of that round's training and scores it.

Caution, pit, broken-car and tactics networks are v8ra's.

```sh
DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/racingLabels.ts --in public/drivers/stable-candidate-v8ra-lines.json \
  --out v8s.json --rounds 6 --races 8 --km 80 --sample 0.05 --keep 6 --field-share 0.5 --epochs 4 --moments 60000 \
  --debris 0.03 --wrecks 0.5 --seed 1 --jobs 10
```

48 min, 10 jobs (`v8s-log.txt`). No solo drive crashed in any round.

| round | cars out in its 8 races | held-out race (length, out) | before: pedal / braking missed / steer | after |
|---|---|---|---|---|
| 0 | 82 | 1240 m, 4 | 0.122 / 23% / 0.134 | 0.123 / 20% / 0.094 |
| 1 | 60 | 1829 m, 2 | 0.126 / 25% / 0.098 | 0.083 / 26% / 0.092 |
| 2 | 52 | 2472 m, 18 | 0.140 / 35% / 0.141 | 0.135 / 34% / 0.137 |
| 3 | 57 | 2702 m, 25 | 0.113 / 41% / 0.110 | 0.115 / 38% / 0.108 |
| 4 | 38 | 2341 m, 2 | 0.154 / 49% / 0.103 | 0.147 / 49% / 0.105 |
| 5 | 127 | 3998 m, 36 | 0.147 / 78% / 0.156 | 0.144 / 77% / 0.153 |

Round 0's training carried to round 1's races (steering 0.098 before any training on them). The held-out braking
missed rose round by round, but each held-out race is one oval: round 5's was a 4 km superspeedway that lost 36 cars in
one wreck (its moments mostly the wreck's aftermath), and round 5's ovals were all big (127 out). Too noisy to call
drift; the bench is the judge.

## Bench

Same seven ovals and seeds as v8ra's and v8rf's benches (`v8ra-v8s.json`, `v8rf-v8s.json`; * past noise; teachers
from `../2026-11-01-takeover-crossing-rate/teachers-v8ra.json`):

| v8ra / v8rf / v8s (teachers) | out | green wall damage | green car damage | clean passes /100 | lap (s) |
|---|---|---|---|---|---|
| short | 2.5 / 1.8 / 2.0 (0.8) | 1.45 / 0.16 / 0.25 * (0.00) | 6.39 / 4.04 / 3.64 * (0.72) | 6.6 / 7.4 / 8.1 (9.8) | 23.48 / 23.56 / 23.45 (23.49) |
| speedway | 13.5 / 11.3 / 8.5 * (1.0) | 1.16 / 0.42 / 0.09 * (0.02) | 3.89 / 4.90 / 5.44 (1.23) | 37.2 / 27.1 / 32.1 (24.8) | 32.95 / 33.51 / 33.09 (32.71) |
| flat | 4.5 / 5.3 / 3.0 (0.0) | 0.48 / 0.07 / 0.17 (0.00) | 2.25 / 1.00 / 2.36 (0.39) | 18.2 / 17.5 / 19.3 (17.3) | 36.49 / 36.58 / 36.43 (36.40) |
| gen. short | 0.5 / 0.5 / 0.8 (0.0) | 1.92 / 1.89 / 0.04 * (0.00) | 1.02 / 0.33 / 0.33 * (0.12) | 1.9 / 1.5 / 1.6 (2.8) | 22.34 / 22.36 / 22.16 * (22.18) |
| gen. intermediate | 6.0 / 6.8 / 9.5 (3.3) | 1.39 / 0.38 / 0.37 * (0.07) | 5.39 / 1.97 / 3.77 (1.09) | 16.3 / 15.2 / 19.6 (16.0) | 40.62 / 40.74 / 40.69 (40.52) |
| gen. speedway | 18.3 / 18.5 / 17.5 (0.0) | 1.65 / 0.13 / 0.22 * (0.00) | 3.96 / 2.17 / 5.65 (1.64) | 49.7 / 16.2 / 28.3 (32.6) | 37.12 / 37.58 / 37.64 (37.24) |
| gen. superspeedway | 14.8 / 10.0 / 11.3 (0.0) | 1.87 / 0.00 / 0.08 * (0.00) | 2.04 / 1.31 / 1.61 (0.28) | 57.5 / 39.3 / 35.7 * (12.3) | 45.11 / 45.47 / 44.94 (44.19) |
| all seven | 60.1 / 54.2 / 52.6 (5.1) | | | | |

Stars are v8s against v8ra. Against v8rf, v8s is past noise quicker on the short (-0.12 s), speedway (-0.42 s) and gen.
short (-0.20 s), with more clean passes on the gen. speedway (16.2 -> 28.3).

- **Kept from v8rf:** green wall damage near the teachers' zero on every oval (v8ra 0.5-1.9).
- **Recovered:** pace (level with v8ra everywhere, the short and gen. short at the teachers'); passing at the
  teachers' level or above on every speedway.
- **Also:** speedway out 13.5 -> 8.5 *, gen. superspeedway cautions 5.3 -> 2.8 *.
- **Worse than v8ra:** gen. intermediate pit-cycle damage 6.3 -> 9.4 *; gen. superspeedway clean passes 57.5 -> 35.7 *
  and less time alongside (still three times the teachers').
- **Still far from the teachers:** retirements on the big ovals (cautions and pit cycles, which this stage doesn't
  train), green car damage 2-5x, laps 0.4-0.75 s off on the speedways.

Bundled as `public/drivers/stable-candidate-v8s-lines.json` (candidate): v8ra with only its racing networks replaced.

## Next

- Green car damage on the speedways (3-5x the teachers'): before a contact the student brakes less than its teacher
  (`scripts/greenLabels.ts`). Braking moments could count for more in the racing half, or the stage run longer.
- The caution networks were race-labelled (v8ra) on labels before the takeover fix and on v8's racing; another round
  of the caution stage from v8s would train them on today's labels and today's field.
- Pit cycles stay the widest gap on every oval (pit work).
