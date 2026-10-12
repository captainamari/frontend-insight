export interface StackFrame {
  raw: string;
  function: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  native: boolean;
  eval: boolean;
  async: boolean;
}
/** Compiled stack only. No fetching arbitrary URLs or source-map inference. */
export function parseErrorStack(stack: unknown, maxFrames = 32) {
  if (typeof stack !== "string" || !stack)
    return { state: "unavailable", frames: [] as StackFrame[], unparsed: 0 };
  const frames: StackFrame[] = [];
  let unparsed = 0;
  for (const raw of stack.split("\n").slice(0, 128)) {
    let value = raw.trim(),
      fn: string | null = null;
    if (!value) continue;
    const chrome = value.startsWith("at ");
    if (chrome) {
      value = value.slice(3);
      const wrapper = value.indexOf(" (");
      if (wrapper >= 0 && value.endsWith(")")) {
        fn = value.slice(0, wrapper);
        value = value.slice(wrapper + 2, -1);
      }
    } else if (value.includes("@")) {
      const at = value.indexOf("@");
      fn = value.slice(0, at) || null;
      value = value.slice(at + 1);
    } else if (!/:\d+(?::\d+)?$/.test(value)) {
      if (frames.length || !/^(?:[\w.]*Error|Error|Exception)(?::|$)/.test(value))
        unparsed++;
      continue;
    }
    const async = /^async\b/.test(fn ?? value);
    if (!fn && value.startsWith("async ")) value = value.slice(6);
    const anonymous = value === "<anonymous>";
    const isEval = /\beval\b/.test(value) || /\beval\b/.test(fn ?? "");
    // Chrome eval location: eval at foo (asset:1:2), <anonymous>:3:4.
    if (isEval && value.includes(", "))
      value = value.slice(value.lastIndexOf(", ") + 2);
    const location = value.match(/^(.*?):(\d+):(\d+)$/) ?? value.match(/^(.*?):(\d+)$/);
    const native = /^(?:native|\[native code\])$/.test(value);
    if (!location && !native && !anonymous) {
      unparsed++;
      continue;
    }
    frames.push({
      raw,
      function: fn,
      file: location?.[1] ?? (anonymous ? "<anonymous>" : null),
      line: location ? Number(location[2]) : null,
      column: location?.[3] ? Number(location[3]) : null,
      native,
      eval: isEval,
      async,
    });
    if (frames.length >= maxFrames) break;
  }
  return {
    state: frames.length ? (unparsed ? "partial" : "parsed") : "parse_failed",
    frames,
    unparsed,
  };
}
export function diagnosticErrorView(raw: Record<string, unknown>) {
  const error =
    raw.error && typeof raw.error === "object" && !Array.isArray(raw.error)
      ? (raw.error as Record<string, unknown>)
      : raw;
  const resource = typeof error.resourceUrl === "string";
  return {
    error,
    stack: resource
      ? { state: "not_applicable", frames: [] as StackFrame[], unparsed: 0 }
      : parseErrorStack(error.stack),
    extraction: raw.extraction ?? null,
    requests: {
      state:
        raw.requestCapture && typeof raw.requestCapture === "object"
          ? String((raw.requestCapture as Record<string, unknown>).state ?? "legacy")
          : "legacy",
      metadata: raw.requestCapture ?? null,
      records: Array.isArray(raw.requests) ? raw.requests : [],
      actions: Array.isArray(raw.timeline) ? raw.timeline : [],
    },
    console: {
      state:
        raw.consoleCapture && typeof raw.consoleCapture === "object"
          ? String((raw.consoleCapture as Record<string, unknown>).state ?? "legacy")
          : "legacy",
      metadata: raw.consoleCapture ?? null,
      records: Array.isArray(raw.console) ? raw.console : [],
    },
  };
}
