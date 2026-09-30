import { createHmac } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  verifyBusinessObjectReference,
  type ObjectReferenceKey,
} from "./object-reference.js";
export const REPEATED_TOPIC = "frontend-insight.objects.v1";
const DAY = 86400000;
export function objectReferenceKeys(
  secret: string,
  projectId: string,
  env: string,
  now: number,
): ObjectReferenceKey[] {
  if (secret.length < 32) throw new Error("OBJECT_REFERENCE_SECRET_INVALID");
  const epoch = Math.floor(now / DAY);
  return Array.from({ length: 4 }, (_, i) => ({
    epoch: epoch - i,
    secret: createHmac("sha256", secret)
      .update(JSON.stringify(["r4c-object-key-1", projectId, env, epoch - i]))
      .digest(),
  }));
}
export interface ObjectOperation {
  project: string;
  env: string;
  user: string;
  session: string;
  instance: string;
  operation: string;
  objectType: string;
  at: number;
  received: number;
  aliases: { epoch: number; digest: string }[];
}
export function verifyObjectOperation(
  ticket: string,
  input: Omit<ObjectOperation, "aliases" | "objectType">,
  secret: string,
): ObjectOperation {
  // Only the trusted signature authorizes the controlled object type. Never trust this peek alone.
  let type: string;
  try {
    type = JSON.parse(
      Buffer.from(ticket.slice(4).split(".")[0]!, "base64url").toString(),
    ).objectType;
  } catch {
    throw new Error("OBJECT_REFERENCE_INVALID");
  }
  const body = verifyBusinessObjectReference(ticket, {
    projectId: input.project,
    env: input.env,
    allowedObjectTypes: [type],
    eventAt: input.at,
    receivedAt: input.received,
    keys: objectReferenceKeys(secret, input.project, input.env, input.received),
  });
  return { ...input, objectType: body.objectType, aliases: body.aliases };
}
export function parseObjectOperations(value: unknown, now: number): ObjectOperation[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new Error("OBJECT_ENVELOPE_INVALID");
  for (const f of value as ObjectOperation[]) {
    if (
      !f ||
      Object.keys(f).sort().join(",") !==
        "aliases,at,env,instance,objectType,operation,project,received,session,user" ||
      !/^[a-f0-9-]{36}$/.test(f.project) ||
      !["prod", "staging", "dev"].includes(f.env) ||
      !/^[a-f0-9]{64}$/.test(f.user) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(f.session) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(f.instance) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(f.operation) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(f.objectType) ||
      !Number.isSafeInteger(f.at) ||
      !Number.isSafeInteger(f.received) ||
      Math.abs(f.at - f.received) > DAY ||
      f.received > now + 60000 ||
      now - f.received >= 2 * DAY ||
      !Array.isArray(f.aliases) ||
      f.aliases.length !== 4 ||
      f.aliases.some(
        (a) =>
          Object.keys(a).sort().join(",") !== "digest,epoch" ||
          !Number.isSafeInteger(a.epoch) ||
          !/^[a-f0-9]{64}$/.test(a.digest),
      )
    )
      throw new Error("OBJECT_ENVELOPE_INVALID_OR_EXPIRED");
  }
  return value as ObjectOperation[];
}
export interface RepeatedProof {
  project: string;
  env: string;
  user: string;
  session: string;
  instance: string;
  operation: string;
  at: number;
  received: number;
  proof_from: number;
  proof_to: number;
  proof_received: number;
  hit: number;
  processed: number;
}
/** Only reference-free receipts and three-operation witnesses survive short storage. */
export function repeatedProofs(
  facts: ObjectOperation[],
  processed: number,
): RepeatedProof[] {
  if (facts.length > 50000) throw new Error("REPEATED_FACT_LIMIT");
  const unique = new Map<string, ObjectOperation>();
  for (const f of facts) {
    const key = JSON.stringify([f.project, f.env, f.instance]);
    const prior = unique.get(key);
    if (
      prior &&
      JSON.stringify({ ...prior, received: 0 }) !==
        JSON.stringify({ ...f, received: 0 })
    )
      throw new Error("REPEATED_INSTANCE_CONFLICT");
    if (!prior || prior.received > f.received) unique.set(key, f);
  }
  // Each overlapping epoch is a valid same-object witness; duplicate witnesses are idempotent.
  const groups = new Map<string, ObjectOperation[]>();
  const rows: RepeatedProof[] = [];
  const row = (f: ObjectOperation, witness: ObjectOperation[] = []): RepeatedProof => ({
    project: f.project,
    env: f.env,
    user: f.user,
    session: f.session,
    instance: f.instance,
    operation: f.operation,
    at: f.at,
    received: f.received,
    hit: witness.length ? 1 : 0,
    proof_from: witness.length ? Math.min(...witness.map((x) => x.at)) : f.at,
    proof_to: witness.length ? Math.max(...witness.map((x) => x.at)) : f.at,
    proof_received: witness.length
      ? Math.max(...witness.map((x) => x.received))
      : f.received,
    processed,
  });
  for (const f of unique.values()) {
    rows.push(row(f));
    for (const a of f.aliases) {
      const key = JSON.stringify([
        f.project,
        f.env,
        f.user,
        f.operation,
        f.objectType,
        a.epoch,
        a.digest,
      ]);
      const group = groups.get(key) ?? [];
      group.push(f);
      groups.set(key, group);
    }
  }
  const proofs = new Map<string, RepeatedProof>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.at - b.at || a.instance.localeCompare(b.instance));
    for (let i = 2; i < group.length; i++) {
      const witness = group.slice(i - 2, i + 1);
      if (witness[2]!.at - witness[0]!.at > DAY) continue;
      for (const f of witness) {
        const p = row(f, witness);
        proofs.set(JSON.stringify(p), p);
      }
    }
  }
  return rows.concat([...proofs.values()]);
}
export async function projectRepeatedOperations(
  client: ClickHouseClient,
  incoming: ObjectOperation[],
  now = Date.now(),
) {
  parseObjectOperations(incoming, now);
  if (!incoming.length) return;
  await client.insert({
    table: "object_operation_refs",
    format: "JSONEachRow",
    values: incoming.map((f) => ({ ...f, aliases: JSON.stringify(f.aliases) })),
  });
  const result = await client.query({
    query: `SELECT project,env,user,session,instance,operation,objectType,at,received,aliases FROM object_operation_refs WHERE project IN {projects:Array(UUID)} AND received>{cutoff:Int64} LIMIT 50001`,
    query_params: {
      projects: [...new Set(incoming.map((f) => f.project))],
      cutoff: now - 2 * DAY,
    },
    format: "JSONEachRow",
    clickhouse_settings: {
      max_execution_time: 5,
      max_rows_to_read: "1000000",
      read_overflow_mode: "throw",
    },
  });
  const rows = await result.json<
    Omit<ObjectOperation, "aliases"> & { aliases: string }
  >();
  const proofs = repeatedProofs(
    rows.map((f) => ({
      ...f,
      at: Number(f.at),
      received: Number(f.received),
      aliases: JSON.parse(f.aliases),
    })),
    now,
  );
  await client.insert({
    table: "repeated_operation_proofs",
    format: "JSONEachRow",
    values: proofs.filter((p) =>
      p.hit
        ? p.proof_received >= Math.min(...incoming.map((f) => f.received))
        : incoming.some(
            (f) =>
              f.project === p.project && f.env === p.env && f.instance === p.instance,
          ),
    ),
  });
}
