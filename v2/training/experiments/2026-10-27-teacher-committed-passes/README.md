# Teacher passes that commit (2026-10-27)

Cup car (`?spec=cup`), teachers only (`teacher:` the v5 bundle's roster driven by TrafficRacer), rules on, 40 cars,
4 seeds, 7 ovals.

- `head.json`: HEAD before this work (4d09850): a pass's side judged every decision.
- `held-lane.json`: a pass held its lane beside the car it's on out to the look-ahead, whatever its closing.
- `committed.json`: as committed: held while it's gaining on that car (closing smoothed over 1.5 s) or alongside it;
  a car given up on isn't gone for again until it's catching it.

Bench:

```sh
T=short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway
DOTGP_EXPERIMENT='?spec=cup' npx tsx scripts/bench.ts teacher:public/drivers/stable-candidate-v5.json \
  --tracks $T --seeds 4 --field 40 --rules 1 --jobs 7 --json committed.json
```

Plan lengths (one 40-lap race a track):

```sh
DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/plans.ts scripts/incidents.ts \
  teacher:public/drivers/stable-candidate-v5.json --tracks speedway --seeds 1 --field 40 --rules 1 --laps 40
```

| plan median / changes a car-minute | speedway | short |
|---|---|---|
| HEAD | 0.03 s / 38-57 | - |
| held lane | 3.4 s | 1.23 s |
| gain from the closing at pull-out (rejected: gave up and went again every other decision) | 0.03 s / 41 | 0.27 s / 31 |
| committed | 3.07 s / 13.7 | 0.77 s / 21.5 |
