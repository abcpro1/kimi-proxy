import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HybridLogStore } from "../src/persistence/hybridLogStore.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-log-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("HybridLogStore", () => {
  it("writes metadata and blobs to disk", () => {
    const dbPath = path.join(tmpDir, "logs.db");
    const blobRoot = path.join(tmpDir, "blobs");
    const store = new HybridLogStore(dbPath, blobRoot);

    const entry = store.append({
      requestId: "req-test",
      method: "POST",
      url: "/v1/chat/completions",
      statusCode: 200,
      model: "gpt-test",
      provider: "openai",
      operation: "chat",
      requestBody: { hello: "world" },
      responseBody: { ok: true },
      providerRequestBody: { upstream: true },
      providerResponseBody: { upstream: "resp" },
    });

    expect(entry?.id).toBeGreaterThan(0);
    expect(entry?.request_path).toBeTruthy();
    expect(entry?.response_path).toBeTruthy();

    const resolvedPath = store.resolveBlobPath(entry!, "request");
    expect(resolvedPath && fs.existsSync(resolvedPath)).toBe(true);

    const ids = store.findIdsByRequestIds(["req-test", "missing"]);
    expect(ids).toContain(entry!.id);
  });
});
