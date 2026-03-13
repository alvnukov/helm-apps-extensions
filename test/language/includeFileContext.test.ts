import test from "node:test";
import assert from "node:assert/strict";

import {
  renderIncludeReferenceSite,
  summarizeIncludedFileContexts,
  type IncludeReferenceContext,
} from "../../src/language/includeFileContext";

test("summarizeIncludedFileContexts detects global._includes include file role", () => {
  const contexts: IncludeReferenceContext[] = [{
    rootDocument: "/repo/.helm/values.yaml",
    sourceFile: "/repo/.helm/values.yaml",
    rawPath: "helm-apps-defaults.yaml",
    line: 108,
    kind: "from-file",
    parentPath: ["global", "_includes"],
  }];

  const summary = summarizeIncludedFileContexts(contexts);
  assert.ok(summary);
  assert.equal(summary.mode, "global-includes");
  assert.equal(summary.primaryPath, "global._includes");
  assert.deepEqual(summary.ownerRoots, ["/repo/.helm/values.yaml"]);
  assert.equal(renderIncludeReferenceSite(contexts[0]), "global._includes._include_from_file");
});

test("summarizeIncludedFileContexts detects _include_files payload role", () => {
  const contexts: IncludeReferenceContext[] = [{
    rootDocument: "/repo/.helm/deployments-values.yaml",
    sourceFile: "/repo/.helm/deployments-values.yaml",
    rawPath: "configs/app.yaml",
    line: 41,
    kind: "files-list",
    parentPath: ["apps-stateless", "api", "containers", "main", "configFilesYAML", "application.yaml", "content"],
  }];

  const summary = summarizeIncludedFileContexts(contexts);
  assert.ok(summary);
  assert.equal(summary.mode, "include-files");
  assert.equal(summary.primaryPath, "apps-stateless.api.containers.main.configFilesYAML.application.yaml.content");
  assert.equal(
    renderIncludeReferenceSite(contexts[0]),
    "apps-stateless.api.containers.main.configFilesYAML.application.yaml.content._include_files",
  );
});
