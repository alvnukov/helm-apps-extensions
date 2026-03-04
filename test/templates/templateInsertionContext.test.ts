import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedTemplateGroupTypesForCursor,
  buildEntityGroupInsertionPrefix,
  collectExistingEntityNames,
  collectTopLevelGroupBlocks,
  findPreferredGroupNameByType,
  findTopLevelGroupBlockAtLine,
  nextEntityName,
} from "../../src/templates/templateInsertionContext";

const SAMPLE_VALUES = `global:
  env: dev

apps-stateless:
  api:
    enabled: true

custom-jobs:
  __GroupVars__:
    type:
      _default: apps-jobs
  migrate:
    enabled: true
`;

test("collectTopLevelGroupBlocks resolves effective type for custom group", () => {
  const blocks = collectTopLevelGroupBlocks(SAMPLE_VALUES);
  assert.equal(blocks.length, 2);

  const stateless = blocks.find((b) => b.name === "apps-stateless");
  const custom = blocks.find((b) => b.name === "custom-jobs");
  assert.equal(stateless?.effectiveType, "apps-stateless");
  assert.equal(custom?.effectiveType, "apps-jobs");
});

test("findTopLevelGroupBlockAtLine detects active group by nested line", () => {
  const blocks = collectTopLevelGroupBlocks(SAMPLE_VALUES);
  const lineInsideApp = 5; // apps-stateless.api.enabled
  const active = findTopLevelGroupBlockAtLine(SAMPLE_VALUES, blocks, lineInsideApp);
  assert.equal(active?.name, "apps-stateless");

  const globalLine = 0;
  const none = findTopLevelGroupBlockAtLine(SAMPLE_VALUES, blocks, globalLine);
  assert.equal(none, undefined);
});

test("allowedTemplateGroupTypesForCursor limits menu to active group type", () => {
  const blocks = collectTopLevelGroupBlocks(SAMPLE_VALUES);
  const allGroupTypes = ["apps-stateless", "apps-jobs", "apps-services"];

  const active = findTopLevelGroupBlockAtLine(SAMPLE_VALUES, blocks, 9); // custom-jobs group
  const scoped = allowedTemplateGroupTypesForCursor(active, allGroupTypes);
  assert.deepEqual([...scoped], ["apps-jobs"]);

  const unscoped = allowedTemplateGroupTypesForCursor(undefined, allGroupTypes);
  assert.equal(unscoped.size, allGroupTypes.length);
});

test("findPreferredGroupNameByType prefers exact, then custom by effective type", () => {
  const blocks = collectTopLevelGroupBlocks(SAMPLE_VALUES);
  assert.equal(findPreferredGroupNameByType(blocks, "apps-stateless"), "apps-stateless");
  assert.equal(findPreferredGroupNameByType(blocks, "apps-jobs"), "custom-jobs");
});

test("collectExistingEntityNames skips __GroupVars__ and nextEntityName increments", () => {
  const names = collectExistingEntityNames(SAMPLE_VALUES, "custom-jobs");
  assert.equal(names.has("__GroupVars__"), false);
  assert.equal(names.has("migrate"), true);

  const generated = nextEntityName(new Set(["app-1", "app-2"]), "app");
  assert.equal(generated, "app-3");
});

test("buildEntityGroupInsertionPrefix keeps one blank separator", () => {
  assert.equal(buildEntityGroupInsertionPrefix("", "\n"), "");
  assert.equal(buildEntityGroupInsertionPrefix("apps-stateless:\n", "\n"), "\n");
  assert.equal(buildEntityGroupInsertionPrefix("apps-stateless:\n\n", "\n"), "");
});
