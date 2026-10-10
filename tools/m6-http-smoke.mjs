import assert from "node:assert/strict";
const base = process.env.M24_API_URL ?? "http://127.0.0.1:3000";
const r = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "admin@example.invalid", password: "LocalAdmin-1234" }),
});
assert(r.ok);
const headers = { authorization: `Bearer ${(await r.json()).accessToken}` };
const project = "11111111-1111-4111-8111-111111111111";
for (const suffix of [
  "overview?env=prod&range=7d",
  "business?env=prod&range=7d",
  "page-operations?env=prod&range=7d",
  "observability/occurrences?env=prod&range=7d",
]) {
  const response = await fetch(`${base}/api/projects/${project}/${suffix}`, {
    headers,
  });
  assert(response.ok, `${suffix}: ${response.status}`);
  const body = await response.json();
  assert(body && typeof body === "object");
}
console.log(
  JSON.stringify({
    status: "passed",
    scope:
      "formal overview/business/page operations/quality HTTP availability; semantic fixtures in R1–R7",
  }),
);
