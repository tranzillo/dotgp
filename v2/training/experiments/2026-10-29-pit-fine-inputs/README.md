# The pit skill's own inputs (2026-10-26 to 10-29)

Circuit machine. Classic car (no `DOTGP_EXPERIMENT`), 40 cars, `--rules 1`.

Goal (the user's): races fall apart in the pits and under caution; find where pit-cycle contact happens and stop it.

## Where the contact was

`scripts/pitZones.ts` puts each damaging contact with a car in a pit cycle into a zone for both cars, and records each
pit entry and each stop. v5's learned stops against the maneuver (the pit skill's teacher), 5 tracks x 4 seeds, 150 km:

- **The pit wall's nose:** learned drivers hit it 4.5-23 times a race, the maneuver never. A car wrecked there blocks
  the entry, and the next pitters run into it.
- **Stops short of the box:** 20-40% of learned stops were serviced 1.5-3 m short of the box, half in the fast lane.
  The sim never checked the lane. Cars into the next boxes and down the lane hit them.
- **The maneuver braking on the racing line** before the GP circuit's entry, for a centreline kink.

The rules and the maneuver were fixed first (4d09850, b604b6d): a pit limiter, stops serviced only in the box, the
maneuver's approach on the racing line's shape. The nose stayed. Learned drivers arrived 1.5-2 m toward the wall and,
on the club circuit, 39 m/s into an entry lane the maneuver takes at 10-22.

## The inputs

The pit skill saw the route as a share of the track's half width and its speed as a share of the limit. Its own
inputs, at the scale a stop is driven to (`pitting.ts` observePitFine), appended to the driver's for the pit network
only (`PIT_NET_LAYERS`, 88 + 6 inputs):

- the route against the car at 0, 10 and 25 m (per 2 m);
- its speed against what the stop allows (`pitAllowed`: the maneuver's braking for the lane's bends, the limit and the
  box; per 5 m/s);
- its clearance to the pit wall's face (per 3 m), from 100 m before the line to the wall's end;
- how near the nose it is.

A pit skill learned before them widens into the network, ignoring them until taught (test/pitfine.test.ts). The
racing, caution, road, broken-car and tactics networks are unchanged.

A first version showed the speed against the limit, and only near the line (fine12). Ovals improved but circuits
didn't: the club circuit's entry lane was still taken at 39 m/s.

## Commands

```
# 12 rounds under the limiter and the box rule (code 4d09850)
npx tsx scripts/pitSkill.ts --in public/drivers/stable-candidate-v5.json --out box12.json --rounds 12 --seed 5 --jobs 10
# 12 more on the racing-line approach (code b604b6d, with a chord entry 90 m long, since reverted)
npx tsx scripts/pitSkill.ts --in box12.json --out route24.json --rounds 12 --seed 6 --jobs 10
# 12 more with its own inputs (this commit): stable-candidate-v5p
npx tsx scripts/pitSkill.ts --in route24.json --out stable-candidate-v5p.json --rounds 12 --seed 7 --jobs 10
# the tracer, per track and seed, then side by side
npx tsx scripts/pitZones.ts public/drivers/stable-candidate-v5p.json --track c0 --seed 1 --json z/v5p/c0-1.json
npx tsx scripts/pitZones.ts --summarize z/v5 z/v5p
# the bench (bench-ovals.json, bench-circuits.json)
npx tsx scripts/bench.ts public/drivers/stable-candidate-v5.json public/drivers/stable-candidate-v5p.json --tracks short,speedway,flat --seeds 4 --field 40 --rules 1 --json bench-ovals.json
npx tsx scripts/bench.ts public/drivers/stable-candidate-v5.json public/drivers/stable-candidate-v5p.json --tracks circuit:11:club,circuit:12:gp --seeds 3 --field 40 --rules 1 --json bench-circuits.json
```

## Results

Tracer, 4 seeds, this commit's code (v5 as bundled, route24, fine12, v5p):

| | nose hits a race | out in pit cycles | cars out |
|---|---|---|---|
| short | 6.0 / 6.5 / 2.8 / 3.3 | 9.8 / 9.8 / 6.5 / 6.8 | 13.0 / 12.3 / 11.3 / 13.3 |
| speedway | 8.5 / 4.5 / 6.5 / 1.8 | 10.8 / 10.0 / 14.3 / 5.3 | 20.0 / 16.8 / 20.5 / 13.5 |
| flat | 8.8 / 5.0 / 3.3 / 0.5 | 7.5 / 0.8 / 2.0 / 2.5 | 8.0 / 1.3 / 2.0 / 2.8 |
| club (c0) | 22 / 21 / 22 / 14.3 | 21.8 / 17.8 / 18.8 / 15.5 | 24.5 / 25.8 / 31.0 / 25.3 |
| GP (c1) | 13.8 / 26.5 / 23.5 / 21.5 | 9.3 / 12.8 / 16.5 / 13.5 | 20.3 / 21.8 / 23.5 / 20.3 |

Bench, v5 against v5p (95% ranges in the JSON). Retirements:

| | v5 | v5p |
|---|---|---|
| short | 16.5 | 13.0 |
| speedway | 18.8 | 27.0 |
| flat | 6.0 | 0.0 ✱ |
| club | 37.7 | 36.3 |
| GP | 36.3 | 27.3 ✱ |

Other bench differences:

- **Short oval:** pit-cycle damage 4.45 → 5.36 (worse ✱), laps 0.2 s quicker ✱.
- **Flat oval:** cautions 3.3 → 0.5 ✱.
- **Club circuit:** at-fault retirements 21.0 → 16.7 ✱.
- Everything else within noise. The speedway's retirements have wide ranges (18.8 ± 12.5 against 27.0 ± 3.4), while the
  tracer had its pit-cycle retirements halving.

## Open

- **GP circuit nose hits** are still above v5's (21.5 against 13.8 in the tracer).
- **Most circuit retirements aren't pit cycles:** 27-36 of 40 out on the bench, about half at fault in racing.
- **Wave-ins:** the crew waves in 10-20% of learned stops (stopped short of the box).
