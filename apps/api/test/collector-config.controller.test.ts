import "reflect-metadata";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { CoreService } from "../src/core.service.js";
import { CollectorConfigController } from "../src/collector-config.controller.js";

function setup(settings: Record<string, unknown> | null = null) {
  const mysql = {
    getIngestionProject: vi.fn(async () => ({
      id: "project-1",
      origins: ["https://app.example.test"],
    })),
    getCollectorSettings: vi.fn(async () => settings),
  };
  const response = { header: vi.fn() };
  return {
    controller: new CollectorConfigController({ mysql } as unknown as CoreService),
    mysql,
    response,
  };
}

describe("public collector configuration", () => {
  it("returns fail-closed defaults for a configured origin", async () => {
    const { controller, response } = setup();
    const result = await controller.config(
      "fi_public_example01",
      "https://app.example.test",
      response as never,
    );
    expect(result).toMatchObject({
      schemaVersion: 1,
      version: 0,
      collectors: {
        api: { enabled: false, globalFetch: false },
        blankScreen: { enabled: false },
        breadcrumbs: { enabled: false, allowedActionKeys: [] },
      },
    });
    expect(response.header).toHaveBeenCalledWith("cache-control", "no-store");
  });

  it("returns the active project version without internal identifiers", async () => {
    const settings = {
      id: "internal-version-id",
      projectId: "project-1",
      version: 3,
      effectiveFrom: "2026-08-13T12:00:00.000Z",
      api: {
        enabled: true,
        sampleRate: 0.2,
        slowThresholdMs: 1500,
        globalFetch: false,
      },
      resources: { enabled: false, sampleRate: 1 },
      firstScreen: { enabled: true, sampleRate: 1 },
      listRender: { enabled: false, sampleRate: 1 },
      longTasks: { enabled: false, sampleRate: 1 },
      blankScreen: { enabled: false, sampleRate: 1 },
      breadcrumbs: { enabled: false, sampleRate: 1, allowedActionKeys: [] },
    };
    const { controller, response } = setup(settings);
    const result = await controller.config(
      "fi_public_example01",
      "https://app.example.test",
      response as never,
    );
    expect(result).toMatchObject({ version: 3, collectors: { api: settings.api } });
    expect(JSON.stringify(result)).not.toContain("internal-version-id");
    expect(JSON.stringify(result)).not.toContain("project-1");
  });

  it("rejects missing or unregistered origins", async () => {
    const { controller, response } = setup();
    await expect(
      controller.config("fi_public_example01", undefined, response as never),
    ).rejects.toEqual(expect.any(HttpException));
    await expect(
      controller.config(
        "fi_public_example01",
        "https://evil.example.test",
        response as never,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
