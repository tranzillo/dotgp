# Pit layout: what driver training found (2026-10-23)

Notes for the track-generation work. Training scripted teachers and learned drivers to race full fields with pit stops (the first milestone, `v2/training/ROADMAP.md`) kept running into the pit layout. Each point below comes from traced crashes or measurements on the current generator. Numbers are from the benchmark tracks (the oval presets and `circuits.ts`'s first four circuits). Geometry names are `Track.pit`'s: `entryStart`, `wallStart` (the nose), `wallEnd`, `exitEnd`, `blendEnd`, `wallD`, `laneD`, `stalls`.

## 1. The pit wall's nose stands inside the track limits

- **Found:** on every track, ovals and circuits alike, `wallD` puts the nose 1.40 m beyond the inside edge (`innerEdge`). The track limits allow a car's centre up to 1.5 m past the edge (`limits.ts`, `CAR_RADIUS`), and a car is 3 m wide, so a car legally on the white line already touches the nose.
- **Effect:** in a 40-car, 150 km trace, 8 of 14 circuit-teacher retirements were the nose.
  - Cars holding the inside line under caution hit it.
  - Cars backing out of an aborted pit entry hit it.
- **Worked around in the drivers, not fixed:** `Track.pitWallClear(s)` keeps cars that aren't pitting 1 m clear of the wall from 60 m before the nose. The formation, aborted entries and the racing line's corridor all use it (9f4c370, e2d5d4e).
- **Suggest:**
  - Nose at least a car's width plus margin beyond the edge (about 4 m or more).
  - Or the wall tapering in from further out, with an attenuator on the nose.
  - Or a painted pit-entry line that is itself a track limit, so the area in front of the nose isn't legal racing surface.
- **Check:** for every generated track, `wallD + pitOffset(wallStart) - innerEdge(wallStart) >= 2 * CAR_RADIUS + 1`.

## 2. Circuit pit entries are short, and slowing cars stay on the racing surface

- **Found:** pit entry starts about 90 m before the nose (`entryStart` -195 to -220, `wallStart` -105 to -130). The racing line usually sets up on the far side for the next corner, so a pitting car crosses the whole track (about 19 m sideways to `laneD` 13.3) in about 90 m at 30-40 m/s.
  - The pit maneuver often can't line up in time and aborts ("Aborted pit entry, not lined up").
- **Effect:** the commonest teacher crash on circuits was a car at 40-55 m/s rear-ending a car slowing for pit road (to 15-25 m/s) on the racing surface. A longer lookahead in the racer fixed most of it, but pitting cars still brake in the racing line.
- **Suggest:** a deceleration lane separated from the racing surface by a line:
  - starting 200-300 m before the nose;
  - or splitting off on the inside before the last corner, as real circuits do;
  - on the side the line sets up for that corner, where possible.

  Cars then slow off the racing line, and a queue for pit road waits off the track.
- **Check:** `wallStart - entryStart` at least 200 m on circuits. The entry lane's start reachable from the racing line without crossing it at speed.

## 3. Too few pit boxes for the field

- **Found:** boxes (`stalls.length`) on the benchmark tracks:

| Track | Boxes |
|---|---|
| short oval (preset) | 9 |
| flat oval | 24 |
| speedway | 30 |
| club circuits | 16-21 |
| GP circuits | 22-47 |

- **Effect:** before the one-car-a-box rule, boxes were shared. Under a safety car crews call cheap stops en masse, so cars queued for their box, and the cars behind stalled on track before pit entry. Race control retires cars stopped on track.
  - Circuit teachers lost 11.3 of 40 a race.
  - The short oval raced 40 cars through 9 boxes.
- **Now:** a race takes at most one car a box (`Track.maxField`; user's rule, 1223b8b). With today's layouts the short oval races 9 cars and club circuits 16-21.
- **Suggest:** size pit road to the field wanted, e.g. 40 boxes on ovals and 20-26 on circuits. On short tracks that means boxes on both sides of pit road, or a longer pit road (real short ovals seat 40).
- **Check:** `stalls.length` at or above the series' field size on every generated track.

## 4. Pit exits blend too far away (big ovals)

- **Found:** on a generated superspeedway the blend lane ends about 2.6 km after the box, most of a lap. A car leaving the pits runs beside the racing surface for a long way before it counts as merged.
  - The pit-skill drills had to be lengthened to 200 s to reach the merge (172869d).
- **Effect:** merging is the commonest pit failure in full races. In a short-oval race, about 6 of the learned drivers' 19 retirements were merging or near a merging car. "Near a merging car" is a common context on the oval bench too.
- **Suggest:** end the blend a short, fixed distance after `wallEnd`, scaled to the track's speed (a few hundred metres), at a clear merge point. On circuits, exit on the inside of the run to the next corner.
- **Check:** `blendEnd - wallEnd` bounded (e.g. at most 500 m, or a few seconds at the track's pace).

## 5. Smaller points

- **Set-back pit roads** (a lane swinging over to a pit road across grass) complicate the pit maneuver's decision points (its abort logic has special cases for them). Straight, parallel pit roads are easier to drive and to learn.
- **The stall rule** (race control retires cars stopped on track) also catches cars held up behind a pit queue. If queues can still form on track, the rule may need an exemption for cars stopped by traffic. That's a rules point, but it interacts with #2 and #3.
- **Consistency helps learning.** The pit network learns stops across many tracks from a few inputs (route ahead, distance to box, the limit zone, clear to merge). Layouts that follow one pattern (entry lane, nose, boxes, exit, blend) relative to the track are easier to learn than ones that vary a lot.

## How to measure a new generator

- **Teachers in races:** `npx tsx scripts/readiness.ts <bundle> --only circuits` (and the oval cells), the teacher columns: cars out a race (gate: at most 5% of the field) and stops called for damage (gate: at most 10%). Today's candidate bundle is `public/drivers/stable-candidate.json`.
- **Pit maneuver alone:** `scripts/pitSkill.ts`'s drills (watching round) complete a stop on nearly every track. A layout where the maneuver fails a stop is one the drivers can't learn.
- **Retirements by context:** the oval bench (`scripts/incidents.ts`) labels each retirement (in a pit cycle by section: before entry, entry, along the wall, exit, blend; merging; under caution).
