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

function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findCredentialLeak(value, path = "$", seen = new WeakSet()) {
  if (typeof value === "string") {
    if (BEARER_VALUE.test(value)) {
      return `${path} contains a Bearer credential`;
    }
    if (JWT_VALUE.test(value)) {
      return `${path} contains a JWT-like credential`;
    }
    return null;
  }

  if (value === null || typeof value !== "object") {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
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
    if (SENSITIVE_KEYS.has(normalizeKey(key))) {
      return `${nestedPath} is a forbidden credential field`;
    }
    const leak = findCredentialLeak(nestedValue, nestedPath, seen);
    if (leak) return leak;
  }

  return null;
}
