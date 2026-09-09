import { test, expect, type Page } from "@playwright/test";
const projectId = "11111111-1111-4111-8111-111111111111";
async function login(page: Page, role: "admin" | "viewer") {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(role + "@example.invalid");
  await page
    .getByLabel("密码")
    .fill(role === "admin" ? "LocalAdmin-1234" : "LocalViewer-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "功能采用", exact: true }),
  ).toBeVisible();
}
async function cleanupDraft(page: Page, type: string) {
  await page.evaluate(
    async ({ projectId, type }) => {
      const headers = {
        authorization: "Bearer " + sessionStorage.getItem("fi.access-token"),
      };
      const response = await fetch(
        `/api/projects/${projectId}/metrics/versions?type=${type}`,
        { headers },
      );
      if (!response.ok) throw new Error("version setup failed");
      const versions = (await response.json()) as { id: string; status: string }[];
      for (const v of versions.filter((v) => v.status === "draft")) {
        const r = await fetch(`/api/projects/${projectId}/metrics/versions/${v.id}`, {
          method: "DELETE",
          headers,
        });
        if (!r.ok) throw new Error("draft setup failed");
      }
    },
    { projectId, type },
  );
}
async function open(page: Page, type: string) {
  await page.goto(
    `/projects/${projectId}/metrics?range=7d&tab=scores&scoreType=${type}`,
  );
  await expect(
    page.getByRole("heading", { name: "分数管理", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("分数版本")).not.toHaveValue("");
  await expect(page.getByText("正在加载或保存…")).toHaveCount(0);
}
async function edit(page: Page) {
  await page.getByRole("button", { name: "复制为工作草稿", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑工作草稿", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "编辑工作草稿", exact: true }).click();
}
async function confirmBusiness(page: Page) {
  await page.getByRole("button", { name: "2. 业务配置", exact: true }).click();
  await page.getByLabel("确认业务配置").check();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存；配置保存不代表事实可计算。")).toBeVisible();
}
async function activate(page: Page, reactivate = false) {
  await page
    .getByRole("button", {
      name: reactivate ? "重新激活前检查" : "激活前检查",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "分数激活检查" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "配置变更与影响" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "适用范围历史试算" })).toBeVisible();
  await expect(dialog.locator("[data-source=project_query]")).toContainText(
    "不可参与计算",
  );
  await dialog.getByRole("button", { name: "确认激活快照" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("分数版本").locator("option:checked")).toContainText(
    "active",
  );
}
for (const type of ["operational", "quality"]) {
  test(`admin ${type}: template, wizard, save failure, diff, activate, copy, supersede, reactivate, abandon`, async ({
    page,
    browserName,
  }) => {
    test.setTimeout(240000);
    await login(page, "admin");
    await cleanupDraft(page, type);
    await open(page, type);
    await edit(page);
    await page.getByRole("button", { name: "采用系统默认模板", exact: true }).click();
    const label = `R1-C ${type} ${browserName}`;
    await page.getByLabel("中文名称", { exact: true }).fill(label);
    // Server validation failures preserve entered values.
    await page.getByLabel("分数 key", { exact: true }).fill("invalid key");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("SCORE_KEY_INVALID");
    await expect(page.getByLabel("中文名称", { exact: true })).toHaveValue(label);
    await page.getByLabel("分数 key", { exact: true }).fill(type + "_score");
    await confirmBusiness(page);
    await page.getByRole("button", { name: "3. 维度与指标", exact: true }).click();
    await expect(page.getByText("高级配置：权重、目标、样本和 gate")).toBeVisible();
    await page.getByRole("button", { name: "4. 校验与预览", exact: true }).click();
    await page.getByRole("button", { name: "校验配置并预览", exact: true }).click();
    await expect(
      page.locator("[data-source=fixed_fixture] [data-testid=score-value]"),
    ).toHaveText(type === "operational" ? "76.15" : "72.953216");
    await expect(page.getByRole("table", { name: "维度分等价表" })).toBeVisible();
    await expect(
      page.getByRole("img", { name: "维度分雷达，范围 0–100，与维度表一致" }),
    ).toBeVisible();
    if (type === "operational") {
      await page.getByLabel("固定示例").selectOption("partial");
      await expect(
        page.locator("[data-source=fixed_fixture] [data-testid=score-value]"),
      ).toHaveText("82.529412");
      await page.getByLabel("固定示例").selectOption("gateFailure");
      await expect(
        page.locator("[data-source=fixed_fixture] [data-testid=score-value]"),
      ).toHaveText("—");
    }
    await save(page);
    const original = await page.getByLabel("分数版本").inputValue();
    await page.reload();
    await expect(page.getByLabel("分数版本")).toHaveValue(original);
    await expect(page.locator("[data-source=project_query]")).toContainText(
      "不可参与计算",
    );
    await activate(page);
    await edit(page);
    await page.getByLabel("中文名称", { exact: true }).fill(label + " copied");
    await page.getByLabel("展示单位").selectOption("percent");
    await confirmBusiness(page);
    await save(page);
    const copied = await page.getByLabel("分数版本").inputValue();
    expect(copied).not.toBe(original);
    await activate(page);
    await page.getByLabel("分数版本").selectOption(original);
    await expect(
      page.getByRole("button", { name: "重新激活前检查", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("分数版本").locator("option:checked")).toContainText(
      "superseded",
    );
    await activate(page, true);
    await edit(page);
    await page.getByRole("button", { name: "废弃工作草稿", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "复制为工作草稿", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "保存历史试算", exact: true }).click();
    await expect(
      page.getByText("历史试算已独立保存；原事实和旧结果未改写。"),
    ).toBeVisible();
    await page.getByLabel("分数环境").selectOption("staging");
    await page.getByRole("button", { name: "刷新查询", exact: true }).click();
    await expect(page).toHaveURL(/env=staging/);
    await expect(page.locator("[data-source=project_query]").first()).toContainText(
      "/ staging /",
    );
    expect(await page.getByRole("alert").count()).toBe(0);
  });
  test(`viewer ${type}: immutable configuration, lineage, radar, table, history and refresh`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await login(page, "viewer");
    await open(page, type);
    await expect(
      page.getByText("只读角色：可查看配置、版本、解释和血缘。"),
    ).toBeVisible();
    for (const name of [
      "复制为工作草稿",
      "编辑工作草稿",
      "保存草稿",
      "激活前检查",
      "保存历史试算",
    ])
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    const version = await page.getByLabel("分数版本").inputValue();
    await expect(page.locator("[data-source=project_query]")).toContainText(
      "不可参与计算",
    );
    await page.getByText("定义依赖血缘与分子、分母", { exact: true }).click();
    await expect(
      page.getByText("定义依赖血缘与分子、分母", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("table", { name: "分数解释明细" })).toBeVisible();
    await expect(page.getByRole("table", { name: "维度分等价表" })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("分数版本")).toHaveValue(version);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
test("late operational response cannot overwrite quality selection or URL", async ({
  page,
}) => {
  await login(page, "viewer");
  await open(page, "operational");
  await page.route("**/score-management/versions/*/result?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.getByRole("button", { name: "质量分数", exact: true }).click();
  await expect(page).toHaveURL(/scoreType=quality/);
  await expect(page.locator("[data-source=project_query]")).toContainText(
    "quality_score",
  );
  await page.waitForTimeout(600);
  await expect(page.locator("[data-source=project_query]")).not.toContainText(
    "operational_score",
  );
});
