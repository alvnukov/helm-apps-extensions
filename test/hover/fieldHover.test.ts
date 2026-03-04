import assert from "node:assert/strict";
import test from "node:test";

import { buildFieldDocMarkdown, buildFieldDocMarkdownLocalized, findFieldDoc, findKeyPathAtPosition } from "../../src/hover/fieldHover";

test("finds path for nested key at cursor", () => {
  const yaml = `global:
  env: prod
apps-stateless:
  nginx:
    enabled: true
`;
  const path = findKeyPathAtPosition(yaml, 4, 6);
  assert.deepEqual(path, ["apps-stateless", "nginx", "enabled"]);
});

test("finds doc for wildcard app path", () => {
  const doc = findFieldDoc(["apps-stateless", "nginx", "enabled"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Resource Toggle");
});

test("finds doc for custom group __GroupVars__.type", () => {
  const doc = findFieldDoc(["test-app-stateless", "__GroupVars__", "type"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Group Renderer Type");
});

test("markdown contains key sections", () => {
  const doc = findFieldDoc(["global", "env"]);
  assert.ok(doc);
  const md = buildFieldDocMarkdown(["global", "env"], doc!);
  assert.ok(md.includes("**Environment Selector**"));
  assert.ok(md.includes("**Type**:"));
  assert.ok(md.includes("```yaml"));
});

test("returns dynamic doc for built-in top-level group", () => {
  const doc = findFieldDoc(["apps-certificates"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Built-in Group");
});

test("returns dynamic doc for app entry node", () => {
  const doc = findFieldDoc(["apps-stateless", "nginx"]);
  assert.ok(doc);
  assert.equal(doc?.title, "App Entry");
});

test("returns explicit doc for releases matrix", () => {
  const doc = findFieldDoc(["global", "releases"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Release Matrix");
});

test("returns unknown-field doc for custom key under app", () => {
  const doc = findFieldDoc(["apps-stateless", "nginx", "myCustomFlag"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Custom or Unknown Field");
});

test("returns resources doc for kafka-strimzi nested resources key", () => {
  const doc = findFieldDoc(["apps-kafka-strimzi", "test-kafka", "kafka", "resources"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Resources");
});

test("helper markdown includes docs link", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "containers", "main", "configFilesYAML"]);
  assert.ok(doc);
  const md = buildFieldDocMarkdown(["apps-stateless", "api", "containers", "main", "configFilesYAML"], doc!);
  assert.ok(md.includes("https://github.com/alvnukov/helm-apps/blob/main/docs/reference-values.md#param-configfilesyaml"));
});

test("envVars helper points to dedicated envVars docs section", () => {
  const doc = findFieldDoc(["apps-stateful", "app-1", "initContainers", "init-container-1", "envVars"]);
  assert.ok(doc);
  const md = buildFieldDocMarkdown(["apps-stateful", "app-1", "initContainers", "init-container-1", "envVars"], doc!);
  assert.ok(md.includes("https://github.com/alvnukov/helm-apps/blob/main/docs/reference-values.md#param-envvars-usage"));
  assert.ok(md.includes("**Example**:"));
});

test("resources helper has inline example in fallback-by-key mode", () => {
  const doc = findFieldDoc(["apps-kafka-strimzi", "test-kafka", "kafka", "resources"]);
  assert.ok(doc);
  const md = buildFieldDocMarkdown(["apps-kafka-strimzi", "test-kafka", "kafka", "resources"], doc!);
  assert.ok(md.includes("requests:"));
  assert.ok(md.includes("limits:"));
});

test("k8s field markdown switches docs link by locale", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "containers", "main", "command"]);
  assert.ok(doc);
  const ru = buildFieldDocMarkdownLocalized(["apps-stateless", "api", "containers", "main", "command"], doc!, "ru");
  const en = buildFieldDocMarkdownLocalized(["apps-stateless", "api", "containers", "main", "command"], doc!, "en");
  assert.ok(ru.includes("docs/k8s-fields-guide.md#command-and-args"));
  assert.ok(en.includes("docs/k8s-fields-guide.en.md#command-and-args"));
});

test("k8s field markdown contains official kubernetes docs link", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "containers", "main", "livenessProbe"]);
  assert.ok(doc);
  const md = buildFieldDocMarkdown(["apps-stateless", "api", "containers", "main", "livenessProbe"], doc!);
  assert.ok(md.includes("https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/"));
});

test("ignores key-like text inside block scalars", () => {
  const yaml = `apps-stateless:
  nginx:
    labels: |-
      enabled: true
`;
  const path = findKeyPathAtPosition(yaml, 3, 8);
  assert.equal(path, null);
});

test("initContainers node has explicit helper doc", () => {
  const path = ["apps-cronjobs", "cronjob-1", "initContainers"];
  const doc = findFieldDoc(path);
  assert.ok(doc);
  assert.equal(doc?.title, "Init Containers Block");
  assert.ok((doc?.summary ?? "").toLowerCase().includes("init"));
});

test("schema fallback for named map entry explains map item semantics", () => {
  const path = ["apps-cronjobs", "cronjob-1", "initContainers", "init-container-1"];
  const doc = findFieldDoc(path);
  assert.ok(doc);
  assert.ok((doc?.summary ?? "").includes("Named entry"));
});

test("nested _include does not fall back to unknown", () => {
  const path = ["apps-stateless", "app-1", "containers", "app-1", "_include"];
  const doc = findFieldDoc(path);
  assert.ok(doc);
  assert.equal(doc?.title, "Include Profiles");
});

test("custom group resolves docs by __GroupVars__.type for nested fields", () => {
  const yaml = `global:
  env: dev
my-apps:
  __GroupVars__:
    type: apps-stateless
  app-1:
    containers:
      app-1:
        image:
          name: nginx
`;
  const path = ["my-apps", "app-1", "containers"];
  const doc = findFieldDoc(path, { documentText: yaml });
  assert.ok(doc);
  assert.equal(doc?.title, "Containers Spec");
});

test("path-specific service type doc overrides generic type", () => {
  const doc = findFieldDoc(["apps-services", "api", "type"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Service Type");
});

test("path-specific secret type doc overrides generic type", () => {
  const doc = findFieldDoc(["apps-secrets", "app-secret", "type"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Secret Type");
});

test("path-specific network policy type doc overrides generic type", () => {
  const doc = findFieldDoc(["apps-network-policies", "deny-all", "type"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Network Policy Renderer Type");
});

test("dex authenticator session field has explicit context doc", () => {
  const doc = findFieldDoc(["apps-dex-authenticators", "auth-main", "keepUsersLoggedInFor"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Dex Session Lifetime");
});

test("dex authenticator sign-out field has explicit context doc", () => {
  const doc = findFieldDoc(["apps-dex-authenticators", "auth-main", "signOutURL"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Dex Sign-out URL");
});

test("dex authenticator source-range field has explicit context doc", () => {
  const doc = findFieldDoc(["apps-dex-authenticators", "auth-main", "whitelistSourceRanges"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Dex Authenticator Source CIDR Allowlist");
});

test("service-account namespace has explicit context doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "namespace"]);
  assert.ok(doc);
  assert.equal(doc?.title, "ServiceAccount Namespace Override");
});

test("service-account automount token has explicit context doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "automountServiceAccountToken"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Automount ServiceAccount Token");
});

test("service-account nested role rules use specific RBAC doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "roles", "pod-reader", "rules"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Role Rules");
});

test("service-account nested binding subjects use specific RBAC doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "clusterRoles", "viewer", "binding", "subjects"]);
  assert.ok(doc);
  assert.equal(doc?.title, "ClusterRoleBinding Subjects");
});

test("kafka-strimzi nested kafka version has specific doc", () => {
  const doc = findFieldDoc(["apps-kafka-strimzi", "main", "kafka", "version"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Kafka Version");
});

test("kafka-strimzi topic entry has specific doc", () => {
  const doc = findFieldDoc(["apps-kafka-strimzi", "main", "topics", "app-events"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Kafka Topic Spec");
});

test("kafka-strimzi topic retention has specific doc", () => {
  const doc = findFieldDoc(["apps-kafka-strimzi", "main", "topics", "app-events", "retention"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Topic Retention (ms)");
});

test("deep labels key gets explicit labels hover instead of unknown", () => {
  const doc = findFieldDoc(["apps-infra", "node-users", "ops", "labels"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Labels");
});
