import test from "node:test";
import assert from "node:assert/strict";

import {
  buildManifestBackendArgs,
  resolveManifestBackendCommand,
  selectManifestValuesFiles,
} from "../../src/preview/manifestBackend";

test("resolveManifestBackendCommand picks configured helm binary for helm backend", () => {
  const cmd = resolveManifestBackendCommand("helm", "/opt/tools/helm");
  assert.equal(cmd, "/opt/tools/helm");
});

test("resolveManifestBackendCommand ignores configured werf path for helm backend", () => {
  const cmd = resolveManifestBackendCommand("helm", "/opt/tools/werf");
  assert.equal(cmd, "helm");
});

test("resolveManifestBackendCommand prefers configured werf binary for werf backend", () => {
  const cmd = resolveManifestBackendCommand("werf", "/opt/tools/werf");
  assert.equal(cmd, "/opt/tools/werf");
});

test("resolveManifestBackendCommand falls back to werf when configured binary is helm", () => {
  const cmd = resolveManifestBackendCommand("werf", "/opt/tools/helm");
  assert.equal(cmd, "werf");
});

test("buildManifestBackendArgs builds helm args with values, isolation flags and env", () => {
  const args = buildManifestBackendArgs(
    "helm",
    "/repo/.helm",
    ["  /repo/.helm/values.yaml  ", "", " /repo/.helm/extra.yaml"],
    ["apps-stateless.app-1.enabled=true", "", "apps-stateless.app-2.enabled=false"],
    " demo ",
  );

  assert.deepEqual(args, [
    "template",
    "helm-apps-preview",
    "/repo/.helm",
    "--values",
    "/repo/.helm/values.yaml",
    "--values",
    "/repo/.helm/extra.yaml",
    "--set",
    "apps-stateless.app-1.enabled=true",
    "--set",
    "apps-stateless.app-2.enabled=false",
    "--set-string",
    "global.env=demo",
  ]);
});

test("buildManifestBackendArgs does not append env flags when env is blank", () => {
  const args = buildManifestBackendArgs(
    "helm",
    "/repo/.helm",
    ["/repo/.helm/values.yaml"],
    ["apps-stateless.app-1.enabled=true"],
    "   ",
  );

  assert.deepEqual(args, [
    "template",
    "helm-apps-preview",
    "/repo/.helm",
    "--values",
    "/repo/.helm/values.yaml",
    "--set",
    "apps-stateless.app-1.enabled=true",
  ]);
});

test("buildManifestBackendArgs builds werf args with dev and keeps secret values enabled", () => {
  const args = buildManifestBackendArgs(
    "werf",
    "/repo",
    ["/repo/.helm/values.yaml"],
    ["apps-stateless.app-1.enabled=true"],
    "demo",
  );

  assert.deepEqual(args, [
    "render",
    "--dir",
    "/repo",
    "--dev",
    "--values",
    "/repo/.helm/values.yaml",
    "--set",
    "apps-stateless.app-1.enabled=true",
    "--env",
    "demo",
    "--set-string",
    "global.env=demo",
  ]);
});

test("selectManifestValuesFiles prefers primary values when current file is include owner", () => {
  const selected = selectManifestValuesFiles({
    currentPath: "/repo/.helm/helm-apps-defaults.yaml",
    rootDocuments: ["/repo/.helm/deployments-values.yaml"],
    primaryValues: "/repo/.helm/deployments-values.yaml",
    includeOwners: [
      "/repo/.helm/other-values.yaml",
      "/repo/.helm/deployments-values.yaml",
    ],
  });

  assert.deepEqual(selected, ["/repo/.helm/deployments-values.yaml"]);
});

test("selectManifestValuesFiles picks lexicographically first include owner when primary absent", () => {
  const selected = selectManifestValuesFiles({
    currentPath: "/repo/.helm/include-a.yaml",
    rootDocuments: ["/repo/.helm/values-b.yaml"],
    includeOwners: [
      "/repo/.helm/values-b.yaml",
      "/repo/.helm/values-a.yaml",
    ],
  });

  assert.deepEqual(selected, ["/repo/.helm/values-a.yaml"]);
});

test("selectManifestValuesFiles prefers primary values for non-primary root document", () => {
  const selected = selectManifestValuesFiles({
    currentPath: "/repo/.helm/deployments-values.yaml",
    rootDocuments: [
      "/repo/.helm/deployments-values.yaml",
      "/repo/.helm/cron-values.yaml",
    ],
    primaryValues: "/repo/.helm/values.yaml",
  });

  assert.deepEqual(selected, ["/repo/.helm/values.yaml"]);
});

test("selectManifestValuesFiles falls back to current file when no root and no primary", () => {
  const selected = selectManifestValuesFiles({
    currentPath: "/repo/.helm/custom-values.yaml",
    rootDocuments: ["/repo/.helm/deployments-values.yaml"],
  });

  assert.deepEqual(selected, ["/repo/.helm/custom-values.yaml"]);
});
