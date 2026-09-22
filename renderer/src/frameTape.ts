/** Mirror of the Rust frame-tape contract (see crates/datarace-core/src/frames.rs). */

export interface FrameTapeEntity {
  id: string;
  name: string;
  flag?: string;
  flagCode?: string;
  color: string;
  logo?: string;
  image?: string;
  group?: string;
  /**
   * Optional data-URI (`data:image/png;base64,...`) for the entity flag,
   * populated by the render CLI so frames never depend on flag CDNs at
   * render time. Components prefer this over `flagBaseUrl` + `flagCode`.
   */
  flagDataUri?: string;
}

export interface FrameTapeBar {
  entityId: string;
  value: number;
  rank: number;
  previousRank?: number;
  width: number;
  held: boolean;
  rankDelta?: number;
  isMover: boolean;
}

export interface FrameTapeFrame {
  index: number;
  label: string;
  fromLabel: string;
  toLabel: string;
  t: number;
  isPeriodBoundary: boolean;
  maxValue: number;
  bars: FrameTapeBar[];
}

export interface FrameTape {
  fps: number;
  width: number;
  height: number;
  topN: number;
  framesPerTransition: number;
  durationInFrames: number;
  periodLabels: string[];
  entities: FrameTapeEntity[];
  frames: FrameTapeFrame[];
  notes: string[];
}