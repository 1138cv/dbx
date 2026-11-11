import { createPinia, setActivePinia } from "pinia";
import { SQL_PREPROCESSOR_KIND } from "@/lib/plugins/sqlPreprocessor";
import type { InstalledPlugin } from "@/types/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const EDITOR_SQL = '{"a": 123, "ab": "123b"}\n===\nselect * from a\nwhere a.a = :a\nand a.bc = :ab';
const REWRITTEN_SQL = "select * from a where a.a = 123 and a.bc = '123b'";

const mocks = vi.hoisted(() => ({
  analyzeEditableQueryEditability: vi.fn(),
  cancelQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  ensureConnected: vi.fn(),
  executeMulti: vi.fn(),
  executeMultiWithProgress: vi.fn(),
  executeQuery: vi.fn(),
  getConnectionConfig: vi.fn(),
  invokePlugin: vi.fn(),
  listPlugins: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(),
  saveOpenTabsState: vi.fn(),
  clearDataGridPendingSnapshot: vi.fn(),
  clearDataGridPendingSnapshotsForTab: vi.fn(),
  tabResultSnapshots: new Map<string, unknown>(),
}));

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: mocks.analyzeEditableQueryEditability,
  cancelQuery: mocks.cancelQuery,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  closeQuerySession: mocks.closeQuerySession,
  executeMulti: mocks.executeMulti,
  executeMultiWithProgress: mocks.executeMultiWithProgress,
  executeQuery: mocks.executeQuery,
  invokePlugin: mocks.invokePlugin,
  listPlugins: mocks.listPlugins,
  prepareQueryPaginationExecutionPlan: mocks.prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConnectionConfig,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { autoCalculateTotalRows: false, pageSize: 100, continueOnErrorOnBatch: false, defaultAutoKeepResults: false },
  }),
}));

vi.mock("@/composables/useDataGridEditor", () => ({
  clearDataGridPendingSnapshot: mocks.clearDataGridPendingSnapshot,
  clearDataGridPendingSnapshotsForTab: mocks.clearDataGridPendingSnapshotsForTab,
}));

vi.mock("@/lib/tabs/tabResultCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
  return {
    ...actual,
    writeTabResultSnapshot: vi.fn(async (key: string, snapshot: unknown) => {
      mocks.tabResultSnapshots.set(key, actual.decodeTabResultSnapshot(actual.encodeTabResultSnapshot(snapshot as Parameters<typeof actual.encodeTabResultSnapshot>[0])));
      return true;
    }),
    readTabResultSnapshot: vi.fn(async (key: string) => mocks.tabResultSnapshots.get(key)),
    deleteTabResultSnapshot: vi.fn(async (key: string) => {
      mocks.tabResultSnapshots.delete(key);
    }),
  };
});

const preprocessorPlugin = (kind: string = SQL_PREPROCESSOR_KIND): InstalledPlugin => ({
  manifest: { id: "vendor.params", name: "Params", drivers: [], entrypoints: { backend: { executable: "bin/pre" } }, capabilities: [{ id: "bind", label: "Bind", kind }] },
  compatibility: { compatible: true },
});

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("queryStore plugin SQL preprocessors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.tabResultSnapshots.clear();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.cancelQuery.mockResolvedValue(true);
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConnectionConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    mocks.listPlugins.mockResolvedValue([]);
    mocks.invokePlugin.mockResolvedValue({ action: "passthrough" });
    mocks.analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "multiple-statements" });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: undefined,
      pageLimit: undefined,
      pageOffset: undefined,
      countSql: undefined,
      useAgentResultSession: false,
    }));
    mocks.executeMulti.mockResolvedValue([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    mocks.executeMultiWithProgress.mockImplementation(async (connectionId, database, sql, onProgress, schema, options) => {
      const results = await mocks.executeMulti(connectionId, database, sql, schema, options?.executionId, options);
      const total = results.length;
      results.forEach((result: any, index: number) => {
        const statementIndex = result.statement_index ?? index;
        const success = result.execution_error !== true;
        onProgress({
          executionId: options?.executionId,
          statementIndex,
          completed: index + 1,
          total,
          success,
          executionTimeMs: result.execution_time_ms,
          affectedRows: result.affected_rows,
          error: success ? undefined : result.error,
        });
      });
      return results;
    });
  });

  it("executes the rewritten statement and records it as the executed SQL", async () => {
    mocks.listPlugins.mockResolvedValue([preprocessorPlugin()]);
    mocks.invokePlugin.mockResolvedValue({ action: "rewrite", sql: REWRITTEN_SQL });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, EDITOR_SQL);

    expect(mocks.invokePlugin).toHaveBeenCalledWith("vendor.params", "sql/preprocess", { preprocessorId: "bind", sql: EDITOR_SQL, context: expect.objectContaining({ connectionId: "mysql-1", dbType: "mysql", database: "app", source: "editor" }) }, 5000);
    expect(mocks.executeMulti).toHaveBeenCalledWith("mysql-1", "app", REWRITTEN_SQL, undefined, expect.any(String), expect.objectContaining({ continueOnError: false }));
    expect(store.tabs.find((item) => item.id === tabId)?.lastExecutedSql).toBe(REWRITTEN_SQL);

    // Unchanged editor text is deterministically preprocessed again, not skipped.
    await store.executeTabSql(tabId, EDITOR_SQL);
    expect(mocks.invokePlugin).toHaveBeenCalledTimes(2);
  });

  it("keeps ordinary statements unchanged on passthrough", async () => {
    mocks.listPlugins.mockResolvedValue([preprocessorPlugin()]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1");
    await store.executeTabSql(tabId, "SELECT 1");

    expect(mocks.invokePlugin).toHaveBeenCalledTimes(2);
    expect(mocks.executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT 1", undefined, expect.any(String), expect.objectContaining({ continueOnError: false }));
  });

  it("does not invoke preprocessors when none are installed", async () => {
    mocks.listPlugins.mockResolvedValue([preprocessorPlugin("unrelated-kind")]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1");

    expect(mocks.invokePlugin).not.toHaveBeenCalled();
    expect(mocks.executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT 1", undefined, expect.any(String), expect.objectContaining({ continueOnError: false }));
  });

  it("recognizes already-preprocessed replay SQL instead of preprocessing twice", async () => {
    mocks.listPlugins.mockResolvedValue([preprocessorPlugin()]);
    mocks.invokePlugin.mockResolvedValue({ action: "rewrite", sql: REWRITTEN_SQL });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, EDITOR_SQL);
    await store.executeTabSql(tabId, REWRITTEN_SQL);

    expect(mocks.invokePlugin).toHaveBeenCalledTimes(1);
    expect(mocks.executeMulti).toHaveBeenLastCalledWith("mysql-1", "app", REWRITTEN_SQL, undefined, expect.any(String), expect.objectContaining({ continueOnError: false }));
  });

  it("fails the execution closed and resets the tab when a preprocessor fails", async () => {
    mocks.listPlugins.mockResolvedValue([preprocessorPlugin()]);
    mocks.invokePlugin.mockRejectedValue(new Error("plugin crashed"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await expect(store.executeTabSql(tabId, EDITOR_SQL)).rejects.toThrow("SQL preprocessor 'Params · Bind' failed: plugin crashed");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(tab.isExecuting).toBe(false);
    expect(tab.executionId).toBeUndefined();
    expect(tab.lastExecutedSql).toBeUndefined();
  });
});
