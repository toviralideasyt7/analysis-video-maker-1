/**
 * Reusable visual components.
 *
 * Everything is deterministic: the same frame always produces the same pixels.
 * No remote fonts, no remote images except optional flag assets, and no
 * third-party logos - entity identity is rendered as a monogram badge.
 */

import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { DEFAULT_FLAG_BASE } from './types';
import { compactNumber, formatValue, type Theme } from './theme';
import type { FrameTapeBar, FrameTapeEntity } from './frameTape';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** The small circular accent mark in the top-left corner. */
export const BrandMark: React.FC<{ theme: Theme; size?: number }> = ({ theme, size = 54 }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: theme.accent,
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: size * 0.11,
      paddingBottom: size * 0.26,
      boxSizing: 'border-box',
      boxShadow: '0 6px 18px rgba(17,24,39,0.18)',
    }}
  >
    {[0.5, 0.85, 0.65].map((factor, index) => (
      <div
        key={index}
        style={{
          width: size * 0.11,
          height: size * 0.52 * factor,
          background: '#ffffff',
          borderRadius: size * 0.05,
        }}
      />
    ))}
  </div>
);

/** Country flag chip with a text fallback when the asset cannot be loaded. */
export const FlagChip: React.FC<{ code?: string; label?: string; theme: Theme; size?: number }> = ({ code, label, theme, size = 34 }) => {
  const width = size * 1.45;
  return (
    <div
      style={{
        width,
        height: size,
        borderRadius: size * 0.22,
        overflow: 'hidden',
        background: theme.surface,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.42,
        fontWeight: 700,
        color: theme.secondaryText,
        flex: '0 0 auto',
        boxShadow: '0 1px 3px rgba(17,24,39,0.16)',
      }}
    >
      {code ? <Img src={`${DEFAULT_FLAG_BASE}/${code}.png`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (label ?? '').slice(0, 3).toUpperCase()}
    </div>
  );
};

/** Monogram badge standing in for a brand logo, in the entity's own colour. */
export const LogoBadge: React.FC<{ name: string; color: string; size?: number; invert?: boolean }> = ({ name, color, size = 44, invert = false }) => {
  const initials = name
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.26,
        background: invert ? '#ffffff' : color,
        color: invert ? color : '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        fontSize: size * 0.42,
        letterSpacing: '-0.02em',
        flex: '0 0 auto',
        boxShadow: '0 2px 6px rgba(17,24,39,0.2)',
      }}
    >
      {initials || name.slice(0, 2).toUpperCase()}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Ranking rows
// ---------------------------------------------------------------------------

export interface RankingRowProps {
  entity: FrameTapeEntity;
  /** Interpolated bar state in render space. */
  value: number;
  widthFrac: number;
  rank: number;
  held: boolean;
  unit: string;
  y: number;
  rowHeight: number;
  maxBarWidth: number;
  appear: number;
  flagBaseUrl: string;
}

/**
 * One full-bleed ranking bar, in the classic data-race style:
 * the bar runs from the left edge, the entity name sits in white bold type
 * inside the bar (right-aligned near the bar end), the flag image is attached
 * to the bar end, and the value is set in dark type just past the flag.
 */
export const RankingRow: React.FC<RankingRowProps> = ({
  entity,
  value,
  widthFrac,
  held,
  unit,
  y,
  rowHeight,
  maxBarWidth,
  appear,
  flagBaseUrl,
}) => {
  const barHeight = rowHeight - 5;
  // Never let a bar get so thin the white name becomes unreadable.
  const barW = Math.max(96, widthFrac * maxBarWidth);
  const baseFont = rowHeight * 0.5;
  const flagSize = Math.min(rowHeight * 0.82, 52);
  const valueFont = rowHeight * 0.44;

  // Does the name fit inside the bar at a readable size? Estimate width with
  // a 0.58 average glyph ratio for bold type. If it can't fit even at the
  // minimum readable size, the name moves outside the bar (past the value)
  // in dark type instead of being clipped or shrunk to illegibility.
  const MIN_INSIDE_FONT = 22;
  const estimateWidth = (fontSize: number) => entity.name.length * fontSize * 0.58;
  const insideAvailable = barW - 28; // 14px padding on each side
  let insideFont = baseFont;
  if (estimateWidth(baseFont) > insideAvailable) {
    insideFont = Math.max(MIN_INSIDE_FONT, (insideAvailable / Math.max(1, entity.name.length)) * 1.72);
  }
  const nameFitsInside = estimateWidth(insideFont) <= insideAvailable && insideFont >= MIN_INSIDE_FONT;
  const nameFont = nameFitsInside ? Math.min(baseFont, insideFont) : baseFont;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: y,
        height: rowHeight,
        width: '100%',
        opacity: appear,
        transform: `translateY(${(1 - appear) * 12}px)`,
      }}
    >
      {/* bar */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: (rowHeight - barHeight) / 2,
          height: barHeight,
          width: barW,
          background: entity.color,
          opacity: held ? 0.55 : 1,
        }}
      >
        {/* name: white bold, right-aligned inside the bar (only when it fits) */}
        {nameFitsInside ? (
          <div
            style={{
              position: 'absolute',
              right: 14,
              top: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              whiteSpace: 'nowrap',
              color: '#ffffff',
              fontWeight: 800,
              fontSize: nameFont,
              letterSpacing: '-0.01em',
            }}
          >
            {entity.name}
          </div>
        ) : null}
      </div>

      {/* flag + value + (outside name when it can't fit inside), in one row */}
      <div
        style={{
          position: 'absolute',
          left: barW - 2,
          top: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {entity.flagCode || entity.flagDataUri ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entity.flagDataUri ?? `${flagBaseUrl}/w80/${entity.flagCode}.png`}
            style={{
              height: flagSize,
              marginRight: 12,
              boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            }}
          />
        ) : (
          <div style={{ marginRight: 12 }}>
            <LogoBadge name={entity.name} color={entity.color} size={flagSize} invert />
          </div>
        )}

        {/* value in dark type past the flag */}
        <div
          style={{
            whiteSpace: 'nowrap',
            fontSize: valueFont,
            fontWeight: 700,
            color: '#1f2937',
            fontVariantNumeric: 'tabular-nums',
            marginRight: nameFitsInside ? 0 : 14,
          }}
        >
          {formatRaceValue(value, unit)}
        </div>

        {/* name outside the bar when too narrow to hold it */}
        {!nameFitsInside ? (
          <div
            style={{
              whiteSpace: 'nowrap',
              color: '#1f2937',
              fontWeight: 800,
              fontSize: nameFont,
              letterSpacing: '-0.01em',
            }}
          >
            {entity.name}
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** Race-style value formatting: full numbers with separators, like the reference. */
export function formatRaceValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return '-';
  if (unit === 'percent') return `${value.toFixed(2)}%`;
  if (unit === 'currency') return `$${Math.round(value).toLocaleString('en-US')}`;
  if (unit === 'count') return Math.round(value).toLocaleString('en-US');
  return compactNumber(value);
}

/**
 * Insert thousand separators into bare long digit runs inside narrative text
 * (e.g. story copy like "a population of 667070000" renders as "667,070,000").
 * Years (4 digits) and already-separated numbers are left untouched.
 */
export function formatNarrativeNumbers(text: string): string {
  return text.replace(/\b\d{5,}\b/g, (m) => Number(m).toLocaleString('en-US'));
}

// ---------------------------------------------------------------------------
// Era panel (the right-hand column: giant year, era title, narrative, flags)
// ---------------------------------------------------------------------------

export interface EraPanelProps {
  yearLabel: string;
  title?: string;
  body?: string;
  featured: FrameTapeEntity[];
  flagBaseUrl: string;
  appear: number;
}

/** The right-hand panel from the reference layout. */
export const EraPanel: React.FC<EraPanelProps> = ({ yearLabel, title, body, featured, flagBaseUrl, appear }) => (
  <div style={{ position: 'absolute', left: 968, top: 228, width: 292, opacity: appear }}>
    <div
      style={{
        fontSize: 138,
        fontWeight: 800,
        color: '#b4b4b4',
        letterSpacing: '-0.04em',
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {yearLabel}
    </div>
    {title ? (
      <div style={{ marginTop: 10, fontSize: 34, fontWeight: 800, color: '#111111', lineHeight: 1.15, letterSpacing: '-0.02em' }}>
        {title}
      </div>
    ) : null}
    {body ? (
      <div style={{ marginTop: 14, fontSize: 23, fontWeight: 500, color: '#5c5c5c', lineHeight: 1.42 }}>{formatNarrativeNumbers(body)}</div>
    ) : null}
    {featured.length > 0 ? (
      <div style={{ marginTop: 22, display: 'flex', gap: 14 }}>
        {featured.slice(0, 2).map((entity) =>
          entity.flagCode || entity.flagDataUri ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={entity.id}
              src={entity.flagDataUri ?? `${flagBaseUrl}/w160/${entity.flagCode}.png`}
              style={{ height: 92, boxShadow: '0 2px 8px rgba(0,0,0,0.22)' }}
            />
          ) : (
            <LogoBadge key={entity.id} name={entity.name} color={entity.color} size={92} />
          ),
        )}
      </div>
    ) : null}
  </div>
);

/** Share gauge: the leader's slice of the visible total. */
export const ShareGauge: React.FC<{ fraction: number; label: string; theme: Theme; color: string; width: number; appear: number }> = ({
  fraction,
  label,
  theme,
  color,
  width,
  appear,
}) => {
  const clamped = Math.max(0.02, Math.min(1, fraction));
  return (
    <div style={{ width, opacity: appear }}>
      <div style={{ height: 16, background: theme.barTrack, borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ width: `${clamped * 100}%`, height: '100%', background: color, borderRadius: 8 }} />
      </div>
      <div style={{ marginTop: 6, fontSize: 15, fontWeight: 700, color: theme.secondaryText, textAlign: 'right' }}>{label}</div>
    </div>
  );
};
/** Vertical bar chart used for the secondary "by group" panel. */
export const GroupBarChart: React.FC<{
  groups: Array<{ label: string; value: number; color: string }>;
  theme: Theme;
  width: number;
  height: number;
  appear: number;
}> = ({ groups, theme, width, height, appear }) => {
  const max = Math.max(1, ...groups.map((g) => g.value));
  const columnWidth = width / Math.max(1, groups.length);
  return (
    <div style={{ width, height, display: 'flex', alignItems: 'flex-end', gap: columnWidth * 0.22, opacity: appear }}>
      {groups.map((group) => {
        // Keep a minimum height so a small value still reads as a bar, not a rule.
        const h = Math.max(6, (group.value / max) * height * 0.72);
        return (
          <div key={group.label} style={{ width: columnWidth * 0.78, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
            <div style={{ fontSize: height * 0.075, fontWeight: 700, color: theme.secondaryText, marginBottom: height * 0.03, fontVariantNumeric: 'tabular-nums' }}>
              {compactNumber(group.value)}
            </div>
            <div style={{ width: '100%', height: h, background: group.color, borderRadius: `${height * 0.05}px ${height * 0.05}px 0 0` }} />
            <div style={{ fontSize: height * 0.075, fontWeight: 700, color: theme.primaryText, marginTop: height * 0.035, textAlign: 'center' }}>
              {group.label}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** Pale ring used beside the summary number. */
export const PieSummary: React.FC<{ fraction: number; theme: Theme; size?: number }> = ({ fraction, theme, size = 92 }) => {
  const clamped = Math.max(0.03, Math.min(1, fraction));
  const radius = size / 2 - 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="#fde8ea" stroke={theme.primaryText} strokeWidth={1.5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={theme.accent}
        strokeWidth={radius * 0.62}
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
};

/** Large light date stamp, e.g. "09/2008". */
export const BigDate: React.FC<{ label: string; theme: Theme; fontSize: number }> = ({ label, theme, fontSize }) => (
  <div style={{ fontSize, fontWeight: 800, color: theme.mutedText, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
    {label}
  </div>
);

/** Animated value that counts up between two frames. */
export const NumberCounter: React.FC<{ from: number; to: number; progress: number; unit: string; theme: Theme; fontSize: number }> = ({ from, to, progress, unit, theme, fontSize }) => {
  const value = from + (to - from) * progress;
  return (
    <div style={{ fontSize, fontWeight: 800, color: theme.primaryText, fontVariantNumeric: 'tabular-nums' }}>
      {formatValue(value, unit)}
    </div>
  );
};

export const useAppear = (startFrame: number, durationInFrames = 12): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - startFrame, fps, durationInFrames, config: { damping: 200 } });
};

export const fadeBetween = (frame: number, start: number, end: number): number =>
  interpolate(frame, [start, end], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
// ---------------------------------------------------------------------------
// Fact box (the "Nokia Peak" panel from the reference layout)
// ---------------------------------------------------------------------------

export interface FactBoxProps {
  heading: string;
  body: string;
  dateLabel?: string;
  wordmark?: string;
  theme: Theme;
  appear: number;
  width: number;
  accentColor?: string;
}

export const FactBox: React.FC<FactBoxProps> = ({ heading, body, dateLabel, wordmark, theme, appear, width, accentColor }) => (
  <div
    style={{
      width,
      opacity: appear,
      transform: `translateY(${(1 - appear) * 18}px)`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 18,
    }}
  >
    <div style={{ width: '100%', height: 6, borderRadius: 3, background: accentColor ?? theme.accent, opacity: 0.9 }} />
    <div style={{ width: '100%', fontSize: 46, fontWeight: 800, color: theme.primaryText, letterSpacing: '-0.02em', textAlign: 'right' }}>{heading}</div>
    <div style={{ width: '100%', fontSize: 24, fontWeight: 600, color: theme.secondaryText, lineHeight: 1.35, textAlign: 'right' }}>{body}</div>
    {wordmark ? (
      <div style={{ width: '100%', fontSize: 62, fontWeight: 900, color: accentColor ?? theme.primaryText, letterSpacing: '-0.04em', textAlign: 'right', lineHeight: 1 }}>
        {wordmark}
      </div>
    ) : null}
    {dateLabel ? <BigDate label={dateLabel} theme={theme} fontSize={72} /> : null}
  </div>
);

// ---------------------------------------------------------------------------
// Highlight arrow
// ---------------------------------------------------------------------------

export const HighlightArrow: React.FC<{ theme: Theme; color: string; appear: number; size?: number }> = ({ color, appear, size = 34 }) => (
  <div
    style={{
      width: size,
      height: size,
      opacity: appear,
      transform: `translateX(${(1 - appear) * 10}px)`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color,
      fontSize: size,
      fontWeight: 900,
      lineHeight: 1,
    }}
  >
    ▲
  </div>
);

// ---------------------------------------------------------------------------
// Title + source card
// ---------------------------------------------------------------------------

export const TitleBlock: React.FC<{ title: string; subtitle?: string; theme: Theme; appear: number; titleSize?: number; subtitleSize?: number; align?: 'center' | 'left' }> = ({
  title,
  subtitle,
  theme,
  appear,
  titleSize = 64,
  subtitleSize = 28,
  align = 'center',
}) => (
  <div style={{ width: '100%', textAlign: align, opacity: appear, transform: `translateY(${(1 - appear) * 16}px)` }}>
    <div style={{ fontSize: titleSize, fontWeight: 800, color: theme.primaryText, letterSpacing: '-0.03em', lineHeight: 1.08 }}>{title}</div>
    {subtitle ? <div style={{ fontSize: subtitleSize, fontWeight: 600, color: theme.secondaryText, marginTop: titleSize * 0.28 }}>{subtitle}</div> : null}
  </div>
);

export const SourceCard: React.FC<{ sourcesLine: string; sources: Array<{ url: string; publisher: string }>; theme: Theme; appear: number }> = ({
  sourcesLine,
  sources,
  theme,
  appear,
}) => (
  <div style={{ width: '86%', opacity: appear, display: 'flex', flexDirection: 'column', gap: 26 }}>
    <div style={{ fontSize: 44, fontWeight: 800, color: theme.primaryText, letterSpacing: '-0.02em' }}>Sources</div>
    <div style={{ fontSize: 24, fontWeight: 600, color: theme.secondaryText }}>{sourcesLine}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {sources.slice(0, 8).map((source) => (
        <div key={source.url} style={{ fontSize: 19, color: theme.secondaryText, borderLeft: `4px solid ${theme.accent}`, paddingLeft: 14 }}>
          <span style={{ fontWeight: 700, color: theme.primaryText }}>{source.publisher}</span> — {source.url}
        </div>
      ))}
    </div>
    <div style={{ fontSize: 17, color: theme.mutedText }}>Every value in this video is traceable to one of the sources above. Missing values are shown as missing, never guessed.</div>
  </div>
);

// ---------------------------------------------------------------------------
// Canvas chrome
// ---------------------------------------------------------------------------

export const Canvas: React.FC<{ theme: Theme; children: React.ReactNode }> = ({ theme, children }) => (
  <AbsoluteFill
    style={{
      backgroundColor: theme.background,
      fontFamily: theme.fontFamily,
      backgroundImage: `radial-gradient(circle at 50% 45%, ${theme.background} 55%, #eef0f3 100%)`,
    }}
  >
    {children}
  </AbsoluteFill>
);

export const NoteStrip: React.FC<{ notes: string[]; theme: Theme; opacity?: number }> = ({ notes, theme, opacity = 0.62 }) => {
  if (notes.length === 0) return null;
  return (
    <div style={{ position: 'absolute', left: 46, bottom: 20, maxWidth: 1000, fontSize: 15, lineHeight: 1.35, color: theme.secondaryText, opacity }}>
      {notes.slice(0, 2).map((note, index) => (
        <div key={index}>• {note}</div>
      ))}
    </div>
  );
};