/**
 * The data-race composition.
 *
 * The data-race composition (1280x720 baseline), in the classic full-bleed style:
 *   full height  ranking bars from the left edge (name in white bold inside the
 *                bar, flag at the bar end, value in dark type past the flag)
 *   right        era panel: giant year, era headline + narrative, featured flags
 *   (no header during the race; title / ending / source card are own scenes)
 */

import React, { useMemo } from 'react';
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Dataset } from '@avm/shared';
import { makeTheme, compactNumber } from './theme';
import type { FrameTape, FrameTapeEntity } from './frameTape';
import { DEFAULT_FLAG_BASE, type RenderInput } from './types';
import {
  BrandMark,
  Canvas,
  EraPanel,
  RankingRow,
  SourceCard,
  TitleBlock,
} from './components';

interface Highlight {
  atFrame: number;
  atLabel: string;
  entityId: string;
  headline: string;
  detail: string;
  factBox?: { heading: string; body: string; dateLabel?: string; wordmark?: string };
}

interface SmoothRanks {
  ranks: Map<string, number>[];
}

/** Pre-compute animated ranks so row movement is smooth rather than jittery. */
function buildSmoothRanks(tape: FrameTape, blendFrames = 12): SmoothRanks {
  const smoothed: Map<string, number>[] = [];
  const displayed = new Map<string, { value: number; target: number; since: number }>();
  tape.frames.forEach((frame, index) => {
    for (const bar of frame.bars) {
      const existing = displayed.get(bar.entityId);
      if (!existing) {
        displayed.set(bar.entityId, { value: bar.rank, target: bar.rank, since: index });
        continue;
      }
      if (existing.target !== bar.rank) {
        existing.target = bar.rank;
        existing.since = index;
      }
      const progress = Math.min(1, (index - existing.since) / Math.max(1, blendFrames));
      const eased = 1 - (1 - progress) ** 3;
      existing.value = existing.value + (existing.target - existing.value) * (index === existing.since ? 1 : eased);
    }
    smoothed.push(new Map(Array.from(displayed.entries()).map(([id, v]) => [id, v.value])));
  });
  return { ranks: smoothed };
}

function groupTotals(tape: FrameTape, frameIndex: number): Array<{ label: string; value: number; color: string }> {
  const frame = tape.frames[Math.min(Math.max(0, frameIndex), tape.frames.length - 1)];
  if (!frame) return [];
  const totals = new Map<string, { value: number; color: string }>();
  for (const bar of frame.bars) {
    const entity = tape.entities.find((e) => e.id === bar.entityId);
    const group = entity?.group ?? 'Other';
    const entry = totals.get(group) ?? { value: 0, color: entity?.color ?? '#111827' };
    entry.value += bar.value;
    totals.set(group, entry);
  }
  return Array.from(totals.entries())
    .map(([label, v]) => ({ label, value: v.value, color: v.color }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
}

/**
 * The bar-race scene, in the classic full-bleed style of the reference video:
 * ranking bars run from the left edge across the full 720px height, the entity
 * name sits in white bold type inside the bar, the flag is attached to the bar
 * end, the value is set in dark type just past the flag, and the right-hand
 * panel shows the giant year + era narrative + featured flags. No header
 * during the race. Values, widths and ranks are interpolated between the two
 * bracketing tape frames so motion glides instead of stepping.
 */
const BarRace: React.FC<{ input: RenderInput; highlights: Highlight[]; durationInFrames: number }> = ({
  input,
  highlights,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tape = input.frameTape;
  const dataset = input.dataset;
  const story = input.story;
  const flagBaseUrl = input.flagBaseUrl ?? DEFAULT_FLAG_BASE;

  const tapeCount = tape.frames.length;
  const tapeFps = tape.fps || 30;

  // Fractional position in tape-frame units; the two bracketing tape frames
  // are interpolated so bars glide smoothly at any render fps.
  const tapePos = Math.min(tapeCount - 1, Math.max(0, (frame / Math.max(1, durationInFrames)) * tapeCount));
  const i0 = Math.min(tapeCount - 1, Math.floor(tapePos));
  const i1 = Math.min(tapeCount - 1, i0 + 1);
  const t = Math.min(1, Math.max(0, tapePos - i0));
  const f0 = tape.frames[i0];
  const f1 = tape.frames[i1];

  const entityById = useMemo(() => new Map(tape.entities.map((e) => [e.id, e])), [tape]);
  const labelToTapeIndex = useMemo(() => {
    const m = new Map<string, number>();
    tape.frames.forEach((f, idx) => {
      if (!m.has(f.label)) m.set(f.label, idx);
    });
    return m;
  }, [tape]);

  interface Row {
    id: string;
    value: number;
    widthFrac: number;
    rank: number;
    held: boolean;
    appear: number;
  }

  const { rows, barCount } = useMemo(() => {
    const a = new Map((f0?.bars ?? []).map((b) => [b.entityId, b]));
    const b = new Map((f1?.bars ?? []).map((b) => [b.entityId, b]));
    const ids = new Set<string>([...a.keys(), ...b.keys()]);
    const count = Math.max(f0?.bars.length ?? 0, f1?.bars.length ?? 0, 1);
    const out: Row[] = [];
    for (const id of ids) {
      const ba = a.get(id);
      const bb = b.get(id);
      if (ba && bb) {
        out.push({
          id,
          value: ba.value + (bb.value - ba.value) * t,
          widthFrac: ba.width + (bb.width - ba.width) * t,
          rank: ba.rank + (bb.rank - ba.rank) * t,
          held: ba.held ?? bb.held ?? false,
          appear: 1,
        });
      } else if (bb) {
        // entering the top-N: glide up from below the list
        out.push({
          id,
          value: bb.value,
          widthFrac: bb.width * t,
          rank: count + 1 + (bb.rank - (count + 1)) * t,
          held: bb.held ?? false,
          appear: t,
        });
      } else if (ba) {
        // leaving the top-N: glide down out of the list
        out.push({
          id,
          value: ba.value,
          widthFrac: ba.width * (1 - t),
          rank: ba.rank + (count + 1 - ba.rank) * t,
          held: ba.held ?? false,
          appear: 1 - t,
        });
      }
    }
    out.sort((x, y) => x.rank - y.rank);
    return { rows: out.slice(0, count + 2), barCount: count };
  }, [f0, f1, t]);

  const rowHeight = 720 / Math.max(1, barCount);
  const maxBarWidth = 800; // leader's bar end; flag + value sit past it, panel starts at x=968
  const introAppear = interpolate(frame, [0, Math.min(18, durationInFrames)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Right-hand era panel ------------------------------------------------------
  const activeHighlight = highlights.find(
    (h) => tapePos >= h.atFrame && tapePos < h.atFrame + 6 * tapeFps,
  );
  const currentLabel = t < 0.5 ? f0?.label ?? '' : f1?.label ?? '';
  const segment = useMemo(() => {
    if (!story) return undefined;
    let current: (typeof story.sequence)[number] | undefined;
    for (const s of story.sequence) {
      const idx = labelToTapeIndex.get(s.atLabel);
      const curIdx = current ? labelToTapeIndex.get(current.atLabel) ?? -1 : -1;
      if (idx !== undefined && idx <= tapePos && idx > curIdx) current = s;
    }
    return current;
  }, [story, labelToTapeIndex, tapePos]);

  const featured = useMemo(() => {
    if (activeHighlight) {
      const e = entityById.get(activeHighlight.entityId);
      return e ? [e] : [];
    }
    return [...rows]
      .sort((x, y) => y.value - x.value)
      .slice(0, 2)
      .map((r) => entityById.get(r.id))
      .filter((e): e is FrameTapeEntity => !!e);
  }, [activeHighlight, rows, entityById]);

  const panelAppear = spring({ frame, fps, durationInFrames: 24, config: { damping: 200 } });

  return (
    <AbsoluteFill style={{ background: '#ffffff' }}>
      {rows.map((row) => {
        const entity = entityById.get(row.id);
        if (!entity) return null;
        return (
          <RankingRow
            key={row.id}
            entity={entity}
            value={row.value}
            widthFrac={row.widthFrac}
            rank={row.rank}
            held={row.held}
            unit={dataset.unit}
            y={(row.rank - 1) * rowHeight}
            rowHeight={rowHeight}
            maxBarWidth={maxBarWidth}
            appear={Math.max(0, Math.min(1, row.appear * introAppear))}
            flagBaseUrl={flagBaseUrl}
          />
        );
      })}
      <EraPanel
        yearLabel={activeHighlight?.atLabel ?? currentLabel}
        title={activeHighlight?.headline}
        body={activeHighlight?.detail ?? segment?.text}
        featured={featured}
        flagBaseUrl={flagBaseUrl}
        appear={panelAppear}
      />
    </AbsoluteFill>
  );
};


export const DataRace: React.FC<{ input: RenderInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = makeTheme(input.videoSpec.theme as Record<string, string | number>);
  const spec = input.videoSpec;
  const offsets: Array<{ id: string; type: string; from: number; to: number; durationInFrames: number; scene: (typeof spec.scenes)[number] }> = [];
  let cursor = 0;
  for (const scene of spec.scenes) {
    const durationInFrames = Math.round(scene.duration * fps);
    offsets.push({ id: scene.id, type: scene.type, from: cursor, to: cursor + durationInFrames, durationInFrames, scene });
    cursor += durationInFrames;
  }

  const raceOffset = offsets.find((o) => o.type === 'bar_race');
  const highlights = ((raceOffset?.scene.props?.highlights as unknown[]) ?? []).map((raw) => {
    const h = raw as Record<string, unknown>;
    return {
      atFrame: Number(h.atFrame ?? 0),
      atLabel: String(h.atLabel ?? ''),
      entityId: String(h.entityId ?? ''),
      headline: String(h.headline ?? ''),
      detail: String(h.detail ?? ''),
      factBox: h.factBox as Highlight['factBox'],
    } satisfies Highlight;
  });
  const raceFrom = raceOffset?.from ?? 0;
  const raceDuration = raceOffset?.durationInFrames ?? input.frameTape.durationInFrames;

  const sourceScene = offsets.find((o) => o.type === 'source_card');
  const endingScene = offsets.find((o) => o.type === 'ending');
  const introScene = offsets.find((o) => o.type === 'intro');
  const titleScene = offsets.find((o) => o.type === 'title');

  return (
    <Canvas theme={theme}>
      {titleScene ? (
        <Sequence from={titleScene.from} durationInFrames={titleScene.durationInFrames}>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: '0 90px' }}>
            <BrandMark theme={theme} size={74} />
            <div style={{ marginTop: 30, width: '100%' }}>
              <TitleBlock
                title={spec.metadata.title}
                subtitle={spec.metadata.subtitle}
                theme={theme}
                appear={interpolate(frame - titleScene.from, [0, 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
                titleSize={66}
              />
            </div>
          </AbsoluteFill>
        </Sequence>
      ) : null}

      {introScene ? (
        <Sequence from={introScene.from} durationInFrames={introScene.durationInFrames}>
          <AbsoluteFill style={{ justifyContent: 'center', padding: '0 110px', background: theme.background }}>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '0.22em', color: theme.accent, marginBottom: 22 }}>WHAT THIS SHOWS</div>
            <TitleBlock
              title={introScene.scene.title ?? ''}
              subtitle={introScene.scene.subtitle}
              theme={theme}
              align="left"
              appear={interpolate(frame - introScene.from, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
              titleSize={46}
              subtitleSize={26}
            />
            <div style={{ marginTop: 34, fontSize: 20, color: theme.secondaryText }}>
              {input.dataset.stats.entities} entities · {input.dataset.stats.observations} observations · {input.dataset.stats.verified} verified ·{' '}
              {input.dataset.stats.unknown} unknown · {input.dataset.stats.conflicting} conflicting
            </div>
          </AbsoluteFill>
        </Sequence>
      ) : null}

      {raceOffset ? (
        <Sequence from={raceOffset.from} durationInFrames={raceOffset.durationInFrames}>
          <BarRace input={input} highlights={highlights} durationInFrames={raceDuration} />
        </Sequence>
      ) : null}

      {endingScene ? (
        <Sequence from={endingScene.from} durationInFrames={endingScene.durationInFrames}>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: '0 110px' }}>
            <TitleBlock
              title={endingScene.scene.title ?? spec.metadata.title}
              theme={theme}
              appear={interpolate(frame - endingScene.from, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
              titleSize={44}
            />
            <div style={{ marginTop: 26, fontSize: 22, color: theme.secondaryText }}>
              {input.dataset.timeRange.start} – {input.dataset.timeRange.end} · {compactNumber(input.dataset.stats.observations)} data points
            </div>
          </AbsoluteFill>
        </Sequence>
      ) : null}

      {sourceScene ? (
        <Sequence from={sourceScene.from} durationInFrames={sourceScene.durationInFrames}>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
            <SourceCard
              sourcesLine={String(sourceScene.scene.props?.sourcesLine ?? '')}
              sources={input.videoSpec.sources.map((s) => ({ url: s.url, publisher: s.publisher }))}
              theme={theme}
              appear={interpolate(frame - sourceScene.from, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
            />
          </AbsoluteFill>
        </Sequence>
      ) : null}
    </Canvas>
  );
};