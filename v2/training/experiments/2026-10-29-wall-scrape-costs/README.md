# Scraping a wall costs health and tyres (2026-10-29)

Wall riding was a viable strategy. Under damage model 2, light contact (impacts under `FREE_IMPACT`) was free, and so was
the friction of sliding along a wall. On the speedway, v6 (Cup) rode the outside wall for 8% of its green time through the
corners. There it held 78 m/s, where cars off the wall lifted to 70-72. Riding scrapes 70-230 (m/s)^2 of friction work a
second (`Car.wallScrape`), and none of it cost anything.

Now wall friction work costs:
- health: `DAMAGE2.SCRAPE` = 5e-5 per (m/s)^2. Ten seconds of riding cost about 0.15 s a lap, twenty about 0.6 s.
- tyres: `P.WALL_SCRAPE_WEAR` = 4e-5 tyre life per (m/s)^2. A second of riding wears up to half a lap's worth on the
  speedway and a lap's worth on the short oval.

Rubbing another car stays free.

## Probes

Cup car, one race per track, before and after. In `probes/`, `ride-*` is before and `scr-*` is after; `t` is the teachers
and `v6` is `stable-candidate-v6`. Speed per 20 m of the lap on and off the wall, and lap times, come from
`scripts/wallRiding.ts`. Each probe is a `wallHits.ts` plus `wallRiding.ts` preload on `incidents.ts`:

```sh
DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/wallHits.ts --import ./scripts/wallRiding.ts scripts/incidents.ts \
  public/drivers/stable-candidate-v6.json --tracks speedway --seeds 1 --field 40 --rules 1
```

Green wall health lost per race, before -> after:

| | teachers | v6 |
|---|---|---|
| short | 9.5 -> 10.1 | 14.1 -> 25.8 |
| speedway | 0 -> 0 | 0.3 -> 3.1 |
| gen. intermediate (3850048323) | 2.3 -> 4.3 | 6.4 -> 6.9 |

v6 still rides, because a fixed net can't adapt to a new cost. Taking the behaviour out needs training under the cost.

## Bench

Teachers, Cup car, rules on, 40 cars, 4 seeds, 7 ovals. `teachers-before.json` is the same bench before the change.

```sh
T=short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway
DOTGP_EXPERIMENT='?spec=cup' npx tsx scripts/bench.ts teacher:public/drivers/stable-candidate-v5.json \
  --tracks $T --seeds 4 --field 40 --rules 1 --jobs 4 --json teachers-scrape.json
```

Retirements and lap times are unchanged on every track (within 0.06 s). Green wall damage rises where the teachers touch
the wall:
- short: 8.1 -> 10.9, with damage stops 15.8 -> 23.0
- flat: 1.4 -> 2.7
- gen. short: 1.0 -> 1.8
- gen. intermediate: 2.3 -> 3.6

The speedways stay at 0.
