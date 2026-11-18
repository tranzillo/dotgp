# The second damage model (?damage=2) against the first (2026-10-25)

Oval machine. Built at 02cb01a (src/sim/damage.ts), measured at abe0c87 (lab).

What model 2 does:

- **Light contact is free.** Normal impacts under 6 m/s, and scraping, cost no health. They still cost speed and tyres.
- **A compromised car loses pace.** Below 0.5 health, power falls toward 4% and grip toward 60% at zero. That's a crawl
  at about a third of top speed. A hard enough hit still wrecks a car outright.
- **A compromised car smokes**, thicker the worse it is (src/render/smoke.ts). The crew calls it in, the spotter
  calls it a hazard, and the radio says "Smoking: get it low, bring it in".
- **Teachers save the car.** A compromised teacher stops passing and heads low: the inside edge by half way, the
  apron once crawling. Everyone goes round a smoking or stopped car, whatever their passing style.
- **Pass counting changes** (abe0c87). A pass of a compromised car doesn't count as a pass: the crawlers being
  gone round aren't racing for the place. Under model 2 this also takes the stable's many damaged-but-running cars out
  of the count. Model 1 has no compromised cars, so the stable's clean-pass drop is partly definitional.

Also in this run, under both sides (9b6569c, 0eed759):

- A stopped car brings a caution first. It's retired only on no fuel, a second stall, or being stuck for 30 s.
- A black-flagged car runs on until called in, then parks at its box.
- Penalty laps on pit road aren't counted.

Bench: the 7 readiness ovals, 40 cars, 150 km, 4 seeds, `--rules 1`, `--experiments '|?damage=2'` (A model 1, B
model 2). ✓ / ✗: B better / worse beyond the 95% range, race by race.

### teachers

| track | out | cautions | damage stops | clean passes /100 | damaging contacts /100 | lap (s) |
|---|---|---|---|---|---|---|
| short | 0.0 → 0.0 | 0.0 → 0.0 | 0.0 → 0.0 | 0.4 → 0.6 | 0.8 → 0.0 ✓ | 26.95 → 26.93 |
| speedway | 0.0 → 0.0 | 0.0 → 0.0 | 0.8 → 0.2 | 7.0 → 6.2 ✗ | 0.8 → 0.0 ✓ | 38.16 → 38.16 |
| flat | 0.5 → 0.0 | 0.2 → 0.0 | 0.5 → 0.0 | 5.1 → 4.6 | 0.5 → 0.0 | 43.91 → 43.85 |
| gen. short | 0.0 → 0.0 | 0.0 → 0.0 | 0.0 → 0.0 | 0.6 → 0.5 | 0.8 → 0.0 | 25.39 → 25.42 |
| gen. intermediate | 0.0 → 0.0 | 0.0 → 0.0 | 0.2 → 0.0 | 4.5 → 4.8 | 0.3 → 0.0 ✓ | 47.34 → 47.31 |
| gen. speedway | 0.0 → 0.0 | 0.0 → 0.0 | 2.8 → 1.5 | 7.6 → 6.9 | 1.5 → 0.1 ✓ | 41.02 → 41.12 ✗ |
| gen. superspeedway | 0.0 → 0.0 | 0.0 → 0.2 | 1.0 → 0.2 | 3.7 → 4.4 | 0.7 → 0.1 | 42.49 → 42.60 |

### stable

| track | out | cautions | damage stops | clean passes /100 | damaging contacts /100 | lap (s) |
|---|---|---|---|---|---|---|
| short | 23.5 → 23.0 | 6.8 → 5.5 | 42.0 → 9.0 ✓ | 33.8 → 26.9 | 131.0 → 30.4 | 26.72 → 26.94 |
| speedway | 25.8 → 24.8 | 7.2 → 5.2 | 23.5 → 4.5 ✓ | 140.9 → 84.4 | 113.5 → 19.8 | 37.99 → 37.83 |
| flat | 21.2 → 19.0 | 7.5 → 4.5 | 32.0 → 4.0 ✓ | 36.1 → 15.7 | 30.6 → 1.4 | 43.92 → 43.77 |
| gen. short | 7.8 → 7.8 | 4.0 → 3.8 | 5.8 → 3.8 | 57.8 → 87.5 | 170.1 → 155.0 | 25.61 → 26.44 |
| gen. intermediate | 21.8 → 20.5 | 3.0 → 1.2 ✓ | 8.5 → 1.0 ✓ | 46.0 → 24.9 | 53.7 → 4.0 ✓ | 47.05 → 47.09 |
| gen. speedway | 35.5 → 33.5 | 6.5 → 7.0 | 21.8 → 6.8 ✓ | 236.4 → 2607.5 | 215.3 → 593.9 | 41.20 → 41.35 |
| gen. superspeedway | 31.2 → 31.0 | 6.5 → 4.8 | 16.5 → 4.0 ✓ | 930.5 → 2196.0 | 517.0 → 215.0 | 42.48 → 42.00 |

### house

| track | out | cautions | damage stops | clean passes /100 | damaging contacts /100 | lap (s) |
|---|---|---|---|---|---|---|
| short | 16.2 → 15.8 | 9.0 → 8.5 | 135.0 → 85.8 ✓ | 24.0 → 22.1 | 46.0 → 15.9 ✓ | 30.80 → 30.05 ✓ |
| speedway | 12.0 → 16.0 | 6.8 → 10.0 | 78.8 → 51.0 ✓ | 83.9 → 120.6 | 58.5 → 35.3 ✓ | 43.46 → 42.92 |
| flat | 5.5 → 1.5 ✓ | 2.8 → 0.8 ✓ | 192.0 → 26.5 ✓ | 26.1 → 20.7 | 36.8 → 6.9 ✓ | 49.32 → 48.88 ✓ |
| gen. short | 7.2 → 8.2 | 11.8 → 16.2 ✗ | 46.8 → 20.0 | 1.2 → 2.7 | 24.9 → 12.2 ✓ | 32.33 → 33.48 ✗ |
| gen. intermediate | 13.2 → 11.5 | 6.0 → 6.0 | 115.0 → 54.0 ✓ | 78.6 → 46.7 | 67.3 → 22.4 ✓ | 56.21 → 54.39 ✓ |
| gen. speedway | 20.8 → 24.0 | 9.2 → 10.0 | 86.0 → 67.2 | 205.5 → 202.7 | 107.8 → 48.6 ✓ | 47.46 → 46.20 |
| gen. superspeedway | 19.5 → 17.5 | 9.5 → 8.8 | 54.5 → 38.0 | 311.2 → 219.1 | 139.6 → 41.9 ✓ | 50.75 → 50.61 |

### Cup teachers

| track | out | cautions | damage stops | clean passes /100 | damaging contacts /100 | lap (s) |
|---|---|---|---|---|---|---|
| short | 0.2 → 0.0 | 0.2 → 0.0 | 0.2 → 0.0 | 1.5 → 1.4 | 1.7 → 0.0 ✓ | 23.62 → 23.65 |
| speedway | 0.0 → 0.0 | 0.0 → 0.0 | 0.0 → 0.0 | 4.5 → 4.0 | 0.6 → 0.0 ✓ | 34.25 → 34.24 |
| flat | 0.0 → 0.0 | 0.0 → 0.0 | 0.0 → 0.0 | 7.9 → 8.1 | 1.3 → 0.0 ✓ | 36.45 → 36.48 |
| gen. short | 0.0 → 0.0 | 0.0 → 0.0 | 0.0 → 0.0 | 1.1 → 0.9 | 0.5 → 0.0 ✓ | 21.61 → 21.62 |
| gen. intermediate | 0.0 → 0.0 | 0.0 → 0.0 | 0.0 → 0.0 | 6.2 → 6.2 | 0.9 → 0.0 ✓ | 40.76 → 40.75 |
| gen. speedway | 0.0 → 0.0 | 0.0 → 0.0 | 1.8 → 0.5 | 4.4 → 4.2 | 1.2 → 0.3 ✓ | 38.65 → 38.66 |
| gen. superspeedway | 0.0 → 0.0 | 0.0 → 0.2 | 0.2 → 0.0 | 3.8 → 2.6 | 0.5 → 0.1 ✓ | 44.74 → 44.53 |

## Reading it

- **Teachers (classic and Cup): contact goes for free.** Damaging contacts fall to 0-0.1 per 100 green car-laps
  everywhere. Clean passing is unchanged within noise, apart from 7.0 → 6.2 on the speedway. Nobody is out.
  Damage stops fall too. Lap times are the same, apart from +0.1 s on the generated speedway.
- **The stable: less damage, the same wrecks.**
  - Damage stops fall 3-8× everywhere but the generated short oval (5.8 → 3.8).
  - Damaging contacts fall on most tracks: short 131 → 30, speedway 114 → 20, flat 31 → 1.4, generated
    intermediate 54 → 4, generated superspeedway 517 → 215. The generated speedway's 215 → 594 is the one race below.
  - Retirements don't move: 20-35 of 40, model 1 and model 2 alike.
  - The stable's wrecks are hard hits, which model 2 still lets end a race, and its students have no save-the-car
    behaviour (only the teachers do).
  - Clean passes fall on most tracks. That's within noise, and partly the pass-counting change above.
  - The generated speedway's 236 → 2607 is one race with almost no clean green laps (9600 per 100). Run per seed,
    both models sit at 186-319. The per-race ratio blows up on wreck-fest races.
  - Of all passes there, 12-14% came with damage under model 1 and 2-4% under model 2. The share with any contact
    held at about 30%.
- **House: less damage, mostly better.**
  - Damaging contacts fall 2-5×, and damage stops 1.3-7×. The flat track's retirements fall 5.5 → 1.5.
  - The generated short oval got worse: cautions 11.8 → 16.2 and lap time +1.1 s. Not traced yet; crawlers on a
    tiny track with no room to get low are the suspect.

Raw: dmg2b-{teachers,stable,house}.txt/.json and dmg2-cup.txt/.json (scratch on the oval machine).
