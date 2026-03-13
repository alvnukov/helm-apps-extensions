import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyMethodCallGuard,
  errorMessageFromUnknown,
  withParentPidArg,
} from "../../src/lsp/clientFlow";

test("withParentPidArg appends parent pid when not provided", () => {
  const input = ["lsp", "--stdio"];
  const result = withParentPidArg(input, 4321);

  assert.deepEqual(result, ["lsp", "--stdio", "--parent-pid=4321"]);
  assert.deepEqual(input, ["lsp", "--stdio"]);
});

test("withParentPidArg keeps explicit --parent-pid argument", () => {
  const input = ["lsp", "--parent-pid", "999"];
  const result = withParentPidArg(input, 4321);

  assert.deepEqual(result, ["lsp", "--parent-pid", "999"]);
});

test("withParentPidArg keeps explicit --parent-pid=<n> argument", () => {
  const input = ["lsp", "--stdio", "--parent-pid=777"];
  const result = withParentPidArg(input, 4321);

  assert.deepEqual(result, ["lsp", "--stdio", "--parent-pid=777"]);
});

test("classifyMethodCallGuard reports not running when client is absent", () => {
  const guard = classifyMethodCallGuard(false, new Set<string>(), "happ/resolveEntity");
  assert.equal(guard, "clientNotRunning");
});

test("classifyMethodCallGuard allows method when server did not advertise custom methods", () => {
  const guard = classifyMethodCallGuard(true, new Set<string>(), "happ/resolveEntity");
  assert.equal(guard, null);
});

test("classifyMethodCallGuard reports method unavailable when advertised set is non-empty", () => {
  const guard = classifyMethodCallGuard(true, new Set<string>(["happ/listEntities"]), "happ/resolveEntity");
  assert.equal(guard, "methodUnavailable");
});

test("classifyMethodCallGuard allows method when it is advertised", () => {
  const guard = classifyMethodCallGuard(
    true,
    new Set<string>(["happ/listEntities", "happ/resolveEntity"]),
    "happ/resolveEntity",
  );
  assert.equal(guard, null);
});

test("errorMessageFromUnknown uses Error.message", () => {
  const message = errorMessageFromUnknown(new Error("boom"));
  assert.equal(message, "boom");
});

test("errorMessageFromUnknown stringifies non-error values", () => {
  const message = errorMessageFromUnknown({ code: 42 });
  assert.equal(message, "[object Object]");
});
