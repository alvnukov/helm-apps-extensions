import assert from "node:assert/strict";
import test from "node:test";

import { findAppScopeAtLine } from "../../src/preview/includeResolver";

test("finds app scope by cursor line", () => {
  const yaml = `global:\n  env: dev\napps-stateless:\n  api:\n    enabled: true\n    labels: |-\n      app: api\n`;

  const scope = findAppScopeAtLine(yaml, 6);
  assert.deepEqual(scope, { group: "apps-stateless", app: "api" });
});

test("finds app scope inside custom group with __GroupVars__", () => {
  const yaml = `test-app-stateless:\n  __GroupVars__:\n    type: apps-stateless\n  nginx:\n    enabled: true\n`;

  const scope = findAppScopeAtLine(yaml, 4);
  assert.deepEqual(scope, { group: "test-app-stateless", app: "nginx" });
});
