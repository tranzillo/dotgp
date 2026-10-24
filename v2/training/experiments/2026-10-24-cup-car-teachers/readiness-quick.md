# Cup car: the oval teacher gate

`DOTGP_EXPERIMENT='?spec=cup' npx tsx scripts/readiness.ts public/drivers/default.json --tier quick --only ovals` @ac64ae0. The bundle column is the house drivers, trained on the classic car (expected to fail); the teacher column is the gate.

Readiness of default.json (quick tier, 2 seeds a cell, 51 min): 0 of 7 cells ready; teachers clean in 7

Cars: as asked; a race takes at most a car a pit box (short oval 9, flat 24, speedway 30, circuits 16-47). Out: cars out a race. Damage: done by fault, per car per 100 km. Repairs: share of stops called for damage. Each pair is teachers / drivers.

| Where | Cars | km | Out | vs teachers | Damage | vs teachers | Repairs | Pace gap | Scripted | Teachers clean | Ready |
|---|---|---|---|---|---|---|---|---|---|---|---|
| oval: short | 20 | 150 | 0.0 / 3.5 | within noise | 0.000 / 0.306 | B worse | 0.0% / 61.7% | no laps | 28.7% | yes | **no** |
| oval: speedway | 20 | 150 | 0.0 / 9.5 | B worse | 0.000 / 0.305 | within noise | 0.0% / 55.8% | no laps | 53.7% | yes | **no** |
| oval: flat | 20 | 150 | 0.0 / 3.5 | within noise | 0.000 / 0.218 | B worse | 0.0% / 55.3% | no laps | 32.3% | yes | **no** |
| oval: generated short | 20 | 150 | 0.0 / 7.0 | within noise | 0.000 / 0.021 | within noise | 0.0% / 84.9% | no laps | 30.7% | yes | **no** |
| oval: generated intermediate | 20 | 150 | 0.0 / 6.0 | within noise | 0.000 / 0.205 | within noise | 0.0% / 79.9% | no laps | 47.0% | yes | **no** |
| oval: generated speedway | 20 | 150 | 0.0 / 3.5 | within noise | 0.000 / 0.214 | B worse | 0.0% / 34.9% | no laps | 41.0% | yes | **no** |
| oval: generated superspeedway | 20 | 150 | 0.0 / 3.5 | within noise | 0.000 / 0.248 | within noise | 0.0% / 45.2% | no laps | 35.9% | yes | **no** |

Not covered yet: rovals and venue rings, qualifying.
