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
  it("reserves the admitted 24h clock skew inside received-time retention", () => {
    // A future-dated event can be received a day before its event timestamp.
    // At 89 days its receipt can already be at the 90-day physical TTL boundary.
    expect(organizationWindowReason({ ...context, asOf: from + 89 * day })).toBeNull();
    expect(organizationWindowReason({ ...context, asOf: from + 89 * day + 1 })).toBe(
      "FACT_RETENTION_RANGE_NOT_COVERED",
    );
    expect(
      reduceOrganization(events(), { ...context, asOf: from + 90 * day }),
    ).toMatchObject({
      reason: "FACT_RETENTION_RANGE_NOT_COVERED",
      values: null,
    });
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

const sourceContext = (): OrganizationContext => ({
  ...structuredClone(context),
  sources: [
    {
      id: "source",
      projectId: "project",
      env: "dev",
      sourceKey: "fixture",
      coverage: "complete",
      status: "published",
      sdkVersion: "0.8.0",
      releases: ["r1"],
      from: new Date(from).toISOString(),
      until: new Date(from + 5 * day).toISOString(),
      scope: {
        pages: [{ pageRevisionId: "page1", moduleRevisionId: "module1" }],
        features: ["save"],
      },
    },
  ],
});
const sourceEvents = () =>
  events(6).map((e) => ({
    ...e,
    sdkVersion: "0.8.0",
    release: "r1",
    usageCoverage: { droppedEvents: 0, failedBatches: 0, businessSampleRate: 1 },
  }));
describe("C07 trusted declaration plus observed coverage", () => {
  it("releases formal 6/6 only with matching source, directory and real facts", () => {
    const r = reduceOrganization(sourceEvents(), sourceContext());
    expect(r.coverage).toBe("admin_attested_complete");
    expect(r.values?.[0]?.groups[0]).toMatchObject({ value: 1, formalActive: 6 });
    expect(r.population).toMatchObject({ count: 6, sourceVersion: "source" });
  });
  it.each([
    "sdk",
    "release",
    "loss",
    "disabled",
    "revision",
    "expired",
    "scope",
    "interrupted",
    "definition",
    "silentSampling",
    "featureChange",
  ])("blocks %s without promoting observed data", (kind) => {
    const c = sourceContext(),
      rows = sourceEvents();
    if (kind === "sdk") rows[0]!.sdkVersion = "0.7.0";
    if (kind === "release") rows[0]!.release = "other";
    if (kind === "loss") rows[0]!.usageCoverage.droppedEvents = 1;
    if (kind === "disabled") delete (rows[0] as OrganizationEvent).usageCoverage;
    if (kind === "revision") c.sources![0]!.scope.pages = [];
    if (kind === "expired") c.sources![0]!.until = new Date(from).toISOString();
    if (kind === "scope") c.sources![0]!.projectId = "foreign";
    if (kind === "interrupted") c.sources![0]!.coverage = "interrupted";
    if (kind === "definition") c.formalDefinitionActive = false;
    if (kind === "silentSampling") rows[0]!.usageCoverage.businessSampleRate = 0.5;
    if (kind === "featureChange")
      c.sources![0]!.scopeChangedAt = new Date(from + 1).toISOString();
    expect(reduceOrganization(rows, c).values?.[0]?.groups[0]?.value).toBeNull();
  });
  it("includes controlled successful feature activity and blocks sampled or incomplete adapters", () => {
    const c = sourceContext();
    const featureRows = sourceEvents()
      .filter((e) => e.event === "page_view")
      .flatMap((e) => [
        {
          ...e,
          id: e.id + "start",
          event: "custom",
          payload: {
            name: "feature_started",
            featureKey: "save",
            businessAdapter: true,
            businessSampleRate: 1,
            operationInstanceId: e.id,
          },
        },
        {
          ...e,
          id: e.id + "end",
          at: e.at + 1,
          event: "custom",
          payload: {
            name: "feature_succeeded",
            featureKey: "save",
            businessAdapter: true,
            businessSampleRate: 1,
            businessResult: "success",
            operationInstanceId: e.id,
          },
        },
      ]);
    expect(reduceOrganization(featureRows, c).values?.[0]?.groups[0]).toMatchObject({
      formalActive: 6,
      value: 1,
      pv: 0,
      visibleDurationMs: null,
    });
    const sampled = [
      ...sourceEvents(),
      ...featureRows.map((e) => ({
        ...e,
        payload: { ...e.payload, businessSampleRate: 0.5 },
      })),
    ];
    expect(reduceOrganization(sampled, c).values?.[0]?.groups[0]?.value).toBeNull();
    const incomplete = [...sourceEvents(), featureRows[0]!];
    expect(reduceOrganization(incomplete, c).values?.[0]?.groups[0]?.value).toBeNull();
  });
  it("does not let a declaration bypass whole-family k5 suppression", () => {
    expect(
      reduceOrganization(sourceEvents().slice(0, 8), sourceContext()).values,
    ).toBeNull();
  });
  it("does not resurrect an old complete declaration after interruption expiry", () => {
    const c = sourceContext();
    c.sources!.push({
      ...c.sources![0]!,
      id: "interruption",
      from: new Date(from - 1).toISOString(),
      until: new Date(from).toISOString(),
      coverage: "interrupted",
    });
    c.sources![0]!.from = new Date(from - 2).toISOString();
    expect(
      reduceOrganization(sourceEvents(), c).values?.[0]?.groups[0]?.value,
    ).toBeNull();
  });
  it("deduplicates whole-window population instead of summing bucket UV", () => {
    const c = sourceContext();
    const bucket = c.buckets[0]!;
    c.buckets.push({
      ...bucket,
      from: new Date(from + day).toISOString(),
      to: new Date(from + 2 * day).toISOString(),
    });
    const rows = sourceEvents();
    rows.push(
      ...sourceEvents().map((e) => ({
        ...e,
        id: e.id + "next",
        pageView: e.pageView + "next",
        at: e.at + day,
        received: e.received + day,
      })),
    );
    expect(reduceOrganization(rows, c).population?.count).toBe(6);
  });
});
