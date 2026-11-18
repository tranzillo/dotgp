# Under caution: practice, the caution skill's cornering, and what the team tells drivers

2026-10-24, circuit machine. Candidate bundle `public/drivers/stable-candidate.json` throughout; readiness is its circuit
cells (4 seeds, 4 circuits; teachers / drivers out a race).

## Retrained on the fixed teachers (8 rounds, @47e0f44)

| | 20 cars 150 km | 40 cars | sprint 25 km | pace gap (20) |
|---|---|---|---|---|
| candidate | 17.5 | 37.7 | 6.8 | 8.7% |
| road cautions only (rc8fix) | 17.9 | 37.1 | 7.0 | 6.8% |
| road cautions + racing (rf8fix) | 18.2 | 37.1 | 8.9 | 16.9% |

47e0f44 also keeps the caution teacher's lane on the racing surface (it was "where you are", ±6 m: a club circuit's edge).

## Practice by PPO in safety car drills (`roadCautions.ts --ppo 1`, f1f95eb)

A drill: 12 students strung out round a circuit, the safety car after 4 s, to the restart (300 s at most). A decision under
the safety car costs damage, harm, fear, trauma, time lost to the safety car's speed while catching up, its place
error after the pickup, places gained, and retirement (a car's worth of damage). Teachers lose 1 car in 6 drills,
students 38 of 72. 60 iterations x 2 drills, groups of 8: clean 25% -> 26%, out 48% -> 47% (flat). Readiness 17.6 /
37.1 / **3.9**, pace gap 4.9%: shorter races and pace a little better, long races not.

(The drill's first version raced from the grid: the circuit rules grid the field when the race is made.)

## The caution skill forgets how to corner

Off-track trips under the safety car in 8 drills (96 student cars): the caution network ~700 (outside of corners at 14-28
m/s, radius 34-82 m), the students' racing network driving the safety car 108, teachers 2. Cars out: caution network
34, the caution network's throttle with the racing network steering 11, the racing network alone 4.

In races (`ROAD_CAUTION_THROTTLE`, an experiment switch in drivers.ts):

| | 20 cars 150 km | 40 cars | sprint | damage (20) |
|---|---|---|---|---|
| 1: racing net steers, caution net only lowers the throttle | 17.0 | 11.9 (no laps) | 0.9 | 0.028 |
| 2: racing net steers, caution net's throttle, all pacing | 18.3 | 6.9 (pace gap 108%) | 1.0 | 0.024 |
| 2, behind the safety car only (82ecf7e) | 17.9 | 37.1 | 4.4 | 0.131 |

The low damage in 1 and 2 was races that barely raced: the racing network can't put a car in its grid box (2) or
brakes for the cars close ahead in a formation (1), and the fields ran dry before the green (9000+ s to form up).
Behind the safety car only, nothing changes. Not a fix as it stands.

## What the team tells drivers (`scripts/audit.ts`, 3 ovals + 2 circuits x 2 seeds, 20 cars, 100 km)

| | ovals green | ovals pacing | circuits green | circuits pacing |
|---|---|---|---|---|
| damaging contacts: the other car on the radio a second before | 88% of 228 | **57%** of 248 | 92% of 187 | **54%** of 63 |
| ... not named: the pace car / safety car | | 70 | | 15 |
| hazard call names a moving car (normal traffic) | 94% | 1% | **97%** (called 50% of the time) | 1% |
| caution input "place in line" at its 120 m clamp | | 36% | | 62% |
| caution input "gap ahead in line" at its 50 m clamp or none | | 43% | | 66% |
| stops called with a racing car on the bumper | 11% | 6% | 0% | 2% |

Pit road: 368 contacts in pit cycles in the 6 oval races (476 on track).

Fixes to the spotter (shared: oval drivers hear them too):
- 1d45af0: while pacing, the hazard is a stopped car or a wreck (it was anything under 25 m/s: the next car in line).
  Safety car drills: wreck called 66% -> 85%, hits on wrecks 56 -> 9.
- 6ecb150: the pace car (safety car) and wreckers on track are called like cars. Audit: under caution on ovals,
  damaging contacts 248 -> 165, named 57% -> 75%, retirements 101 -> 84; circuits named 54% -> 72% (the safety car
  coming out of pit road still unnamed in 10).

Readiness with the hazard fix alone (before 6ecb150): 17.5 / 37.0 / 7.4 (unchanged).

## Pit wave-off (063e8ab, 4c1274a)

A car on its way in, still on the racing surface, stays out if following cars slowing into the pit (or a car stopped
in its path) needs more braking, with racing cars behind, than its nerve stands (2.5-6.5 m/s²); not with a penalty
to serve or under 1.25 laps of fuel. In 36 teacher races it never fired: teachers slow in step (1.2 m/s² at most).
The pit-entry damage there is the car called in slowing and moving down in a drafting pack (speedway) and boxes vs
arrivals on pit road (GP).

## Next

- The hazard channel under green on circuits: normal traffic in slow corners (97% of calls).
- Caution inputs at their clamps (the place in line, the gap ahead in it): rescale.
- The safety car coming out of pit road (unnamed, and it ran off at a pit exit when the field was there).
- Retrain the caution skills on the new radio (they learned on the old one).
