import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const beforeInvocationBudget = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/budgets.js", async () => {
  const actual = await vi.importActual<typeof import("../services/budgets.js")>("../services/budgets.js");
  return { ...actual, budgetService: (...args: Parameters<typeof actual.budgetService>) => {
    const service = actual.budgetService(...args);
    return { ...service, getInvocationBlock: async (...input: Parameters<typeof service.getInvocationBlock>) => {
      await beforeInvocationBudget();
      return service.getInvocationBlock(...input);
    } };
  } };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat stale-queue invalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupHeartbeatInvalidationFixture(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "company_skills",
          "issue_comments",
          "issue_documents",
          "document_revisions",
          "documents",
          "issue_relations",
          "issue_tree_holds",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch (error) {
      const isLateCommentRace =
        error instanceof Error &&
        error.message.includes("issue_comments_issue_id_issues_id_fk");
      if (!isLateCommentRace || attempt === 9) {
        throw error;
      }

      // Heartbeat completion can write issue-thread comments shortly after the
      // run leaves queued/running. Retry the dependent deletes once those land.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

type SeedOptions = {
  agentName?: string;
  agentRole?: string;
  maxConcurrentRuns?: number;
  heartbeatConfig?: Record<string, unknown>;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat stale queued-run invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    beforeInvocationBudget.mockReset();
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stale-queue invalidation test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await cleanupHeartbeatInvalidationFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: SeedOptions = {}): Promise<SeedResult> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.agentName ?? "ClaudeCoder",
      role: opts.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
          ...(opts.heartbeatConfig ?? {}),
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    contextExtras?: Record<string, unknown>;
    invocationSource?: "assignment" | "automation";
    scheduledRetryReason?: string | null;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input.wakeReason,
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.wakeReason,
        ...(input.contextExtras ?? {}),
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it("skips generic timer wakes with no actionable assigned work before adapter execution", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const runRows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.timer.no_actionable_work",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        reason: expect.stringContaining("No assigned todo or in_progress issue"),
      },
    });
    expect(runRows).toHaveLength(0);
  });

  it("rate-limits skipped generic timer wakes by advancing the timer baseline", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
        skipTimerWhenNoActionableWork: true,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date(now.getTime() - 120_000) })
      .where(eq(agents.id, agentId));

    const firstTick = await heartbeat.tickTimers(now);
    const secondTick = await heartbeat.tickTimers(now);

    expect(firstTick.skipped).toBe(1);
    expect(secondTick.skipped).toBe(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.reason).toBe("heartbeat.timer.no_actionable_work");
    expect(agent?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThan(now.getTime() - 120_000);
  });

  it("atomically claims a due timer interval across overlapping scheduler ticks", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({
        createdAt: new Date(now.getTime() - 120_000),
        lastHeartbeatAt: null,
      })
      .where(eq(agents.id, agentId));

    const results = await Promise.all([
      heartbeat.tickTimers(now),
      heartbeat.tickTimers(now),
    ]);

    expect(results.reduce((total, result) => total + result.enqueued, 0)).toBe(1);

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      timerClaimWasFirstHeartbeat: true,
    });
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("allows generic timer wakes when the agent has assigned todo work", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Assigned work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);

    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows legacy generic timer wakes by default when no skip policy is set", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows explicit proactive generic timer wakes without assigned issue work", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: false,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("skips wakes before queueing when per-agent daily run cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("treats zero daily run cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("counts started cancelled runs toward the per-agent daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "cancelled",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("coalesces same-issue wakes before enforcing the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });

    expect(run?.id).toBe(queuedRunId);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "coalesced",
          reason: "issue_execution_same_name",
          runId: queuedRunId,
        }),
      ]),
    );
  });

  it("skips wakes before queueing when per-agent daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 75,
        limit: 75,
      },
    });
  });

  it("treats zero daily cost cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("skips already queued runs before adapter execution when the daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_cost_limit",
    });
    expect(run?.resultJson).toMatchObject({
      stopReason: "heartbeat.daily_cost_limit",
      observed: 75,
      limit: 75,
    });
    expect(wakeup).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("per-day heartbeat budget cap"),
    });
  });

  it("skips already queued issue runs at the daily run cap and releases the execution lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    const [issue] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_run_limit",
    });
    expect(wakeup).toMatchObject({ status: "skipped" });
    expect(issue?.executionRunId).toBeNull();
  });

  it.each(["codex_local", "process"])("blocks seventh native reservation for %s despite spoofed campaign", async (adapterType) => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 1 });
    await db.update(agents).set({ adapterType }).where(eq(agents.id, agentId));
    const issueId = randomUUID();
    const campaignId = "acceptance-issue-cap";
    await db.update(agents).set({ runtimeConfig: { heartbeat: { campaignId, maxConcurrentRuns: 2, coordinationOnly: adapterType !== "process" } } }).where(eq(agents.id, agentId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Capped issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
    for (let i = 0; i < 6; i += 1) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(),
        contextSnapshot: { issueId, campaignId, nativeCampaignAdmission: true, nativeModelReservation: true },
      });
    }
    const queued = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: { campaignId: "untrusted-reset-attempt" },
    });
    await db.update(issues).set({ executionRunId: queued.runId }).where(eq(issues.id, issueId));

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued.runId));
    expect(run).toMatchObject({ status: "cancelled", errorCode: "heartbeat.issue_invocation_limit" });
    expect(run?.resultJson).toMatchObject({ stopReason: "heartbeat.issue_invocation_limit", observed: 6, limit: 6 });
  });

  it("does not charge process coordination against a model slot", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 1 });
    const issueId = randomUUID();
    const campaignId = "acceptance-issue-cap";
    await db.update(agents).set({ adapterType: "process", runtimeConfig: { heartbeat: { campaignId, coordinationOnly: true } } }).where(eq(agents.id, agentId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Capped issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
    for (let i = 0; i < 6; i += 1) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(),
        contextSnapshot: { issueId, campaignId, nativeCampaignAdmission: true, nativeModelReservation: true },
      });
    }
    const queued = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: { campaignId: "untrusted-reset-attempt" },
    });
    await db.update(issues).set({ executionRunId: queued.runId }).where(eq(issues.id, issueId));

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(countExecuteCallsForRun(queued.runId)).toBe(1);
    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued.runId));
    expect(run?.status).toBe("succeeded");
  });

  it("ignores caller campaign opt-in when no saved actor campaign exists", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 1 });
    const issueId = randomUUID();
    const campaignId = "acceptance-issue-cap";
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, agentId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Capped issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
    for (let i = 0; i < 6; i += 1) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(),
        contextSnapshot: { issueId, campaignId, nativeCampaignAdmission: true, nativeModelReservation: true },
      });
    }
    const queued = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: { campaignId },
    });
    await db.update(issues).set({ executionRunId: queued.runId }).where(eq(issues.id, issueId));

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(countExecuteCallsForRun(queued.runId)).toBe(1);
    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued.runId));
    expect(run?.status).toBe("succeeded");
  });

  it("blocks a campaign whose first started run is older than the budget window", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 1 });
    const issueId = randomUUID();
    const campaignId = "acceptance-budget-expired";
    await db.update(agents).set({ adapterType: "process", runtimeConfig: { heartbeat: { campaignId, coordinationOnly: true } } }).where(eq(agents.id, agentId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired campaign work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      status: "succeeded",
      createdAt: new Date(Date.now() - 46 * 60_000),
      startedAt: new Date(Date.now() - 46 * 60_000),
      finishedAt: new Date(Date.now() - 45 * 60_000),
      contextSnapshot: { issueId, campaignId, nativeCampaignAdmission: true, nativeModelReservation: false },
    });
    const queued = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
      invocationSource: "assignment",
      contextExtras: { campaignId },
    });
    await db.update(issues).set({ executionRunId: queued.runId }).where(eq(issues.id, issueId));

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued.runId));
    expect(run).toMatchObject({ status: "cancelled", errorCode: "heartbeat.campaign_budget_expired" });
    expect(run?.resultJson).toMatchObject({
      stopReason: "heartbeat.campaign_budget_expired",
      limit: 45 * 60 * 1000,
    });
  });

  it.each(["ordinary", "campaign", "capped"])("preserves a wake coalesced after claim fetched the queued row (%s)", async (mode) => {
    const campaignId = mode === "ordinary" ? null : "coalesced-claim";
    const { companyId, agentId } = await seedCompanyAndAgent({ heartbeatConfig: { campaignId } });
    const issueId = randomUUID(), commentId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Coalesced claim", status: "in_progress", assigneeAgentId: agentId });
    const queued = await seedQueuedRun({ companyId, agentId, issueId, wakeReason: "issue_assigned" });
    await db.update(issues).set({ executionRunId: queued.runId }).where(eq(issues.id, issueId));
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, body: "Follow-up arriving during claim" });
    if (mode === "capped") {
      for (let i = 0; i < 6; i++) await db.insert(heartbeatRuns).values({
        companyId, agentId, invocationSource: "automation", status: "succeeded",
        startedAt: new Date(), finishedAt: new Date(),
        contextSnapshot: { issueId, campaignId, nativeCampaignAdmission: true, nativeModelReservation: true },
      });
    }
    let reached!: () => void, release!: () => void;
    const fetched = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    beforeInvocationBudget.mockImplementationOnce(async () => { reached(); await gate; });
    const claiming = heartbeat.resumeQueuedRuns();
    let waking: ReturnType<typeof heartbeat.wakeup> | undefined;
    try {
      await fetched;
      // wakeup commits the coalesced row, then waits for the same agent start lock
      // held by claiming. Observe its committed write, not its final promise.
      waking = heartbeat.wakeup(agentId, {
        source: "on_demand", triggerDetail: "manual", payload: { issueId, commentId },
      });
      expect(await waitForCondition(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
        return row?.contextSnapshot?.wakeCommentId === commentId;
      })).toBe(true);
      const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, queued.runId));
      expect(wakeups.some(wake => wake.status === "coalesced")).toBe(true);
    } finally {
      release();
      await Promise.all([claiming, waking]);
    }
    await heartbeat.drainActiveRunExecutions();
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
    expect(row.contextSnapshot?.wakeCommentId).toBe(commentId);
    expect(row.contextSnapshot?.wakeCommentIds).toContain(commentId);
    expect(row.status).toBe(mode === "capped" ? "cancelled" : "succeeded");
    expect(countExecuteCallsForRun(queued.runId)).toBe(mode === "capped" ? 0 : 1);
  });

  it("serializes concurrent campaign admissions so the campaign cap cannot be exceeded", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 2 });
    const campaignId = "acceptance-campaign-cap";
    await db.update(agents).set({ runtimeConfig: { heartbeat: { campaignId, maxConcurrentRuns: 2 } } }).where(eq(agents.id, agentId));
    for (let i = 0; i < 23; i += 1) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(),
        contextSnapshot: { campaignId, issueId: randomUUID(), nativeCampaignAdmission: true, nativeModelReservation: true },
      });
    }
    const [template] = await db.select().from(agents).where(eq(agents.id, agentId));
    const peerAgentId = randomUUID();
    await db.insert(agents).values({ ...template!, id: peerAgentId, name: "Campaign peer" });
    const queued: string[] = [];
    let peerIssueId = "";
    for (let i = 0; i < 2; i += 1) {
      const workerId = i === 0 ? agentId : peerAgentId;
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Concurrent campaign issue ${i}`,
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerId,
      });
      if (i === 1) { peerIssueId = issueId; continue; }
      const run = await seedQueuedRun({
        companyId,
        agentId: workerId,
        issueId,
        wakeReason: "issue_assigned",
        invocationSource: "assignment",
        contextExtras: { campaignId },
      });
      await db.update(issues).set({ executionRunId: run.runId }).where(eq(issues.id, issueId));
      queued.push(run.runId);
    }

    let countQueries = 0, lockAttempts = 0;
    let releaseCount!: () => void;
    const countGate = new Promise<void>(resolve => { releaseCount = resolve; });
    const transaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((callback, options) =>
      transaction(async tx => {
        const execute = tx.execute.bind(tx);
        vi.spyOn(tx, "execute").mockImplementation(query => {
          if ((typeof query === "string" ? query : new PgDialect().sqlToQuery(query.getSQL()).sql).includes("pg_advisory_xact_lock")) lockAttempts++;
          return execute(query);
        });
        const select = tx.select.bind(tx);
        vi.spyOn(tx, "select").mockImplementation(((fields: Parameters<typeof tx.select>[0]) => {
          const builder = select(fields);
          if (fields && "firstStartedAt" in fields) {
            const from = builder.from.bind(builder);
            vi.spyOn(builder, "from").mockImplementation((table: Parameters<typeof builder.from>[0]) => {
              const selection = from(table);
              const where = selection.where.bind(selection);
              vi.spyOn(selection, "where").mockImplementation(condition => {
                const query = where(condition);
                return Promise.resolve(query).then(async rows => {
                  countQueries++;
                  if (countQueries === 1) await countGate;
                  return rows;
                }) as unknown as ReturnType<typeof where>;
              });
              return selection;
            });
          }
          return builder;
        }) as typeof tx.select);
        return callback(tx);
      }, options),
    );
    const firstClaim = heartbeat.resumeQueuedRuns();
    let secondClaim: Promise<void> | undefined;
    try {
      expect(await waitForCondition(async () => countQueries === 1)).toBe(true);
      secondClaim = heartbeat.wakeup(peerAgentId, {
        source: "on_demand", triggerDetail: "manual", payload: { issueId: peerIssueId },
      }).then(run => { expect(run).not.toBeNull(); queued.push(run!.id); });
      expect(await waitForCondition(async () => lockAttempts >= 2 || countQueries >= 2)).toBe(true);
      // The second claim has reached the lock, but cannot count until the first commits.
      expect(lockAttempts).toBeGreaterThanOrEqual(2);
      expect(countQueries).toBe(1);
    } finally {
      releaseCount();
      await Promise.all([firstClaim, secondClaim]);
      transactionSpy.mockRestore();
    }
    await heartbeat.drainActiveRunExecutions();

    const rows = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} in (${sql.join(queued.map((id) => sql`${id}`), sql`, `)})`);
    expect(rows.filter((row) => row.status === "running" || row.status === "succeeded")).toHaveLength(1);
    expect(rows.filter((row) => row.errorCode === "heartbeat.campaign_invocation_limit")).toHaveLength(1);
  });

  it("promotes deferred issue wakes when a queued holder is cancelled by the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    const deferredWakeupId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "PeerAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId: peerAgentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_mention",
        },
      },
      status: "deferred_issue_execution",
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [deferred] = await db
        .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeupId));
      return Boolean(deferred?.runId) && deferred?.status !== "deferred_issue_execution";
    });

    const [deferred] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeupId));
    const [promotedRun] = deferred?.runId
      ? await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, deferred.runId))
      : [];

    expect(deferred?.status).not.toBe("deferred_issue_execution");
    expect(promotedRun?.agentId).toBe(peerAgentId);
  });

  it("cancels queued runs when the issue assignee changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OriginalCoder" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ReplacementCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: replacementAgentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_assignee_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("assignee changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued runs when the issue reaches a terminal status before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already-completed task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued max-turn continuations when the issue is no longer in_progress before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked max-turn continuation",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_not_in_progress");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_not_in_progress" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("no longer in_progress");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued max-turn continuations when another continuation owns the issue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const lockOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: lockOwnerRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
      scheduledRetryAt: new Date("2026-04-20T12:00:00.000Z"),
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Duplicate max-turn continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: lockOwnerRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: new Date("2026-04-20T11:59:00.000Z"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup, issue] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_execution_lock_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_execution_lock_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("execution lock");
    expect(issue?.executionRunId).toBe(lockOwnerRunId);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued in_review runs when the current participant changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task now owned by reviewer",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_review_participant_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_review_participant_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("in-review participant changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("still runs comment-driven wakes on in_review issues even when the agent is no longer the current participant", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task with comment feedback",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: otherAgentId,
      body: "Review feedback comment",
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
  });

  it("baseline: runs queued runs when the issue is in_progress with the same assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Still actionable",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("cancels queued continuation recovery when the continuation summary parks executor work for review", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implementation parked for review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_continuation_waiting_on_review" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("continuation summary says the executor should wait");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("runs accepted-interaction continuation recovery despite a pre-acceptance review park", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Approved implementation resumes",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
        mutation: "interaction",
        interactionId: randomUUID(),
        interactionResolvedAt: "2026-03-19T00:05:00.000Z",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });
});
