# Training results

One line per experiment, newest last: date, name, commit, discipline, what it asked, what answered it. Lines from the lab are copied from `lab/RESULTS.md` (git-ignored) on the machine that ran them.

## From the lab (2026-10-16)

- 2026-10-16 **00-smoke** @e4d4a08 · lab — smoke test of the lab itself: works.
- 2026-10-16 **01-pits** @e4d4a08 · oval — drivers doing their own stops (pits then pit-traffic lessons, whole network): 2/4 licensed; races far worse (retirements short 11.6→22.4, speedway 10.9→17.4, flat 4.9→18.6); rejected. Lesson: a skill trained on the whole network costs racing.
- 2026-10-16 **02-season-fear** @e4d4a08 · oval — a season of race learning with fear (nerve 0.5): within noise everywhere.
- 2026-10-16 **03-road-courses** @41f0e99 · circuit — right turns taught on the oval network: oval racing ruined (short 13.5→21.8, speedway 9.4→20.0, flat 5.9→20.5). Led to the road skill network.
- 2026-10-16 **04/05-road-skill** @905d2e5, 059daf7 · circuit — road skill by ES through the curriculum, 1500 + 3000 rounds: 0/4 licensed, GP solo still ~96% crashed.
- 2026-10-16 **06-road-apprentice** @b25c084 · circuit — apprenticeship to the line follower then practice: 4/4 licensed; club crashes 100%→79%, GP 96%→58%.
- 2026-10-16 **07-road-test** @19608c1 · circuit — apprenticeship then practice to the license test: 2/4 licensed.

## Ovals: bench v2 and the oval stable (2026-10-21 to 10-23)

All 40 cars, full distance (150 km), 8 seeds a track; retirements per race short / speedway / flat (generated ovals in brackets).

- 2026-10-21 **house baseline** @3021b7c · oval — the 4 house drivers cycled to 40 cars: 29.1 / 24.3 / 22.3 (32-37); 47-71% of car-time driven by scripts; twins: copies follow each other ~3x closer at the same spot than different drivers.
- 2026-10-21 **traffic racer teacher** @7494280 · oval — one style, own cautions: 0 / 9.4 / 0 (0-0.6); laps 4-20% faster than the house drivers; 2-8 passes per 100 green car-laps.
- 2026-10-21 **styled teachers** @f4ec826 · oval — 40 individuals (racerStyle): 0 / 5.3 / 1.6 (0-3.5); passes 6.5 / 18.8 / 22.0.
- 2026-10-21 **stable v1-v2** @f4ec826 · oval — apprenticeship in 40-car classroom races: v1 couldn't lap solo (3% of moments alone); v2 with solo drives laps within 1-2% of teachers; cautions wreck.
- 2026-10-22 **stable v3-v6** @d45fd0c · oval — caution skill network, race control's calls as inputs, smooth teacher throttle, noise injection: caution throttle 20x easier to copy from the teacher's own driving, but student-driven caution moments stay hard (threshold teacher); races still wrecked under caution.
- 2026-10-22 **caution practice ES** @d45fd0c · oval — 60 rounds on v6: clean drills 0-27% throughout, no trend.
- 2026-10-22 **cross-discipline** @9934fbc · both — re-anchored teacher labels (both), oval track knowledge, smooth throttle oval-only (circuit teacher copyability 81%→67% with it, 77-79% without), smooth formation, banking fix.
- 2026-10-22 **stable v8** @9934fbc · oval — 31.8 / 30.6 / 20.3 (32-38); laps 26.86 / 37.94 / 44.01 s (house 30.13 / 42.49 / 49.82); scripted share now pit maneuver only.
- 2026-10-22 **caution practice PPO** @08675aa · oval — 120 iterations on v8: clean ~40%, flat. Diagnosis: most caution damage was walls at the caution's start.
- 2026-10-22 **stable v9** @08675aa · oval — caution network keeps racing: caution-drill damage -45%; 28.9 / 29.9 / 8.9 (31-37).
- 2026-10-23 **stable v10** @077df17 · oval — pit calls: 27.3 / 29.5 / 13.4 (30-37); pit-related retirements on the speedway down somewhat.
- 2026-10-23 **01-oval-race-practice** @c662970 · oval · lab — v10 after 120 races of PPO race practice anchored to teachers: v10 vs practised within noise everywhere (flat laps 0.25 s quicker). Against the house drivers: laps 3-8 s quicker everywhere, but head to head 2.8-4.4 places worse on 4 of 6 tracks (more cars out); better on the flat (4.2 places). Promotion refused.

## Circuits (from commits, 2026-10-18 to 10-23)

Races are 20 cars, about 25 km, 6 circuits x 3 seeds (`scripts/circuits.ts`); solo is `scripts/solo.ts` on 30 tracks of each kind; "old pipeline" is the line-follower apprentice + PPO + ES racecraft.

- 2026-10-18 **brake bug** @d3bb2e3 · both — brakes pushed a car backwards at a crawl; every no-teacher "stall" was this. PPO learners stopping on training wheels 50-100% → 0-6%.
- 2026-10-18 **PPO from scratch** @dc12a22 · circuit — from a blank driver, 500 iterations: curriculum reached 43-58 m corners (ES no-teacher 58 m in 1500 rounds); no clean laps without training wheels.
- 2026-10-18 **PPO practice after apprenticeship** @8bf58fe · circuit — 12 drivers, 300 PPO iterations vs 300 ES rounds from the same apprentices: club 4.21 vs 3.97 km in 120 s, crashed 4% vs 11%, laps 99.0% vs 99.7% of the line follower's. PPO racecraft (pack drills) made races worse (contact); chicane-focused PPO didn't fix running wide.
- 2026-10-18 **fastest line** @d5bbc4d · circuit — `racingLine.ts`: a scripted racer on the computed fastest line laps at 81-84% of the line follower's time, valid on 8/8 benchmark circuits. Practised drivers then: 98%.
- 2026-10-19 **knocks** @b3d0818 · circuit — racing-line students parked in hairpins (they braked by position, never having seen a slow approach). Speed knocks in the apprenticeship: club stops 15% → 3%, 4.41 km (old 4.21).
- 2026-10-19 **traffic teacher + wear** @34863b5, 0ae73b2 · circuit — vs the old pipeline in races: best valid lap 25.69 vs 27.85 s/km, damage done 0.54 vs 1.38, finishers equal; valid laps 64% vs 87% (running wide).
- 2026-10-19 **capacity** @b75b1d9 · circuit — teacher's answers explained by student inputs: 32x24 to 256x128 all ~58%; + its line and the line's speed ahead 86%; + road edges ahead no help.
- 2026-10-20 **track knowledge** @b75b1d9 · circuit — vs the old pipeline: best valid lap 23.99 vs 27.85 s/km, damage done 0.17 vs 1.38, 0 retirements (0.5), valid laps 95% (87%), 20/20 finish. Students valid on 75-100% of runs straight from the apprenticeship (was ~25%). Field uniform (84-87% of follower lap).
- 2026-10-20 **own lines** @b2a885f · circuit — each driver knows its style's line: styles survive practice and racecraft (laps spread 4.6%, ordered by grip share); races 24.21 s/km, damage 0.25, valid 96%. Before this, practice washed styles out.
- 2026-10-22 **racecraft's worth** @c40082a · circuit — the same students before vs after ES racecraft: corner cuts 32.8 → 4.8, valid laps 75% → 96%, damage done 0.57 → 0.25, best lap 1.7% slower.
- 2026-10-22 **teachers vs students** @c40082a · circuit — the styled circuit field against its own teachers, 6 circuits x 3 seeds: retirements and finishers within noise; teachers 1.7% faster, a little less damage; students cleaner on track limits (valid laps 96% vs 93%).
- 2026-10-23 **human limits on circuits** @97b275f · circuit — limits (0.1-0.2 s, 2-8% noise) reach every circuit lesson and benchmark. The styled field given limits untrained: 3.3 retirements, 17.0 finishers, 1.4 safety cars. Trained through them: 0.5, 19.6, 0.2; against no limits: track limits 7.8 → 25.7, valid laps 96% → 86%, damage done 0.25 → 0.68, best lap 1.1% slower. Chargers (tight line, high grip) make the most mistakes.
- 2026-10-23 **scripted share** @ca4f1c5 · circuit — the human-limits circuit field: formation 9.4% of car-time, pit maneuver 0.14%.
- 2026-10-23 **road cautions, pit skill** @8561497 · both — skill networks for road cautions and pit stops; pit smoke test 0-6 of 32 stops completed (needs rounds and practice).
- 2026-10-23 **pit skill, more data** @172869d · both — 4 drivers, 12 rounds of 4 ovals + 4 circuits, drills run to the merge: 42/48 stops done on held-out ovals and 42/48 on held-out circuits. The 90 s drill had been cutting superspeedway stops off mid-merge (blend lane most of a lap after the box).
