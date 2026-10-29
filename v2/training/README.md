# Training: what we know, and what we're building

Driver training runs on more than one machine (oval drivers on one, road-circuit drivers on another so far). `lab/` is git-ignored, so the lab's results never left the machine they ran on. This folder is the shared record, committed, so every training funnel reads the others' findings.

| File | What |
|---|---|
| [PLAYBOOK.md](PLAYBOOK.md) | What works and what doesn't when training drivers, with the evidence (numbers, commits). Read it before designing a lesson. |
| [RESULTS.md](RESULTS.md) | One line per experiment, from any machine, newest last, tagged by discipline. |
| [PROCESS.md](PROCESS.md) | How both machines train: one pipeline per skill (teacher, apprenticeship, practice, bundle, readiness), each stage with a gate; shared code; who owns which skill; the order of work. |
| [ROADMAP.md](ROADMAP.md) | Where this is going: one driver identity (personality, style, skills) across every discipline, measured in every event, rated from real results. Phases and open decisions. |

## How to use it

- **Before a training change:** read PLAYBOOK.md for the discipline and the shared principles; the other funnel may have hit the same wall.
- **After an experiment:** add a line to RESULTS.md (date, name, commit, discipline, what was asked, the numbers that answer it). If it teaches something general, add it to PLAYBOOK.md with its evidence. The lab still writes its own `lab/RESULTS.md` locally; copy the line here when it matters.
- **Experiment specs and summaries** worth keeping go in `training/experiments/<date>-<name>/` (spec.json, summary.md, the bench text). Driver bundles stay out (megabytes); a bundle worth sharing goes to `public/drivers/` with an `index.json` note, as the house drivers do.
- **Run long experiments in the lab** (`scripts/lab.ts`: a pinned worktree, so edits on the main tree can't leak into a run). Step kinds: class, season, bench, solo, circuits, promote, and for the oval stable: stable, stableCautions, stableRaces. `npx tsx scripts/dashboard.ts lab/results` follows them.
