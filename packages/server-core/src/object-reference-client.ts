import {
  mintBusinessObjectReference,
  type ObjectReferenceKey,
} from "./object-reference.js";
/** Trusted business backend only. Neither platform credentials nor signing keys enter the browser. */
export function createObjectReferenceProvider(config: {
  apiBase: string;
  projectId: string;
  env: "dev" | "staging" | "prod";
  accessToken: () => Promise<string>;
}) {
  let cached: { until: number; keys: ObjectReferenceKey[] } | null = null;
  return async (objectType: string, rawObjectId: string): Promise<string> => {
    const now = Date.now();
    if (!cached || now >= cached.until) {
      const response = await fetch(
        config.apiBase.replace(/\/$/, "") +
          `/api/projects/${config.projectId}/object-reference-keys`,
        {
          method: "POST",
          signal: AbortSignal.timeout(10000),
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + (await config.accessToken()),
          },
          body: JSON.stringify({ env: config.env }),
        },
      );
      if (!response.ok) throw new Error("OBJECT_REFERENCE_KEYS_UNAVAILABLE");
      const body = (await response.json()) as {
        projectId: string;
        env: string;
        expiresAt: string;
        keys: { epoch: number; secret: string }[];
      };
      if (
        body.projectId !== config.projectId ||
        body.env !== config.env ||
        !Array.isArray(body.keys) ||
        body.keys.length !== 4 ||
        body.keys.some(
          (k) => !Number.isSafeInteger(k.epoch) || !/^[a-f0-9]{64}$/.test(k.secret),
        )
      )
        throw new Error("OBJECT_REFERENCE_KEYS_INVALID");
      const until = Date.parse(body.expiresAt);
      if (!Number.isFinite(until) || until <= now || until > now + 86400000)
        throw new Error("OBJECT_REFERENCE_KEYS_INVALID");
      cached = {
        until,
        keys: body.keys.map((k) => ({
          epoch: k.epoch,
          secret: Buffer.from(k.secret, "hex"),
        })),
      };
    }
    return mintBusinessObjectReference({
      projectId: config.projectId,
      env: config.env,
      objectType,
      rawObjectId,
      issuedAt: now,
      keys: cached.keys,
    });
  };
}
