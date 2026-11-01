# Green car contact: hands, rear-ends on corner entry, and two lines nobody passes on (2026-11-01)

Oval machine. `?spec=cup&lines=2`, 40 cars, `--rules 1`, at 34442f5. Bundle: `stable-candidate-v8s-lines` (v8s,
`../2026-11-01-racing-race-labels`), whose green car damage was 2-5x its teachers'. Probe outputs are in `probes.txt`,
numbered as below. (The pit work's v8sp, c9da59d, is v8s with new pit skills: out over seven ovals 52.6 -> 9.9, its
racing networks v8s's. Everything here holds for it; with pit cycles gone, green racing is most of what's left.)

## The teachers through their students' hands

Students drive through their human limits (0.1-0.2 s latency, 2-8% motor noise); the bench's teachers (`teacher:`)
had none. `TEACHER_HANDS=1` (scripts/incidents.ts, passed on by bench.ts) drives each teacher through its student's own
limits. `handed-teachers-v8s.json`, against v8s; teachers without hands from
`../2026-11-01-takeover-crossing-rate/teachers-v8ra.json` (the same teachers):

| teachers / handed teachers / v8s | out | green car damage | damaging contacts /100 | green wall damage | lap (s) |
|---|---|---|---|---|---|
| short | 0.8 / 1.3 / 2.0 | 0.72 / 2.22 / 3.64 | 1.7 / 3.0 / 5.4 | 0.00 / 0.02 / 0.25 | 23.49 / 23.56 / 23.45 |
| speedway | 1.0 / 0.3 / 8.5 | 1.23 / 2.72 / 5.44 | 0.8 / 2.7 / 10.1 | 0.02 / 0.06 / 0.09 | 32.71 / 32.91 / 33.09 |
| flat | 0.0 / 0.0 / 3.0 | 0.39 / 1.40 / 2.36 | 1.4 / 2.1 / 4.9 | 0.00 / 0.67 / 0.17 | 36.40 / 36.48 / 36.43 |
| gen. short | 0.0 / 0.0 / 0.8 | 0.12 / 0.55 / 0.33 | 0.8 / 2.7 / 2.6 | 0.00 / 0.04 / 0.04 | 22.18 / 22.15 / 22.16 |
| gen. intermediate | 3.3 / 0.8 / 9.5 | 1.09 / 2.37 / 3.77 | 1.0 / 1.9 / 6.9 | 0.07 / 0.55 / 0.37 | 40.52 / 40.70 / 40.69 |
| gen. speedway | 0.0 / 1.3 / 17.5 | 1.64 / 4.26 / 5.65 | 2.2 / 4.1 / 16.1 | 0.00 / 0.03 / 0.22 | 37.24 / 37.38 / 37.64 |
| gen. superspeedway | 0.0 / 0.0 / 11.3 | 0.28 / 1.34 / 1.61 | 0.4 / 1.0 / 4.3 | 0.00 / 0.00 / 0.08 | 44.19 / 44.30 / 44.94 |

The hands account for half or more of the gap in green car damage (v8s within noise of the handed teachers everywhere
but the short oval), and handed teachers scrape walls the students don't (flat, gen. intermediate). Not the
retirements (cautions and pit cycles), and not the number of contacts: the students touch 2-4x as often, lightly.

## What the contacts are

Short oval, 2 races (`probes.txt` 1): teachers 113 damaging green contacts (77 beside, 36 nose to tail), handed
teachers 199 (110 / 89), v8s 516 (167 / 349). The students' excess is running into the car ahead, including 68 where
neither car was moving across (handed teachers 3). Before them the student brakes later than its teacher would (3):
2-3 s out its pedal +0.14 against the teacher's -0.12, 1-2 s out -0.01 against -0.22; the speedway's alike (6).

`scripts/rearEnds.ts` (4), from the following car's side:

| | short: handed teachers / v8s | speedway: handed teachers / v8s |
|---|---|---|
| nose-to-tail contacts (2 races) | 89 / 349 | 24 / 98 |
| on corner entry / mid-corner / straight | 40 / 43 / 4 ; 134 / 163 / 47 | 1 / 18 / 2 ; 1 / 61 / 29 |
| corner entry: behind that same car for (s) | 8.5 / 50.4 | |
| same line as the car hit | 98-100% / 98-99% | 100% / 97-100% |
| the other line beside it open | 72% / 55-72% | 89-100% / 70-97% |
| a plan to go by in the 2 s before | 2-13% / 4-8% | 67-100% / 10-72% |
| all green following (closing on a car within 30 m in its lane): a plan to go by | 3-22% / 3-22% | 76-81% / 61-73% |

On the short oval nobody uses the second line to pass, teachers included: faster cars queue behind slower ones (v8s
50 s behind the car it hit on corner entry), and the faster car, braking later for the corner than the one ahead,
runs into it.

- Why the teacher holds: it pulls out only when its own pace there beats the car ahead by its passing edge (`pass`,
  0.7-1.8 m/s by nerve). With the lines lapping alike, a faster driver's edge on a short oval is its talent, about
  1 m/s. And the ways past it weighs are that car's line shifted a car's width across, or a groove beside it, judged
  in m/s, never the other line, judged by progress round the track. (On the short oval the high line runs 2.4 m/s
  faster than the low one nearly everywhere, its lap the same.)
- Why it hits: following, its room (`followLoss`) plans on the car ahead braking at its nerve's `insure` from the
  speed it has now, not slowing to the corner ahead: at corner entry the leader slows 6 m/s in a second.

## The two lines at the drivers' grip

`src/trackgen/balance.ts` balances an oval's two lines on `racingLine(...).lapTime`, which is the profile at full grip
(`gripShare` only steers refinement, and the balance doesn't refine). At the grip drivers race at (`line.at(0.86)`),
margin 0.6: short 22.75 / 22.76 s (low / high), flat 35.31 / 35.31, gen. short 21.74 / 21.76, gen. intermediate
39.19 / 39.28, gen. speedway 34.95 / 34.82, but the preset speedway 30.96 / 30.15: its high line is 0.8 s a lap quicker
(at full grip 29.27 / 29.29). The gen. superspeedway is flat out (low quicker by its distance, as designed).

## Latency-led labels (not bundled)

`RecorderOptions.lead` (src/school/recorder.ts; `scripts/racingLabels.ts --lead 1`): each moment labelled with what
the teacher says when the student's command lands, its latency later. Two continuations of the race-labelling stage
from v8s, 3 rounds on new ovals (`--seed 2`), the same but for `--lead` (`v8sc-v8sl.json`; `probes.txt` 5):

| v8s / + 3 rounds / + 3 rounds, lead | out | green car damage | lap (s) |
|---|---|---|---|
| short | 2.0 / 3.0 / 1.3 | 3.64 / 3.97 / 3.69 | 23.45 / 23.50 / 23.40 |
| speedway | 8.5 / 12.0 / 12.0 | 5.44 / 1.45 / 2.93 | 33.09 / 33.41 / 33.36 |
| flat | 3.0 / 6.8 / 5.5 | 2.36 / 2.12 / 0.63 | 36.43 / 36.52 / 36.43 |
| gen. short | 0.8 / 0.3 / 0.5 | 0.33 / 0.46 / 0.10 | 22.16 / 22.25 / 22.11 * |
| gen. intermediate | 9.5 / 4.8 / 6.0 | 3.77 / 2.39 / 4.70 | 40.69 / 41.03 / 41.06 |
| gen. speedway | 17.5 / 19.5 / 16.8 | 5.65 / 2.30 / 2.98 | 37.64 / 37.42 / 37.32 |
| gen. superspeedway | 11.3 / 20.5 / 14.8 | 1.61 / 1.68 / 1.28 | 44.94 / 46.22 / 44.98 |
| all seven out | 52.6 / 66.9 / 56.9 | | |

(* lead against the control past noise; also worse: speedway green wall damage 0.01 -> 0.26, gen. superspeedway
pit-cycle damage 5.6 -> 11.1.) Neither beats v8s; lead against the control is within noise nearly everywhere. The
labels are harder to fit (stage loss 0.051 against 0.043). The rear-ends are the teacher's own following, which a
student copies however its labels are timed. `--brake-weight` (a braking racing moment drawn w times as often) is in
the stage, untried.

## Next (teachers: every student's labels change with them)

- Following into a corner: room for the car ahead slowing to the corner's speed ahead, not only for its braking from
  the speed it has; then the racing networks retrained through the stage.
- Passing on two lines: a faster car held up with the other line open goes by on that line, judged on progress round
  the track.
- Balancing the two lines at the drivers' grip (the preset speedway's banking).

## Commands

```sh
export DOTGP_EXPERIMENT='?spec=cup&lines=2'
T=short,speedway,flat,oval:894715320:short,oval:3850048323:intermediate,oval:3148308672:speedway,oval:774865359:superspeedway
B=public/drivers/stable-candidate-v8s-lines.json
TEACHER_HANDS=1 npx tsx scripts/bench.ts teacher:$B $B --tracks $T --seeds 4 --field 40 --rules 1 --jobs 6 --json handed-teachers-v8s.json
# probes (each on short and speedway; TEACHER_HANDS=1 with teacher:$B for the handed teachers)
npx tsx --import ./scripts/greenContacts.ts scripts/incidents.ts $B --tracks short --seeds 2 --field 40 --rules 1
npx tsx --import ./scripts/greenLabels.ts scripts/incidents.ts $B --tracks short --seeds 2 --field 40 --rules 1
npx tsx --import ./scripts/rearEnds.ts scripts/incidents.ts $B --tracks short --seeds 2 --field 40 --rules 1
# the two continuations, then their bench
C="--in $B --rounds 3 --races 8 --km 80 --sample 0.05 --keep 3 --field-share 0.5 --epochs 4 --moments 60000 --debris 0.03 --wrecks 0.5 --seed 2 --jobs 5"
npx tsx scripts/racingLabels.ts $C --out v8s-c.json
npx tsx scripts/racingLabels.ts $C --lead 1 --out v8s-l.json
npx tsx scripts/bench.ts v8s-c.json v8s-l.json --tracks $T --seeds 4 --field 40 --rules 1 --jobs 11 --json v8sc-v8sl.json
```
