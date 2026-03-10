import assert from "node:assert/strict";
import test from "node:test";
import * as YAML from "yaml";
import { forceEntityEnabled, withManifestRenderEntityEnabled } from "../../src/preview/entityRenderOverrides";

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

test("withManifestRenderEntityEnabled sets selected entity enabled to true", () => {
  const source = [
    "global:",
    "  env: dev",
    "apps-stateless:",
    "  app-1:",
    "    enabled: false",
    "    image:",
    "      name: nginx",
    "",
  ].join("\n");

  const out = withManifestRenderEntityEnabled(source, "apps-stateless", "app-1");
  const parsed = YAML.parse(out) as Record<string, unknown>;
  const apps = (parsed["apps-stateless"] as Record<string, unknown>) ?? {};
  const app = (apps["app-1"] as Record<string, unknown>) ?? {};

  assert.equal(app.enabled, true);
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
