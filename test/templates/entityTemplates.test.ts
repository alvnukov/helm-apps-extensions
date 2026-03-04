import assert from "node:assert/strict";
import test from "node:test";

import { renderEntityTemplateLines, type EntityTemplateGroupType } from "../../src/templates/entityTemplates";

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
    mustContain: ["    schedule: \"*/15 * * * *\"", "    concurrencyPolicy: Forbid", "    containers:"],
  },
  {
    group: "apps-services",
    mustContain: ["    type: ClusterIP", "    selector: |-", "    ports: |-"],
  },
  {
    group: "apps-ingresses",
    mustContain: ["    ingressClassName: nginx", "    paths: |-", "    tls:"],
  },
  {
    group: "apps-network-policies",
    mustContain: ["    type: kubernetes", "    policyTypes: |-", "    ingress: |-", "    egress: |-"],
  },
  {
    group: "apps-configmaps",
    mustContain: ["    data:", "    binaryData:", "    envVars:"],
  },
  {
    group: "apps-secrets",
    mustContain: ["    type: Opaque", "    data:", "    binaryData:"],
  },
  {
    group: "apps-pvcs",
    mustContain: ["    storageClassName: gp3", "    accessModes: |-", "    resources: |-"],
  },
  {
    group: "apps-service-accounts",
    mustContain: ["    roles:", "    clusterRoles:", "    name: app-runtime"],
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
