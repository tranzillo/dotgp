# Road racing apprenticed in full-field classroom races (2026-10-23)

Question: does copying the fixed road teachers in full fields (20-car classroom races under the circuit rules, plus
solo drives and start drills each round; `scripts/roadCautions.ts --racing 1`) make road students cleaner in races?

Setup: the candidate bundle's 40 individuals, continuing from their road and road caution skills; 8 rounds, groups of
8, field 20 (at most a car a pit box), 6 laps, 6 start drills a round, knocks 2/min. Then readiness's circuit cells
(4 seeds, 4 circuits), each driver's own road teacher as the yardstick (b58036d).

## Results (cars out a race, teachers / drivers; pace gap)

| | 20 cars 150 km | 40 cars 150 km | sprint 25 km |
|---|---|---|---|
| candidate (before) | 0.0 / 17.3, 5.1% | 0.1 / 23.8, 6.4% | 0.0 / 5.8, 1.2% |
| full-field apprenticeship (rf8) | 0.0 / 17.8, 5.1% | 0.1 / 23.8, 13.4% | 0.0 / 8.7, 6.1% |
| same, teachers' pedal limited to 4/s (rf8p4) | 0.1 / 18.9, 61.8% | 0.2 / 24.6, 45.7% | 0.0 / 18.9, 55.7% |

No better; with the pedal limit far worse (solo crashes in training 7-19 of 24 drives in the last round; before ~0).

## Why: copy fidelity by situation (rf8, 10 students driving, 4 classroom races)

Labels are the teacher's answers from where the student's car is; error is the student network's squared error.

| What is in the teacher's path | Share of moments | Error | Throttle | Steering | Share of all error |
|---|---|---|---|---|---|
| clear road | 7.9% | 0.091 | 0.057 | 0.034 | 2.8% |
| a car within the radio's 120 m | 27.8% | ~0.21 | ~0.19 | ~0.03 | 23.2% |
| a car 120-250 m (beyond the radio) | 1.6% | 0.239 | 0.219 | 0.020 | 1.5% |
| under caution (safety car) | 62.6% | 0.294 | 0.237 | 0.057 | 72.3% |

- Students race under the safety car most of the time (their own crashes bring it out), and that's most of the error.
- The error is throttle. In traffic and under caution the teacher's throttle is bimodal (about 20% of moments braking
  hard, 35% near full, little between); the students answer in between.
- Perception before capacity: 64-64 networks fitted on 3 races and tested on a 4th explain little of the throttle
  even given extra features a driver could perceive (the car in its path: gap, closing, offset, pitting; under
  caution: distance to its place in line, that place's speed, pace speed). Throttle error following 0.20 → 0.18 with
  the extras; under caution 0.27 → 0.24 (variance 0.31 / 0.36). Neither inputs nor capacity: the teacher's throttle
  flips between flat out and braking on changes nothing a driver sees predicts.
- A teacher's foot (pedal moving at most 4/s from where the car's is): labels sit near the student's own last
  command, so per-moment error falls to ~0.013, but a network predicts almost none of the *change* beyond "hold the
  last command" (0-17%; the instant pedal 12-19%), and students that hold their pedal don't brake for corners.

Next: a teacher whose speed control is continuous in what a driver sees (proportional on the car ahead, smooth under
caution), measured by the share of its pedal changes a network predicts before any training run; and outcome-scored
practice in full fields (ES racecraft), which doesn't need the teacher's throttle copied.

## Proportional teachers (followGain 1.5/s, cautionGain 2/s; @1c54a28, off by default)

Copyability (64-64 networks, held-out race): throttle error following 0.21 → 0.16, under caution 0.29 → 0.16. Teachers
still lose no cars but do about 3x the damage by fault (repairs 5-6%). Apprenticed with them (rf8g): no cleaner.

## Re-measured with drivers' pit skills driving their stops (circuits.ts fix @54e63d8)

circuits.ts never passed a driver's pit network, so every stop in circuit readiness was driven by the road racing net.
With the fix (cars out a race, 20 / 40 cars at 150 km, sprint): candidate 17.5 / 23.0 / 8.0; rf8 17.5 / 23.1 / 5.9;
rf8g 17.3 / 22.5 / 5.5. Pits weren't the main cause.

## What takes the students out (16 races, candidate, 20 cars, 150 km; 276 retirements)

- Out after contact 132; stopped on track 99; out of the race (wall damage) 39.
- The stopped cars: nearly all under the safety car (30-320 s into it), healthy and fuelled, several from one caution:
  beached off the outside of the track (5-14 m past the edge), or stuck between the track and pit road at the pit wall's
  nose with no stop called. The road caution skill driving: its copy is the worst (throttle error 0.29), and once
  crashes start the field spends most of the race under it.
