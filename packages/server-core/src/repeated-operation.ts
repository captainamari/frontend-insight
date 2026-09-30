import { R4C_FACT_DEFINITION_VERSION } from "./system-metric-catalog.js";
/** C03: rolling inclusive 24h windows, never project calendar days. Internal refs only. */
export interface RepeatedOperationFact {
  projectId: string;
  env: string;
  user: string;
  session: string;
  objectType: string;
  reference: string;
  /** Verified short-lived aliases only; never accept unverified browser claims. */
  aliases?: readonly { epoch: number; digest: string }[];
  operationKey: string;
  instanceId: string;
  at: number;
  received: number;
}
const DAY = 86_400_000;
export function repeatedOperationRate(
  facts: RepeatedOperationFact[],
  context: {
    projectId: string;
    env: string;
    from: number;
    to: number;
    asOf: number;
    scannedFrom: number;
    scannedTo: number;
    coverage: "proven" | "unknown" | "expired";
  },
) {
  if (facts.length > 50000) throw new Error("REPEATED_FACT_LIMIT");
  const instances = new Map<string, RepeatedOperationFact>();
  const conflicts = new Set<string>();
  for (const f of facts) {
    if (
      f.projectId !== context.projectId ||
      f.env !== context.env ||
      f.at > context.asOf ||
      f.received > context.asOf ||
      f.at < context.from - DAY ||
      f.at >= context.to + DAY
    )
      continue;
    const prior = instances.get(f.instanceId);
    if (
      prior &&
      JSON.stringify({ ...prior, received: 0 }) !==
        JSON.stringify({ ...f, received: 0 })
    )
      conflicts.add(f.instanceId);
    else instances.set(f.instanceId, f);
  }
  // Match verified rotation aliases within the complete identity/operation scope.
  // The disjoint-set exists only for this bounded reduction; no stable object ID
  // is persisted or returned. Processing all aliases first makes replay order irrelevant.
  const parents = new Map<string, string>();
  const root = (key: string): string => {
    let head = key;
    while (parents.has(head) && parents.get(head) !== head) head = parents.get(head)!;
    while (parents.has(key) && parents.get(key) !== head) {
      const next = parents.get(key)!;
      parents.set(key, head);
      key = next;
    }
    return head;
  };
  const referenceKeys = (f: RepeatedOperationFact): string[] => {
    const scope = [f.user, f.objectType, f.operationKey];
    if (!f.aliases) return [JSON.stringify([...scope, "single", f.reference])];
    if (
      f.aliases.length !== 4 ||
      f.aliases.some(
        (a, i) =>
          !Number.isSafeInteger(a.epoch) ||
          a.epoch < 0 ||
          !/^[a-f0-9]{64}$/.test(a.digest) ||
          (i > 0 && a.epoch !== f.aliases![i - 1]!.epoch - 1),
      )
    )
      throw new Error("REPEATED_REFERENCE_ALIASES_INVALID");
    return f.aliases.map((a) =>
      JSON.stringify([...scope, "rotating", a.epoch, a.digest]),
    );
  };
  for (const f of instances.values()) {
    if (conflicts.has(f.instanceId) || !f.user || (!f.reference && !f.aliases))
      continue;
    const keys = referenceKeys(f);
    for (const key of keys) if (!parents.has(key)) parents.set(key, key);
    const head = root(keys[0]!);
    for (const key of keys) parents.set(root(key), head);
  }
  const groups = new Map<string, RepeatedOperationFact[]>();
  const denominator = new Set<string>();
  const sessionKey = (f: RepeatedOperationFact) => JSON.stringify([f.user, f.session]);
  for (const f of instances.values()) {
    if (conflicts.has(f.instanceId) || !f.user || (!f.reference && !f.aliases))
      continue;
    if (f.at >= context.from && f.at < context.to) denominator.add(sessionKey(f));
    const key = root(referenceKeys(f)[0]!);
    const group = groups.get(key) ?? [];
    group.push(f);
    groups.set(key, group);
  }
  const hits = new Set<string>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.at - b.at || a.instanceId.localeCompare(b.instanceId));
    // Mark the union of qualifying intervals in linear time after sorting.
    // Avoid scanning every member for each overlapping window (quadratic at scale).
    const delta = new Int32Array(group.length + 1);
    let left = 0;
    for (let right = 0; right < group.length; right++) {
      while (group[left]!.at < group[right]!.at - DAY) left++;
      if (right - left + 1 >= 3) {
        delta[left] = delta[left]! + 1;
        delta[right + 1] = delta[right + 1]! - 1;
      }
    }
    let active = 0;
    for (let i = 0; i < group.length; i++) {
      active += delta[i]!;
      const key = sessionKey(group[i]!);
      if (active && denominator.has(key)) hits.add(key);
    }
  }
  const reason =
    context.coverage === "expired"
      ? "OBJECT_REFERENCE_COVERAGE_EXPIRED"
      : conflicts.size
        ? "CONFLICTING_OPERATION_INSTANCES"
        : context.scannedFrom > context.from - DAY ||
            context.scannedTo < context.to + DAY
          ? "REPEATED_LOOKAROUND_INCOMPLETE"
          : context.asOf < context.to + 2 * DAY
            ? "REPEATED_LATENESS_WINDOW_OPEN"
            : context.coverage !== "proven"
              ? "REPEATED_COVERAGE_NOT_VERIFIED"
              : !denominator.size
                ? "ZERO_DENOMINATOR"
                : denominator.size < 5
                  ? "INSUFFICIENT_SAMPLE"
                  : null;
  return {
    value: reason ? null : hits.size / denominator.size,
    observedValue: denominator.size ? hits.size / denominator.size : null,
    numerator: hits.size,
    denominator: denominator.size,
    status: reason ? "partial" : "available",
    reason,
    definitionVersion: R4C_FACT_DEFINITION_VERSION,
    asOf: new Date(context.asOf).toISOString(),
    // No reference, object type, user, session or instance escapes this reducer.
  };
}
