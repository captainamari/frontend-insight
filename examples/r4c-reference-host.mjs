// Isolated localhost acceptance host. Do not deploy this fixture as a business service.
import { createServer } from "node:http";
import { createObjectReferenceProvider } from "../packages/server-core/dist/src/index.js";
const projectId = process.env.FI_PROJECT_ID;
if (!projectId || !process.env.FI_ADMIN_TOKEN)
  throw new Error("FI_PROJECT_ID_AND_BACKEND_TOKEN_REQUIRED");
const issue = createObjectReferenceProvider({
  apiBase: process.env.FI_API_URL ?? "http://127.0.0.1:3000",
  projectId,
  env: "dev",
  accessToken: async () => process.env.FI_ADMIN_TOKEN,
});
createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (
    !["http://localhost:4174", "http://127.0.0.1:4174"].includes(origin) ||
    req.method !== "GET" ||
    req.url !== "/reference"
  ) {
    res.writeHead(403);
    res.end();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Cache-Control", "no-store");
  try {
    const reference = await issue("order", "isolated-order-fixture");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ reference }));
  } catch {
    res.writeHead(503);
    res.end('{"code":"REFERENCE_HOST_UNAVAILABLE"}');
  }
}).listen(4180, "127.0.0.1", () =>
  console.log(
    "Isolated reference host ready on localhost:4180; no identifiers or keys are logged.",
  ),
);
