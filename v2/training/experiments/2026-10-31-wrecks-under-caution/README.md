# Wrecks under caution (2026-10-31)

Circuit machine. Classic car (no `DOTGP_EXPERIMENT`), 40 cars, `--rules 1`, seeds 1-2 (circuits under the circuit
rulebook: 1-3). Bundle: `stable-candidate-v5p`.

Goal (the user's): under caution the field runs into wrecked cars while pacing, not in the big accident but lap after
lap. Make the field aware of wrecks and avoid them; a red flag if the track is blocked; ghosting wrecks only if training
the field to avoid them doesn't work.

## Where the contact was

`scripts/cautionWrecks.ts` (a preload for `incidents.ts`) puts each damaging hit while the field is pacing by what was
hit. v5p, two races a track (`wreck-probes.txt`, run 1):

| | hits into wrecks | cars they put out | all retirements | a wreck on the racing surface | under 3 car widths free |
|---|---|---|---|---|---|
| speedway | 131 | 36 | 54 | 64% of caution time | 13% |
| short | 34 | 4 | 26 | 15% | 2% |

Nearly every speedway retirement under caution was a pacing car into a wreck. On the short oval it was bumping in line.

Why: the caution skill learns from debris cautions (nothing on track) and from teachers who almost never wreck. The
scripted formation went round wrecks (race control's `wreckAhead`), but a driver's caution inputs showed its place's
lane straight through them.

## What changed

- **Race control's way by a wreck** (`raceControl.ts` `aroundWreck`, `wreckSpeed`): through the gap beside it nearest
  the car (between the track's edges, an oval's apron included, and each wreck), 2 m clear where there's room, as much
  of the way as the wreck is near (60-200 m); through a gap with under 2 m either side no faster than 8 m/s + 3 m/s per
  metre. The formation script, the smooth formation (teachers), the pace car and a driver's caution inputs (its place's
  lane and speed) all use it. Going round a line of wrecks as one span, the formation script went round its end into the
  wall.
- **The red flag**: stopped wrecks leaving under a car's width and half a metre either side for 2 s under caution. The
  pace car and every car stop 40 m short, the formation script drives everyone (a procedure, not a skill), nobody is
  counted stuck, and 2 s after the track is passable the field rolls again under caution for a lap at least
  (`test/raceControl.test.ts` "red flag"). Tape and viewer know the flag.
- **The track clear for a restart**: a tow on the outside of the track counts as clear once off it, as one inside did;
  a wreck waiting for a truck 5 m past the edge (or an oval's apron) doesn't hold the restart.
- **Wreck drills** (`src/school/wreckDrill.ts`): once the field is in line, one or two pack cars are wrecked across the
  track somewhere clear of traffic. In the caution drill (`CautionDrill`'s `wreck`), the classroom race (`wrecks`: a
  share of debris cautions), the oval apprenticeship (`scripts/stable.ts --wrecks`, `--caution-only 1`: only the caution
  skill trains) and road cautions (`scripts/roadCautions.ts --wrecks`).
- **The bench raced circuits to the oval rulebook** (`incidents.ts --rules 1`): a pace car at the speed of the
  circuit's tightest hairpin all the way round (7.8 m/s on the GP circuit: 12 minutes a caution lap; one race in two
  ended with nobody classified) and a rolling start. It now races road courses to `CIRCUIT_RULES` (safety car at
  formation pace, standing start), as the app's road series does.

## Commands

```
# the probe, per track (runs 1-4; circuits 5-6 add --seeds 3, run in a worktree at 22eb886 for the base)
npx tsx --import ./scripts/cautionWrecks.ts scripts/incidents.ts public/drivers/stable-candidate-v5p.json --tracks speedway --seeds 2 --field 40 --rules 1
# the caution skill retrained with wrecks (v5w: 8 rounds, 28 min on 5 jobs)
npx tsx scripts/stable.ts --from public/drivers/stable-candidate-v5p.json --out v5w.json --rounds 8 --laps 20 --debris 0.2 --wrecks 0.8 --caution-only 1 --group 8 --jobs 5 --seed 11
```

## Results

Speedway / short oval, two races (`wreck-probes.txt`):

| | hits into wrecks | cars they put out | retirements a race |
|---|---|---|---|
| v5p, before | 131 / 34 | 36 / 4 | 27.0 / 13.0 |
| v5p, the lane round the wreck | 98 / 33 | 22 / 3 | 23.5 / 17.0 |
| v5p, everything (red flag etc.) | 99 / 41 | 24 / 8 | 21.5 / 15.5 |
| v5w (caution skill retrained) | 94 / 25 | 25 / 1 | 26.5 / 15.0 |

No red flag in any of these races (at a car's width and half a metre, with the apron, nothing was that blocked); two on
the club circuit, 49 s in all.

Circuits under the circuit rulebook, three races (base at 22eb886 / this commit's code): club 28.7 / 30.3 retirements a
race, GP 19.7 / 17.7: within noise. Raced as the app races them the GP finishes 20 of 40 with 3 short safety cars, where
the bench had 0-14 of 40 classified behind its pace car.

Why the trained field still hits them (`_hittrace` in the lab, v5w on the speedway): at the hit, the input mostly asked
for the right lane. Cars sat 2-5 m from the lane they were shown (one 4.8 m off a lane clear of the wreck, clipping its
edge); cars a few hundred metres to 1.7 km behind their place caught up at 45 m/s and never moved over in the 200 m the
lane bends round; in a 13-car pileup the only gap was on the apron, 13 m across. The caution skill follows its place's
lane and speed loosely, and eight rounds of copying a teacher that goes round wrecks didn't tighten it (copying loss
climbs as students drive: 0.007 -> 0.05).

## Open

- Ghosting wrecks for cars that are pacing (the user's fallback), or practice by outcome (`stableCautions.ts` ES with
  `CautionDrill` wrecks; not run), or holding catching-up speed near a wreck.
- v5w isn't bundled (no better on the speedway).
- The club circuit: 11 cautions a race under the circuit rulebook; the GP: pit-cycle wall hits are its biggest cause.
