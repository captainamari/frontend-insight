const apiUrl = process.env.M24_API_URL ?? "http://127.0.0.1:3000";
const projectId = "11111111-1111-4111-8111-111111111111";

const login = await fetch(`${apiUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "admin@example.invalid",
    password: "LocalAdmin-1234",
  }),
});
if (!login.ok) throw new Error(`M6 smoke login failed: ${login.status}`);
const body = await login.json();
const headers = { authorization: `Bearer ${body.accessToken}` };
const now = new Date();
const query = new URLSearchParams({
  from: new Date(now.valueOf() - 7 * 86_400_000).toISOString(),
  to: now.toISOString(),
  timezone: "UTC",
  granularity: "hour",
});

const checks = [
  [`/api/projects/${projectId}/modules`, "module definitions"],
  [`/api/projects/${projectId}/page-definitions`, "page definitions"],
  [`/api/projects/${projectId}/metric-profiles`, "metric profiles"],
  [`/api/projects/${projectId}/metrics`, "metric catalog"],
  [
    `/api/projects/${projectId}/analytics/operational-overview?${query}`,
    "operational overview",
  ],
  [`/api/projects/${projectId}/operational-index?${query}`, "operational index"],
  [`/api/projects/${projectId}/metrics/operational_score/lineage`, "metric lineage"],
];

const results = [];
for (const [path, name] of checks) {
  const response = await fetch(`${apiUrl}${path}`, { headers });
  if (!response.ok) {
    throw new Error(
      `${name} smoke failed: ${response.status} ${await response.text()}`,
    );
  }
  const responseBody = await response.json();
  results.push({ name, ok: true });
  if (name === "metric profiles") {
    if (!responseBody.some((profile) => profile.status === "active")) {
      throw new Error("M6 smoke expected one active metric profile");
    }
  }
  if (name === "metric catalog") {
    if (
      !Array.isArray(responseBody) ||
      !responseBody.some((definition) => definition.metricKey === "operational_score")
    ) {
      throw new Error("M6 smoke expected the versioned operational metric catalog");
    }
  }
  if (name === "operational overview") {
    if (
      responseBody.summary?.pageViews <= 0 ||
      responseBody.summary?.activeUsers <= 0
    ) {
      throw new Error("M6 smoke expected raw and valid-use overview evidence");
    }
  }
  if (name === "operational index") {
    if (
      responseBody.index?.status !== "available" ||
      !Array.isArray(responseBody.rawMetrics) ||
      responseBody.rawMetrics.length !== 10
    ) {
      throw new Error("M6 smoke expected an explainable, eligible project index");
    }
  }
  if (name === "metric lineage") {
    if (!Array.isArray(responseBody.nodes) || !Array.isArray(responseBody.edges)) {
      throw new Error("M6 lineage response is incomplete");
    }
  }
}

console.log(JSON.stringify({ status: "passed", milestone: "M6", results }));
