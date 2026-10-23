# Readiness: teachers that see a slow car their path comes to (c0ac558)

Same candidate bundle as before (drivers unchanged); only the teachers changed. The traffic racer counts a slower car
ahead as in its way wherever its path reaches that car before catching it (not only where its path is beside it now),
and doesn't pass a car heading for pit road on the pit side.

Why: traced, 26 of the 34 teacher retirements in the 20-car, 150 km circuit cell were on one circuit (Oxmoor): a car
turning in for the apex of the corner before pit entry ran into a pitter slowing along the inside, seen only 17 m back
at 24 m/s closing (the line was 7 m across from it until the apex). Those 16 races: 34 retirements -> 2.

Before: experiments/2026-10-23-readiness-teachers-fixed (teachers clean in 10).

Readiness of stable-candidate.json (4 seeds a cell, 17 min): 0 of 17 cells ready; teachers clean in 11

Cars: as asked; a race takes at most a car a pit box (short oval 9, flat 24, speedway 30, circuits 16-47). Out: cars out a race. Damage: done by fault, per car per 100 km. Repairs: share of stops called for damage. Each pair is teachers / drivers.

| Where | Cars | km | Out | vs teachers | Damage | vs teachers | Repairs | Pace gap | Scripted | Teachers clean | Ready |
|---|---|---|---|---|---|---|---|---|---|---|---|
| oval: short | 20 | 150 | 0.0 / 6.3 | B worse | 0.003 / 0.157 | B worse | 5.7% / 99.5% | -0.3% | 0.0% | yes | **no** |
| oval: speedway | 20 | 150 | 0.0 / 13.5 | B worse | 0.041 / 0.219 | B worse | 5.5% / 62.4% | -0.1% | 0.0% | yes | **no** |
| oval: flat | 20 | 150 | 0.0 / 14.5 | B worse | 0.025 / 0.204 | B worse | 3.2% / 75.1% | 0.4% | 0.0% | yes | **no** |
| oval: generated short | 20 | 150 | 0.0 / 0.5 | within noise | 0.000 / 0.001 | within noise | 0.0% / 100.0% | 6.5% | 0.0% | yes | **no** |
| oval: generated intermediate | 20 | 150 | 2.5 / 17.3 | B worse | 0.076 / 0.154 | within noise | 11.4% / 98.4% | 0.1% | 0.0% | **no** | **no** |
| oval: generated speedway | 20 | 150 | 0.0 / 14.8 | B worse | 0.036 / 0.128 | B worse | 4.1% / 59.5% | 0.6% | 0.0% | yes | **no** |
| oval: generated superspeedway | 20 | 150 | 2.5 / 13.5 | B worse | 0.116 / 0.165 | B worse | 8.9% / 63.5% | 0.7% | 0.0% | **no** | **no** |
| oval: short | 40 | 150 | 0.0 / 6.3 | B worse | 0.001 / 0.079 | B worse | 5.7% / 99.5% | -0.3% | 0.0% | yes | **no** |
| oval: speedway | 40 | 150 | 0.3 / 22.0 | B worse | 0.066 / 0.170 | B worse | 13.5% / 68.7% | -1.0% | 0.0% | **no** | **no** |
| oval: flat | 40 | 150 | 0.0 / 17.5 | B worse | 0.023 / 0.129 | B worse | 5.8% / 81.0% | 0.3% | 0.0% | yes | **no** |
| oval: generated short | 40 | 150 | 0.0 / 0.5 | within noise | 0.000 / 0.000 | within noise | 0.0% / 100.0% | 6.5% | 0.0% | yes | **no** |
| oval: generated intermediate | 40 | 150 | 2.0 / 21.3 | B worse | 0.043 / 0.102 | B worse | 11.9% / 97.3% | -0.2% | 0.0% | **no** | **no** |
| oval: generated speedway | 40 | 150 | 0.0 / 36.0 | B worse | 0.078 / 0.133 | B worse | 14.8% / 73.0% | 0.4% | 0.0% | **no** | **no** |
| oval: generated superspeedway | 40 | 150 | 5.5 / 29.8 | B worse | 0.107 / 0.132 | within noise | 17.3% / 59.2% | -1.6% | 0.0% | **no** | **no** |
| club + GP | 20 | 150 | 0.1 / 17.3 | B worse | 0.009 / 0.104 | B worse | 0.7% / 18.8% | 5.3% | 0.0% | yes | **no** |
| club + GP | 40 | 150 | 0.1 / 23.8 | B worse | 0.008 / 0.083 | B worse | 1.3% / 40.0% | 6.2% | 0.0% | yes | **no** |
| club + GP (sprint) | 20 | 25 | 0.0 / 5.8 | B worse | 0.003 / 0.365 | B worse | 0.0% / 76.4% | 1.3% | 0.0% | yes | **no** |

Not covered yet: rovals and venue rings, qualifying.

## Circuit cells again, with each individual's own road teacher (b58036d)

circuits.ts teacher: now races roadTeacherOf (personality caution manners, smooth cautions), the teacher the apprenticeship copied.

Readiness of stable-candidate.json (4 seeds a cell, 7 min): 0 of 3 cells ready; teachers clean in 3

Cars: as asked; a race takes at most a car a pit box (short oval 9, flat 24, speedway 30, circuits 16-47). Out: cars out a race. Damage: done by fault, per car per 100 km. Repairs: share of stops called for damage. Each pair is teachers / drivers.

| Where | Cars | km | Out | vs teachers | Damage | vs teachers | Repairs | Pace gap | Scripted | Teachers clean | Ready |
|---|---|---|---|---|---|---|---|---|---|---|---|
| club + GP | 20 | 150 | 0.0 / 17.3 | B worse | 0.010 / 0.104 | B worse | 0.7% / 18.8% | 5.1% | 0.0% | yes | **no** |
| club + GP | 40 | 150 | 0.1 / 23.8 | B worse | 0.011 / 0.083 | B worse | 1.9% / 40.0% | 6.4% | 0.0% | yes | **no** |
| club + GP (sprint) | 20 | 25 | 0.0 / 5.8 | B worse | 0.003 / 0.365 | B worse | 0.0% / 76.4% | 1.2% | 0.0% | yes | **no** |

Not covered yet: rovals and venue rings, qualifying.
