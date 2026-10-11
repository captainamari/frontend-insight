// Capture before optional collectors install wrappers. Never identify SDK output by text.
const output = globalThis.console;
const warn = output?.warn?.bind(output);
export const sdkWarn = (code: string) => warn?.(`[frontend-insight] ${code}`);
