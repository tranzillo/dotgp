# Training playbook

What we've learned training drivers, from both funnels, with the evidence. Newest understanding wins: when something here turns out wrong, correct it and say why.

## Principles (both disciplines)

1. **Copy first, then practise.** Learning from nothing never produced a driver.
   - Circuits: ES and PPO from scratch never made a clean lap (a2f2628, 3596487, dc12a22).
   - Ovals: rookie school worked only with soft walls and a long curriculum.
   - Apprenticeships (DAgger: the teacher drives, then labels the student's own driving) are the start of every skill.
   - After copying, PPO beat ES for solo driving on circuits (8bf58fe). ES needs small steps (0.002; 0.02 made drivers worse).
2. **The teacher must be copyable, not only good.** Three ways a good teacher fails as a teacher, all found on ovals:
   - **On/off control.** The line followers drove flat out below their target speed. A network learns the average of on and off: it coasts where the teacher braked. Proportional drive (`driveGain`) made caution throttle about 20x easier to copy (9934fbc). The pit maneuver had the same flaw (8561497: watching-round loss 0.027 → 0.0047).
     - Caveat: on circuits the smooth racing throttle made the teacher *harder* to copy on unseen circuits (81% → 67% of its answers explained). A proportional racer trails the line's speed out of slow corners by an amount the student can't see. So it's an oval style setting, off for road teachers.
   - **Threshold rules.** The formation script decides by in/out bands: near your place or not, in a file or not. A smooth network averages across a jump, and a car slightly out of place is always near one. `src/ai/smoothFormation.ts` keeps the intent with bands. Student-driven caution throttle went from 71-73% explained to 78%.
   - **Demonstrations only near the teacher's own states.** A teacher that is always at the right speed never shows what to do when far below it. Racing-line students learned to brake by position alone and parked in hairpins after a slow approach. Speed knocks in the apprenticeship (the car's speed cut to a random share while the student drives) cut club stops 15% → 3% (b3d0818). The oval noise-injection rounds (`--shake`) attack the same gap.
   - **Hidden teacher state.** The traffic racer's planned offset followed its own plan while a student drove, so its labels answered for a car that wasn't there. `takeOver()` re-anchors it before every label, in both disciplines. Steering on student-driven moments went from 74% to 82% explained.
3. **Perception beats capacity.** Bigger networks never fit better: 32x24 to 256x128 on circuits; 32x24 to 128x96 on ovals. What the driver can see does matter:
   - Track knowledge (its line and the line's speed ahead): circuits 58% → 86% explained (b75b1d9), ovals 64% → 71%.
   - Race control's caution calls, and the spotter's calls about other cars' pit stops: small gains.
   - Seeing the 6 nearest cars ahead instead of the radio's 5 changed nothing (c662970).
   - Rule: when the teacher acts on something, the student needs a way to perceive it.
   - **Style survives only if it's perceived.** With every circuit driver knowing the same line, practice washed styles out (laps within 84-87%). When each knows its own style's line, styles survive practice and racecraft: laps spread 4.6%, ordered by grip share (b2a885f).
4. **A skill trained only on its own situation forgets everything else.**
   - Every drill lesson that trained the whole network cost drivers their racing: the Cautions and pit lessons in the lab.
   - Skill networks fix it by construction. Each skill is a network of its own: oval racing, oval cautions, road racing, road cautions, pits.
   - Each skill must still train on racing moments too. The oval caution network takes the wheel mid-corner at racing speed when the flag flies. Trained on caution moments alone, it forgot fast cornering and put cars in the wall (stable v8: most caution damage was the outside wall above 25 m/s; teachers none). Training it on half racing moments cut caution-drill damage 45% (08675aa).
5. **Solo moments are a must.** In a 40-car field a student is alone 3% of the time. It learned to brake for the car ahead, never for the corner, and crashed solo. Solo drives from three lanes on worn tyres each round, half the training set, fixed it (stable v2).
6. **Personality makes the style, and the style makes the teacher.** Nerve, talent and human limits make each driver's teacher: `racerStyle` on ovals, `roadTeacherOf` on circuits. Bold drivers insure only against a lift and run nose to tail; timid ones insure against full braking. Forty teachers, forty different students, no shared ancestry. The twins seen in races were exact copies of four brains (3021b7c).
7. **Human limits are part of the driver.**
   - Reaction latency (0.1-0.2 s) and smooth, signal-dependent motor noise in every race, lesson and benchmark (3021b7c ovals, 97b275f circuits).
   - In DAgger the teacher labels from where the student's limits leave the car.
   - In ES, a student's variations share their noise so it doesn't pick the winner.
   - Switching limits off didn't make oval students safer (18-32 out still), so they aren't the oval gap.
   - **Train through them.** The circuit field given limits it never trained with: 3.3 retirements a race, 1.4 safety cars, 17 of 20 finishing. Trained through them: 0.5, 0.2, 19.6. Against no limits, the trained field has believable mistakes (track-limit offences 7.8 → 25.7) and keeps its pace (−1.1%) (97b275f).
8. **Measure what you want, in full races.**
   - Short races hid how oval wrecks pile up over 150 km (30-lap tests looked fine).
   - The bench reports retirements, lap time, passes, time alongside and drafting, the share driven by scripts, and twins (same-spot lane and speed against the car ahead).
   - Head to head in mixed fields (`--h2h`) catches what separate fields don't. The oval stable laps 10-20% faster than the house drivers but finishes 3-4 places worse, because it crashes more.
9. **Every training score in seconds** (b1b2807): progress at the track's pace, damage taken and done by fault at 120 s a unit, fear (seconds of an imminent hit) and trauma scaled by nerve. Scores from different tracks and situations are then comparable.
10. **Check the physics and the measuring stick before concluding.** Three "learning failures" were measurement or physics:
    - Every no-teacher circuit learner "learned to stop": brakes pushed a crawling car backwards (d3bb2e3).
    - Solo crash rates counted cars stuck in the gravel as crashes (1b76a5b).
    - Pit drills cut superspeedway stops off mid-merge (172869d).

    Trace a few cases before believing a number.
11. **No scripts in races, eventually.** Scripts are teachers in class, never drivers in races. The bench measures their share. Ovals: the formation script is gone from the stable's races, and the pit maneuver remains. Circuits: formation 9.4%, pit maneuver 0.14% (ca4f1c5).

## Ovals: where it stands (2026-10-23)

- **The oval teacher** (traffic racer with `racerStyle`):
  - draft-aware following (`insure`)
  - "car outside" checks
  - its own cautions through the smooth formation
  - banked speeds beside its line, fixed in 9934fbc: it had crawled beside its line on banking
  - A field of 40 styled teachers: 0-5 cars out in 150 km, at 6-28 passes per 100 green car-laps.
- **The stable** (`scripts/stable.ts`): 40 individuals apprenticed to their own teachers.
  - Solo laps at teacher pace.
  - Green laps 10-20% faster than the house drivers.
  - No formation script.
  - **But about 30 of 40 cars out per 150 km race** on most tracks (13 on the flat track), against about 1 for their teachers. Mostly rear-ending in caution lines, at restarts, and contact in the draft.
- **Practice tried:**
  - ES caution drills: flat.
  - PPO caution drills: flat. They were aimed at the wrong damage before the wall fix.
  - PPO race practice anchored to the teacher (`scripts/stableRaces.ts`): small gains while practising (3.8 → 3.3 of 8 out per 15-lap race), none measurable after (lab 01-oval-race-practice).

## Circuits: where it stands (2026-10-23)

- **The teacher:** a traffic racer on the circuit's computed fastest line (`racingLine.ts`), at the driver's style (grip share, margin, room), following and leaving room, never passing (scripted passing cost more than it gained). Its throttle is flat out below target: smooth throttle made it harder to copy on circuits.
- **The pipeline** (`class.ts --teacher traffic:G --knocks 2 --apprentice-rounds 24 --apprentice-epochs 8 --packs 2 --wear [--styles] [--limits]`, then `ppo.ts` 300 iterations `--wear`, then `class.ts --lesson roadcraft` 150 rounds):
  - Apprenticeship with speed knocks, pack drills and worn tyres, each student knowing its own line, through its human limits.
  - PPO practice (300 iterations; longer drifts riskier).
  - ES racecraft (cuts corner-cutting in traffic: valid laps 75% → 96%, at 1.7% of pace).
- **Results:** against the line-follower pipeline, best lap 13% faster, damage done −80% or more, 96% valid laps (b2a885f). Styled students race within noise of their own teachers, 1.7% slower and cleaner on track limits (c40082a).
- **Not working:** PPO racecraft (worse in traffic); learning from scratch (curricula stall at 43-58 m corners); chicanes beyond what the line already gives.
- **Under way:** the oval stable's 40 individuals learning road courses under their own personalities (`class.ts` derives a stable driver's road style from its nerve and talent); road cautions and a pit skill (8561497, 172869d).

## Open questions across funnels

- **Why do circuit students copy their teachers nearly whole and oval students not?** Candidate differences:
  - ES racecraft after PPO on circuits
  - shorter races (25 km against 150 km)
  - smaller fields
  - safety cars against pace-car cautions
  - students practising among other students on ovals
- **Copy fidelity in student-driven moments** is about 83-92% under green and 77-85% under caution on ovals. What does it reach on circuits, and what limits it?
- **Race practice on ovals** moved the practice races but not the benchmark. Is it the frozen field around the students, too few iterations, or a reward that can't see what full races punish?
