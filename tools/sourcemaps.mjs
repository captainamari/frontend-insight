#!/usr/bin/env node
// Node 24, no dependencies. Credentials are never accepted in argv or URL.
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2),
  command = args.shift(),
  options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || !args[i + 1])
    throw new Error("Expected --option value");
  options[args[i].slice(2)] = args[i + 1];
}
async function main() {
  const url = new URL(options.api ?? "http://127.0.0.1:3000");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.protocol !== "https:")
  )
    throw new Error("Use HTTPS, or local loopback HTTP");
  if (!/^[0-9a-f-]{36}$/.test(options.project ?? ""))
    throw new Error("--project UUID required");
  const upload = command === "upload";
  const token = upload
    ? (process.env.FI_SOURCEMAP_TOKEN ??
      (options["credential-file"]
        ? JSON.parse(await readFile(options["credential-file"], "utf8")).token
        : undefined))
    : process.env.FI_SESSION_TOKEN;
  if (!token)
    throw new Error(
      upload ? "Upload credential required" : "FI_SESSION_TOKEN required",
    );
  const root = `/api/projects/${options.project}/diagnostics/sourcemaps`;
  async function request(path, method, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetch(new URL(root + path, url), {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
      } catch {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        throw new Error("Network failure; retry is idempotent");
      }
      if (response.ok) return response.json();
      // Only bounded error codes, never dump arbitrary proxy bodies or credentials.
      if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      throw new Error(`Request failed: HTTP ${response.status}`);
    }
  }
  if (command === "issue") {
    if (!options["credential-file"])
      throw new Error("--credential-file required; token is written mode 0600 only");
    const result = await request("/credentials", "POST", {
      days: Number(options.days ?? 7),
    });
    await writeFile(options["credential-file"], JSON.stringify(result) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        id: result.id,
        expiresAt: result.expiresAt,
        purpose: result.purpose,
      }),
    );
  } else if (command === "revoke")
    console.log(JSON.stringify(await request("/credentials/" + options.id, "DELETE")));
  else if (command === "list")
    console.log(
      JSON.stringify(
        (await request("", "GET")).map(
          ({
            id,
            release,
            build,
            assetSha256,
            mapSha256,
            bytes,
            state,
            expiresAt,
          }) => ({
            id,
            release,
            build,
            assetSha256,
            mapSha256,
            bytes,
            state,
            expiresAt,
          }),
        ),
      ),
    );
  else if (command === "delete")
    console.log(JSON.stringify(await request("/" + options.id, "DELETE")));
  else if (upload) {
    // One JS/map pair per request. No globs, archive extraction or recursive upload.
    if (
      !options.js ||
      !options.map ||
      !options["asset-url"] ||
      !options.release ||
      !options.build
    )
      throw new Error("--js --map --asset-url --release --build required");
    if (
      (await stat(options.js)).size > 1048576 ||
      (await stat(options.map)).size > 2097152
    )
      throw new Error("Upload byte budget exceeded");
    const js = await readFile(options.js),
      map = await readFile(options.map);
    const result = await request("/upload", "POST", {
      release: options.release,
      build: options.build,
      asset: options["asset-url"],
      assetSha256: hash(js),
      mapSha256: hash(map),
      javascript: js.toString("base64"),
      map: map.toString("base64"),
      retentionDays: Number(options.days ?? 30),
    });
    console.log(
      JSON.stringify({
        id: result.id,
        assetSha256: result.assetSha256,
        mapSha256: result.mapSha256,
        bytes: result.bytes,
        state: result.state,
        idempotent: result.idempotent,
      }),
    );
  } else throw new Error("Commands: issue, revoke, list, upload, delete");
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
