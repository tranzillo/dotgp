# The lane view: what a driver can see of the lanes beside it (2026-11-17)

PACK-RACING.md step 3 ("back to the goal"). Pack racing needs drivers to see, at a glance, whether the lane beside is
moving, how long the line there is, who is behind there to go with them, and when the car ahead pulls out. Nothing
remembered: gaps and closing speeds now.

## The view

`laneView` in `src/ai/spotter.ts` (`LANES`, 12 values in [-1, 1]). For the lane below and the lane above (2.5-7 m
across): the nearest car ahead there (proximity, closing: negative is that lane pulling away), how many cars in that
line ahead within 120 m, and the nearest car behind there (proximity, closing). For its own lane: how many cars in its
line, and how fast the car ahead is moving out of its groove.

That last one took three goes: across the road, the groove sweeping across the banking carried every car with it (a
"pull-out" every few seconds); across from us, a car 20-30 m on is at another point of the sweep (no better). Out of
its own groove (the nearer of the two lines; the line's slope times its speed taken off) is what a driver sees.

Read by teachers and probes only: not in students' inputs yet (that changes every student's network: later, with an
adapter, once teachers use it).

## What it sees (`probes/v-*`)

`scripts/laneLook.ts`, teachers of v8sp, `?spec=cup&lines=2&follow=3&draft=2&wake=1`, `--rules 1`, 40 cars (36
superspeedway), 4 races a track:

| | short | speedway | gen. intermediate | gen. superspeedway |
|---|---|---|---|---|
| green time two wide or more | 25% | 17% | 12% | 12% |
| held up | 28% | 17% | 17% | 35% |
| held up: lane beside empty / rolling / level / stacked | 91 / 6 / 2 / 1% | 89 / 5 / 4 / 1% | 94 / 4 / 2 / 0% | 98 / 1 / 1 / 0% |
| held up: a car behind in that lane within 15 m | 5% | 6% | 4% | 3% |
| car ahead moving out of its groove (1+ m/s) | 10191 | 10083 | 5042 | 25745 |
| of those, a lane over within 2 s | 4346 | 2613 | 2115 | 4138 |
| ... and the follower went with it | 37% | 31% | 50% | 23% |

- Single file: held up, the lane beside is empty 89-98% of the time, and there's almost never a car behind in it to
  push.
- When the car ahead does pull out a lane, its follower goes with it a quarter to half the time (23% on the
  superspeedway): the car that pulled out is mostly alone, and under the new air a car alone is slower than the line.
- Most of the times the car ahead moves out of its groove it doesn't reach the next lane (84% on the superspeedway):
  teachers' pass attempts flicker on and off and the car wiggles. A student would see those feints too.

## Commands

```sh
B=public/drivers/stable-candidate-v8sp-lines.json
DOTGP_EXPERIMENT='?spec=cup&lines=2&follow=3&draft=2&wake=1' npx tsx --import ./scripts/laneLook.ts \
  scripts/incidents.ts teacher:$B --tracks short --seeds 4 --field 40 --rules 1
# also speedway, oval:3850048323:intermediate, oval:774865359:superspeedway (--field 36)
```
