const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "password",
  "passwd",
  "secret",
  "clientsecret",
]);

const BEARER_VALUE = /^\s*bearer\s+\S+/i;
const JWT_VALUE = /^\s*eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\s*$/;
const EMAIL_VALUE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;
const CREDENTIAL_ASSIGNMENT =
  /\b(?:token|password|passwd|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/i;
const URL_WITH_PRIVATE_SUFFIX = /(?:https?:\/\/[^\s?#]+|(?:^|\s)\/[^\s?#]*)[?#][^\s]*/i;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findCredentialLeak(
  value: unknown,
  path = "$",
  seen = new WeakSet<object>(),
): string | null {
  if (typeof value === "string") {
    if (BEARER_VALUE.test(value)) return `${path}:bearer`;
    if (JWT_VALUE.test(value)) return `${path}:jwt`;
    if (EMAIL_VALUE.test(value)) return `${path}:email`;
    if (CREDENTIAL_ASSIGNMENT.test(value)) return `${path}:credential-assignment`;
    if (URL_WITH_PRIVATE_SUFFIX.test(value)) return `${path}:url-query-or-hash`;
    return null;
  }

  if (value === null || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const leak = findCredentialLeak(value[index], `${path}[${index}]`, seen);
      if (leak) return leak;
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (SENSITIVE_KEYS.has(normalizeKey(key))) return `${nestedPath}:field`;
    const leak = findCredentialLeak(nestedValue, nestedPath, seen);
    if (leak) return leak;
  }

  return null;
}
