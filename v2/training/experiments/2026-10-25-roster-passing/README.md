# The roster: passing against contact (2026-10-25)

Oval machine. What the oval drivers do in traffic now: the teachers since the passing fix (cb8de0a), the candidate
bundle's oval skills (the oval stable v10, apprenticed at 077df17 to the teachers before the fix), the house drivers;
and the teachers in the Cup car. New in the bench (a39d91d, 83e25b8):

- **clean passes** /100 green car-laps: passes with no touch between the pair in the 3 s before;
- **damaging contacts** /100 green car-laps: car-to-car hits that cost health under green (a pair's hits within a second are one);
- **clean passes per contact**: the ratio, the balance being asked about;
- shares of passes with a damaging touch and **from a tow** (the passer in a tow, 10%+ less drag, in the 3 s before:
  loose, since a car closing from behind is nearly always in one);
- **health lost on track** by what was hit: walls under green (alone or with a car alongside), cars, and under caution.

Bench: the 7 readiness ovals, 40 cars (capped by boxes), 150 km, 4 seeds, at a39d91d (lab).
`teacher:stable-candidate.json`, `stable-candidate.json`, `default.json`; then the teachers with `?spec=cup`.

## Classic car

| track | out (T / S / H) | clean passes /100 (T / S / H) | damaging contacts /100 (T / S / H) | clean passes per contact (T / S / H) | lap (T / S / H) |
|---|---|---|---|---|---|
| short | 0 / 20.3 / 20.5 | 0.5 / 6.7 / 32.7 | 2.1 / 27.3 / 53.1 | 0.22 / 0.25 / 0.62 | 26.98 / 26.83 / 30.52 |
| speedway | 0 / 21.3 / 14.0 | 6.6 / 45.3 / 96.0 | 1.0 / 35.2 / 65.7 | 6.84 / 1.37 / 1.46 | 38.19 / 37.66 / 43.60 |
| flat | 0 / 15.0 / 7.0 | 4.6 / 21.4 / 35.8 | 0.4 / 14.8 / 31.6 | 9.32 / 1.42 / 1.12 | 43.88 / 43.79 / 49.54 |
| gen. short | 0 / 6.5 / 6.8 | 0.7 / 3.3 / 1.1 | 1.6 / 8.0 / 11.9 | 0.61 / 0.50 / 0.10 | 25.40 / 25.62 / 31.80 |
| gen. intermediate | 0 / 22.0 / 13.0 | 3.8 / 35.0 / 76.4 | 0.5 / 37.6 / 62.1 | 8.73 / 1.07 / 1.28 | 47.45 / 47.08 / 55.26 |
| gen. speedway | 0 / 33.5 / 18.8 | 7.8 / 113 / 174 | 2.0 / 77.4 / 94.9 | 4.07 / 1.48 / 1.81 | 41.30 / 40.98 / 47.18 |
| gen. superspeedway | 0 / 32.3 / 18.0 | 3.4 / 357 / 220 | 0.6 / 152 / 119 | 6.01 / 2.26 / 1.84 | 42.47 / 41.70 / 50.18 |

T teachers, S the stable (candidate bundle), H house drivers. Full bench text: `roster-classic.txt` on the oval machine
(scratch); 95% ranges are wide for S and H (wrecking fields).

- **Teachers: clean, few passes.** 0 out, damage to others 0.1-1.2 a race. Clean passes 3.4-7.8 per 100 green
  car-laps on bigger ovals, **0.5-0.7 on short ovals**, where contacts outnumber clean passes. Superspeedway 3.4: the
  draft doesn't make passes (passes from a tow 21%, against 32-43% on the other big ovals).
- **The stable isn't clean racing at the cost of passing: it wrecks.** 6.5-33.5 of 40 out; its passing is mostly of
  damaged and slow cars, at 1-2 clean passes per damaging contact (teachers 4-9). Its pace is the teachers' (0.2-0.8 s
  quicker). It copied the teachers before the passing fix.
- **The teachers' repairs are walls, not cars.** Short oval, 26 cars, 80 laps: walls 10.2 health a race (4.0 with a car
  alongside), cars 0.75; 46% of stops called for damage.

## Cup car (teachers)

| track | out | clean passes /100 | damaging contacts /100 | clean per contact | pit stops (for damage) | lap |
|---|---|---|---|---|---|---|
| short | 0 | 1.8 | 2.0 | 0.90 | 102.5 (0.8) | 23.62 |
| speedway | 0.3 | 2.3 | 0.5 | 4.64 | **216.8 (125.8)** | 34.64 |
| flat | 0 | 8.2 | 1.6 | 5.22 | 98.5 (0) | 36.47 |
| gen. short | 0 | 1.2 | 1.0 | 1.22 | 37.0 (0) | 21.61 |
| gen. intermediate | 0 | 6.5 | 0.9 | 7.74 | 96.0 (0) | 40.82 |
| gen. speedway | 0 | 3.5 | 1.0 | 3.57 | **218.8 (45.8)** | 39.12 |
| gen. superspeedway | 0 | 3.9 | 0.4 | 9.45 | 155.0 (1.0) | 44.71 |

- **Tyres:** the Cup car on the speedway wears 0.079 a green lap: the cliff in 9 laps (4x pace), so 40 cars make
  about 5 stops each in 150 km.
- **The speedway's repairs: the outside wall at pit entry.** Traced (25 laps, 40 cars): ~1000 wall touches, all within
  10 m of one spot (s 2312-2321, 15 m before the pit wall starts), on the outside edge, 60-70 m/s (the line: 84.5),
  nobody alongside, nose to tail behind other cars there. The field going round the cars slowing for pit road rides the
  outside wall; the more stops, the more of it. Solo: no wall damage. The classic car does it at the same spot, rarely
  (fewer stops, 0.15 health in 25 laps).
