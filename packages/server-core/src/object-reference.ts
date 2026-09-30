/** Trusted host backend / ingestion only. Never import this module into browser SDK code. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
const DAY = 86400000;
const PREFIX = "or1_";
export const OBJECT_REFERENCE_RETENTION_MS = 2 * DAY;
export interface ObjectReferenceKey {
  /** UTC key-rotation epoch, not the metric's rolling-window boundary. */
  epoch: number;
  secret: Uint8Array;
}
interface ReferenceBody {
  v: 1;
  projectId: string;
  env: string;
  objectType: string;
  issuedAt: number;
  keyEpoch: number;
  aliases: { epoch: number; digest: string }[];
}
export class ObjectReferenceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new ObjectReferenceError(code);
}
function keysByEpoch(keys: readonly ObjectReferenceKey[]) {
  if (keys.length > 4 || keys.length < 1) fail("OBJECT_REFERENCE_KEYS_INVALID");
  const result = new Map<number, Uint8Array>();
  for (const k of keys) {
    if (
      !Number.isSafeInteger(k.epoch) ||
      k.epoch < 0 ||
      k.secret.byteLength !== 32 ||
      result.has(k.epoch)
    )
      fail("OBJECT_REFERENCE_KEYS_INVALID");
    result.set(k.epoch, k.secret);
  }
  return result;
}
function scope(projectId: string, env: string, objectType: string) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      projectId,
    ) ||
    !["prod", "staging", "dev"].includes(env) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(objectType)
  )
    fail("OBJECT_REFERENCE_SCOPE_INVALID");
}
const mac = (secret: Uint8Array, domain: string, input: string) =>
  createHmac("sha256", secret)
    .update(domain + "\0" + input)
    .digest();
export function generateObjectReferenceKey(epoch: number): ObjectReferenceKey {
  if (!Number.isSafeInteger(epoch) || epoch < 0) fail("OBJECT_REFERENCE_KEYS_INVALID");
  return { epoch, secret: randomBytes(32) };
}
/** The raw object ID is handled only here in the trusted host, never sent to the platform. */
export function mintBusinessObjectReference(input: {
  projectId: string;
  env: string;
  objectType: string;
  rawObjectId: string;
  issuedAt: number;
  keys: readonly ObjectReferenceKey[];
}): string {
  scope(input.projectId, input.env, input.objectType);
  if (
    typeof input.rawObjectId !== "string" ||
    !input.rawObjectId.length ||
    input.rawObjectId.length > 256 ||
    !Number.isSafeInteger(input.issuedAt) ||
    input.issuedAt < 0
  )
    fail("OBJECT_REFERENCE_INPUT_INVALID");
  const keys = keysByEpoch(input.keys),
    epoch = Math.floor(input.issuedAt / DAY);
  const aliases = Array.from({ length: 4 }, (_, offset) => {
    const keyEpoch = epoch - offset,
      secret = keys.get(keyEpoch);
    if (!secret) fail("OBJECT_REFERENCE_OVERLAP_KEYS_MISSING");
    return {
      epoch: keyEpoch,
      digest: mac(
        secret,
        "reference",
        JSON.stringify([
          input.projectId,
          input.env,
          input.objectType,
          input.rawObjectId,
        ]),
      ).toString("hex"),
    };
  });
  const body: ReferenceBody = {
    v: 1,
    projectId: input.projectId,
    env: input.env,
    objectType: input.objectType,
    issuedAt: input.issuedAt,
    keyEpoch: epoch,
    aliases,
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  return (
    PREFIX +
    encoded +
    "." +
    mac(keys.get(epoch)!, "attestation", encoded).toString("base64url")
  );
}
/** Project/env/operation timestamp come from the ingestion context, never from ticket claims. */
export function verifyBusinessObjectReference(
  ticket: string,
  context: {
    projectId: string;
    env: string;
    allowedObjectTypes: readonly string[];
    eventAt: number;
    receivedAt: number;
    keys: readonly ObjectReferenceKey[];
  },
): Readonly<ReferenceBody> {
  if (
    typeof ticket !== "string" ||
    ticket.length > 2048 ||
    !/^or1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket)
  )
    fail("OBJECT_REFERENCE_INVALID");
  const [encoded, signature] = ticket.slice(PREFIX.length).split(".");
  let body: ReferenceBody;
  try {
    body = JSON.parse(
      Buffer.from(encoded!, "base64url").toString("utf8"),
    ) as ReferenceBody;
  } catch {
    return fail("OBJECT_REFERENCE_INVALID");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Object.keys(body).sort().join(",") !==
      "aliases,env,issuedAt,keyEpoch,objectType,projectId,v" ||
    body.v !== 1 ||
    !Number.isSafeInteger(body.issuedAt) ||
    !Number.isSafeInteger(body.keyEpoch) ||
    body.keyEpoch !== Math.floor(body.issuedAt / DAY)
  )
    fail("OBJECT_REFERENCE_INVALID");
  scope(body.projectId, body.env, body.objectType);
  if (
    body.projectId !== context.projectId ||
    body.env !== context.env ||
    context.allowedObjectTypes.length > 50 ||
    !context.allowedObjectTypes.includes(body.objectType)
  )
    fail("OBJECT_REFERENCE_SCOPE_MISMATCH");
  const key = keysByEpoch(context.keys).get(body.keyEpoch);
  if (!key) fail("OBJECT_REFERENCE_KEY_UNAVAILABLE");
  const supplied = Buffer.from(signature!, "base64url"),
    expected = mac(key, "attestation", encoded!);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    fail("OBJECT_REFERENCE_SIGNATURE_INVALID");
  if (
    !Number.isSafeInteger(context.eventAt) ||
    !Number.isSafeInteger(context.receivedAt) ||
    Math.abs(context.eventAt - context.receivedAt) > DAY ||
    Math.abs(body.issuedAt - context.eventAt) > DAY ||
    body.issuedAt > context.receivedAt + DAY ||
    context.receivedAt - body.issuedAt > OBJECT_REFERENCE_RETENTION_MS
  )
    fail("OBJECT_REFERENCE_EXPIRED_OR_CLOCK_INVALID");
  if (
    !Array.isArray(body.aliases) ||
    body.aliases.length !== 4 ||
    body.aliases.some(
      (a, i) =>
        !a ||
        Object.keys(a).sort().join(",") !== "digest,epoch" ||
        a.epoch !== body.keyEpoch - i ||
        typeof a.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(a.digest),
    )
  )
    fail("OBJECT_REFERENCE_INVALID");
  return Object.freeze({
    ...body,
    aliases: body.aliases.map((a) => Object.freeze({ ...a })),
  });
}
