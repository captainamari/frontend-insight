import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { projects } from "../src/projects";
import type { Project } from "../src/types";
vi.mock("../src/api", () => ({ api: { listProjects: vi.fn() } }));
const record = (id: string) => ({ id, name: id, status: "active" }) as Project;
beforeEach(() => {
  projects.reset();
  vi.clearAllMocks();
});
it("R2 current authorized project survives a stale legacy project-list response", async () => {
  let resolve!: (value: Project[]) => void;
  vi.mocked(api.listProjects).mockImplementationOnce(
    () => new Promise((r) => (resolve = r)),
  );
  const old = projects.load();
  projects.remember(record("current"));
  resolve([record("old")]);
  await old;
  expect(projects.state.items.map((p) => p.id)).toEqual(["current"]);
});
it("R2 logout isolates a previous user's pending projects", async () => {
  let resolve!: (value: Project[]) => void;
  vi.mocked(api.listProjects).mockImplementationOnce(
    () => new Promise((r) => (resolve = r)),
  );
  const old = projects.load();
  projects.reset();
  resolve([record("previous-user")]);
  await old;
  expect(projects.state.items).toEqual([]);
  expect(projects.state.loaded).toBe(false);
});
it("R2 newest project-list request wins", async () => {
  let resolve!: (value: Project[]) => void;
  vi.mocked(api.listProjects)
    .mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    .mockResolvedValueOnce([record("new")]);
  const old = projects.load();
  await projects.load(true);
  resolve([record("old")]);
  await old;
  expect(projects.state.items.map((p) => p.id)).toEqual(["new"]);
});
