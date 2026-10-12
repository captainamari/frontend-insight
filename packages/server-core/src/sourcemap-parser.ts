import { Worker } from "node:worker_threads";
export const SOURCEMAP_LIMITS = {
  mapBytes: 2 * 1024 * 1024,
  assetBytes: 1024 * 1024,
  bodyBytes: 4500000,
  projectBytes: 100 * 1024 * 1024,
  projectFiles: 200,
  frames: 32,
  outputBytes: 65536,
  workerMs: 1500,
  workers: 2,
} as const;
export class SourceMapError extends Error {
  constructor(public readonly state: string) {
    super(`SOURCEMAP_${state.toUpperCase()}`);
  }
}
export interface MappedFrame {
  state: string;
  original?: { file: string; function: string | null; line: number; column: number };
  snippet?: { line: number; text: string }[];
}
export interface ParsedMap {
  state: string;
  frames: MappedFrame[];
}
let active = 0;
export async function parseSourceMap(
  map: string,
  frames: { line: number; column: number }[] = [],
): Promise<ParsedMap> {
  if (
    Buffer.byteLength(map) > SOURCEMAP_LIMITS.mapBytes ||
    frames.length > SOURCEMAP_LIMITS.frames
  )
    return { state: "parse_budget", frames: [] };
  if (active >= SOURCEMAP_LIMITS.workers) return { state: "busy", frames: [] };
  active++;
  try {
    return await new Promise<ParsedMap>((resolve) => {
      const worker = new Worker(new URL("./sourcemap-worker.mjs", import.meta.url), {
        workerData: { map, frames },
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 8,
          stackSizeMb: 2,
        },
      });
      let done = false;
      const finish = (value: ParsedMap) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void worker.terminate().then(() => resolve(value));
      };
      const timer = setTimeout(
        () => finish({ state: "parse_budget", frames: [] }),
        SOURCEMAP_LIMITS.workerMs,
      );
      worker.once("message", finish);
      worker.once("error", () => finish({ state: "parse_budget", frames: [] }));
      worker.once("exit", () => finish({ state: "parse_failed", frames: [] }));
    });
  } finally {
    active--;
  }
}
/** Exact WHATWG URL identity. Query retained, fragment discarded. Relative paths
 * need an explicit absolute page/base URL; no basename/CDN-prefix fallback. */
export function canonicalAsset(input: string, base?: string): string {
  if (
    input.length > 2048 ||
    [...input].some((c) => c.charCodeAt(0) <= 32 || c === "\\") ||
    /(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(input)
  )
    throw new SourceMapError("invalid_asset");
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new SourceMapError("invalid_asset");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new SourceMapError("invalid_asset");
  url.hash = "";
  if (url.href.length > 2048) throw new SourceMapError("invalid_asset");
  return url.href;
}
