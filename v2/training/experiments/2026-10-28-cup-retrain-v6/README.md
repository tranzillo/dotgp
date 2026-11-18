# v5 retrained in the Cup car: v6 (2026-10-28)

v5 (`public/drivers/stable-candidate-v5.json`) retrained in the Cup car (`?spec=cup`) by apprenticeship to its own
teachers, as they were at c9f795f (passes that commit), then the broken-car drills. Trained before this commit's
caution easing and launch moments: v6 learned the teachers as of c9f795f. Kept as `public/drivers/stable-candidate-v6.json`.

```sh
export DOTGP_EXPERIMENT='?spec=cup'
npx tsx scripts/stable.ts --from public/drivers/stable-candidate-v5.json --rounds 8 --group 4 --solo-tracks 4 \
  --out lab/cup-retrain/stable.json > lab/cup-retrain/stable.log 2>&1
npx tsx scripts/brokenCar.ts --in lab/cup-retrain/stable.json --out lab/cup-retrain/v6.json \
  --ahead 4 --rounds 6 --tracks 3 --drills 3 > lab/cup-retrain/broken.log 2>&1
```

238 min for the apprenticeship, 58 min for the drills (19 of 40 broken-car licences). Logs: `stable.log`, `broken.log`.
The tactics loss rose over the rounds (0.05-0.09 in round 0, 0.49-0.71 in round 7; more plans to learn as they pile up).

v6b (running on the oval machine when this was committed): the same from v5 with this commit's code (eased caution
teachers, launch moments a quarter of the racing set) and more restarts, `--debris 0.15` on the `stable.ts` line;
outputs `lab/cup-retrain-b/`.

## Bench

Cup car, rules on, 40 cars, 4 seeds, 7 ovals. `v5.json` is v5 benched with the same code.

```sh
T=short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway
DOTGP_EXPERIMENT='?spec=cup' npx tsx scripts/bench.ts lab/cup-retrain/v6.json \
  --tracks $T --seeds 4 --field 40 --rules 1 --jobs 4 --json v6.json
```

| v5 -> v6 | out | green wall damage | damage stops | lap (s) | clean passes /100 | green car hits |
|---|---|---|---|---|---|---|
| short | 15.3 -> 12.8 | 8.7 -> 25.6 | 59 -> 108 | 23.63 -> 24.11 | 5.8 -> 11.3 | 19.1 -> 21.6 |
| speedway | 23.3 -> 23.8 | 0.3 -> 0.1 | 11 -> 6 | 37.97 -> 32.02 | 83.5 -> 96.8 | 23.6 -> 10.8 |
| flat | 12.8 -> 12.8 | 0.5 -> 2.1 | 6 -> 8 | 36.65 -> 36.42 | 23.0 -> 33.7 | 12.0 -> 7.3 |
| gen. short | 3.8 -> 4.5 | 10.7 -> 32.7 | 33 -> 107 | 21.75 -> 22.86 | 2.5 -> 2.2 | 5.9 -> 10.7 |
| gen. intermediate | 17.3 -> 15.8 | 4.5 -> 5.9 | 15 -> 15 | 40.99 -> 40.63 | 40.0 -> 37.3 | 16.2 -> 14.8 |
| gen. speedway | 31.8 -> 31.8 | 1.3 -> 0.2 | 13 -> 7 | 40.34 -> 42.43 | 240 -> 235 | 31.3 -> 18.7 |
| gen. superspeedway | 34.5 -> 28.8 | 0.3 -> 0.2 | 6 -> 9 | 47.78 -> 44.63 | 3947 -> 151 | 250 -> 14 |

## Probes (`probes/`)

Caution contact by phase (`scripts/cautionHits.ts`; preset short, 2 races), hits per car-minute v5 -> v6: before the
start 3.60 -> 0.00, start green 0-10 s 3.37 -> 1.50, 10-30 s 0.69 -> 1.71, forming 0.66 -> 0.49, pacing 0.73 -> 0.49,
one to go 1.49 -> 0.82, restart flag 1.37 -> 0.71, restart green 0-10 s 2.53 -> 1.89, 10-30 s 1.79 -> 1.74; health
lost in these phases about 39 -> 27, retirements there 16 -> 11.

```sh
DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/cautionHits.ts scripts/incidents.ts lab/cup-retrain/v6.json \
  --tracks short --seeds 2 --field 40 --rules 1
```

The short-oval wall damage: alone (`scripts/soloWall.ts`, each driver 180 s, gen. short) v5 and v6 scrape alike (361
vs 394 scrapes, health 9.3 vs 11.4; teachers 0). In races (`scripts/wallHits.ts`, gen. short, 2 races), v5 scrapes
half as often as alone and v6 as often as alone; few hits come from traffic (a car alongside on the inside doubles
the rate, rarely). Fresh tyres double everyone's rate (teachers too), and v6 runs a loop: scrapes add up to smoking, a
damage stop, fresh tyres, more scrapes (82% of its green time on tyres over 80%, v5 42%, teachers 30%).

```sh
DOTGP_EXPERIMENT='?spec=cup' npx tsx scripts/soloWall.ts lab/cup-retrain/v6.json --tracks short,oval:894715320:short
DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/wallHits.ts scripts/incidents.ts lab/cup-retrain/v6.json \
  --tracks oval:894715320:short --seeds 2 --field 40 --rules 1
```

Hands alone don't explain it: the teachers driven alone through their students' own latency and motor noise
(`--hands 1`) scrape 0 times on the gen. short oval; twice both (`--hands 2`) 264, four times 570. The students' 361-394
scrapes are mostly their imitation's own error.

```sh
DOTGP_EXPERIMENT='?spec=cup' npx tsx scripts/soloWall.ts teacher:public/drivers/stable-candidate-v5.json --hands 1
```
