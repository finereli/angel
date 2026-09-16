// Pyramid knobs. See ../../docs/pyramid-spec.md (canonical: the infinite-context repo).

// Stream pyramid (conversation continuity)
export const STREAM = {
  WIDTH: 5,        // fan-out per tier: a tier-t tile = WIDTH tier-(t-1) tiles
  VERBATIM: 8,     // message pairs kept verbatim at the tail
  MAX_TIER: 4,     // highest tier built; one tile spans WIDTH^4 = 625 pairs
  RAMP: 5,         // most-recent tiles per tier in the render gradient (= WIDTH)
  KEEP_FACTOR: 2,  // prune tiles older than KEEP_FACTOR * WIDTH^MAX_TIER pairs
} as const

// Observation pyramid (per-tag memory)
export const OBS = {
  OBS_BATCH: 10,   // observations per tier-0 tile
  SUM_BATCH: 5,    // tiles per higher tier
} as const
