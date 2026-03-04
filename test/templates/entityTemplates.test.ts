import assert from "node:assert/strict";
import test from "node:test";

import {
  renderAppsInfraTemplateLines,
  renderEntityTemplateLines,
  type EntityTemplateGroupType,
} from "../../src/templates/entityTemplates";

type GroupExpectation = {
  group: EntityTemplateGroupType;
  mustContain: string[];
};

const GROUP_EXPECTATIONS: GroupExpectation[] = [
  {
    group: "apps-stateless",
    mustContain: ["    containers:", "    service:", "    horizontalPodAutoscaler:"],
  },
  {
    group: "apps-stateful",
    mustContain: ["    volumes: |-", "    service:", "    serviceAccount:"],
  },
  {
    group: "apps-jobs",
    mustContain: ["    restartPolicy: OnFailure", "    backoffLimit: 3", "    activeDeadlineSeconds: 1800"],
  },
  {
    group: "apps-cronjobs",
    mustContain: ["    _include: [\"apps-cronjobs-defaultCronJob\"]", "    schedule: \"*/15 * * * *\"", "    concurrencyPolicy: Forbid", "    containers:"],
  },
  {
    group: "apps-services",
    mustContain: ["    type: ClusterIP", "    selector: |-", "    ports: |-"],
  },
  {
    group: "apps-ingresses",
    mustContain: ["    _include: [\"apps-ingresses-defaultIngress\"]", "    ingressClassName: nginx", "    paths: |-", "    tls:"],
  },
  {
    group: "apps-network-policies",
    mustContain: ["    _include: [\"apps-network-policies-defaultNetworkPolicy\"]", "    type: kubernetes", "    policyTypes: |-", "    ingress: |-", "    egress: |-"],
  },
  {
    group: "apps-configmaps",
    mustContain: ["    _include: [\"apps-configmaps-defaultConfigmap\"]", "    data:", "    binaryData:", "    envVars:"],
  },
  {
    group: "apps-secrets",
    mustContain: ["    _include: [\"apps-secrets-defaultSecret\"]", "    type: Opaque", "    data:", "    binaryData:"],
  },
  {
    group: "apps-pvcs",
    mustContain: ["    storageClassName: gp3", "    accessModes: |-", "    resources: |-"],
  },
  {
    group: "apps-limit-range",
    mustContain: ["    limits: |-"],
  },
  {
    group: "apps-certificates",
    mustContain: ["    clusterIssuer: letsencrypt-prod", "    host: app.example.local", "    hosts: |-"],
  },
  {
    group: "apps-dex-clients",
    mustContain: ["    redirectURIs: |-"],
  },
  {
    group: "apps-dex-authenticators",
    mustContain: [
      "    applicationDomain: auth.example.local",
      "    keepUsersLoggedInFor: 168h",
      "    signOutURL: https://auth.example.local/sign_out",
      "    allowedGroups: |-",
      "    whitelistSourceRanges: |-",
    ],
  },
  {
    group: "apps-custom-prometheus-rules",
    mustContain: ["    groups:", "          highErrorRate:"],
  },
  {
    group: "apps-grafana-dashboards",
    mustContain: ["    folder: Platform"],
  },
  {
    group: "apps-kafka-strimzi",
    mustContain: ["    priorityClassName: production-high", "    kafka:", "    zookeeper:", "    deckhouseMetrics:", "    topics:"],
  },
  {
    group: "apps-service-accounts",
    mustContain: ["    roles:", "    clusterRoles:", "    name: app-runtime", "    namespace: apps", "    automountServiceAccountToken: false"],
  },
  {
    group: "apps-k8s-manifests",
    mustContain: ["    apiVersion: v1", "    kind: ConfigMap", "    fieldsYAML:", "    extraFields:"],
  },
];

test("entity templates include app root and group-specific onboarding fields", () => {
  for (const { group, mustContain } of GROUP_EXPECTATIONS) {
    const lines = renderEntityTemplateLines(group, "app-42");
    assert.equal(lines[0], "  app-42:");
    assert.ok(lines.includes("    enabled: true"), `${group}: template must include enabled flag`);
    for (const token of mustContain) {
      assert.ok(lines.includes(token), `${group}: template is missing '${token}'`);
    }
  }
});

test("job template no longer uses legacy trivial example command", () => {
  const lines = renderEntityTemplateLines("apps-jobs", "job-1");
  const body = lines.join("\n");
  assert.equal(body.includes("job example"), false);
});

test("apps-infra scaffold renders node-users and node-groups blocks", () => {
  const lines = renderAppsInfraTemplateLines();
  assert.ok(lines.includes("  node-users:"));
  assert.ok(lines.includes("  node-groups:"));
  assert.ok(lines.includes("      uid: 10001"));
});

test("apps-infra scaffold can render only missing section", () => {
  const lines = renderAppsInfraTemplateLines({ includeNodeUsers: false, includeNodeGroups: true });
  assert.equal(lines.includes("  node-users:"), false);
  assert.equal(lines.includes("  node-groups:"), true);
});
