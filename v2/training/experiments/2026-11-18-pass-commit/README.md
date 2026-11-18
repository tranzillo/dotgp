# A pass under way is a commitment (2026-11-18)

PACK-RACING.md, after the lane view (experiments/2026-11-17-lane-view): most of the times the car ahead moved out of
its groove it never reached the next lane. Before teaching a follower to go with a car pulling out, a pull-out has to
mean something. This looks at why teachers' pass attempts flicker, and fixes the cause behind a switch.

## Why attempts flicker (`scripts/passEnd.ts`, `probes/base-*`)

The probe follows each teacher pass attempt (`TrafficRacer.last.passing` on, with `passOn`) to its end, and reads what
the teacher's own decision made of it (`TrafficRacer.passWhy`, a diagnostics-only field: no driving changes). It also
counts attempts ending because the passer went for another car ("switched").

Teachers of v8sp, `?spec=cup&lines=2&follow=3&draft=2&wake=1`, `--rules 1`, 40 cars (36 superspeedway), 4 races a track:

| | short | speedway | gen. intermediate | gen. superspeedway |
|---|---|---|---|---|
| attempts | 29,433 | 148,899 | 11,545 | 149,045 |
| median length | 0.6 s | 0.2 s | 0.6 s | 0.6 s |
| reached a lane across | 11% | 6% | 17% | 9% |
| ended by switching to another car | 45% | 94% | 54% | 90% |

Most attempts don't end, they switch. On the speedway (1 race, probe extended): 81% of switches go to the other side and
62% go back to the car before. The passer goes for car A on the high side; moving across, A leaves its path and car B,
ahead in the lane it's moving into, enters it; B is "passed" on the low side, back where it came from; now A is in the
way again. Several times a second.

## The fix, `?commit=1` (off by default)

In `src/ai/trafficRacer.ts`:

1. While a pass on one car is under way, a car ahead in the lane it's moving into is followed there, not passed back
   the other way. The pass carries on while the passer is still gaining on the car it went for (the existing
   `passGain` check), and is given up when it isn't. Stopped and smoking cars are still gone round either side.
2. Moving across to pass, it looks along the lane it's moving into (from where it is to beside the car it's passing),
   not only along its own line. A car there is followed, never taken as a new pass.

Step 1 alone (`probes/c1-*`) ended the bouncing but doubled damage on the speedway and the generated intermediate
(`probes/contacts-*`, `scripts/greenContacts.ts` now prints health lost and the worst hits with who was who): a few
hits at 15-25 m/s closing, a passer moving into a lane with a much slower car in it, seen only once it was there. The
old bouncing had kept it off those cars by accident. Step 2 as a new pass (`probes/c2-*`) cut the damage but started a
same-side back-and-forth (go for B further out, then back for A, which is in the way of that: median attempt 0.0 s), so
a car seen only in that lane is followed, not passed (`probes/c3-*`, the version committed).

## Results (`probes/c3-*` against `probes/base-*`)

| | short | speedway | gen. intermediate | gen. superspeedway |
|---|---|---|---|---|
| attempts | 29,433 -> 26,269 | 148,899 -> 47,636 | 11,545 -> 9,256 | 149,045 -> 87,981 |
| median length | 0.6 -> 0.7 s | 0.2 -> 0.9 s | 0.6 -> 0.8 s | 0.6 -> 0.9 s |
| reached a lane across | 11 -> 13% | 6 -> 21% | 17 -> 22% | 9 -> 10% |
| switches: the other side | | 81% (1 race) -> 0% | -> 0% | -> 0% |
| passes /100 green car-laps | 11.4 -> 10.5 | 31.0 -> 39.8 | 19.2 -> 20.4 | 25.6 -> 30.6 |
| green time two wide or more | 25 -> 25% | 17 -> 19% | 12 -> 13% | 12 -> 15% |
| health lost to cars under green /race | 0.75 -> 0.63 | 1.23 -> 1.34 | 0.53 -> 0.44 | 0.85 -> 0.71 |
| damaging contacts /100 green car-laps | 1.4 -> 1.1 | 1.5 -> 1.6 | 1.2 -> 1.2 | 1.2 -> 0.7 |
| follower goes with a car pulling out a lane | 37 -> 38% | 31 -> 27% | 50 -> 55% | 23 -> 24% |

- The back-and-forth is gone: every switch left is to a car on the same side (about half further on: working past a
  string of cars in the other lane). 15-19% still go back to the car before, a smaller loop not yet looked into.
- More passing on the bigger ovals, damage about level (speedway a little up, the rest down).
- Short oval retirements 1.0 -> 1.5 a race (2 in green and 1 hitting the pace car, over 4 races, against pit-merge
  wall hits in both): few, not yet looked into.
- The worst hits left, with and without the switch: a passer pulling out on a car 15-20 m/s slower and hitting it as
  both move across. Who those slow cars are (not in a pit phase, not damaged) is next to find out.
- The field still runs single file when held up (the lane beside empty 84-97%): the flicker was in the way of reading
  pull-outs, not the reason for single file. Next, as planned: teachers that go with a car pulling out.

## Commands

```sh
B=public/drivers/stable-candidate-v8sp-lines.json
# baseline (probes/base-*): without &commit=1, passEnd.ts only
DOTGP_EXPERIMENT='?spec=cup&lines=2&follow=3&draft=2&wake=1&commit=1' npx tsx --import ./scripts/passEnd.ts \
  --import ./scripts/laneLook.ts --import ./scripts/greenContacts.ts scripts/incidents.ts teacher:$B \
  --tracks short --seeds 4 --field 40 --rules 1
# also speedway, oval:3850048323:intermediate, oval:774865359:superspeedway (--field 36)
# contacts (probes/contacts-*): --import ./scripts/greenContacts.ts, speedway and the intermediate, c0 without and
# c1 with step 1 of the switch only (as in probes/c1-*)
```

`base-*` predate the probe's switch line (target switches show as "switched" in END ended). `c1-*` and `c2-*` were run
with the earlier versions of the switch described above; only `c3-*` matches this commit's code.
