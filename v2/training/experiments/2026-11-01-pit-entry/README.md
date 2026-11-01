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

## Next

- Train the pit skill where it fails: race labelling (as `scripts/raceLabels.ts` does for the caution skill), the
  student driving its own stops in full fields, the pit maneuver labelling from where it is.
- Insurance in the geometry, after: attenuators on the nose that absorb a hit (they're drawn, but hit as hard as the
  wall), or more room between the route and the nose.
- Until then, for work on cautions: races with the maneuver pitting take most of the cautions the pit skill starts.

## Commands

```sh
export DOTGP_EXPERIMENT='?spec=cup&lines=2'
B=public/drivers/stable-candidate-v8ra-lines.json
npx tsx --import ./scripts/pitEntryHits.ts scripts/incidents.ts $B --tracks speedway,oval:3850048323:intermediate,oval:774865359:superspeedway --seeds 2 --field 40 --rules 1
# the maneuver driving every stop: the bundle with pitTrafficLicensed off for every driver
python -c "import json; d=json.load(open('$B')); [x.update(pitTrafficLicensed=False) for x in d['drivers']]; json.dump(d, open('scriptpits.json','w'))"
npx tsx --import ./scripts/pitEntryHits.ts scripts/incidents.ts scriptpits.json --tracks speedway,oval:3850048323:intermediate,oval:774865359:superspeedway --seeds 2 --field 40 --rules 1
```
