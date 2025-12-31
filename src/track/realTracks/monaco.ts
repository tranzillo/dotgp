import { RealTrackDefinition } from './types';

/**
 * Monaco Grand Prix - Circuit de Monaco
 *
 * Coordinates extracted from SVG path, normalized to 0-1.
 * SVG viewBox: 0 0 768 800
 *
 * Track width varies by section:
 * - Main straights: ~14-16m wide
 * - Fast sweepers: ~12-14m
 * - Technical sections: ~10-12m
 * - Tight corners (hairpin, Rascasse): ~9-10m but still drivable
 */
export const MONACO: RealTrackDefinition = {
  id: 'monaco',
  name: 'Monaco GP',
  country: 'Monaco',
  length: 3337,
  defaultWidth: 12,

  // Extracted from SVG path endpoints, normalized (x/768, y/800)
  // Width values adjusted for realistic racing line widths
  controlPoints: [
    // START - Near Anthony Noghes (bottom-left)
    { x: 0.136, y: 0.817, width: 14 },   // 0: Start area

    // UP the left side (Swimming Pool backward direction)
    { x: 0.104, y: 0.745, width: 13 },   // 1: ~80,596
    { x: 0.098, y: 0.665, width: 12 },   // 2: ~75,532 - Swimming Pool section
    { x: 0.111, y: 0.564, width: 12 },   // 3: ~85,451 - Louis Chiron
    { x: 0.142, y: 0.485, width: 13 },   // 4: ~109,388 - Tabac approach
    { x: 0.170, y: 0.441, width: 14 },   // 5: ~131,353 - Opening up

    // SAINTE DEVOTE area - main straight begins
    { x: 0.193, y: 0.430, width: 15 },   // 6: ~148,344 - Sainte Devote
    { x: 0.246, y: 0.435, width: 16 },   // 7: ~189,348 - Pit straight (wide)

    // Main straight toward Casino - WIDE
    { x: 0.443, y: 0.431, width: 16 },   // 8: ~340,345 - Straight
    { x: 0.481, y: 0.422, width: 15 },   // 9: ~369,337 - Beau Rivage
    { x: 0.519, y: 0.417, width: 14 },   // 10: ~399,334 - Massenet
    { x: 0.605, y: 0.413, width: 14 },   // 11: ~465,331 - Casino approach

    // MIRABEAU section - narrowing for technical turns
    { x: 0.633, y: 0.403, width: 13 },   // 12: ~486,322 - Mirabeau entry
    { x: 0.653, y: 0.385, width: 12 },   // 13: ~502,308 - Mirabeau Haute
    { x: 0.663, y: 0.364, width: 11 },   // 14: ~509,291 - Mirabeau Bas

    // GRAND HOTEL HAIRPIN - tight but drivable
    { x: 0.660, y: 0.348, width: 11 },   // 15: ~507,278 - Hairpin approach
    { x: 0.634, y: 0.297, width: 10 },   // 16: ~487,237 - HAIRPIN APEX
    { x: 0.630, y: 0.274, width: 10 },   // 17: ~484,219 - Hairpin exit
    { x: 0.634, y: 0.261, width: 11 },   // 18: ~487,209 - Accelerating out

    // PORTIER - heading toward tunnel (opening up)
    { x: 0.753, y: 0.153, width: 13 },   // 19: ~578,122 - Portier
    { x: 0.775, y: 0.140, width: 14 },   // 20: ~595,112 - Tunnel approach
    { x: 0.787, y: 0.151, width: 14 },   // 21: ~604,121 - Tunnel entry

    // TUNNEL section - fast, needs width
    { x: 0.790, y: 0.198, width: 14 },   // 22: ~607,158 - In tunnel
    { x: 0.796, y: 0.239, width: 14 },   // 23: ~611,191 - Tunnel mid
    { x: 0.809, y: 0.251, width: 13 },   // 24: ~621,201 - Tunnel exit
    { x: 0.819, y: 0.251, width: 13 },   // 25: ~629,201 - After tunnel
    { x: 0.818, y: 0.203, width: 12 },   // 26: ~628,163 - Chicane approach

    // CHICANE (upper right corner) - technical
    { x: 0.837, y: 0.185, width: 11 },   // 27: ~642,148 - Chicane entry
    { x: 0.872, y: 0.183, width: 11 },   // 28: ~670,147 - Chicane mid
    { x: 0.885, y: 0.201, width: 12 },   // 29: ~679,161 - Chicane exit
    { x: 0.874, y: 0.243, width: 13 },   // 30: ~671,194 - Opening up

    // Coming back down (harbor/Tabac direction) - fast section
    { x: 0.793, y: 0.387, width: 14 },   // 31: ~609,310 - Fast sweeper
    { x: 0.654, y: 0.458, width: 14 },   // 32: ~502,366 - Harbor straight

    // TABAC / back toward pits - medium speed
    { x: 0.580, y: 0.467, width: 13 },   // 33: ~445,374 - Tabac
    { x: 0.456, y: 0.470, width: 13 },   // 34: ~350,376 - Straight section
    { x: 0.449, y: 0.482, width: 12 },   // 35: ~345,385 - Narrowing
    { x: 0.449, y: 0.493, width: 12 },   // 36: ~345,395 - Technical

    // Toward Rascasse - narrowing
    { x: 0.434, y: 0.494, width: 12 },   // 37: ~333,396
    { x: 0.404, y: 0.494, width: 11 },   // 38: ~310,396
    { x: 0.392, y: 0.488, width: 11 },   // 39: ~301,390
    { x: 0.367, y: 0.480, width: 11 },   // 40: ~282,384
    { x: 0.289, y: 0.481, width: 12 },   // 41: ~222,385 - Opening slightly
    { x: 0.235, y: 0.483, width: 12 },   // 42: ~180,386

    // RASCASSE area - tight hairpin
    { x: 0.201, y: 0.503, width: 11 },   // 43: ~155,402 - Rascasse approach
    { x: 0.175, y: 0.597, width: 10 },   // 44: ~134,478 - Rascasse entry
    { x: 0.183, y: 0.605, width: 10 },   // 45: ~140,484 - Rascasse apex
    { x: 0.188, y: 0.617, width: 11 },   // 46: ~144,493 - Rascasse exit
    { x: 0.190, y: 0.690, width: 12 },   // 47: ~146,552 - Swimming Pool
    { x: 0.173, y: 0.721, width: 12 },   // 48: ~133,577 - Swimming Pool
    { x: 0.169, y: 0.763, width: 13 },   // 49: ~130,610 - Opening up

    // ANTHONY NOGHES - final corners back to start
    { x: 0.212, y: 0.818, width: 13 },   // 50: ~162,654 - Noghes
    { x: 0.250, y: 0.844, width: 14 },   // 51: ~192,675 - Exit
    { x: 0.266, y: 0.867, width: 15 },   // 52: ~204,694 - Pit straight approach
    { x: 0.266, y: 0.880, width: 15 },   // 53: ~204,704 - Wide
    { x: 0.248, y: 0.879, width: 15 },   // 54: ~190,703 - Pit entry
    { x: 0.151, y: 0.869, width: 14 },   // 55: ~116,695 - Back to start
    { x: 0.139, y: 0.853, width: 14 },   // 56: ~107,682 - Loop closure
  ],

  corners: [
    { name: 'Sainte Devote', pointIndex: 6 },
    { name: 'Casino', pointIndex: 10 },
    { name: 'Mirabeau', pointIndex: 13 },
    { name: 'Grand Hotel Hairpin', pointIndex: 16 },
    { name: 'Portier', pointIndex: 19 },
    { name: 'Tunnel', pointIndex: 23 },
    { name: 'Nouvelle Chicane', pointIndex: 28 },
    { name: 'Tabac', pointIndex: 33 },
    { name: 'Swimming Pool', pointIndex: 47 },
    { name: 'La Rascasse', pointIndex: 45 },
    { name: 'Anthony Noghes', pointIndex: 50 },
  ],

  startFinishIndex: 0,

  pitLane: {
    startIndex: 50,
    endIndex: 6,
    side: 'inside',
  },

  segmentsPerPoint: 12,
};
