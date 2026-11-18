# Reds for pile-ups, not for every wreck

Cup, two lines (`?spec=cup&lines=2`), `--rules 1`, 40 cars, code at 34442f5 (in the lab), v8s
(`public/drivers/stable-candidate-v8s-lines.json`: many cars out, most under caution) and v8sp
(`stable-candidate-v8sp-lines.json`). Speedway, gen. intermediate, gen. speedway, gen. superspeedway (where cars go
out). The user's brief (2026-11-01): keep yellows; no red for every wreck (`scripts/redForWrecks.ts` was that: 127 -> 85
out in 6 races, about 15 min stopped a race); a narrow margin for reds, thrown to stop a pile-up before it snowballs or
once cars start piling up; then back to pacing round an obstacle.

Race control's own red (a wreck leaving less than a car's width and a metre to get by, `raceControl.ts RED_FREE`)
never fires on these ovals: a wreck leaves 10 m or more nearly every time.

## Wrecks within a range of each other

`scripts/redForPileups.ts` (`RED_PILE=N:R[:APART]`): a red when N stopped wrecks lie within R m of each other on the
racing surface or apron (with APART, one stopping APART s or more after another: a car into a wreck already there, not
one tangle), held until every wreck within R of the pile-up is towed. (Released as soon as there were fewer than N, the
first try, it rolled again under yellow with a wreck still there: no better.) 4 races an oval (`probes.txt` 1):

| | v8s: out a race (four ovals) | reds a race | min stopped | v8sp: out | reds | min |
|---|---|---|---|---|---|---|
| none | 46.8 | 0 | 0 | 9.1 | 0 | 0 |
| 2 within 150 m | 45.1 | 1.13 | 1.5 | 8.6 | 0.31 | 0.5 |
| 2 within 150 m, 5 s apart | 48.0 | 0.63 | 1.0 | 8.9 | 0.31 | 0.5 |
| 3 within 150 m | 47.1 | 0.63 | 0.9 | 10.4 | 0.06 | 0.1 |

Within noise. Where cars go out (v8s, 16 races): under green with no wreck near 105; under caution with none near 49;
under caution within 50 m of a wreck already there 43 (the snowball); under green within 50 m of one 15 (a tangle).
A cluster can only be seen once the second car is in, and most snowballs are that second car.

## Which wrecks the field runs into

`scripts/wreckHits.ts`: every wreck stopped on the racing surface or apron, followed until towed; hit if another car
goes out within 50 m of it while it's there. 8 races an oval (`probes.txt` 2, 3):

| v8s | wrecks | hit | cars out into them | of them 5 s or more after it stopped |
|---|---|---|---|---|
| all | 337 | 116 (34%) | 213 | 162 |
| mid-track (3 m or more from both the outside wall's edge and the inside edge) | 101 | 63 (62%) | 112 | 86 |
| mid-track in a corner | 61 | 41 (67%) | 76 | |
| against the outside wall (within 3 m) | 64 | 21 (33%) | 42 | 34 |
| low (within 3 m of the inside edge, or on the apron) | 172 | 32 (19%) | 59 | 42 |
| low on a straight | 125 | 16 (13%) | 28 | |

v8sp, 50 wrecks: mid-track 53% hit, low 24%, against the wall 22%. A mid-track wreck is the one the field runs into: under
a third of the wrecks, over half the cars out into them, most of them 5 s or more later (not the same tangle).

## A red for a mid-track wreck

`RED_MID=3` (with `RED_PILE=2:150`): a wreck stopped 3 m or more from both edges is a red, until it's towed or moved
off the line. 8 races an oval (`probes.txt` 3):

| | v8s | v8s, mid-track red | v8sp | v8sp, mid-track red |
|---|---|---|---|---|
| out a race (four ovals) | 54.2 | 49.3 | 10.1 | 8.0 |
| gen. superspeedway | 14.6 | 12.7 | 5.5 | 3.8 |
| reds a race | 0 | 2.2 | 0 | 0.3 |
| min stopped a race | 0 | 2.6 | 0 | 0.3 |
| out into a wreck under caution (all races) | 124 | 58, and 17 under red | 26 | 13 |

By the context incidents.ts gives each car out (v8s, 32 races): green 82 -> 76, caution 199 -> 141, red 0 -> 26,
restart 15 -> 13. The red takes 58 out of the caution count, but 26 go out while the field stops for it: under red the
formation script stops everyone in line 40 m short (`RED_SHORT`, at `RED_DECEL` 2.5 m/s^2), and cars run into the stopped
line or the wreck coming to a halt. Stopping the field smoothly under red is itself the next thing to fix before a red
rule pays. Nothing in the app changed: both rules are preloads.

## Next

- The red stop: why cars go out while the field stops (who hits what, from what speed), and a smoother stop (stop
  short of the wreck from further back, lower decel; or the pace car slows the line first and the red stops it).
- Then the margin: mid-track wrecks (3 m from both edges) are the candidate; to decide with the user.
- Then pacing round an obstacle (the caution skill past a wreck), as the user asked.

## Commands

```sh
export DOTGP_EXPERIMENT='?spec=cup&lines=2'
T=speedway,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway
S=public/drivers/stable-candidate-v8s-lines.json; V=public/drivers/stable-candidate-v8sp-lines.json
for b in $S $V; do for r in 999:0 2:150 2:150:5 3:150; do RED_PILE=$r npx tsx --import ./scripts/redForPileups.ts scripts/incidents.ts $b --tracks $T --seeds 4 --field 40 --rules 1; done; done
for b in $S $V; do for g in 1 5; do npx tsx --import ./scripts/wreckHits.ts scripts/incidents.ts $b --tracks $T --seeds 4 --seed-start $g --field 40 --rules 1; done; done
for b in $S $V; do for g in 1 5; do
  RED_PILE=999:0 npx tsx --import ./scripts/redForPileups.ts --import ./scripts/wreckHits.ts scripts/incidents.ts $b --tracks $T --seeds 4 --seed-start $g --field 40 --rules 1
  RED_PILE=2:150 RED_MID=3 npx tsx --import ./scripts/redForPileups.ts --import ./scripts/wreckHits.ts scripts/incidents.ts $b --tracks $T --seeds 4 --seed-start $g --field 40 --rules 1
done; done
```
