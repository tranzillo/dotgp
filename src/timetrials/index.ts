/**
 * Time Trial System Exports
 */

export { TimeTrialManager } from './TimeTrialManager';
export { TimeTrialStorage } from './TimeTrialStorage';
export type {
  TimeTrialRecord,
  TrackLeaderboard,
  TimeTrialData,
  TimeTrialTrackType,
  SizeClass,
  GPSizeClass,
  OvalSizeClass,
  TrackMeta,
  FullTrackConfig,
  OvalShape,
  SurfaceType,
} from './types';
export {
  getTrackKey,
  parseTrackKey,
  SIZE_CLASS_OPTIONS,
  DEFAULT_SIZE_CLASS,
  encodeCompositeSeed,
  decodeCompositeSeed,
  isCompositeSeed,
} from './types';
