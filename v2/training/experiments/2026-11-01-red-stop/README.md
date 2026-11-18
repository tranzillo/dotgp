# A smooth red stop, and a red for the wrecks the field runs into

Cup, two lines (`?spec=cup&lines=2`), `--rules 1`, 40 cars, v8s and v8sp, from 34442f5 with the pit work of c9da59d
(in the lab). Follows [2026-11-01-pileup-reds](../2026-11-01-pileup-reds/README.md): a red for a wreck stopped
mid-track cut the cars going into wrecks under caution, but 26 went out while the field stopped for the red. The user
(2026-11-01): whatever keeps races smooth without doing away with yellows.

## What went wrong in the red stop

`scripts/redStopHits.ts` (with the mid-track red as a preload, `scripts/redForPileups.ts RED_PILE=2:150 RED_MID=3`):
every hit under red, by who drove and what was hit, and at each red what braking each car needed to stop
`RED_SHORT` (40 m) short of the wreck. v8s, the four ovals where cars go out, 8 races each (`probes.txt` 1, 2):

| under red | hits | health | out |
|---|---|---|---|
| the pace car into the stopped line (impact ~10 m/s, up to 31) | 55 | 7.1 | 5 |
| the formation script into a car still wrecking (too near when the red flew) | 22 | 9.4 | 6 |
| the formation script into a car in the stopping line | 79 | 7.9 | 6 |
| pitting cars (the pit skill drove them, and knows nothing of a red) | ~250 | ~8.5 | ~9 |

At the red, 171 of 556 cars needed more than 8 m/s^2 to stop short (many already within 40 m): their cap went to
nothing at once. The pace car, let out of pit road under a red when the leader was by the end of pit road, came out at
pace speed onto the stopped line; out on track it slowed for the red's places but not for cars.

## The red procedure now

- Stop or pass (`raceControl.ts RED_PASS_DECEL`): when a red flies, a car that would need more than 5 m/s^2 to stop
  short of the place goes on past it (no faster than past a wreck under caution) and stops at the tail of the line next
  time round. Not where there's no way by (`RED_FREE`): there everyone stops.
- The pace car is let out under red only to a leader still doing 10 m/s (`RED_RELEASE_SPEED`), and under red it never
  goes faster than lets it stop behind a car ahead in its lane (`formation.ts redStop`).
- Pit road is closed under red: the pit maneuver drives every pit cycle (as the formation script drives on track);
  a car leaving its box waits there, one rolling down pit road stops short of its end, one already out stops short of
  the place like everyone (`drivers.ts`, `pitting.ts`).

The same races with the new stop (`probes.txt` 3), a race, four ovals:

| | out | out under red | reds | min stopped |
|---|---|---|---|---|
| v8s, no red | 54.2 | | 0 | 0 |
| v8s, mid-track red, old stop | 49.3 | 26 (all races) | 2.2 | 2.6 |
| v8s, mid-track red, new stop | 45.9 | 11 | 2.0 | 2.4 |
| v8sp, no red | 10.1 | | 0 | 0 |
| v8sp, mid-track red, new stop | 9.5 | 1 | 0.5 | 0.5 |

The 11 left are mostly cars that hadn't yet reacted to the caution, into a wreck still happening.

## Race control's rule

On ovals (`raceControl.ts RED_MID`, `RED_PILE`, `RED_PILE_RANGE`): a wreck stopped 3 m or more from both the outside
wall's edge and the inside edge is a red until it's towed or moved off the line, and 2 wrecks within 150 m of each other
are a red until every wreck within 150 m is towed. Any other wreck stays a caution; circuits as before. The timeline
logs the red (a red marker) and doesn't count the caution after it as a new one.

Bench against the same races before (`bench-red.json` against the pit work's `v8s-v8sp.json`: 7 ovals, 4 seeds), out a
race: v8s 52.6 -> 50.9 (gen. intermediate 9.5 -> 6.8, gen. speedway 17.5 -> 15.8, gen. superspeedway 11.3 -> 13.5,
within noise at 4 seeds); v8sp 9.9 -> 9.7 (most of its races never see a red: the same races to the decimal). Laps,
passing and pit-cycle damage level. A small gain for little: about two minutes stopped a race with v8s, half a minute
with v8sp. Tests: `test/raceControl.test.ts` (a wreck in the racing line is a red, one low stays a caution).

## Next

- Pacing round an obstacle (the caution skill past a wreck), as the user asked: what's left of the snowball is cars
  going into wrecks under caution low or against the wall (v8s 124 -> 58 with the red, v8sp 26 -> 13).
- The red stop is scripted (the formation script, the pit maneuver): a skill to learn, if reds become common.

## Commands

```sh
export DOTGP_EXPERIMENT='?spec=cup&lines=2'
T=speedway,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway
S=public/drivers/stable-candidate-v8s-lines.json; V=public/drivers/stable-candidate-v8sp-lines.json
# before the rule was race control's (at c9da59d): the red as a preload, the stop probed
for g in 1 3 5 7; do RED_PILE=2:150 RED_MID=3 npx tsx --import ./scripts/redForPileups.ts --import ./scripts/redStopHits.ts scripts/incidents.ts $S --tracks $T --seeds 2 --seed-start $g --field 40 --rules 1; done
# with the new stop (the same, for $S and $V)
# after: race control's own rule
npx tsx scripts/bench.ts $S $V --tracks short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway --seeds 4 --field 40 --rules 1 --json bench-red.json
```
