import { describe, expect, it } from "vitest";
import { resolveProjectCalendar } from "@frontend-insight/event-contract/project-range";
import {
  reduceOrganization,
  organizationWindowReason,
  type OrganizationContext,
  type OrganizationEvent,
} from "../src/organization-facts.js";
const day = 86400000;
const from = Date.parse("2026-09-01T00:00:00Z");
const context: OrganizationContext = {
  projectId: "project",
  env: "dev",
  asOf: from + 4 * day,
  moduleId: "module",
  buckets: resolveProjectCalendar(
    {
      range: "7d",
      env: "dev",
      from: new Date(from).toISOString(),
      to: new Date(from + day).toISOString(),
    },
    "UTC",
  ).buckets,
  directories: [
    {
      projectId: "project",
      id: "directory",
      env: "dev",
      sourceKey: "isolated_fixture",
      coverage: "complete",
      status: "published",
      from: new Date(from).toISOString(),
      until: new Date(from + 5 * day).toISOString(),
      entries: Array.from({ length: 6 }, (_, i) => ({
        userId: `user${i}`,
        deptId: "dept_fixture",
        roleId: "role_fixture",
        eligible: true,
      })),
    },
  ],
  pages: [
    {
      pageId: "p",
      pageRoute: "/",
      name: "fixture",
      moduleId: "module",
      pageRevisionId: "page1",
      moduleRevisionId: "module1",
      from: new Date(from).toISOString(),
      to: new Date(from + 5 * day).toISOString(),
      included: true,
      reason: "INCLUDED",
    },
  ],
};
const events = (count = 5): OrganizationEvent[] =>
  Array.from({ length: count }, (_, i) => {
    const view: OrganizationEvent = {
      id: `v${i}`,
      at: from + 1000,
      received: from + 1000,
      event: "page_view",
      user: `user${i}`,
      session: `session${i}`,
      page: "/",
      pageView: `view${i}`,
      directory: "directory",
      dept: "dept_fixture",
      role: "role_fixture",
      payload: {},
    };
    return [
      view,
      {
        ...view,
        id: `l${i}`,
        at: from + 2000,
        received: from + 2000,
        event: "page_leave",
        payload: { visibleDurationMs: 1000 },
      },
    ];
  }).flat();
describe("C05 server-side whole-family organization policy", () => {
  it("computes observed unique people, real eligible denominator, PV and validated visible duration", () => {
    const r = reduceOrganization([...events(), events()[0]!], context);
    expect(r.status).toBe("partial");
    expect(r.values?.[0]?.groups).toMatchObject([
      {
        active: 5,
        eligible: 6,
        observedRatio: 5 / 6,
        pv: 5,
        visibleDurationMs: 5000,
        value: null,
      },
      { active: 5, eligible: 6, pv: 5 },
    ]);
    expect(r.values?.[0]?.directoryVersionId).toBe("directory");
    expect(JSON.stringify(r)).not.toContain('"user0"');
    expect(JSON.stringify(r)).not.toContain('"session0"');
  });
  it("suppresses every number at k-1 and releases observed aggregates at k, never treating sample minimum as policy", () => {
    expect(reduceOrganization(events(4), context)).toMatchObject({
      status: "privacy_suppressed",
      reason: "ORGANIZATION_SMALL_GROUP",
      values: null,
    });
    expect(reduceOrganization(events(5), context).values).not.toBeNull();
    const c = structuredClone(context);
    c.directories[0]!.entries = c.directories[0]!.entries.slice(0, 4);
    expect(reduceOrganization(events(5), c).values).toBeNull();
  });
  it("does not allow module selection, Top N or totals to bypass a hidden small group", () => {
    const c = structuredClone(context);
    c.pages.push({
      ...c.pages[0]!,
      pageRoute: "/other",
      pageId: "other",
      moduleId: "other",
    });
    expect(reduceOrganization(events(), c).values).toBeNull();
    c.directories[0]!.entries.push({
      userId: "extra",
      deptId: "dept_small",
      roleId: "role_small",
      eligible: true,
    });
    expect(reduceOrganization(events(), c).values).toBeNull();
  });
  it("never replaces missing or overlapping page-leave data with zero duration", () => {
    const without = events().filter((e) => e.id !== "l0");
    expect(reduceOrganization(without, context).values?.[0]?.groups[0]).toMatchObject({
      pv: 5,
      visibleDurationMs: null,
      durationReason: "VALID_PAGE_LEAVE_MISSING",
    });
    const overlap = [...events(), { ...events()[1]!, id: "overlap" }];
    expect(
      reduceOrganization(overlap, context).values?.[0]?.groups[0]?.visibleDurationMs,
    ).toBeNull();
  });
  it("rejects forged membership and asOf-late samples before aggregation", () => {
    const forged = events().map((e) =>
      e.user === "user0" ? { ...e, dept: "dept_forged" } : e,
    );
    expect(reduceOrganization(forged, context).values).toBeNull();
    expect(
      reduceOrganization(
        events().map((e) =>
          e.user === "user0" ? { ...e, received: context.asOf + 1 } : e,
        ),
        context,
      ).values,
    ).toBeNull();
    expect(
      reduceOrganization([...events(), { ...events()[0]!, user: "other" }], context)
        .reason,
    ).toBe("ORGANIZATION_CONFLICTING_FACTS");
  });
  it("does not publish partial/sliding/open buckets, unknown coverage, zero population or a version boundary", () => {
    expect(organizationWindowReason({ ...context, directories: [] })).toBe(
      "TRUSTED_DIRECTORY_MISSING",
    );
    expect(
      organizationWindowReason({
        ...context,
        buckets: context.buckets.map((b) => ({ ...b, partial: true })),
      }),
    ).toBe("ORGANIZATION_FIXED_BUCKET_REQUIRED");
    expect(organizationWindowReason({ ...context, asOf: from + day })).toBe(
      "ORGANIZATION_LATENESS_WINDOW_OPEN",
    );
    const c = structuredClone(context);
    c.directories[0]!.coverage = "unknown";
    expect(organizationWindowReason(c)).toBe("DIRECTORY_COVERAGE_UNKNOWN");
    c.directories[0]!.coverage = "complete";
    c.directories.push({
      ...c.directories[0]!,
      id: "second",
      from: new Date(from + 1000).toISOString(),
    });
    expect(organizationWindowReason(c)).toBe("DIRECTORY_VERSION_BOUNDARY");
    c.directories = [{ ...c.directories[0]!, entries: [] }];
    expect(organizationWindowReason(c)).toBe("ZERO_DENOMINATOR");
  });
  it("uses actual DST calendar bucket boundaries rather than fixed 24h day lengths", () => {
    const c = structuredClone(context);
    c.buckets = resolveProjectCalendar(
      {
        range: "7d",
        env: "dev",
        from: "2026-03-08T05:00:00.000Z",
        to: "2026-03-09T04:00:00.000Z",
      },
      "America/New_York",
    ).buckets;
    expect(Date.parse(c.buckets[0]!.to) - Date.parse(c.buckets[0]!.from)).toBe(
      23 * 3600000,
    );
    c.asOf = Date.parse("2026-03-10T04:00:00Z");
    c.directories[0]!.from = "2026-03-01T00:00:00Z";
    c.directories[0]!.until = "2026-04-01T00:00:00Z";
    expect(organizationWindowReason(c)).toBeNull();
  });
});
