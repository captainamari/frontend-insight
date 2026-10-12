import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
test("D5 deployed compressed source → CLI → SDK/Kafka/storage → authorized source UI", async ({
  page,
  request,
}, info) => {
  test.setTimeout(240000);
  const login = async (email: string, password: string) =>
    (await request.post("/api/auth/login", { data: { email, password } })).json();
  const admin = await login("admin@example.invalid", "LocalAdmin-1234");
  const headers = { authorization: `Bearer ${admin.accessToken}` };
  const project = await (
    await request.post("/api/projects", {
      headers,
      data: {
        name: `D5 ${info.project.name} ${randomUUID()}`,
        timezone: "UTC",
        origins: ["http://127.0.0.1:4174"],
      },
    })
  ).json();
  const root = `/api/projects/${project.id}`,
    sm = root + "/diagnostics/sourcemaps";
  const credential = await (
    await request.post(sm + "/credentials", { headers, data: { days: 1 } })
  ).json();
  expect(credential.token).toMatch(/^fi_sm_/);
  const manifest = JSON.parse(readFileSync("artifacts/d5-build/manifest.json", "utf8"));
  const js = readFileSync("artifacts/d5-build/fixture.js"),
    map = readFileSync("artifacts/d5-build/fixture.js.map");
  const runCli = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "tools/sourcemaps.mjs",
          "upload",
          "--api",
          "http://127.0.0.1:4173",
          "--project",
          project.id,
          "--release",
          manifest.release,
          "--build",
          manifest.build,
          "--asset-url",
          "http://127.0.0.1:4174/d5/fixture.js",
          "--js",
          "artifacts/d5-build/fixture.js",
          "--map",
          "artifacts/d5-build/fixture.js.map",
        ],
        {
          env: { ...process.env, FI_SOURCEMAP_TOKEN: credential.token },
          encoding: "utf8",
        },
      ),
    );
  const uploaded = runCli();
  expect(uploaded.state).toBe("ready");
  expect(runCli().idempotent).toBe(true);
  const deployed = await request.get("http://127.0.0.1:4174/d5/fixture.js");
  expect(hash(await deployed.body())).toBe(uploaded.assetSha256);
  const publicMap = await request.get("http://127.0.0.1:4174/d5/fixture.js.map");
  expect(await publicMap.text()).not.toContain("sourcesContent");
  let batch: Record<string, unknown> | undefined;
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.postData()) {
      const b = JSON.parse(r.postData()!);
      if (
        b.events.some(
          (e: { diagnostic?: unknown; release?: string }) =>
            e.diagnostic && e.release === manifest.release,
        )
      )
        batch = b;
    }
  });
  await page.goto(
    `http://127.0.0.1:4174/observability?acceptance=fast&d5AppId=${project.appId}`,
  );
  await page.getByLabel("模拟密码").fill("synthetic");
  await page.getByRole("button", { name: "进入场景实验室" }).click();
  await page.getByRole("button", { name: "D5 压缩源码异常" }).click();
  await expect.poll(() => batch).toBeTruthy();
  const event = (
    batch!.events as {
      eventId: string;
      diagnostic?: { raw: Record<string, unknown> };
    }[]
  ).find((e) => e.diagnostic)!;
  const url = root + `/diagnostics/instances/${event.eventId}`;
  await expect
    .poll(async () => (await (await request.get(url, { headers })).json()).state, {
      timeout: 45000,
    })
    .toBe("ready");
  const detail = await (await request.get(url, { headers })).json();
  expect(detail.diagnostic).toEqual(event.diagnostic);
  const mapped = detail.sourceMapping.frames.find(
    (f: { original?: { line: number } }) => f.original?.line === 4,
  );
  expect(mapped.original).toMatchObject({
    file: "../../examples/sourcemaps/源码场景.ts",
    line: 4,
    column: 9,
  });
  expect(mapped.snippet.map((s: { text: string }) => s.text).join("\n")).toContain(
    "throw new TypeError(label);",
  );
  expect(
    detail.sourceMapping.frames.some(
      (f: { original?: { line: number } }) => f.original?.line === 7,
    ),
  ).toBe(true);
  expect(detail.view.error.stack).toContain("/d5/fixture.js:1:");
  expect(detail.sourceMapping.state).toBe("partial"); // caller Vue/bundle frames absent from upload manifest
  const list = await request.get(sm, { headers });
  expect(await list.text()).not.toContain("sourcesContent");
  const uploadBody = {
    release: manifest.release,
    build: manifest.build,
    asset: "http://127.0.0.1:4174/d5/fixture.js",
    assetSha256: hash(js),
    mapSha256: hash(map),
    javascript: js.toString("base64"),
    map: map.toString("base64"),
    retentionDays: 30,
  };
  const uh = { authorization: `Bearer ${credential.token}` };
  const changed = Buffer.from(map.toString().replace("FI_D5_SYNTHETIC", "FI_D5_OTHER"));
  expect(
    (
      await request.post(sm + "/upload", {
        headers: uh,
        data: {
          ...uploadBody,
          map: changed.toString("base64"),
          mapSha256: hash(changed),
        },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await request.post(sm + "/upload", {
        headers: uh,
        data: { ...uploadBody, assetSha256: "0".repeat(64) },
      })
    ).status(),
  ).toBe(422);
  const viewer = await login("viewer@example.invalid", "LocalViewer-1234"),
    vh = { authorization: `Bearer ${viewer.accessToken}` };
  for (const h of [
    headers,
    vh,
    { authorization: `Bearer ${project.appId}` },
    { authorization: "Bearer fi_external_invalid" },
    {},
  ])
    expect(
      (await request.post(sm + "/upload", { headers: h, data: uploadBody })).status(),
    ).toBe(403);
  expect((await request.get(url, { headers: uh })).status()).toBe(401);
  expect((await request.get(sm, { headers: uh })).status()).toBe(401);
  const download = sm + `/${uploaded.id}/download`;
  expect((await request.post(download)).status()).toBe(401);
  expect((await request.post(download, { headers: vh })).status()).toBe(403);
  await request.put(root + `/members/${viewer.user.userId}`, {
    headers,
    data: { role: "viewer" },
  });
  expect((await request.get(url, { headers: vh })).status()).toBe(403);
  const grant = root + `/diagnostics/grants/${viewer.user.userId}`;
  await request.put(grant, { headers, data: { read: true, export: false } });
  expect((await request.get(url, { headers: vh })).status()).toBe(200);
  expect((await request.get(sm, { headers: vh })).status()).toBe(403);
  expect(
    (
      await request.post(sm + "/credentials", { headers: vh, data: { days: 1 } })
    ).status(),
  ).toBe(403);
  expect((await request.delete(sm + "/" + uploaded.id, { headers: vh })).status()).toBe(
    403,
  );
  expect((await request.post(download, { headers: vh })).status()).toBe(403);
  await request.put(grant, { headers, data: { read: true, export: true } });
  const raw = await request.post(download, { headers: vh });
  expect(raw.status()).toBe(201);
  expect(hash(await raw.body())).toBe(uploaded.mapSha256);
  expect(raw.headers()["cache-control"]).toContain("no-store");
  for (const format of ["json", "text"]) {
    const exp = await request.post(url + "/export", { headers: vh, data: { format } });
    expect(exp.status()).toBe(201);
    expect(await exp.text()).toContain("sourceMapping");
    expect(await exp.text()).toContain(uploaded.mapSha256);
  }
  await page.goto(`/projects/${project.id}/diagnostics/${event.eventId}`);
  await page.getByLabel("邮箱").fill("viewer@example.invalid");
  await page.getByLabel("密码").fill("LocalViewer-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByTestId("source-mapping")).toContainText(
    "throw new TypeError(label);",
  );
  await expect(page.getByTestId("diagnostic-stack")).toContainText("/d5/fixture.js:1:");
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (s: string) => {
          (window as unknown as { copied: string }).copied = s;
        },
      },
    }),
  );
  await page.getByRole("button", { name: "重新授权并复制源码定位" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied))
    .toContain("throw new TypeError(label);");
  await request.put(grant, { headers, data: { read: true, export: false } });
  expect((await request.post(download, { headers: vh })).status()).toBe(403);
  await expect(page.getByRole("button", { name: "下载 JSON 证据" })).toBeDisabled();
  await request.put(grant, { headers, data: { read: false, export: false } });
  await expect(page.getByTestId("source-mapping")).toHaveCount(0);
  await request.put(grant, { headers, data: { read: true, export: true } });
  await request.delete(root + `/members/${viewer.user.userId}`, { headers });
  expect((await request.post(download, { headers: vh })).status()).toBe(403);
  // Send synthetic variants through the actual ingestion/Kafka path; never fake mapped responses.
  async function variant(change: (e: Record<string, unknown>) => void) {
    const e = structuredClone(event) as Record<string, unknown>;
    e.eventId = "evt_" + randomUUID().replaceAll("-", "");
    e.pageViewId = "pv_" + randomUUID().replaceAll("-", "");
    change(e);
    const response = await request.post("http://127.0.0.1:4174/v1/events", {
      headers: { origin: "http://127.0.0.1:4174" },
      data: { ...batch, events: [e] },
    });
    expect(response.status()).toBe(202);
    const endpoint = root + `/diagnostics/instances/${e.eventId}`;
    await expect
      .poll(
        async () => (await (await request.get(endpoint, { headers })).json()).state,
        { timeout: 45000 },
      )
      .toBe("ready");
    return (await request.get(endpoint, { headers })).json();
  }
  const rawOf = (e: Record<string, unknown>) =>
    (e.diagnostic as { raw: Record<string, unknown> }).raw;
  const identityOf = (e: Record<string, unknown>) =>
    rawOf(e).sourceMap as {
      build: string;
      release: string;
      assets: { url: string; sha256: string }[];
    };
  for (const [state, change] of [
    [
      "identity_missing",
      (e: Record<string, unknown>) => {
        delete rawOf(e).sourceMap;
      },
    ],
    [
      "not_found",
      (e: Record<string, unknown>) => {
        identityOf(e).build = "wrong-build";
      },
    ],
    [
      "version_mismatch",
      (e: Record<string, unknown>) => {
        identityOf(e).release = "wrong-release";
      },
    ],
    [
      "checksum_mismatch",
      (e: Record<string, unknown>) => {
        identityOf(e).assets[0]!.sha256 = "0".repeat(64);
      },
    ],
    [
      "ambiguous_asset",
      (e: Record<string, unknown>) => {
        identityOf(e).assets.push(identityOf(e).assets[0]!);
      },
    ],
  ] as const) {
    const v = await variant(change);
    expect(v.sourceMapping.frames[0].state).toBe(state);
    expect(v.view.error.stack).toBe(detail.view.error.stack);
  }
  const child = await variant((e) => {
    const r = rawOf(e);
    r.error = {
      ...(r.error as object),
      cause: structuredClone(r.error),
      errors: [structuredClone(r.error)],
    };
  });
  expect(
    child.sourceMapping.frames.some(
      (f: { errorPath: string; state: string }) =>
        f.errorPath === "error.cause" && f.state === "mapped",
    ),
  ).toBe(true);
  const noContent = JSON.parse(map.toString());
  delete noContent.sourcesContent;
  const nc = Buffer.from(JSON.stringify(noContent));
  expect(
    (
      await request.post(sm + "/upload", {
        headers: uh,
        data: {
          ...uploadBody,
          build: "no-content",
          map: nc.toString("base64"),
          mapSha256: hash(nc),
        },
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await variant((e) => {
        identityOf(e).build = "no-content";
      })
    ).sourceMapping.frames[0].state,
  ).toBe("no_sources_content");
  // Same named asset in another project must not satisfy missing artifact identity.
  const other = await (
    await request.post("/api/projects", {
      headers,
      data: {
        name: `D5 isolated ${randomUUID()}`,
        origins: ["http://127.0.0.1:4174"],
        timezone: "UTC",
      },
    })
  ).json();
  expect(
    (
      await request.post(`/api/projects/${other.id}/diagnostics/sourcemaps/upload`, {
        headers: uh,
        data: uploadBody,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(
        `/api/projects/${other.id}/diagnostics/sourcemaps/${uploaded.id}/download`,
        { headers },
      )
    ).status(),
  ).toBe(404);
  await request.delete(sm + "/credentials/" + credential.id, { headers });
  expect(
    (await request.post(sm + "/upload", { headers: uh, data: uploadBody })).status(),
  ).toBe(403);
  // Leave first artifact for real restart/backup/restore verification, then test separate delete tombstone.
  const ncId = (await (await request.get(sm, { headers })).json()).find(
    (r: { build: string }) => r.build === "no-content",
  ).id;
  await request.delete(sm + "/" + ncId, { headers });
  expect((await request.post(sm + `/${ncId}/download`, { headers })).status()).toBe(
    410,
  );
  expect(
    (
      await variant((e) => {
        identityOf(e).build = "no-content";
      })
    ).sourceMapping.frames[0].state,
  ).toBe("deleted");
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/d5-${info.project.name}.json`,
    JSON.stringify({
      testedCommit: process.env.GITHUB_SHA,
      browser: info.project.name,
      projectId: project.id,
      eventId: event.eventId,
      artifactId: uploaded.id,
      assetSha256: uploaded.assetSha256,
      mapSha256: uploaded.mapSha256,
      location: mapped.original,
      cli: true,
      realDeployedBuild: true,
      permissions: true,
      variants: true,
    }),
  );
});
