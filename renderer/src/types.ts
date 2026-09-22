/**
 * Composition input contract.
 *
 * A render needs three files produced by the orchestrator:
 *   video-spec.json  (VideoSpec)      - what to show
 *   dataset.json     (Dataset)        - the verified observations and provenance
 *   frames.json      (FrameTape)      - the pre-computed per-frame bar state
 */

import type { Dataset, Story, ThumbnailSpec, VideoSpec } from '@avm/shared';
import type { FrameTape } from './frameTape';

export interface RenderInput {
  videoSpec: VideoSpec;
  dataset: Dataset;
  frameTape: FrameTape;
  thumbnail?: ThumbnailSpec;
  /** Narrative beats (hook/setup/sequence/highlights/ending) for the era panel; optional. */
  story?: Story;
  /** Bare host for entity flags; components append `/w80|w160/{code}.png` themselves. */
  flagBaseUrl?: string;
}

export const DEFAULT_FLAG_BASE = 'https://flagcdn.com';