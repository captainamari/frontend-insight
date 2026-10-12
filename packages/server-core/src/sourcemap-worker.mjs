// No filesystem, network, eval, source execution or section URL resolution.
import { parentPort, workerData } from "node:worker_threads";
import {
  TraceMap,
  decodedMappings,
  originalPositionFor,
  sourceContentFor,
} from "@jridgewell/trace-mapping";
const fail = (state) => {
  throw new Error(state);
};
try {
  const data = JSON.parse(workerData.map);
  if (
    data?.version !== 3 ||
    data.sections !== undefined ||
    !Array.isArray(data.sources) ||
    !Array.isArray(data.names) ||
    typeof data.mappings !== "string"
  )
    fail("unsupported_format");
  if (
    data.sources.length > 2048 ||
    data.names.length > 10000 ||
    data.mappings.length > 1048576
  )
    fail("parse_budget");
  if (
    !data.sources.every((s) => typeof s === "string" && s.length <= 2048) ||
    !data.names.every((s) => typeof s === "string" && s.length <= 512) ||
    (data.sourceRoot !== undefined &&
      (typeof data.sourceRoot !== "string" || data.sourceRoot.length > 2048)) ||
    (data.sourcesContent !== undefined &&
      (!Array.isArray(data.sourcesContent) ||
        data.sourcesContent.length !== data.sources.length ||
        !data.sourcesContent.every((s) => s === null || typeof s === "string")))
  )
    fail("parse_failed");
  if (!/^[A-Za-z0-9+/,;]*$/.test(data.mappings)) fail("parse_failed");
  const map = new TraceMap(data);
  let count = 0;
  for (const line of decodedMappings(map)) {
    let last = -1;
    for (const s of line) {
      if (++count > 100000) fail("parse_budget");
      if (
        ![1, 4, 5].includes(s.length) ||
        !s.every(Number.isSafeInteger) ||
        s[0] < 0 ||
        s[0] < last ||
        (s.length > 1 &&
          (s[1] < 0 || s[1] >= data.sources.length || s[2] < 0 || s[3] < 0)) ||
        (s.length === 5 && (s[4] < 0 || s[4] >= data.names.length))
      )
        fail("parse_failed");
      last = s[0];
    }
  }
  const frames = workerData.frames.map((f) => {
    const original = originalPositionFor(map, { line: f.line, column: f.column - 1 });
    if (original.source === null) return { state: "mapping_not_found" };
    const content = sourceContentFor(map, original.source);
    const location = {
      file: original.source,
      function: original.name,
      line: original.line,
      column: original.column + 1,
    };
    if (content === null) return { state: "no_sources_content", original: location };
    const lines = content.split(/\r\n|\n|\r/),
      start = Math.max(1, original.line - 2),
      end = Math.min(lines.length, original.line + 2);
    const snippet = lines
      .slice(start - 1, end)
      .map((text, i) => ({ line: start + i, text }));
    if (Buffer.byteLength(JSON.stringify(snippet)) > 4096)
      return { state: "output_budget", original: location };
    return { state: "mapped", original: location, snippet };
  });
  parentPort.postMessage({ state: "ready", frames });
} catch (e) {
  parentPort.postMessage({
    state: ["unsupported_format", "parse_budget", "output_budget"].includes(e?.message)
      ? e.message
      : "parse_failed",
    frames: [],
  });
}
