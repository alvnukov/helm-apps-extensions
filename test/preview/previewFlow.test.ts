import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPreviewEntityMenuModel,
  buildPreviewEntityMenuModelFromGroups,
  buildPreviewGlobalProjection,
} from "../../src/preview/previewFlow";

test("buildPreviewEntityMenuModel skips global and __GroupVars__ entries", () => {
  const menu = buildPreviewEntityMenuModel(
    {
      global: { env: "dev" },
      "apps-stateless": {
        __GroupVars__: { type: "apps-stateless" },
        "app-1": { enabled: true },
        "app-2": { enabled: false },
      },
      "apps-empty": {
        __GroupVars__: { type: "apps-stateless" },
      },
      "not-a-group": "scalar",
    },
    "apps-stateless",
    "app-2",
  );

  assert.deepEqual(menu, {
    groups: [
      {
        name: "apps-stateless",
        apps: ["app-1", "app-2"],
      },
    ],
    selectedGroup: "apps-stateless",
    selectedApp: "app-2",
  });
});

test("buildPreviewEntityMenuModel falls back to first available group/app", () => {
  const menu = buildPreviewEntityMenuModel(
    {
      "apps-b": { "b-app": {} },
      "apps-a": { "a-app": {} },
    },
    "missing-group",
    "missing-app",
  );

  assert.equal(menu.selectedGroup, "apps-b");
  assert.equal(menu.selectedApp, "b-app");
});

test("buildPreviewEntityMenuModelFromGroups normalizes and sorts groups/apps", () => {
  const menu = buildPreviewEntityMenuModelFromGroups(
    [
      { name: "apps-z", apps: [" z-2 ", "z-1", "", "   "] },
      { name: "", apps: ["x"] },
      { name: "apps-a", apps: ["a-2", "a-1"] },
    ],
    "apps-a",
    "missing",
  );

  assert.deepEqual(menu.groups, [
    { name: "apps-a", apps: ["a-1", "a-2"] },
    { name: "apps-z", apps: ["z-1", "z-2"] },
  ]);
  assert.equal(menu.selectedGroup, "apps-a");
  assert.equal(menu.selectedApp, "a-1");
});

test("buildPreviewGlobalProjection keeps non-default sections and referenced global keys", () => {
  const values = {
    global: {
      env: "dev",
      validation: {
        strict: false,
        allowNativeListsInBuiltInListFields: true,
      },
      labels: {
        addEnv: false,
      },
      deploy: {
        enabled: false,
        annotateAllWithRelease: false,
      },
      releases: {
        _default: "1.2.3",
        prod: null,
      },
      base_url: "corp.example",
      emptyValue: "",
    },
  };

  const entity = {
    host: "api.{{ $.Values.global.base_url }}",
    enabledExpr: "{{ if $.Values.global.deploy.enabled }}yes{{ end }}",
  };

  const projection = buildPreviewGlobalProjection(values, entity, "prod");

  assert.deepEqual(projection, {
    env: "prod",
    validation: {
      allowNativeListsInBuiltInListFields: true,
    },
    releases: {
      _default: "1.2.3",
    },
    deploy: {
      enabled: false,
      annotateAllWithRelease: false,
    },
    base_url: "corp.example",
  });
});

test("buildPreviewGlobalProjection returns minimal output when global is absent", () => {
  const projection = buildPreviewGlobalProjection({}, { key: "value" }, "demo");
  assert.deepEqual(projection, { env: "demo" });
});
