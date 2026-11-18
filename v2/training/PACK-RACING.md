# Pack racing under green: the plan

Agreed with the user on 2026-11-04. This is a living plan: each step adds a RESULTS line and an experiment folder, and
this file says where the work stands. Read it before changing the draft, the teachers' following and passing, or the
racing network's inputs.

## The goal

Believable pack racing. Drivers should:
- use the draft to build a run into and out of the corners, then pull out of it late to make the pass;
- choose a line by how fast it's moving in traffic, not by how fast it is on an empty track (the fast line is often
  slower when it's stacked up);
- read the cars around them and make decisions that leave their learned line when the race calls for it.

Solo clean lapping is already good. Pack racing isn't. "Clean" stays a requirement: it must not mean a procession, and
passing must not cost the safety the caution and pit work bought (memory: speed with realistic crashes).

## What the probes show (2026-11-01, experiments/2026-11-01-green-rear-ends)

`scripts/passKinds.ts` and `scripts/rearEnds.ts` on two-line ovals (`?spec=cup&lines=2`, 40 cars):

- **No slingshot, teachers included.** 63-77% of green passes are cars already a lane apart, passing on lane speed.
  Drivers pull out from about 15 m back with no closing speed, so only 6-11% of pull-outs become a pass.
- **Following kills the run.** The teacher follows at its reaction gap at the leader's speed, so the tow never turns
  into closing speed, and its run-building branch (`building`) never fires.
- **Nobody passes on the other line.** Following a car it's closing on, the short oval's drivers plan to go by 3-22% of
  the time; the other line was open 72% of the time when they ran into the car ahead.

## Why: four layers, each a ceiling on the next

**1. Physics gives few reasons to change lines.** The draft is strong enough to make a run: solo top speed is about
85 m/s, and 15 m behind a car the drag is 22% lower, about 0.7 m/s^2 more at 80 m/s (2 m/s of closing in 3 s). But two
real mechanisms behind pack racing are missing (`computeDraft`, src/sim/collisions.ts):
- **The draft doesn't stack in a line.** A car in the middle takes the larger of its draft and its push, not both, so
  ten cars nose to tail run no faster than two. In real racing a long line outruns a short one. That is what makes "the
  fast line in traffic" differ from the fast line on an empty track.
- **No dirty air.** Following closely through a corner costs nothing. In real racing, the front grip a car loses in the
  wake of the one ahead is why followers move to the other line.

**2. Teachers don't race a pack.** `TrafficRacer` (src/ai/trafficRacer.ts) goes for a pass only when its own pace
without a draft beats the leader's speed by its passing edge (0.7-1.8 m/s). It never compares the lines by the ground
each gains over the next seconds. Students copy their teachers, so this is their ceiling.

**3. Students can't see the pack or remember.** The racing network is about 90 inputs, 32, 24, 2: feedforward, with no
memory but its last command. It sees the nearest car in its lane, the next car ahead, one car behind, the cars
alongside, three mirror readings and the draft strength (`RADIO`, src/ai/spotter.ts). It can't see how fast the other
line is moving or how full it is, and can't tell that a run is building (a trend). The tactics network can't learn which
side its teacher passes on for the same reason: the teacher decides from memory the student never sees
(2026-10-31, `scripts/tacticsFit.ts`).

**4. Copying caps the drivers at the script.** Building a run, or switching lines to gain later, pays off seconds after
the decision, which is what copying learns worst. The last practice by outcome (`src/school/racePpo.ts`, 2026-10-23)
came out within noise of copying, but its reward was progress at the track's pace, not position against the cars
around, and it was anchored to the same teacher. Nothing rewarded passing.

## The plan, in order

Each step is measured with the scorecard (step 1) against the step before it, on teachers before students where it
can be. Physics and teacher changes alter every machine's training, so each lands with a RESULTS line saying so.

1. **A pack-racing scorecard** (`scripts/packCard.ts`). Per race: runs built in the tow before a pull-out, and how many
   pull-outs become passes; time held up while the other line was moving faster; position changes per lap; time side
   by side; against green contact. It builds on `passKinds.ts` and `rearEnds.ts`. Baseline: the teachers and the latest
   candidate.
2. **Physics: a draft that stacks in a line, and dirty air in corners.** Calibrated to real numbers, checked with
   teachers only (no training), on the scorecard and the bench. Gives drivers real reasons to build runs and choose
   lines.
3. **The crew's view of the lanes.** A spotter's call of how fast each lane's traffic ahead is moving and how full it is
   ("the top's rolling, the bottom's stacked up"), as real spotters give it. Teachers choose lines by it; students get
   it as inputs.
4. **Teachers that build runs and race the pack.** Sit back where the tow is still strong, let closing speed build, pull
   out late; choose the line by ground gained over the next seconds, using the lane call. Every student's labels change.
5. **Students that can see and remember.** The lane call, a few seconds of closing and draft history, a wider network.
6. **Practice by outcome with a competitive reward.** Self-play races with the 40 individuals (no hive mind), scored on
   ground gained against the cars around, with damage and penalties as costs and a weaker anchor to the teacher. Only
   once steps 2-5 give the drivers something to find and the means to see it.

### 2026-11-16: back to the goal, a field aware of each other

Two detours, set aside: tuning the follow cap further, and a lane choice from each driver's remembered estimate of the
car ahead's pace over the last corners. A driver judges the closing speed of the car in front, and whether the other
lane is moving, in a fraction of a second, from what it sees now; nobody tracks a car round a lap to decide. (A slower
line on purpose is out too: lines that lap alike are the best case for passing.) What's kept: `?follow=3` (close
following is safe, short-oval contact under the baseline), and the probes (`laneGamble.ts`: held up with a lane open,
teachers go as often whatever the car ahead's pace; 60-80% of those moments are behind a car at the field's pace).

Pack racing needs three things, and each is a ceiling on the next:
1. **A reason**: a lane or line faster now than the one a car is in. With equal cars and lines that lap alike, there
   mostly isn't one: the field runs at one pace. In real packs the difference is the air: a line outruns a single
   car, a pushed car gains, a car that pulls out alone is hung out. That's `?draft=2&wake=1` (step 2), within noise
   before only because teachers never raced close enough to feel it; with `?follow=3` they do.
2. **Seeing it**: students' radio shows one car ahead in their lane, the next ahead in any lane, one behind, the cars
   alongside and the draft, not whether the other lane is moving. Step 3's lane view (each lane's closing speed to its
   nearest car ahead, how many cars in that line, from what's there now) is what lets them be aware of it.
3. **Acting on it**: teachers choose the lane by that view (closing now in mine against the other, nerve setting the
   gamble), not a fixed speed margin, and students learn it; then competitive practice (step 6).

So, in order: the scorecard with the air on and close following (`?follow=3&draft=2&wake=1` against `?follow=3`),
then the lane view, then teachers choosing by it.

A later option for teaching decisions: a teacher that tries each choice (hold, go low, go high) by simulating a few
seconds ahead and labels the best. It needs a way to copy a race mid-way, which the sim doesn't have.

## Where it stands

- 2026-11-04: plan agreed. Steps 1 and 2 done (experiments/2026-11-04-pack-scorecard): the scorecard confirms no runs
  and lanes left open (teachers and students alike); the second air model (`?draft=2`, `?wake=1`) is in, off by
  default: today's teachers never race close enough to feel it. Next: steps 3 and 4 together (the lane call and
  teachers that build runs), tested with the new air on and off.
- 2026-11-04: step 4 begun, behind `?follow=2` (off by default; experiments/2026-11-04-follow-cap). Why nobody builds a
  run was the teachers' follow cap: a stopping distance from the follower's own speed, as if the car ahead weren't
  moving, which lifted every run away from 50 m out whatever the driver's nerve. Now the gap between two moving cars
  (checking up behind a lift, as the nerve insures), and a pull-out at the last moment the run can still get beside.
  Passing comes alive (pull-outs pass 1.3-3x as often, 12-42% more position changes) but damaging contact doubles, and
  still no run is built in the tow: nothing makes a teacher hang back to take one. Next: where the new contact is (a cap
  that sees the corner the car ahead will brake for), then a teacher that hangs back and takes a run, then the lane
  call. The superspeedway is not yet measured with it.
- 2026-11-05: `?follow=2` now sees the corner the car ahead will slow for, sizes its gap by it, and opens a gap that
  grew. Contact down from the first version (teachers 1.2-2.6 damaging contacts a 100 car-laps, baseline 0.3-1.8),
  position changes still 13-130% up. Left: on short ovals followers go into corners 2-4 m back and react to the car
  ahead's braking instead of anticipating it (in the baseline too). Next: an anticipating cap (the car ahead's speeds
  along its line at each distance ahead), then the hang-back run and the lane call.
- 2026-11-05: the anticipating cap, `?follow=3` (`?follow=2` plus braking with the car ahead for the corner it comes
  to). Corner-entry rear-ends nearly gone (short oval 35 -> 1); damaging contacts a 100 car-laps 1.2/1.3/1.3/0.8 (short
  under the baseline's 1.8). Position changes still up on the bigger ovals (0.290/0.203/0.252), but the short oval's
  fell to 0.130, under the baseline's 0.152: to look into. Then the hang-back run and the lane call.
  Over 4 races: short oval position changes 0.158 baseline / 0.168 `?follow=2` / 0.145 `?follow=3`, clean passes
  9.8/10.5/9.7, damaging contacts 1.9/2.5/1.3. What it gave up is mid-corner, where followers no longer sit on the
  bumper. Short-oval passing was thin before (runs pass 7-11%): next, the hang-back run. Also seen: pass attempts
  flicker on and off (some 10,000 mid-corner starts in 4 races, 1% passing, the baseline too).
- 2026-11-05: the lane choice as a judgement (the plan above). First, what today's teachers do
  (experiments/2026-11-05-lane-gamble, `scripts/laneGamble.ts`): held up with a lane open, how often they go doesn't
  depend on how slow the car ahead is (short 39-45% whatever its pace; gen. superspeedway 10%, 17% only for cars 3+
  m/s off). Most chances are behind a car at the field's pace. Going gains more places on the big ovals (0.50 vs 0.27
  in 15 s on the superspeedway), nothing on the short oval. Next: the driver's estimate of the car ahead's pace, each
  lane's for its own car, and the choice by expected time.
- 2026-11-16: back to the goal (the section above). The second air model with close following
  (`?follow=3&draft=2&wake=1`): within noise again (position changes 0.145/0.300/0.208/0.235 -> 0.166/0.285/0.206/0.253).
  Held up, the lane beside is empty 78-95% of the time: the field runs single file, and under the new air a car pulling
  out alone is slower than the line it leaves. A second line needs a car to go with the one pulling out, and seeing
  it: the lane view, and a teacher that goes with a car pulling out beside it. experiments/2026-11-16-air-close.
- 2026-11-17: the lane view (step 3), `laneView` in spotter.ts: the lanes beside (nearest car ahead and its closing,
  the line's length, the car behind there) and the car ahead moving out of its groove, all from now. Teachers and
  probes only for now. What it sees: held up, the lane beside is empty 89-98% of the time with almost never a car
  behind in it; when the car ahead pulls out a lane, its follower goes with it 23-50% of the time (23% superspeedway);
  most moves out of the groove are feints that never reach the next lane (pass attempts flickering). Next: teachers
  that go with a car pulling out (or not, by nerve), and the flicker. experiments/2026-11-17-lane-view.
- 2026-11-18: the flicker (experiments/2026-11-18-pass-commit, `scripts/passEnd.ts`). Most pass attempts didn't end,
  they switched cars: going round car A, car B in the lane it was moving into got in its path and was "passed" back the
  other way, then A again (speedway: 94% of attempts, median 0.2 s). `?commit=1` (off by default): a car in the lane
  it's moving into is followed there, not passed back, and it looks along that lane, not just its own line; the pass
  carries on while it's gaining. Speedway attempts 148,899 -> 47,636, median 0.2 -> 0.9 s, passes a 100 car-laps 31 ->
  40, damage about level (bigger ovals more passing, three of four tracks less damage). Held up, the lane beside is
  still empty 84-97%: the flicker wasn't why the field runs single file. Next: teachers that go with a car pulling out.
