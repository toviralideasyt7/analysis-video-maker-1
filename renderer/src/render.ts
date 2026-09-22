/**
 * Render CLI.
 *
 *   npx tsx src/render.ts --project ../projects/<id> --out renders/<id>.mp4
 *   npx tsx src/render.ts --project ../projects/<id> --thumbnail-only
 *
 * Reads the approved project bundle (video-spec.json + dataset.json +
 * frames.json + thumbnail.json), validates the VideoSpec against the shared
 * schema, then renders with Remotion. It deliberately refuses to render a spec
 * that fails validation or a dataset whose quality gate failed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { get } from 'node:https';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { semanticVideoSpecProblems, validateVideoSpec } from '@avm/shared';
import type { Dataset, Story, ThumbnailSpec, VideoSpec } from '@avm/shared';
import type { FrameTape } from './frameTape';
import type { RenderInput } from './types';
import { DEFAULT_FLAG_BASE } from './types';

interface Args {
  project?: string;
  out?: string;
  thumbnailOnly: boolean;
  stillFrame?: number;
  skipQualityGate: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { thumbnailOnly: false, skipQualityGate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project' || a === '--in') args.project = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--thumbnail' || a === '--thumbnail-only') args.thumbnailOnly = true;
    else if (a === '--still-frame') args.stillFrame = Number(argv[++i]);
    else if (a === '--skip-quality-gate') args.skipQualityGate = true;
  }
  return args;
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`missing required file: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Fetch a flag PNG and return it as a data URI. Flags are embedded at render
 * time so frames never depend on flag CDNs being reachable from the browser
 * (sandboxed CI runners in particular often can't load them due to TLS
 * interception). Failures resolve to undefined and components fall back to
 * the remote URL.
 */
function fetchFlagDataUri(flagBaseUrl: string, code: string): Promise<string | undefined> {
  const url = `${flagBaseUrl}/w160/${code.toLowerCase()}.png`;
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(undefined), 15000);
    get(url, { headers: { 'User-Agent': 'analysis-video-maker/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        res.resume();
        resolvePromise(undefined);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) resolvePromise(undefined);
        else resolvePromise(`data:image/png;base64,${buf.toString('base64')}`);
      });
      res.on('error', () => {
        clearTimeout(timer);
        resolvePromise(undefined);
      });
    }).on('error', () => {
      clearTimeout(timer);
      resolvePromise(undefined);
    });
  });
}

/** Populate `flagDataUri` on every entity that has a flagCode. */
async function embedFlags(input: RenderInput): Promise<void> {
  const base = input.flagBaseUrl ?? DEFAULT_FLAG_BASE;
  const codes = [...new Set(input.frameTape.entities.map((e) => e.flagCode?.toLowerCase()).filter((c): c is string => !!c))];
  if (codes.length === 0) return;
  process.stdout.write(`embedding ${codes.length} flags from ${base}\n`);
  const results = await Promise.all(codes.map((code) => fetchFlagDataUri(base, code)));
  const byCode = new Map(codes.map((code, i) => [code, results[i]]));
  let embedded = 0;
  for (const entity of input.frameTape.entities) {
    const uri = entity.flagCode ? byCode.get(entity.flagCode.toLowerCase()) : undefined;
    if (uri) {
      entity.flagDataUri = uri;
      embedded += 1;
    }
  }
  process.stdout.write(`embedded ${embedded}/${codes.length} flags\n`);
}

async function loadInput(projectDir: string): Promise<{ input: RenderInput; spec: VideoSpec; quality: unknown }> {
  const spec = readJson<VideoSpec>(join(projectDir, 'video-spec.json'));
  const dataset = readJson<Dataset>(join(projectDir, 'dataset.json'));
  const frameTape = readJson<FrameTape>(join(projectDir, 'frames.json'));
  const thumbnailPath = join(projectDir, 'thumbnail.json');
  const thumbnail = existsSync(thumbnailPath) ? readJson<ThumbnailSpec>(thumbnailPath) : undefined;
  const storyPath = join(projectDir, 'story.json');
  const story = existsSync(storyPath) ? readJson<Story>(storyPath) : undefined;
  const quality = existsSync(join(projectDir, 'quality.json')) ? readJson<unknown>(join(projectDir, 'quality.json')) : undefined;
  const input: RenderInput = { videoSpec: spec, dataset, frameTape, thumbnail, story };
  await embedFlags(input);
  return { input, spec, quality };
}

/**
 * Remotion writes `runtime.availableParallelism`-driven concurrency by default;
 * keeping it explicit makes the render reproducible across machines and keeps
 * GitHub-hosted runners inside their memory budget.
 */
const CONCURRENCY = Number(process.env.RENDER_CONCURRENCY ?? 2);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    process.stderr.write('usage: tsx src/render.ts --project <projectDir> [--out <file.mp4>] [--thumbnail]\n');
    process.exit(2);
  }
  const projectDir = resolve(args.project);
  if (!existsSync(projectDir)) throw new Error(`project directory not found: ${projectDir}`);

  const { input, spec, quality } = await loadInput(projectDir);

  // --- gates --------------------------------------------------------------
  const schema = validateVideoSpec(spec);
  if (!schema.valid) throw new Error(`VideoSpec failed validation:\n - ${schema.errors.join('\n - ')}`);
  const semantic = semanticVideoSpecProblems(spec);
  if (semantic.length > 0) throw new Error(`VideoSpec failed semantic checks:\n - ${semantic.join('\n - ')}`);
  if (!args.skipQualityGate && quality) {
    const gate = quality as { passed?: boolean; violations?: number };
    if (gate.passed === false) throw new Error(`data-quality gate failed with ${gate.violations} violations; pass --skip-quality-gate to override`);
  }

  const entry = resolve(import.meta.dirname ?? __dirname, 'index.ts');
  process.stdout.write(`bundling ${entry}\n`);
  const bundleLocation = await bundle({
    entryPoint: entry,
    onProgress: (percent) => {
      if (percent % 25 === 0) process.stdout.write(`  bundle ${percent}%\n`);
    },
  });

  await ensureBrowser();
  const props = { input };

  const out = args.out
    ? resolve(args.out)
    : join(projectDir, 'renders', `${spec.datasetRef}.mp4`);
  mkdirSync(dirname(out), { recursive: true });

  if (args.thumbnailOnly) {
    const composition = await selectComposition({ serveUrl: bundleLocation, id: 'Thumbnail', inputProps: props });
    await renderStill({ composition, serveUrl: bundleLocation, output: out.replace(/\.mp4$/, '.jpg'), inputProps: props, imageFormat: 'jpeg', jpegQuality: 92 });
    process.stdout.write(`thumbnail: ${out.replace(/\.mp4$/, '.jpg')}\n`);
    return;
  }

  const composition = await selectComposition({ serveUrl: bundleLocation, id: 'DataRace', inputProps: props });

  if (args.stillFrame !== undefined) {
    const target = args.out ? resolve(args.out) : join(projectDir, 'renders', `frame-${args.stillFrame}.png`);
    mkdirSync(dirname(target), { recursive: true });
    const outPng = target.replace(/\.mp4$/, '.png');
    await renderStill({
      composition,
      serveUrl: bundleLocation,
      output: outPng,
      inputProps: props,
      imageFormat: 'png',
      frame: Math.max(0, Math.min(composition.durationInFrames - 1, args.stillFrame)),
    });
    process.stdout.write(`still: ${outPng}\n`);
    return;
  }

  process.stdout.write(`rendering ${composition.durationInFrames} frames @ ${composition.fps}fps (${spec.metadata.durationSeconds}s)\n`);
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: out,
    inputProps: props,
    concurrency: CONCURRENCY,
    videoBitrate: '8M',
    onProgress: ({ renderedFrames, encodedFrames }) => {
      if (renderedFrames % 150 === 0) process.stdout.write(`  ${renderedFrames}/${composition.durationInFrames} frames (${encodedFrames} encoded)\n`);
    },
  });
  writeFileSync(join(dirname(out), 'render-manifest.json'), JSON.stringify({ renderedAt: new Date().toISOString(), out, spec: spec.metadata }, null, 2));
  process.stdout.write(`video: ${out}\n`);
}

main().catch((error) => {
  process.stderr.write(`render failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});