import { CrossfadeType } from '../../src/types';

export interface TransitionPlan {
  cue_out_ms: number;
  cue_in_ms: number;
  switch_point_ms: number;
  transition_type: CrossfadeType;
  transition_duration_ms: number;
  time_stretch_ratio: number;
  automation_a_low: [number, number][];
  automation_b_low: [number, number][];
}

/**
 * Genre → preferred crossfade type mapping.
 * DJs use different techniques for different styles:
 *   Techno/DnB: quick cuts or short equal-power
 *   House: long smooth equal-power
 *   Ambient: slow S-curve / filter sweep
 */
const GENRE_TRANSITION_MAP: Record<string, { type: CrossfadeType; bars: number }> = {
  // Techno & Industry
  'Techno': { type: 'equal_power', bars: 8 },
  'peak_time_techno': { type: 'equal_power', bars: 4 },
  'driving_techno': { type: 'equal_power', bars: 8 },
  'hard_techno': { type: 'instant_cut', bars: 4 },
  'Industrial': { type: 'equal_power', bars: 4 },

  // House
  'House': { type: 'equal_power', bars: 16 },
  'tech_house': { type: 'equal_power', bars: 16 },
  'Deep House': { type: 's_curve', bars: 16 },
  'deep_house': { type: 's_curve', bars: 16 },
  'Progressive House': { type: 's_curve', bars: 16 },
  'electro_house': { type: 'equal_power', bars: 8 },
  'bass_house': { type: 'instant_cut', bars: 8 },

  // Trance & Ambient
  'Trance': { type: 's_curve', bars: 32 },
  'psy_trance': { type: 's_curve', bars: 16 },
  'uplifting_trance': { type: 's_curve', bars: 32 },
  'Ambient': { type: 'filter_sweep', bars: 32 },

  // Bass & Jungle
  'Drum and Bass': { type: 'instant_cut', bars: 4 },
  'liquid_dnb': { type: 'equal_power', bars: 8 },
  'Jungle': { type: 'instant_cut', bars: 4 },
  'Dubstep': { type: 'backspin', bars: 4 },
  'brostep': { type: 'backspin', bars: 4 },
  'riddim': { type: 'echo_out', bars: 4 },

  // Hip-Hop & Rap
  'Hip-Hop': { type: 'echo_out', bars: 4 },
  'Rap': { type: 'echo_out', bars: 4 },
  'Trap': { type: 'echo_out', bars: 4 },
  'trap': { type: 'echo_out', bars: 4 },
  'drill': { type: 'echo_out', bars: 4 },
  'boom_bap': { type: 'echo_out', bars: 4 },

  // Other
  'Pop': { type: 'linear', bars: 8 },
  'synth_pop': { type: 'linear', bars: 8 },
  'Other': { type: 'equal_power', bars: 8 },
};

const DEFAULT_TRANSITION = { type: 'equal_power' as CrossfadeType, bars: 8 };

function getTransitionStyle(genreA: string, genreB: string): { type: CrossfadeType; bars: number } {
  // Use the incoming track's genre to determine style
  const incoming = GENRE_TRANSITION_MAP[genreB] ?? GENRE_TRANSITION_MAP[genreA] ?? DEFAULT_TRANSITION;
  return incoming;
}

export function planTransition(
  trackABpm: number,
  trackAOutroStartMs: number,
  trackADurationMs: number,
  trackACueInMs: number,
  trackBBpm: number,
  trackBIntroEndMs: number,
  trackBDurationMs: number,
  genreA: string = 'Other',
  genreB: string = 'Other',
  vocalSegmentsA: { start: number; end: number }[] = [],
  vocalSegmentsB: { start: number; end: number }[] = []
): TransitionPlan {
  const safeBpmA = trackABpm > 0 ? trackABpm : 128;
  const safeBpmB = trackBBpm > 0 ? trackBBpm : 128;

  const { type: transitionType, bars } = getTransitionStyle(genreA, genreB);

  // 1. Calculate ideal duration based on BPM/Style
  const beatDurationMs = (60 * 1000) / safeBpmA;
  let transitionDurationMs = Math.round(bars * 4 * beatDurationMs);

  // --- CAP 0: keep blends punchy (long 16–32 bar blends drone and expose any
  // tempo/key mismatch). 16s is a musical upper bound for an auto-mix. ---
  if (transitionDurationMs > 16000) {
    transitionDurationMs = 16000;
  }

  // 2. SAFETY CAP: Duration cannot exceed 30% of either track total length
  const absoluteMax = Math.min(trackADurationMs, trackBDurationMs) * 0.3;
  if (transitionDurationMs > absoluteMax) {
    transitionDurationMs = Math.floor(absoluteMax / (beatDurationMs * 4)) * (beatDurationMs * 4);
    if (transitionDurationMs < 1000) transitionDurationMs = 1000;
  }

  // 3. Outgoing Segment (A)
  // Exit at the outro so the track plays out and the blend lands near the END of the
  // song (proper DJ behaviour). No artificial 29s cap — this is a local mixing tool.
  // (outro detection can occasionally report past the track end, so guard against that.)
  let finalCueOutMs = (trackAOutroStartMs > 0 && trackAOutroStartMs < trackADurationMs)
    ? trackAOutroStartMs
    : Math.round(trackADurationMs * 0.9);

  // Boundary check
  if (finalCueOutMs > trackADurationMs) finalCueOutMs = trackADurationMs;

  // 4. Incoming Segment (B)
  // Jump past the silent/boring intro of the next song
  let cueInMs = trackBIntroEndMs > 0 ? trackBIntroEndMs - Math.round(beatDurationMs * 4) : Math.round(trackBDurationMs * 0.05);
  if (cueInMs < 0) cueInMs = 0;

  // --- VOCAL AVOIDANCE ---
  // If vocals overlap, drop transition duration up to 50%, or shift cueInMs.
  let clashFound = true;
  let resolveAttempts = 0;

  while (clashFound && resolveAttempts < 2) {
    clashFound = false;
    const transStartA = finalCueOutMs - transitionDurationMs;
    const transStartB = cueInMs;

    for (const vA of vocalSegmentsA) {
      const vRelStartA = Math.max(0, vA.start - transStartA);
      const vRelEndA = Math.min(transitionDurationMs, vA.end - transStartA);
      if (vRelStartA >= vRelEndA) continue; // No overlap with transition window

      for (const vB of vocalSegmentsB) {
        const vRelStartB = Math.max(0, vB.start - transStartB);
        const vRelEndB = Math.min(transitionDurationMs, vB.end - transStartB);
        if (vRelStartB >= vRelEndB) continue;

        // Check if the relative vocal windows overlap
        if (vRelStartA < vRelEndB && vRelStartB < vRelEndA) {
          clashFound = true;
          break;
        }
      }
      if (clashFound) break;
    }

    if (clashFound) {
      if (resolveAttempts === 0) {
        // Attempt 1: Shift Track B's cue in forward by 16 beats (skipping introduction deeper)
        cueInMs += Math.round(beatDurationMs * 16);
      } else {
        // Attempt 2: Push Track A's cue out backward
        finalCueOutMs -= Math.round(beatDurationMs * 16);
      }
    }
    resolveAttempts++;
  }

  // Safety resets if adjustments pushed out of bounds
  if (finalCueOutMs < trackACueInMs + transitionDurationMs) finalCueOutMs = trackADurationMs;
  if (cueInMs + transitionDurationMs > trackBDurationMs) cueInMs = 0;
  if (transitionDurationMs < 100) transitionDurationMs = 100;

  const automation_a_low: [number, number][] = [
    [0, 0],
    [Math.round(transitionDurationMs * 0.6), -6],
    [transitionDurationMs, -60],
  ];
  const automation_b_low: [number, number][] = [
    [0, -60],
    [Math.round(transitionDurationMs * 0.4), -6],
    [transitionDurationMs, 0],
  ];

  return {
    cue_out_ms: Math.round(finalCueOutMs),
    cue_in_ms: Math.round(cueInMs),
    switch_point_ms: Math.round(finalCueOutMs),
    transition_type: transitionType,
    transition_duration_ms: Math.round(transitionDurationMs),
    time_stretch_ratio: safeBpmA / safeBpmB,
    automation_a_low,
    automation_b_low,
  };
}
