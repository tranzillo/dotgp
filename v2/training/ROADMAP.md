# Roadmap: one driver, every discipline, rated from real results

Agreed in outline with the user on 2026-10-23. The aim: each driver agent is one individual across ovals, circuits and everything to come. Its personality shapes its style in every discipline. Its skills are trained by one workflow and every step is recorded. Its strengths and weaknesses (by track type, conditions, later car class) are visible as ratings drawn from the real events it raced, so the user sees what its personality and training actually produce.

## Today (what exists)

- **Race records** (`src/records/activity.ts`):
  - Kept: track name, finishing position, laps, best and average lap, stops, wall hits, points, penalties (as text).
  - Missing: series, layout kind, venue, contacts, damage done by fault, passes, behaviour under caution, structured penalties.
  - `brain` is one round count for the whole driver.
- **Measured but never surfaced:** the car tracks damage done by fault (`harmDone`), self-inflicted damage and trauma. The bench computes passes, time alongside, drafting, twins and scripted share.
- **Progress:** licence booleans and a round count per network. **No ratings anywhere.**
- **Personality is split:**
  - `nerve` and `limits` are on the game's `DriverAgent`.
  - `talent` exists only in the training stable (`StableDriver`).
  - Personality to style: `racerStyle` (ovals) and `roadTeacherOf` (circuits).
- **Skills are scattered fields:**
  - weights (oval racing)
  - `caution`
  - `roadCourse` (with its own `caution` and `style`)
  - `pit`
  - `cautionLicensed`, `pitLicensed`, …

## The model

1. **Personality.** Innate, fixed for a career, inherited with variation. Only traits with a mechanical meaning:
   - **Nerve:** what risk it insures against, room left alongside, eagerness to pass, what fear costs it.
   - **Talent:** the share of grip it can use.
   - **Human limits:** reaction latency, motor noise.
   - **Line preference:** its margin to the limits.
2. **Style.** Derived per discipline: `styleOf(personality, discipline)`. One place turns personality into each discipline's teacher, merging `racerStyle` and `roadTeacherOf`.
3. **Skills.** A registry, one entry per network:
   - The skills: `oval.racing`, `oval.cautions`, `road.racing`, `road.cautions`, `pits`, and later rally, dirt, wet.
   - Each entry holds: weights, version (training steps), licence, and its training history (lessons, rounds, copy fidelity and drill metrics as it learned).
   - Today's scattered fields migrate into it.
   - Both funnels write one bundle format, so a driver trained on ovals on one machine and circuits on another is one driver.
4. **Evidence.** One measurement module, used by game sessions and benchmarks alike, per entrant per event:
   - **Context:** discipline, layout kind, series, field size, and later conditions and car class.
   - **Behaviour:**
     - pace against the field, lap consistency
     - passes made and lost
     - contacts and damage done by fault
     - track limits and valid laps
     - place kept under caution, restart gains or losses
     - pit time lost and pit offences
     - tyre wear, scripted share
     - structured penalties (offence, ruling)
   - **Skill versions** that drove the event, so a rating change traces to the training behind it.
5. **Ratings.** From real events only (races, qualifying); training shows as *progress*, never as ratings.
   - Dimensions: pace, consistency, racecraft, safety, cautions and restarts, pit work, tyre management, adaptability (first time on a layout against later).
   - Each rated by context (discipline, layout kind).
   - Each starts at the field average and moves with evidence, with a confidence shown.
   - Comparisons are made within the same race, so the track's own noise cancels.
6. **Presentation.** The agent page:
   - personality → style → skills (training curves, licences) → ratings by context
   - automatic strengths and weaknesses (e.g. "fast on short ovals, at fault at caution restarts; untested on GP circuits")
   - rating changes linked to the races and replays behind them

## Phases

1. **Measurement.** The per-entrant behaviour module shared by sessions and benchmarks; context tags and structured penalties on race records. Useful at once: better benchmarks in both funnels, and the evidence everything else needs.
2. **Identity.** `personality` and `skills` on `DriverAgent`, migration, one bundle format, `styleOf`.
3. **Ratings and the agent page.** The rating engine with confidence; strengths and weaknesses.
4. **One career pipeline.** A lab spec that takes a driver from rookie through every skill's apprenticeship and practice, recorded the same way for every driver.

## Open decisions (for the user)

1. **Traits:** nerve, talent, limits and line preference, adding others only with a mechanism behind them? Or other personality traits in mind?
2. **What counts toward ratings:** real events only, with training shown separately as progress?
3. **Presentation:** 0-100 per dimension with confidence bands, letter grades, or a sports-game card?
4. **Sharing:** this folder as the record for both machines (decided 2026-10-23: yes).
