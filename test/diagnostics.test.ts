import assert from "node:assert/strict";
import { test } from "node:test";
import { getRequestDiagnostics, recordTransportError, startRequestDiagnostics } from "../src/diagnostics.ts";

test("diagnostics preserve timeout codes and never retain error messages or payloads", () => {
  const record = startRequestDiagnostics("model", 300000, 12345);
  recordTransportError(record, Object.assign(new Error("secret prompt and key"), {
    cause: Object.assign(new Error("secret-url"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
  }), 4012, false);
  const diagnostics = getRequestDiagnostics()!;
  assert.equal(diagnostics.timeoutMs, 300000);
  assert.equal(diagnostics.elapsedMs, 4012);
  assert.equal(diagnostics.transportErrors?.[1].code, "UND_ERR_CONNECT_TIMEOUT");
  assert.ok(!JSON.stringify(diagnostics).includes("secret"));
  diagnostics.phase = "streaming";
  assert.equal(getRequestDiagnostics()!.phase, "transport-error");
});
