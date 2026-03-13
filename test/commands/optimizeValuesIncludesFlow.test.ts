import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOptimizeValuesRequest,
  classifyOptimizeValuesGuard,
  classifyOptimizeValuesResult,
  type OptimizeValuesLspResult,
} from "../../src/commands/optimizeValuesIncludesFlow";

test("classifyOptimizeValuesGuard blocks when editor is missing", () => {
  const out = classifyOptimizeValuesGuard({
    hasActiveEditor: false,
    isHelmAppsLanguageDocument: true,
    happRunning: true,
    methodAdvertised: true,
  });
  assert.equal(out, "noActiveEditor");
});

test("classifyOptimizeValuesGuard blocks when document is not helm-apps values/include", () => {
  const out = classifyOptimizeValuesGuard({
    hasActiveEditor: true,
    isHelmAppsLanguageDocument: false,
    happRunning: true,
    methodAdvertised: true,
  });
  assert.equal(out, "wrongDocument");
});

test("classifyOptimizeValuesGuard blocks when happ lsp is not running", () => {
  const out = classifyOptimizeValuesGuard({
    hasActiveEditor: true,
    isHelmAppsLanguageDocument: true,
    happRunning: false,
    methodAdvertised: true,
  });
  assert.equal(out, "happUnavailable");
});

test("classifyOptimizeValuesGuard blocks when method is not advertised by happ", () => {
  const out = classifyOptimizeValuesGuard({
    hasActiveEditor: true,
    isHelmAppsLanguageDocument: true,
    happRunning: true,
    methodAdvertised: false,
  });
  assert.equal(out, "methodUnavailable");
});

test("classifyOptimizeValuesGuard allows execution when all preconditions are satisfied", () => {
  const out = classifyOptimizeValuesGuard({
    hasActiveEditor: true,
    isHelmAppsLanguageDocument: true,
    happRunning: true,
    methodAdvertised: true,
  });
  assert.equal(out, null);
});

test("buildOptimizeValuesRequest sets default minProfileBytes to 24", () => {
  const out = buildOptimizeValuesRequest({
    uri: "file:///repo/.helm/values.yaml",
    text: "apps-stateless: {}",
  });
  assert.deepEqual(out, {
    uri: "file:///repo/.helm/values.yaml",
    text: "apps-stateless: {}",
    minProfileBytes: 24,
  });
});

test("buildOptimizeValuesRequest preserves explicit minProfileBytes", () => {
  const out = buildOptimizeValuesRequest({
    uri: "file:///repo/.helm/values.yaml",
    text: "apps-stateless: {}",
    minProfileBytes: 64,
  });
  assert.equal(out.minProfileBytes, 64);
});

test("classifyOptimizeValuesResult reports noChanges for unchanged payload", () => {
  const result: OptimizeValuesLspResult = {
    changed: false,
    profilesAdded: 0,
    optimizedText: "global: {}",
  };
  const out = classifyOptimizeValuesResult(result);
  assert.deepEqual(out, { kind: "noChanges" });
});

test("classifyOptimizeValuesResult reports apply with profilesAdded for changed payload", () => {
  const result: OptimizeValuesLspResult = {
    changed: true,
    profilesAdded: 3,
    optimizedText: "global:\n  _includes: {}",
  };
  const out = classifyOptimizeValuesResult(result);
  assert.deepEqual(out, {
    kind: "apply",
    optimizedText: "global:\n  _includes: {}",
    profilesAdded: 3,
  });
});
