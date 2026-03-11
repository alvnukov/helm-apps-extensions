import assert from "node:assert/strict";
import test from "node:test";
import * as YAML from "yaml";
import {
  buildManifestEntityIsolationOverrides,
  buildManifestEntityIsolationSetValues,
  forceEntityEnabled,
  withManifestRenderEntityEnabled,
} from "../../src/preview/entityRenderOverrides";

test("forceEntityEnabled overrides enabled to true and keeps other fields", () => {
  const input = {
    enabled: false,
    image: {
      name: "nginx",
    },
  };
  const out = forceEntityEnabled(input) as Record<string, unknown>;

  assert.equal(out.enabled, true);
  assert.deepEqual(out.image, { name: "nginx" });
  assert.equal(input.enabled, false);
});

test("withManifestRenderEntityEnabled sets selected entity enabled to true and disables only enabled siblings", () => {
  const source = [
    "global:",
    "  env: dev",
    "apps-stateless:",
    "  app-1:",
    "    enabled: false",
    "    image:",
    "      name: nginx",
    "  app-2:",
    "    enabled: true",
    "    image:",
    "      name: busybox",
    "  app-3:",
    "    enabled: false",
    "    image:",
    "      name: alpine",
    "",
  ].join("\n");

  const out = withManifestRenderEntityEnabled(source, "apps-stateless", "app-1");
  const parsed = YAML.parse(out) as Record<string, unknown>;
  const apps = (parsed["apps-stateless"] as Record<string, unknown>) ?? {};
  const app = (apps["app-1"] as Record<string, unknown>) ?? {};
  const app2 = (apps["app-2"] as Record<string, unknown>) ?? {};
  const app3 = (apps["app-3"] as Record<string, unknown>) ?? {};

  assert.equal(app.enabled, true);
  assert.equal(app2.enabled, false);
  assert.equal(app3.enabled, false);
});

test("withManifestRenderEntityEnabled injects enabled when missing", () => {
  const source = [
    "apps-stateless:",
    "  app-1:",
    "    containers:",
    "      app-1:",
    "        image:",
    "          name: nginx",
    "",
  ].join("\n");

  const out = withManifestRenderEntityEnabled(source, "apps-stateless", "app-1");
  const parsed = YAML.parse(out) as Record<string, unknown>;
  const apps = (parsed["apps-stateless"] as Record<string, unknown>) ?? {};
  const app = (apps["app-1"] as Record<string, unknown>) ?? {};

  assert.equal(app.enabled, true);
});

test("withManifestRenderEntityEnabled keeps source when yaml is invalid", () => {
  const source = "apps-stateless:\n  app-1: [\n";
  const out = withManifestRenderEntityEnabled(source, "apps-stateless", "app-1");
  assert.equal(out, source);
});

test("withManifestRenderEntityEnabled keeps source when target app is missing", () => {
  const source = "apps-stateless:\n  app-2:\n    enabled: false\n";
  const out = withManifestRenderEntityEnabled(source, "apps-stateless", "app-1");
  assert.equal(out, source);
});

test("buildManifestEntityIsolationOverrides builds overrides only for target and currently enabled siblings", () => {
  const source = [
    "global:",
    "  env: dev",
    "apps-stateless:",
    "  app-1:",
    "    enabled: false",
    "  app-2:",
    "    enabled: true",
    "  app-3:",
    "    enabled: false",
    "apps-services:",
    "  svc-1:",
    "    enabled: true",
    "  svc-2:",
    "    enabled: false",
    "",
  ].join("\n");

  const overrideYaml = buildManifestEntityIsolationOverrides(source, "apps-stateless", "app-1");
  assert.ok(overrideYaml);
  const parsed = YAML.parse(String(overrideYaml)) as Record<string, unknown>;

  assert.deepEqual(parsed, {
    "apps-stateless": {
      "app-1": { enabled: true },
      "app-2": { enabled: false },
    },
    "apps-services": {
      "svc-1": { enabled: false },
    },
  });
});

test("buildManifestEntityIsolationSetValues returns minimal set values", () => {
  const source = [
    "global:",
    "  env: dev",
    "apps-stateless:",
    "  app-1:",
    "    enabled: false",
    "  app-2:",
    "    enabled: true",
    "  app-3:",
    "    enabled: false",
    "",
  ].join("\n");

  const setValues = buildManifestEntityIsolationSetValues(source, "apps-stateless", "app-1");
  assert.deepEqual(setValues, [
    "apps-stateless.app-1.enabled=true",
    "apps-stateless.app-2.enabled=false",
  ]);
});

test("buildManifestEntityIsolationSetValues falls back to target=true when yaml is invalid", () => {
  const source = "apps-stateless:\n  app-1: {{\n";
  const setValues = buildManifestEntityIsolationSetValues(source, "apps-stateless", "app-1");
  assert.deepEqual(setValues, ["apps-stateless.app-1.enabled=true"]);
});

test("buildManifestEntityIsolationSetValues falls back to target=true when app is absent in current file", () => {
  const source = [
    "apps-stateless:",
    "  app-2:",
    "    enabled: false",
    "",
  ].join("\n");
  const setValues = buildManifestEntityIsolationSetValues(source, "apps-stateless", "app-1");
  assert.deepEqual(setValues, ["apps-stateless.app-1.enabled=true"]);
});

test("buildManifestEntityIsolationOverrides returns null when target app is missing", () => {
  const source = "apps-stateless:\n  app-2:\n    enabled: false\n";
  const out = buildManifestEntityIsolationOverrides(source, "apps-stateless", "app-1");
  assert.equal(out, null);
});
