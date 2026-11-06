# F1 telemetry (fastf1 / OpenF1) as training data for circuits

2026-10-24, circuit machine. Question: are real pole laps usable as pro driving lines?

**Access.** fastf1 3.9 needs an F1TV subscription (F1 live timing answers 401 without one). OpenF1
(api.openf1.org) serves the same feed free for past sessions, except while a live session is running. Its
`country_name` is ambiguous (Italy is Imola and Monza): pick by `circuit_short_name`.

**Registration.** 2024 qualifying, fastest lap per circuit (car data and position at ~3.7 Hz), rigidly fitted onto the
TUMFTM surveys: scale 0.992-1.003, 0-5.5% of points over 1 m outside the edges on 11 circuits. Barcelona, Melbourne
and Yas Marina don't fit (the surveys predate their changed layouts); Shanghai's survey can't be laid out.

**Positions are not lines.** Two drivers' fastest laps (P1, P2) agree across the track within 0.1-0.2 m (median)
everywhere on six circuits; at the 2024 Monza race the front row's staggered grid boxes come out 0.1 m apart across the
track. The feed places every car on one reference path per circuit (a broadcast map's 1D position). fastf1 reads the
same feed. So no pro racing lines from this source.

**What is real:** speed, throttle, brake (on/off), gear and rpm per car, by distance round the lap: braking points,
corner minimum speeds, throttle application. A fitting target for the cars (carSpec), not for lines.
