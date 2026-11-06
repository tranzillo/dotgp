# Real track centrelines (TUMFTM racetrack-database)

These 25 files are the `tracks/` folder of the
[TUMFTM racetrack-database](https://github.com/TUMFTM/racetrack-database)
(Chair of Automotive Technology, Technical University of Munich), unchanged.
They are licensed under the GNU Lesser General Public License v3.0 (`LICENSE`
here; it supplements the [GNU GPL v3](https://www.gnu.org/licenses/gpl-3.0.html)).

Each row is `x_m, y_m, w_tr_right_m, w_tr_left_m`: a point on the centreline,
and the track's width to its right and left (metres), in driving order. The
first point is on the start line.

From the database's README:

- The centrelines were fetched as GPS points from
  [OpenStreetMap](https://www.openstreetmap.org) (© OpenStreetMap
  contributors, [ODbL](https://opendatacommons.org/licenses/odbl/)) and
  smoothed, so they don't lie exactly in the middle of the track.
- The widths were extracted from satellite images by an image processing
  algorithm (developed by Andressa de Paula Suiti).
- The quality varies a lot from track to track.

DotGP fits these into its own track layouts (`src/trackgen/realtrack.ts`).
Clockwise tracks are mirrored, because DotGP's laps turn left. Pits, run-off,
widths and banking are DotGP's own, not the real track's.
