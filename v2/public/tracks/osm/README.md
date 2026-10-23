# Real oval centrelines (OpenStreetMap)

These centrelines come from [OpenStreetMap](https://www.openstreetmap.org)
(© OpenStreetMap contributors). The data is available under the
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
Each file's second line lists the OpenStreetMap ways it was assembled from.

`scripts/osmtrack.ts` makes them:
- It fetches the raceway ways around a track from the Overpass API.
- It assembles the oval's loop.
- It puts the start line where the loop passes the pit lane's middle.

The widths are published figures, not mapped ones. Banking is in
`src/trackgen/realtrack.ts` (`REAL_TRACKS`), also from published figures.
Pits, run-off and infield are DotGP's own.
