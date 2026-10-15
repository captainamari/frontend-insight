export type DiagnosticCodeLanguage = "javascript" | "json" | "stack" | "text";

export interface DiagnosticCodeToken {
  kind:
    | "comment"
    | "function"
    | "keyword"
    | "number"
    | "path"
    | "property"
    | "punctuation"
    | "string"
    | "text";
  text: string;
}

const keywords = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

export function diagnosticCodeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "未采集";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function token(kind: DiagnosticCodeToken["kind"], text: string) {
  return { kind, text } satisfies DiagnosticCodeToken;
}

function tokenizeStack(line: string): DiagnosticCodeToken[] {
  const match = line.match(/^(\s*at\s+)(.*?)(\s+\()(.+?)(:\d+:\d+)(\))$/);
  if (!match) {
    const anonymous = line.match(/^(\s*at\s+)(.+?)(:\d+:\d+)$/);
    return anonymous
      ? [
          token("keyword", anonymous[1]!),
          token("path", anonymous[2]!),
          token("number", anonymous[3]!),
        ]
      : [token("text", line)];
  }
  return [
    token("keyword", match[1]!),
    token("function", match[2]!),
    token("punctuation", match[3]!),
    token("path", match[4]!),
    token("number", match[5]!),
    token("punctuation", match[6]!),
  ];
}

function readQuoted(line: string, start: number): number {
  const quote = line[start];
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === "\\") index += 2;
    else if (line[index++] === quote) break;
  }
  return Math.min(index, line.length);
}

function tokenizeStructured(line: string, language: DiagnosticCodeLanguage) {
  const result: DiagnosticCodeToken[] = [];
  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);
    const whitespace = rest.match(/^\s+/)?.[0];
    if (whitespace) {
      result.push(token("text", whitespace));
      index += whitespace.length;
      continue;
    }
    if (language === "javascript" && rest.startsWith("//")) {
      result.push(token("comment", rest));
      break;
    }
    if (language === "javascript" && rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      const text = end < 0 ? rest : rest.slice(0, end + 2);
      result.push(token("comment", text));
      index += text.length;
      continue;
    }
    if (['"', "'", "`"].includes(line[index]!)) {
      const end = readQuoted(line, index);
      const text = line.slice(index, end);
      const after = line.slice(end);
      result.push(token(/^\s*:/.test(after) ? "property" : "string", text));
      index = end;
      continue;
    }
    const number = rest.match(
      /^-?(?:0[xob][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i,
    )?.[0];
    if (number) {
      result.push(token("number", number));
      index += number.length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_$][\w$-]*/)?.[0];
    if (identifier) {
      const after = line.slice(index + identifier.length);
      result.push(
        token(
          keywords.has(identifier)
            ? "keyword"
            : /^\s*:/.test(after)
              ? "property"
              : "text",
          identifier,
        ),
      );
      index += identifier.length;
      continue;
    }
    const punctuation = rest.match(/^[{}[\](),.:;=+*/<>!?&|%-]+/)?.[0];
    if (punctuation) {
      result.push(token("punctuation", punctuation));
      index += punctuation.length;
      continue;
    }
    result.push(token("text", line[index]!));
    index++;
  }
  return result;
}

export function tokenizeDiagnosticCode(
  line: string,
  language: DiagnosticCodeLanguage,
): DiagnosticCodeToken[] {
  if (language === "text") return [token("text", line)];
  if (language === "stack") return tokenizeStack(line);
  return tokenizeStructured(line, language);
}
