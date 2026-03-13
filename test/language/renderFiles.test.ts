import test from "node:test";
import assert from "node:assert/strict";

import { collectIncludeFileRefsWithContext, selectHelmAppsRootDocuments } from "../../src/language/renderFiles";

test("keeps only render entry files and excludes direct include targets", () => {
  const roots = selectHelmAppsRootDocuments([
    {
      filePath: "/repo/.helm/deployments-values.yaml",
      text: "global:\n  _includes:\n    _include_from_file: defaults.yaml\napps-stateless:\n  api:\n    enabled: true\n",
    },
    {
      filePath: "/repo/.helm/defaults.yaml",
      text: "apps-stateless:\n  api:\n    _include:\n      - defaults\n",
    },
  ]);

  assert.deepEqual(roots, ["/repo/.helm/deployments-values.yaml"]);
});

test("excludes transitive include targets from root documents", () => {
  const roots = selectHelmAppsRootDocuments([
    {
      filePath: "/repo/.helm/deployments-values.yaml",
      text: "global:\n  _includes:\n    _include_from_file: defaults.yaml\n",
    },
    {
      filePath: "/repo/.helm/defaults.yaml",
      text: "_include_from_file: nested/service-values.yaml\n",
    },
    {
      filePath: "/repo/.helm/nested/service-values.yaml",
      text: "apps-stateless:\n  api:\n    enabled: true\n",
    },
  ]);

  assert.deepEqual(roots, ["/repo/.helm/deployments-values.yaml"]);
});

test("keeps independent values entry files as separate roots", () => {
  const roots = selectHelmAppsRootDocuments([
    {
      filePath: "/repo/.helm/deployments-values.yaml",
      text: "apps-stateless:\n  api:\n    enabled: true\n",
    },
    {
      filePath: "/repo/.helm/cron-values.yaml",
      text: "__GroupVars__:\n  type: apps-cronjobs\napps-cronjobs:\n  job:\n    enabled: true\n",
    },
  ]);

  assert.deepEqual(roots, [
    "/repo/.helm/cron-values.yaml",
    "/repo/.helm/deployments-values.yaml",
  ]);
});

test("does not exclude roots for templated include paths that cannot be resolved statically", () => {
  const roots = selectHelmAppsRootDocuments([
    {
      filePath: "/repo/.helm/deployments-values.yaml",
      text: "global:\n  _includes:\n    _include_from_file: '{{ .Values.global.defaultsFile }}'\napps-stateless:\n  api:\n    enabled: true\n",
    },
    {
      filePath: "/repo/.helm/defaults.yaml",
      text: "apps-stateless:\n  api:\n    enabled: false\n",
    },
  ]);

  assert.deepEqual(roots, [
    "/repo/.helm/defaults.yaml",
    "/repo/.helm/deployments-values.yaml",
  ]);
});

test("collectIncludeFileRefsWithContext keeps include kind and parent path", () => {
  const refs = collectIncludeFileRefsWithContext(`
global:
  _includes:
    _include_from_file: helm-apps-defaults.yaml
apps-stateless:
  api:
    containers:
      main:
        configFilesYAML:
          application.yaml:
            content:
              _include_files:
                - configs/app.yaml
`);

  assert.deepEqual(refs, [
    {
      path: "helm-apps-defaults.yaml",
      line: 3,
      kind: "from-file",
      parentPath: ["global", "_includes"],
    },
    {
      path: "configs/app.yaml",
      line: 12,
      kind: "files-list",
      parentPath: ["apps-stateless", "api", "containers", "main", "configFilesYAML", "application.yaml", "content"],
    },
  ]);
});
