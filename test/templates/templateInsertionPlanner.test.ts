import assert from "node:assert/strict";
import test from "node:test";

import { ENTITY_TEMPLATE_COMMAND_SPECS, type EntityTemplateCommandSpec } from "../../src/catalog/entityGroups";
import { planEntityTemplateInsertion } from "../../src/templates/templateInsertionPlanner";

function specFor(groupType: string): EntityTemplateCommandSpec {
  const spec = ENTITY_TEMPLATE_COMMAND_SPECS.find((s) => s.groupType === groupType);
  assert.ok(spec, `missing spec for ${groupType}`);
  return spec;
}

test("plan insertion appends app template into existing group", () => {
  const text = [
    "apps-stateless:",
    "  app-1:",
    "    enabled: true",
    "",
    "apps-jobs:",
    "  job-1:",
    "    enabled: true",
    "",
  ].join("\n");

  const plan = planEntityTemplateInsertion(text, "\n", "apps-stateless", specFor("apps-stateless"));
  assert.ok(plan);
  assert.equal(plan.line, 4);
  assert.ok(plan.text.includes("  app-2:"));
  assert.equal(plan.insertedLabel, "apps-stateless.app-2");
});

test("plan insertion creates missing group with separator prefix", () => {
  const text = [
    "global:",
    "  env: dev",
  ].join("\n");

  const plan = planEntityTemplateInsertion(text, "\n", "apps-services", specFor("apps-services"));
  assert.ok(plan);
  assert.equal(plan.line, 2);
  assert.ok(plan.text.includes("apps-services:\n  service-1:\n"));
  assert.equal(plan.insertedLabel, "apps-services.service-1");
});

test("plan insertion supports CRLF line endings", () => {
  const text = "global:\r\n  env: dev\r\n";
  const plan = planEntityTemplateInsertion(text, "\r\n", "apps-pvcs", specFor("apps-pvcs"));
  assert.ok(plan);
  assert.ok(plan.text.includes("\r\n"));
});

test("apps-infra scaffold inserts both sections for missing group", () => {
  const text = "global:\n  env: dev\n";
  const plan = planEntityTemplateInsertion(text, "\n", "apps-infra", specFor("apps-infra"));
  assert.ok(plan);
  assert.equal(plan.insertedLabel, "apps-infra.{node-users,node-groups}");
  assert.ok(plan.text.includes("  node-users:"));
  assert.ok(plan.text.includes("  node-groups:"));
});

test("apps-infra scaffold inserts only missing section in existing group", () => {
  const text = [
    "apps-infra:",
    "  node-users:",
    "    deploy:",
    "      uid: 10001",
    "",
    "apps-stateless:",
    "  app-1:",
    "    enabled: true",
    "",
  ].join("\n");

  const plan = planEntityTemplateInsertion(text, "\n", "apps-infra", specFor("apps-infra"));
  assert.ok(plan);
  assert.equal(plan.line, 5);
  assert.equal(plan.text.includes("  node-users:"), false);
  assert.equal(plan.text.includes("  node-groups:"), true);
});

test("apps-infra scaffold returns null when scaffold already complete", () => {
  const text = [
    "apps-infra:",
    "  node-users:",
    "    deploy:",
    "      uid: 10001",
    "  node-groups:",
    "    workers:",
    "      enabled: true",
    "",
  ].join("\n");

  const plan = planEntityTemplateInsertion(text, "\n", "apps-infra", specFor("apps-infra"));
  assert.equal(plan, null);
});
