const apiUrl = process.env.M24_API_URL ?? "http://127.0.0.1:3000";
const projectId = "11111111-1111-4111-8111-111111111111";

const login = await fetch(`${apiUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "viewer@example.invalid",
    password: "LocalViewer-1234",
  }),
});
if (!login.ok) throw new Error(`M8 smoke login failed: ${login.status}`);
const body = await login.json();
const headers = { authorization: `Bearer ${body.accessToken}` };
const now = new Date();
const query = new URLSearchParams({
  from: new Date(now.valueOf() - 7 * 86_400_000).toISOString(),
  to: now.toISOString(),
  timezone: "UTC",
  granularity: "hour",
});

async function get(path, name) {
  const response = await fetch(`${apiUrl}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const base = `/api/projects/${projectId}/observability`;
const overview = await get(`${base}/overview?${query}`, "observability overview");
if (
  overview.definitionVersion !== "observability_v1.0.0" ||
  overview.summary?.errorGroups < 3 ||
  overview.summary?.vitalSamples < 20 ||
  !Array.isArray(overview.alerts) ||
  overview.alerts.length < 4
) {
  throw new Error(`M8 overview evidence is incomplete: ${JSON.stringify(overview)}`);
}
if (
  overview.boundaries?.operationalIndexVersion !== "operational_v1_unchanged" ||
  overview.boundaries?.sourceMaps !== "disabled_pending_real_location_evidence"
) {
  throw new Error("M8 boundary flags must protect index v1 and deferred SourceMap");
}

const errors = await get(`${base}/errors?${query}`, "error groups");
const groupId = errors.items?.[0]?.groupId;
if (!/^[a-f0-9]{64}$/.test(groupId ?? "")) {
  throw new Error("M8 expected one stable SHA-256 error group");
}
const detail = await get(`${base}/errors/${groupId}?${query}`, "error group detail");
if (!detail.item || !Array.isArray(detail.impact) || !detail.privacy) {
  throw new Error("M8 error group detail is incomplete");
}

const [vitals, releases, alerts] = await Promise.all([
  get(`${base}/web-vitals?${query}`, "Web Vitals"),
  get(`${base}/releases?${query}`, "releases"),
  get(`${base}/alerts?${query}`, "fixed alerts"),
]);
if (!vitals.items?.some((item) => item.vitalName === "LCP" && item.sampleSize >= 20)) {
  throw new Error("M8 LCP read model is missing");
}
if (!releases.items?.some((item) => item.releaseVersion === "2026.08.1")) {
  throw new Error("M8 release association is missing");
}
if (!alerts.items?.some((item) => item.ruleKey === "error_spike")) {
  throw new Error("M8 error fixed alert is missing");
}

console.log(
  JSON.stringify({
    status: "passed",
    milestone: "M8",
    summary: overview.summary,
    errorGroupId: groupId,
    releases: releases.items.length,
    alerts: alerts.items.length,
  }),
);
