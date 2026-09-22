/** Placeholder props so Remotion Studio always has something valid to render. */

import type { RenderInput } from './types';

export function demoInput(): RenderInput {
  const videoSpec = {
    version: '1.0' as const,
    metadata: { title: 'Demo', subtitle: 'placeholder', language: 'en', durationSeconds: 5 },
    canvas: { width: 1280, height: 720, fps: 60 },
    theme: { background: '#ffffff', primaryText: '#111827', fontFamily: 'Inter' },
    datasetRef: 'demo',
    scenes: [{ id: 's1', type: 'bar_race' as const, duration: 5 }],
    assets: [],
    sources: [],
  };
  return {
    videoSpec,
    dataset: {
      datasetId: 'demo',
      projectId: 'demo',
      name: 'Demo',
      metric: 'demo metric',
      unit: 'count',
      timeRange: { start: '2000', end: '2001' },
      frequency: 'annual',
      missingDataPolicy: 'STRICT',
      version: 1,
      frozen: false,
      observations: [],
      conflicts: [],
      stats: { observations: 0, entities: 0, verified: 0, supported: 0, estimated: 0, unknown: 0, conflicting: 0, rejected: 0 },
      createdAt: new Date(0).toISOString(),
    },
    frameTape: {
      fps: 60,
      width: 1280,
      height: 720,
      topN: 10,
      framesPerTransition: 30,
      durationInFrames: 150,
      periodLabels: [],
      entities: [],
      frames: [],
      notes: ['no data supplied: this is the placeholder composition'],
    },
  };
}