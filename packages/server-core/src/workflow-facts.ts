import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { CalendarBucket } from "@frontend-insight/event-contract/project-range";
import { SafeClickHouseLogger } from "./clickhouse-logger.js";
import {
  reduceWorkflowInstances,
  summarizeWorkflowCohort,
  type WorkflowFactEvent,
} from "./workflow-reducer.js";
import type { WorkflowFactDefinition } from "./workflow-definitions.js";
import type { BusinessPageWindow } from "./business-facts.js";
export class WorkflowFactStore {
  private readonly client: ClickHouseClient;
  constructor(config: {
    url: string;
    username: string;
    password: string;
    database: string;
  }) {
    this.client = createClient({
      ...config,
      log: { LoggerClass: SafeClickHouseLogger },
    });
  }
  close() {
    return this.client.close();
  }
  async read(
    projectId: string,
    env: string,
    from: string,
    to: string,
    definitions: WorkflowFactDefinition[],
    buckets: CalendarBucket[],
    pages: BusinessPageWindow[],
    asOf = new Date(),
    page = 1,
  ) {
    const end = asOf.valueOf(),
      start = Date.parse(from);
    let queries = 0;
    const response = await this.client.query({
      query: `SELECT event_id AS eventId,toUnixTimestamp64Milli(timestamp) AS timestamp,toUnixTimestamp64Milli(received_at) AS receivedAt,session_id AS sessionId,user_id IS NOT NULL AND user_id!='' AS identified,JSONExtractString(payload_json,'name') AS name,workflow_instance_id AS workflowInstanceId,workflow_key AS workflowKey,workflow_definition_version AS version,workflow_step_key AS stepKey,workflow_step_order AS stepOrder,operation_instance_id AS operationInstanceId,feature_key AS operationKey FROM raw_events WHERE project_id={projectId:UUID} AND env={env:String} AND workflow_instance_id IS NOT NULL AND timestamp>=fromUnixTimestamp64Milli({start:Int64}) AND timestamp<=fromUnixTimestamp64Milli({end:Int64}) AND received_at<=fromUnixTimestamp64Milli({end:Int64}) ORDER BY timestamp,event_id LIMIT 50001`,
      query_params: { projectId, env, start: start - 604800000, end },
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 5,
        max_rows_to_read: "400000000",
        read_overflow_mode: "throw",
      },
    });
    queries++;
    const body = await response.json<Record<string, unknown>>();
    if (body.data.length > 50000) throw new Error("WORKFLOW_FACT_LIMIT");
    const events = body.data.map((r) => ({
      eventId: String(r.eventId),
      timestamp: Number(r.timestamp),
      receivedAt: Number(r.receivedAt),
      sessionId: String(r.sessionId),
      identified: Boolean(Number(r.identified)),
      name: String(r.name),
      workflowInstanceId: String(r.workflowInstanceId),
      workflowKey: String(r.workflowKey),
      version: Number(r.version),
      ...(r.stepKey
        ? { stepKey: String(r.stepKey), stepOrder: Number(r.stepOrder) }
        : {}),
      ...(r.operationInstanceId
        ? { operationInstanceId: String(r.operationInstanceId) }
        : {}),
      ...(r.operationKey ? { operationKey: String(r.operationKey) } : {}),
    })) satisfies WorkflowFactEvent[];
    const reduced = reduceWorkflowInstances(events, definitions, end);
    const instances = reduced.instances.filter(
      (i) => i.startedAt >= start && i.startedAt < Date.parse(to),
    );
    const completed = instances.filter((i) => i.state === "completed");
    const sessionIds = [...new Set(completed.map((i) => i.sessionId))];
    if (sessionIds.length > 5000) throw new Error("WORKFLOW_SESSION_LIMIT");
    let pathRows: { timestamp: number; sessionId: string; pageRoute: string }[] = [];
    if (sessionIds.length) {
      const response = await this.client.query({
        query: `SELECT toUnixTimestamp64Milli(timestamp) AS timestamp,session_id AS sessionId,page_route AS pageRoute FROM (SELECT event_id,timestamp,session_id,page_route FROM raw_events WHERE project_id={projectId:UUID} AND env={env:String} AND event='page_view' AND session_id IN {sessionIds:Array(String)} AND timestamp>=fromUnixTimestamp64Milli({start:Int64}) AND timestamp<=fromUnixTimestamp64Milli({end:Int64}) AND received_at<=fromUnixTimestamp64Milli({end:Int64}) ORDER BY received_at,event_id LIMIT 1 BY event_id) ORDER BY timestamp,event_id LIMIT 50001`,
        query_params: { projectId, env, sessionIds, start: start - 1800000, end },
        format: "JSONEachRow",
        clickhouse_settings: { max_execution_time: 5 },
      });
      queries++;
      const rows = await response.json<{
        timestamp: string;
        sessionId: string;
        pageRoute: string;
      }>();
      if (rows.length > 50000) throw new Error("WORKFLOW_PATH_LIMIT");
      pathRows = rows.map((r) => ({ ...r, timestamp: Number(r.timestamp) }));
    }
    const paths = new Map(
      completed.map((i) => {
        const path = pathRows.filter(
          (p) =>
            p.sessionId === i.sessionId &&
            p.timestamp >= i.startedAt - 1800000 &&
            p.timestamp <= i.terminalAt!,
        );
        const classified = path.map((p) => ({
          p,
          revision: pages.find(
            (r) =>
              r.pageRoute === p.pageRoute &&
              p.timestamp >= Date.parse(r.from) &&
              p.timestamp < Date.parse(r.to),
          ),
        }));
        const included = classified.filter((p) => p.revision?.included);
        const seen = new Set<string>();
        let backtracks = 0,
          previous: string | null = null;
        for (const { p } of included) {
          if (p.pageRoute !== previous && seen.has(p.pageRoute)) backtracks++;
          seen.add(p.pageRoute);
          previous = p.pageRoute;
        }
        return [
          i.workflowInstanceId,
          {
            distinctPages: seen.size,
            totalSteps: included.length,
            backtrackSteps: backtracks,
            moduleSpan: new Set(included.map((p) => p.revision!.moduleId)).size,
            excluded: classified.length - included.length,
            from: new Date(i.startedAt - 1800000).toISOString(),
            to: new Date(i.terminalAt!).toISOString(),
            status: "partial",
            reason: "SESSION_LOOKBACK_BOUNDED_NOT_CAUSAL",
            explanation:
              "同session完成前观察路径，最多回溯开始前30分钟；并发任务可能共享页面，不表示因果归属；未归类/停用或缺历史revision的页面排除。",
          },
        ] as const;
      }),
    );
    return {
      context: {
        projectId,
        env,
        from,
        to,
        asOf: asOf.toISOString(),
        cohort: "started_at_in_[from,to)",
        terminalWindow:
          "cohort outcomes observed through asOf; not terminal-time filtered",
        completion: "provisional; late events may change observations",
        physicalRetentionDays: 90,
      },
      status: definitions.length
        ? instances.length
          ? "partial"
          : "no_facts"
        : "no_definitions",
      reason: instances.length
        ? "WORKFLOW_OBSERVATIONS_COVERAGE_NOT_VERIFIED"
        : "NO_WORKFLOW_EVENTS_IN_COHORT",
      availableFrom: events.length
        ? new Date(Math.min(...events.map((e) => e.timestamp))).toISOString()
        : null,
      coverage: "unknown; earliest observation is not a completeness guarantee",
      rejected: reduced.rejected,
      page,
      pageSize: 20,
      totalDefinitions: definitions.length,
      definitions: definitions.slice((page - 1) * 20, page * 20).map((d) => ({
        id: d.id,
        versionId: d.versionId,
        workflowKey: d.workflowKey,
        name: d.name,
        version: d.version,
        moduleId: d.moduleId,
        status: d.status,
        effectiveFrom: d.effectiveFrom,
        effectiveTo: d.effectiveTo,
        timeoutSeconds: d.timeoutSeconds,
        ...summarizeWorkflowCohort(instances, d, start, Date.parse(to)),
        trends: buckets.map((b) => ({
          from: b.from,
          to: b.to,
          partial: b.partial,
          ...summarizeWorkflowCohort(
            instances,
            d,
            Date.parse(b.from),
            Date.parse(b.to),
          ),
        })),
      })),
      evidence: instances.slice(0, 100).map((i) => ({
        workflowInstanceId: i.workflowInstanceId,
        workflowKey: i.workflowKey,
        versionId: i.versionId,
        startedAt: new Date(i.startedAt).toISOString(),
        terminalAt: i.terminalAt === null ? null : new Date(i.terminalAt).toISOString(),
        state: i.state,
        durationMs: i.durationMs,
        identified: i.identified,
        steps: i.steps,
        reasons: i.reasons,
        path_steps: paths.get(i.workflowInstanceId) ?? null,
      })),
      evidenceTotal: instances.length,
      evidenceLimit: 100,
      evidenceTruncated: instances.length > 100,
      diagnostics: {
        clickHouseQueries: queries,
        rowsRead: body.statistics?.rows_read ?? 0,
        bytesRead: body.statistics?.bytes_read ?? 0,
      },
    };
  }
}
