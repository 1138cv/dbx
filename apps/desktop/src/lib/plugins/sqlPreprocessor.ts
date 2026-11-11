import type { InstalledPlugin } from "@/types/database";

/** Versioned capability kind; older hosts simply ignore it. */
export const SQL_PREPROCESSOR_KIND = "sql-preprocessor-v1";
export const SQL_PREPROCESSOR_MAX_SQL_CHARS = 1_000_000;
export const SQL_PREPROCESSOR_TIMEOUT_MS = 5_000;

export interface SqlPreprocessor {
  key: string;
  pluginId: string;
  preprocessorId: string;
  label: string;
}

/** Where the text comes from; plugins may treat replays differently. */
export type SqlPreprocessSource = "editor" | "replay";

export interface SqlPreprocessContext {
  connectionId: string;
  dbType?: string;
  database?: string;
  schema?: string;
  locale?: string;
  source: SqlPreprocessSource;
}

export type SqlPreprocessOutcome = { action: "rewrite"; sql: string } | { action: "passthrough" };

export function listSqlPreprocessors(plugins: readonly InstalledPlugin[]): SqlPreprocessor[] {
  return plugins
    .filter((plugin) => plugin.compatibility.compatible && plugin.manifest.entrypoints?.backend)
    .flatMap((plugin) =>
      (plugin.manifest.capabilities ?? [])
        .filter((capability) => capability.kind === SQL_PREPROCESSOR_KIND)
        .map((capability) => ({
          key: JSON.stringify([plugin.manifest.id, capability.id]),
          pluginId: plugin.manifest.id,
          preprocessorId: capability.id,
          label: `${plugin.manifest.name} · ${capability.label}`,
        })),
    )
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function validateSqlPreprocessorSql(sql: string): void {
  if (sql.length > SQL_PREPROCESSOR_MAX_SQL_CHARS) throw new Error(`SQL preprocessor input exceeds ${SQL_PREPROCESSOR_MAX_SQL_CHARS} characters`);
}

export function validateSqlPreprocessorResult(result: unknown): SqlPreprocessOutcome {
  if (!result || typeof result !== "object") throw new Error("Invalid SQL preprocessor response");
  const response = result as { action?: unknown; sql?: unknown };
  if (response.action === "passthrough") return { action: "passthrough" };
  if (response.action !== "rewrite") throw new Error("SQL preprocessor must return rewrite or passthrough");
  if (typeof response.sql !== "string" || !response.sql.trim()) throw new Error("SQL preprocessor rewrite must return a non-empty SQL string");
  if (response.sql.length > SQL_PREPROCESSOR_MAX_SQL_CHARS) throw new Error(`SQL preprocessor result exceeds ${SQL_PREPROCESSOR_MAX_SQL_CHARS} characters`);
  return { action: "rewrite", sql: response.sql };
}

export type SqlPreprocessorInvoker = (pluginId: string, method: string, params: unknown, timeoutMs: number) => Promise<unknown>;

/**
 * Runs one preprocessor. The plugin answers `passthrough` for text it does not
 * own, so unrelated statements execute unchanged; a rewrite must be
 * deterministic because pagination, sorting, and refresh replays derive from
 * the rewritten base SQL and replays re-run this method on the same editor text.
 */
export async function preprocessSql(invoke: SqlPreprocessorInvoker, preprocessor: SqlPreprocessor, sql: string, context: SqlPreprocessContext): Promise<string> {
  validateSqlPreprocessorSql(sql);
  const result = validateSqlPreprocessorResult(await invoke(preprocessor.pluginId, "sql/preprocess", { preprocessorId: preprocessor.preprocessorId, sql, context }, SQL_PREPROCESSOR_TIMEOUT_MS));
  return result.action === "rewrite" ? result.sql : sql;
}
