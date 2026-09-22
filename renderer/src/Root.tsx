import React from 'react';
import { Composition } from 'remotion';
import { DataRace } from './DataRace';
import { Thumbnail } from './Thumbnail';
import type { RenderInput } from './types';
import { demoInput } from './demo';

/**
 * Compositions are registered with placeholder props; `calculateMetadata`
 * derives the real duration from the supplied VideoSpec, so a project's scene
 * timings are always the source of truth.
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="DataRace"
      component={DataRace}
      durationInFrames={300}
      fps={60}
      width={1280}
      height={720}
      defaultProps={{ input: demoInput() }}
      calculateMetadata={({ props, defaultProps }) => {
        const input = (props as { input?: RenderInput }).input ?? (defaultProps as { input: RenderInput }).input;
        // The rebuilt renderer targets 60fps output; ignore any legacy fps in the spec.
        const fps = 60;
        const frames = Math.max(1, Math.round(input.videoSpec.metadata.durationSeconds * fps));
        return {
          durationInFrames: frames,
          fps,
          width: input.videoSpec.canvas.width,
          height: input.videoSpec.canvas.height,
        };
      }}
    />
    <Composition
      id="Thumbnail"
      component={Thumbnail}
      durationInFrames={1}
      fps={60}
      width={1280}
      height={720}
      defaultProps={{ input: demoInput() }}
      calculateMetadata={({ props, defaultProps }) => {
        const input = (props as { input?: RenderInput }).input ?? (defaultProps as { input: RenderInput }).input;
        return { width: input.videoSpec.canvas.width, height: input.videoSpec.canvas.height };
      }}
    />
  </>
);