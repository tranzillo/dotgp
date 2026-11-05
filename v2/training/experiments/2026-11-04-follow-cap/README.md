# Following by the gap between moving cars, and pulling out late (2026-11-04)

The first part of step 4 of [PACK-RACING.md](../../PACK-RACING.md), behind `?follow=2` (off by default: every teacher,
and so every label, is as before without it). Teachers only, no training. Cup car on two-line ovals, rules on, 40
cars, 2 races per track, the teachers of `stable-candidate-v8sp-lines.json` (`teacher:`), measured with the scorecard
(`scripts/packCard.ts`, experiments/2026-11-04-pack-scorecard).

## What was wrong

Why nobody builds a run is in the teacher's follow cap (`TrafficRacer`, src/ai/trafficRacer.ts), not its choices. Behind
a car it held its speed to `sqrt(vOther^2 + 2 brake (ds - gap))`: what lets it stop from its own speed down to the
other car's within the room beyond its gap. But the car ahead is moving too: the room between them shrinks only by the
closing. At 80 m/s, 20 m beyond the gap, that cap allowed about 1 m/s of closing, where checking up behind a car that
lifts takes room for some 6 m/s. So every follower lifted its run away from 50 m out, bold or timid, whatever its nerve
(`insure`: the braking of the car ahead it leaves room for, a lift for the bold) said.

And a run that did last was ended too late: the teacher kept building until it was at its following gap (about 5 m for
a bold racer), where it couldn't get across before reaching the car's tail, and was braked to that car's speed while
pulling out.

(Correction to the scorecard's README: bold teachers follow about 5 m back, not 25. The scorecard's 13-15% drag cut in
a tow is an average over every car within the draft's 40 m and 2.6 m across, much of it offset to one side.)

## The change (`?follow=2`)

- **The cap is the gap between two moving cars.** A teacher whose nerve insures against less than its own following
  brake closes as fast as it could still check up behind the car ahead if that car started slowing at `insure` now:
  `closingRoom` (the room it loses over its reaction and its braking, no more than the room it has). Timid racers
  (insuring against full braking), and anything ahead slowing hard (a pitter, a smoking car), keep the old cap.
- **Pull out at the last moment.** While the run lasts it stays in the tow until the room left is just what it takes
  to get beside the car with its closing (the pull-out a run is let go on, `ds - alongside > closing x getAcross + 1`)
  plus a reaction, not until its following gap.

## Results: teachers, before (t, today's follow) and after (f), and after with the new air (fa: `&draft=2&wake=1`)

| | short t / f / fa | speedway t / f / fa | gen. intermediate t / f / fa |
|---|---|---|---|
| pull-outs that pass within 10 s, with a run | 8% / 20% / 24% | 35% / 44% / 42% | 13% / 40% / 35% |
| ...without a run | 5% / 8% / 9% | 8% / 13% / 12% | 3% / 6% / 7% |
| pull-outs with a run | 24% / 23% / 20% | 18% / 29% / 27% | 25% / 21% / 21% |
| closing built in the tow, 3 s before a pull-out (m/s) | -0.32 / -0.42 / -0.65 | -0.23 / -0.39 / -0.56 | -0.04 / -0.32 / -0.51 |
| position changes a car-lap | 0.152 / 0.171 / 0.160 | 0.238 / 0.302 / 0.327 | 0.149 / 0.211 / 0.213 |
| alongside (share of green time) | 5% / 6% / 5% | 3% / 5% / 5% | 2% / 3% / 3% |
| damaging car contacts a 100 car-laps | 1.8 / 3.3 / 2.9 | 0.6 / 1.7 / 1.7 | 1.2 / 2.7 / 3.0 |
| retirements a race | 1.0 / 0.5 / 1.5 | 2.0 / 0.5 / 0.5 | 0.5 / 0 / 0 |

The superspeedway runs were stopped unfinished (to commit); not measured yet.

What it says:

- **Passing comes alive.** Pull-outs pass 1.3-3 times as often, and the field changes places 12-42% more.
- **Contact roughly doubles** (1.7-3.3 damaging contacts a 100 car-laps, from 0.6-1.8). Not yet looked at where. Likely:
  insuring against a lift, a bold racer now closes hard into corners, where the car ahead slows by more than a lift.
  The cap knows the car ahead's speed, not that it is about to brake for the corner both of them can see coming.
- **Still no run built in the tow.** Closing falls over the 3 s before a pull-out, more than before. The cap now lets a
  run live, but nothing makes one: a teacher still tucks up to its gap (where the draft is strongest but it has no
  room to use it), and its pull-outs still come from its own pace in the corners (`paceAt`), not from a run.
- **The new air adds little on top**, as before: the teachers' choices, not the physics, are still the limit.

## Next

1. Where the new contact is (`scripts/rearEnds.ts` and `scripts/greenContacts.ts` on teachers, `?follow=2` against
   HEAD), and a cap that sees the corner the car ahead will brake for (its speed ahead along the line, not only now).
2. A teacher that makes a run: one that means to pass hangs back where the tow still carries it (the distance its
   excess power in the draft needs to build a closing worth having: about 10-15 m at superspeedway speeds), then goes
   and pulls out at the last moment. Measured by closing built in the tow turning positive.
3. Then the lane call (step 3) and choosing a line by ground gained.

## 2026-11-05: the corners

Where the new contact was (`scripts/rearEnds.ts`, `scripts/greenContacts.ts`, and a new probe, `scripts/entryHits.ts`:
the 3 s before each damaging nose-to-tail hit, from the teacher's own follow decision, now kept in `TrafficRacer.last`
as `behind`, `slowing` and `lead`). On the short oval nose-to-tail damage went 39 -> 134 a two-race run with the first
`?follow=2`, 83 of them at corner entry: followers insuring only against a lift closed hard into corners on cars braking
for them.

What `?follow=2` does now, in steps:

1. **It sees the corner the car ahead will slow for.** Over the next `SLOWING_LOOK` (3.5 s; 2 s was too late on the
   intermediate), the slowing that car's line asks (this car's pace on the line, scaled to that car's speed now), and
   insures against that or its lift, the harder. Slowing harder than its following brake, it uses its full braking
   (still the gap between the cars, not a stopping distance: switching formula took its run away in one step).
2. **Its following gap insures against the same**, not only its closing.
3. **Inside its gap it opens it**: `OPEN_GAIN` (0.5 m/s per m short) slower than the car ahead. Held at that car's
   speed, a gap that grew was never opened (the old cap the same).

Teachers, `?follow=2` now (short / speedway / gen. intermediate / gen. superspeedway; `probes/n-*`):

| | baseline (t) | first ?follow=2 (f) | now |
|---|---|---|---|
| damaging car contacts a 100 car-laps | 1.8 / 0.6 / 1.2 / 0.3 | 3.3 / 1.7 / 2.7 / 0.8 | 2.6 / 1.2 / 1.9 / 0.8 |
| position changes a car-lap | 0.152 / 0.238 / 0.149 / 0.113 | 0.171 / 0.302 / 0.211 / 0.264 | 0.172 / 0.304 / 0.203 / 0.262 |
| pull-outs with a run that pass | 8% / 35% / 13% / 25% | 20% / 44% / 40% / 23% | 10% / 43% / 20% / 23% |
| short oval: nose-to-tail damaging hits, at entry | 39, 21 | 134, 83 | 70, 35 |

What the probe says is left, and it was there before `?follow=2` too (the baseline's 21 entry hits are the same): a
short oval's followers go into the corners 2-4 m behind the car ahead, which brakes at up to 10 m/s^2 for 0.5 s. The
slowing a follower sees coming is an average to the corner (about 4 m/s^2), not that burst; insuring against the burst
with a reaction would be a 20 m gap into every short-oval turn, which isn't how packs run. Real drivers anticipate: the
car ahead brakes where the corner is, and the follower brakes with it, not after it. The teacher's follow cap is one
speed for every distance ahead (that car's speed now plus room), so it plans braking for its own line's corner speed
but never for the slower one of the car ahead, and reacts to it through its speed control instead.

Next: an anticipating cap. At each distance ahead, the speed the car ahead will have where this car is then (its line's
speeds there, as it drives it), so the teacher's speed plan brakes with it for the corner, as it brakes for its own.

## Commands

```sh
B=public/drivers/stable-candidate-v8sp-lines.json
DOTGP_EXPERIMENT='?spec=cup&lines=2&follow=2' npx tsx --import ./scripts/packCard.ts scripts/incidents.ts teacher:$B \
  --tracks speedway --seeds 2 --field 40 --rules 1
# with the new air: '?spec=cup&lines=2&follow=2&draft=2&wake=1'; tracks short, speedway, oval:3850048323:intermediate,
# oval:774865359:superspeedway (--field 36). Before: without follow=2 (the scorecard's t- probes).
```

The probes (`probes/f-*`, `probes/fa-*`) were run before the switch was added, with the change on unconditionally: the
same code as `?follow=2` now.
