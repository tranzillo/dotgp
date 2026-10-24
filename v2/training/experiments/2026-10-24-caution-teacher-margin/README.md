# Road cautions: the teacher's margin, the new caution inputs, and longer training

2026-10-24, circuit machine. Candidate bundle `public/drivers/stable-candidate.json`; only the road caution skill
retrained (`roadCautions.ts --rounds 8 --field 20 --laps 6 --knocks 2 --racing 0`); readiness is its circuit cells
(teachers / drivers out a race; 20 cars 150 km, 40 cars 150 km, sprint 20 cars 25 km).

## Why students leave the track under the safety car

`_whyoff`-style trace, 6 drills, 507 trips off: in the 1.5 s before one the student is at **90% of the racing line's
speed, 7.2 m off the line** (on average under caution: 67%, 4.9 m), braking and steering about as the road network
would on the same inputs. The smooth formation teacher catching the queue drives pace + eagerness, capped at 0.85 of
its *lane's* cornering limit: in slow corners it rides that cap, off the racing line. Students copy it with latency
and noise and see only the racing line's speeds.

## The teacher's margin (`ROAD_CAUTION_GRIP`, 636ab22; @636ab22)

| road teachers' share of the lane's limit | 20 cars | 40 cars | sprint | damage (20) | pace gap |
|---|---|---|---|---|---|
| 0.85 (as before) | 17.9 | 37.1 | 6.1 | 0.123 | 7.5% |
| 0.7 | 17.3 | 36.9 | 4.3 | 0.105 | 5.2% |
| 0.6 | 17.0 | 36.4 | 4.6 | 0.092 | 4.5% |

Retirements, 6 races of 150 km (`_cautiontrace`): 0.85 — car contact under caution 44, wall 28, stopped 21; 0.6 —
contact 13, wall 24, **stopped 36 (+10 at the restart)**. Stopped cars moved from the gravel (15 -> 9) onto the track
(8 -> 37), 19 of them with a stopped car within 40 m ahead in their file: students crawling to a halt behind each
other where the teacher's label says go. A stall rule that spares a car held up behind a stopped one (lab patch, not
landed) changes nothing (17.0 -> 16.5).

## The new inputs (5d023ba: green hazard relative to the corner, unclamped place / gap under caution), 0.7

| | 20 cars | 40 cars | sprint | damage sprint |
|---|---|---|---|---|
| 0.7 bundle, old training, on 5d023ba (hazard change only) | 17.6 | 37.3 | 7.3 | 0.420 |
| retrained 8 rounds | 17.9 | 36.6 | 5.2 | 0.382 |
| retrained **16 rounds** | 17.3 | 35.9 | **1.5** | **0.186** |

Longer training helps the short race a lot, long races not. 16 rounds, 6 races of 150 km: 81 out under caution (car
31, wall 28, stopped 22), 28 under green. One race lost 9 cars to the racing skill under green before the first
safety car (wall crashes off the surface don't bring one out), then one caution of 11 minutes in which 3 ran dry.

## Reading

- 0.7 is a mild win for road teachers (and 0.6 trades crashes for crawling): worth setting in the next retrain.
- The caution skill keeps improving with rounds (sprint 6 -> 1.5); the next retrain should run longer.
- Long races fail by compounding: green crashes by the road skill (not retrained here, and it now hears a different
  hazard call), contacts under caution, cars that crawl and stop, long cautions that run cars dry.
