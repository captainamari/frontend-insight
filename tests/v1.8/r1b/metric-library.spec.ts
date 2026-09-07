import { expect, test, type Locator, type Page } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "功能采用" })).toBeVisible();
}

async function choose(
  page: Page,
  select: Locator,
  option: string | RegExp,
): Promise<void> {
  await select
    .locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' el-select__wrapper ')][1]",
    )
    .click();
  const target = page
    .locator(".el-select-dropdown:visible")
    .last()
    .getByRole("option", { name: option, exact: true });
  await expect(target).toBeVisible();
  await target.dispatchEvent("click");
}

test("admin manages a controlled business metric while system definitions stay read-only", async ({
  page,
  browserName,
}) => {
  test.setTimeout(180_000);
  await login(page, "admin@example.invalid", "LocalAdmin-1234");
  await page.goto(`/projects/${projectId}/metrics?range=7d&tab=operational-metrics`);

  await expect(page.getByRole("heading", { name: "系统默认指标" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "用户业务指标" })).toBeVisible();
  const systemTable = page.getByTestId("system-metrics");
  await expect(systemTable.getByText("pv", { exact: true })).toBeVisible();
  await expect(systemTable.getByText("uv", { exact: true })).toBeVisible();
  await expect(systemTable.getByText("未采集", { exact: true }).first()).toBeVisible();

  const pvRow = systemTable
    .getByRole("row")
    .filter({ has: page.getByText("pv", { exact: true }) });
  await pvRow.getByRole("button", { name: "定义" }).click();
  const definitionDrawer = page.getByRole("dialog", { name: "指标定义" });
  await expect(definitionDrawer).toContainText("计算口径");
  await expect(definitionDrawer).not.toContainText("formulaDescription");
  await expect(definitionDrawer).toContainText("eventId");
  const definitionRowsOverlap = await definitionDrawer
    .locator(".definition-row")
    .evaluateAll((rows) =>
      rows.some((row) => {
        const label = row.querySelector("dt")?.getBoundingClientRect();
        const value = row.querySelector("dd")?.getBoundingClientRect();
        return Boolean(label && value && label.right > value.left + 1);
      }),
    );
  expect(definitionRowsOverlap).toBe(false);
  await page.keyboard.press("Escape");

  const suffix = `${browserName}_${Date.now()}`;

  await page.getByRole("button", { name: "新建业务指标" }).click();
  let editor = page.getByRole("dialog", { name: "语义化业务指标编辑器" });
  await editor.getByLabel("指标 key").fill(`bounded_users_${suffix}`);
  await editor.getByLabel("中文名").fill(`限定活跃用户 ${suffix}`);
  await editor.getByLabel("业务说明").fill("将活跃用户数限制在明确上下界内");
  await editor.getByRole("button", { name: "下一步" }).click();
  await choose(page, editor.getByLabel("输入指标 A"), "uv · 活跃用户数 · 部分实现");
  const clampPreviewResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/definitions/preview") &&
      response.status() === 200 &&
      response.request().postData()?.includes('"function":"clamp"') === true,
  );
  await choose(page, editor.getByLabel("运算方式"), "限制在上下界内");
  await clampPreviewResponse;
  await expect(editor).toContainText("clamp(uv, 0, 100)");
  await editor.getByRole("button", { name: "下一步" }).click();
  await expect(editor.getByLabel("输出单位（服务端推导）")).toHaveValue("users");
  await editor.getByRole("button", { name: "取消" }).click();

  const metricKey = `pages_per_visit_${suffix}`;
  await page.getByRole("button", { name: "新建业务指标" }).click();
  editor = page.getByRole("dialog", { name: "语义化业务指标编辑器" });
  await expect(editor).toContainText("不会保存 SQL、代码、任意字段或任意函数");
  await editor.getByLabel("指标 key").fill(metricKey);
  await editor.getByLabel("中文名").fill(`单会话页面数 ${suffix}`);
  await editor.getByLabel("业务说明").fill("页面浏览量除以会话数");
  await editor.getByRole("button", { name: "下一步" }).click();
  await choose(page, editor.getByLabel("输入指标 A"), "pv · 页面浏览量 · 部分实现");
  const divisionPreviewResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/definitions/preview") &&
      response.status() === 200 &&
      response.request().postData()?.includes(`"metricKey":"${metricKey}"`) === true &&
      response.request().postData()?.includes('"metricKey":"vv"') === true,
  );
  await choose(page, editor.getByLabel("输入指标 B"), "vv · 会话数（VV） · 部分实现");
  await divisionPreviewResponse;
  await expect(editor).toContainText("(pv / vv)");
  await editor.getByRole("button", { name: "下一步" }).click();
  await expect(editor.getByLabel("输出单位（服务端推导）")).toHaveValue(
    "views_per_session",
  );
  await editor.getByLabel("分子说明").fill("PV");
  await editor.getByLabel("分母说明").fill("VV");
  await editor.getByRole("button", { name: "下一步" }).click();
  await expect(editor).toContainText("服务端预校验通过");
  await editor.getByRole("button", { name: "保存到工作草稿" }).click();
  await expect(page.getByText(/业务指标已保存到 v\d+ 草稿/)).toBeVisible();
  await expect(page.getByTestId("business-metrics")).toContainText(metricKey);
  await expect(page.getByText("服务端权威校验通过", { exact: true })).toBeVisible();

  const businessRow = page
    .getByTestId("business-metrics")
    .getByRole("row")
    .filter({ hasText: metricKey });
  await businessRow.getByRole("button", { name: "血缘" }).click();
  const lineageDrawer = page.getByRole("dialog", { name: "指标血缘" });
  await expect(lineageDrawer).toContainText(metricKey);
  const lineageGraph = lineageDrawer.getByTestId("lineage-graph");
  await expect(lineageGraph.locator(`[data-node-key="${metricKey}"]`)).toBeVisible();
  await expect(lineageGraph.locator('[data-node-key="pv"]')).toBeVisible();
  await expect(lineageGraph.locator('[data-node-key="vv"]')).toBeVisible();
  await expect(lineageGraph.locator(`[data-edge="pv->${metricKey}"]`)).toHaveCount(1);
  await expect(lineageGraph.locator(`[data-edge="vv->${metricKey}"]`)).toHaveCount(1);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "版本库", exact: true }).click();
  await expect(page).toHaveURL(/tab=versions/);
  await expect(page.getByRole("heading", { name: "版本库" })).toBeVisible();
  await expect(page.getByRole("button", { name: "服务端校验" })).toBeVisible();
  await page.getByRole("button", { name: "查看 diff / 影响" }).click();
  await expect(page.getByTestId("metric-diff")).toContainText("版本变更");
  await expect(page.getByTestId("metric-impact")).toContainText("影响范围");

  // Enter quality through the product navigation and save a real quality definition.
  await page.getByRole("button", { name: "质量指标", exact: true }).click();
  await expect(page.getByTestId("system-metrics")).toContainText("lcp");
  const qualityKey = `scaled_lcp_${suffix}`;
  await page.getByRole("button", { name: "新建业务指标" }).click();
  editor = page.getByRole("dialog", { name: "语义化业务指标编辑器" });
  await editor.getByLabel("指标 key").fill(qualityKey);
  await editor.getByLabel("中文名").fill(`两倍绘制耗时 ${suffix}`);
  await editor.getByLabel("业务说明").fill("LCP 乘以固定系数 2，验证质量版本独立保存");
  await editor.getByRole("button", { name: "下一步" }).click();
  await choose(page, editor.getByLabel("输入指标 A"), /^lcp ·/);
  await choose(page, editor.getByLabel("运算方式"), "乘以系数");
  await editor.getByRole("radio", { name: "固定系数", exact: true }).check();
  await editor.getByRole("spinbutton", { name: "固定系数", exact: true }).fill("2");
  await editor.getByRole("spinbutton", { name: "固定系数", exact: true }).blur();
  await expect(editor).toContainText("(lcp * 2)");
  await editor.getByRole("button", { name: "下一步" }).click();
  await expect(editor.getByLabel("输出单位（服务端推导）")).toHaveValue("milliseconds");
  await editor.getByRole("button", { name: "下一步" }).click();
  await expect(editor).toContainText("服务端预校验通过");
  const savedQualityResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(`/definitions/${qualityKey}`),
  );
  await editor.getByRole("button", { name: "保存到工作草稿" }).click();
  const savedQuality = await savedQualityResponse;
  expect(savedQuality.status()).toBe(200);
  const { version: qualityVersion } = await savedQuality.json();
  expect(qualityVersion.libraryType).toBe("quality");
  expect(qualityVersion.status).toBe("draft");
  await expect(page.getByTestId("business-metrics")).toContainText(qualityKey);

  await page.getByRole("button", { name: "版本库", exact: true }).click();
  const versionTable = page.getByTestId("metric-versions");
  await expect(page.getByTestId("version-type-filter")).toContainText("全部类型");
  await expect(
    versionTable.getByRole("cell", { name: "运营", exact: true }).first(),
  ).toBeVisible();
  await expect(
    versionTable.getByRole("cell", { name: "质量", exact: true }).first(),
  ).toBeVisible();
  await choose(page, page.getByRole("combobox", { name: "版本类型" }), "质量");
  await expect(
    versionTable.getByRole("cell", { name: "运营", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("version-selector")).toContainText(
    `质量 v${qualityVersion.version} · 草稿`,
  );
  await page.getByRole("button", { name: "查看 diff / 影响" }).click();
  await expect(page.getByTestId("metric-diff")).toContainText(qualityKey);
  await expect(page.getByTestId("metric-diff")).not.toContainText(metricKey);
  const qualityVersionCount = await versionTable
    .getByRole("cell", { name: "质量", exact: true })
    .count();
  await page.getByRole("button", { name: /继续编辑.*草稿/ }).click();
  await expect(
    versionTable.getByRole("cell", { name: "质量", exact: true }),
  ).toHaveCount(qualityVersionCount);
  await page.getByRole("button", { name: "激活", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "确认激活完整快照" })).toContainText(
    `质量指标 v${qualityVersion.version}`,
  );
  await page.getByRole("button", { name: "校验并激活", exact: true }).click();
  await expect(page.getByTestId("version-selector")).toContainText(
    `质量 v${qualityVersion.version} · 已激活`,
  );
  await page.getByRole("button", { name: /创建工作草稿/ }).click();
  await expect(page.getByTestId("version-selector")).toContainText(
    `质量 v${qualityVersion.version + 1} · 草稿`,
  );
  await choose(page, page.getByRole("combobox", { name: "版本类型" }), "运营");
  await expect(
    versionTable.getByRole("cell", { name: "质量", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "查看 diff / 影响" }).click();
  await expect(page.getByTestId("metric-diff")).toContainText(metricKey);
  await page.reload();
  await expect(
    versionTable.getByRole("cell", { name: "运营", exact: true }).first(),
  ).toBeVisible();
  await expect(
    versionTable.getByRole("cell", { name: "质量", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "质量指标", exact: true }).click();
  await expect(page.getByTestId("business-metrics")).toContainText(qualityKey);
  await expect(page.getByTestId("business-metrics")).not.toContainText(metricKey);
});

test("viewer can inspect definitions, versions and lineage but has no writes", async ({
  page,
}) => {
  await login(page, "viewer@example.invalid", "LocalViewer-1234");
  await page.goto(`/projects/${projectId}/metrics?range=7d&tab=quality-metrics`);
  await expect(page.getByText(/当前账号为 viewer/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "系统默认指标" })).toBeVisible();
  await expect(page.getByTestId("system-metrics")).toContainText("lcp");
  await expect(page.getByRole("button", { name: /工作草稿/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建业务指标" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "激活", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "废弃草稿" })).toHaveCount(0);

  const metricRow = page
    .getByTestId("system-metrics")
    .getByRole("row")
    .filter({ has: page.getByText("lcp", { exact: true }) });
  await metricRow.getByRole("button", { name: "定义" }).click();
  await expect(page.getByRole("dialog", { name: "指标定义" })).toContainText("R5-A");
  await page.keyboard.press("Escape");
  await metricRow.getByRole("button", { name: "血缘" }).click();
  const lineageDrawer = page.getByRole("dialog", { name: "指标血缘" });
  await expect(lineageDrawer).toContainText("不会根据文字公式猜测或伪造上游");
  await expect(lineageDrawer.getByTestId("lineage-graph")).toBeVisible();
  await expect(lineageDrawer.locator('[data-node-key="lcp"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "版本库", exact: true }).click();
  const versionTable = page.getByTestId("metric-versions");
  await expect(
    versionTable.getByRole("cell", { name: "运营", exact: true }).first(),
  ).toBeVisible();
  await expect(
    versionTable.getByRole("cell", { name: "质量", exact: true }).first(),
  ).toBeVisible();
  await choose(page, page.getByRole("combobox", { name: "版本类型" }), "质量");
  await expect(
    page.getByRole("button", { name: /工作草稿|激活|废弃草稿/ }),
  ).toHaveCount(0);
});
