import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
const exec = promisify(execFile);
const project = "11111111-1111-4111-8111-111111111111";
it("CLI rejects malformed credentials without printing secrets and reserves issue destination before HTTP", async () => {
  const dir = await mkdtemp(tmpdir() + "/fi-cli-");
  const credential = dir + "/credential.json";
  const secret = "fi_sm_SYNTHETIC_MUST_NOT_APPEAR";
  await writeFile(credential, secret);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FI_SESSION_TOKEN: "synthetic-session",
  };
  delete env.FI_SOURCEMAP_TOKEN;
  try {
    for (const command of ["upload", "issue"]) {
      const result = await exec(
        process.execPath,
        [
          "tools/sourcemaps.mjs",
          command,
          "--project",
          project,
          "--credential-file",
          credential,
        ],
        { env },
      ).then(
        () => {
          throw new Error("CLI should fail");
        },
        (error) => error,
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("CLI_INPUT_OR_IO_ERROR\n");
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(credential);
    }
    expect(await readFile(credential, "utf8")).toBe(secret);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("CLI retries the identical upload body on transient failure and prints safe receipts only", async () => {
  const dir = await mkdtemp(tmpdir() + "/fi-cli-");
  const bodies: string[] = [];
  const secret = "fi_sm_SYNTHETIC_CLI_TOKEN";
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    res.statusCode = bodies.length === 1 ? 503 : 201;
    res.end(
      JSON.stringify(
        bodies.length === 1
          ? { message: "temporary" }
          : {
              id: "a".repeat(64),
              state: "ready",
              idempotent: true,
              assetSha256: "b".repeat(64),
              mapSha256: "c".repeat(64),
              bytes: 10,
              token: secret,
              map: "SYNTHETIC_MAP_BODY",
            },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await writeFile(dir + "/a.js", "synthetic JS");
    await writeFile(dir + "/a.map", "synthetic map");
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        "tools/sourcemaps.mjs",
        "upload",
        "--api",
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        "--project",
        project,
        "--release",
        "v1",
        "--build",
        "b1",
        "--asset-url",
        "https://cdn.invalid/a.js",
        "--js",
        dir + "/a.js",
        "--map",
        dir + "/a.map",
      ],
      { env: { ...process.env, FI_SOURCEMAP_TOKEN: secret } },
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(stdout)).toMatchObject({ state: "ready", idempotent: true });
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain("SYNTHETIC_MAP_BODY");
    expect(stderr).toBe("");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
