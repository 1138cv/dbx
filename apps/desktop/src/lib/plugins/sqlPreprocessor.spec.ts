import { describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@/types/database";
import { listSqlPreprocessors, preprocessSql, SQL_PREPROCESSOR_KIND, validateSqlPreprocessorResult } from "@/lib/plugins/sqlPreprocessor";

const installed = (id = "example.pre", compatible = true): InstalledPlugin => ({
  manifest: { id, name: id, drivers: [], entrypoints: { backend: { executable: "bin/pre" } }, capabilities: [{ id: "params", label: "Params", kind: SQL_PREPROCESSOR_KIND }] },
  compatibility: { compatible },
});

describe("SQL plugin preprocessors", () => {
  it("offers only compatible native plugins declaring the versioned preprocessor capability", () => {
    const noBackend = installed("frontend");
    noBackend.manifest.entrypoints = {};
    const other = installed("other");
    other.manifest.capabilities![0]!.kind = "unrelated";
    expect(listSqlPreprocessors([installed(), installed("old", false), noBackend, other]).map((pre) => pre.pluginId)).toEqual(["example.pre"]);
  });

  it("sends the editor text and non-secret context to the declared method", async () => {
    const invoke = vi.fn().mockResolvedValue({ action: "rewrite", sql: "select * from a where a.a = 123" });
    const pre = listSqlPreprocessors([installed()])[0]!;
    const context = { connectionId: "conn-1", dbType: "mysql", database: "app", source: "editor" } as const;
    expect(await preprocessSql(invoke, pre, '{"a": 123}\n===\nselect * from a where a.a = :a', context)).toBe("select * from a where a.a = 123");
    expect(invoke).toHaveBeenCalledWith("example.pre", "sql/preprocess", { preprocessorId: "params", sql: '{"a": 123}\n===\nselect * from a where a.a = :a', context }, 5000);
  });

  it("keeps the original text on passthrough", async () => {
    const invoke = vi.fn().mockResolvedValue({ action: "passthrough" });
    const pre = listSqlPreprocessors([installed()])[0]!;
    expect(await preprocessSql(invoke, pre, "select 1", { connectionId: "c", source: "replay" })).toBe("select 1");
  });

  it("rejects malformed and oversized responses", () => {
    for (const invalid of [null, {}, { action: "drop" }, { action: "rewrite" }, { action: "rewrite", sql: " " }, { action: "rewrite", sql: 1 }, { action: "rewrite", sql: "x".repeat(1_000_001) }]) {
      expect(() => validateSqlPreprocessorResult(invalid)).toThrow();
    }
  });
});
