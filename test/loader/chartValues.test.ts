import test from "node:test";
import assert from "node:assert/strict";

import {
  createChartValuesReadFile,
  isWerfSecretValuesFilePath,
  mergeChartValues,
  planChartValuesLoad,
} from "../../src/loader/chartValues";

test("planChartValuesLoad uses primary values as base for secondary chart values file", () => {
  const plan = planChartValuesLoad({
    currentPath: "/repo/.helm/deployments-values.yaml",
    primaryValuesPath: "/repo/.helm/values.yaml",
    werfSecretValuesPath: "/repo/.helm/secret-values.yaml",
  });

  assert.deepEqual(plan, {
    basePath: "/repo/.helm/values.yaml",
    mergePaths: ["/repo/.helm/secret-values.yaml"],
  });
});

test("planChartValuesLoad uses primary values as base when current file is werf secret values", () => {
  const plan = planChartValuesLoad({
    currentPath: "/repo/.helm/secret-values.yaml",
    primaryValuesPath: "/repo/.helm/values.yaml",
    werfSecretValuesPath: "/repo/.helm/secret-values.yaml",
  });

  assert.deepEqual(plan, {
    basePath: "/repo/.helm/values.yaml",
    mergePaths: ["/repo/.helm/secret-values.yaml"],
  });
});

test("planChartValuesLoad falls back to current file when secret file has no primary pair", () => {
  const plan = planChartValuesLoad({
    currentPath: "/repo/.helm/secret-values.yaml",
    werfSecretValuesPath: "/repo/.helm/secret-values.yaml",
  });

  assert.deepEqual(plan, {
    basePath: "/repo/.helm/secret-values.yaml",
    mergePaths: [],
  });
});

test("planChartValuesLoad uses primary values as base for included helm-apps file", () => {
  const plan = planChartValuesLoad({
    currentPath: "/repo/.helm/helm-apps-defaults.yaml",
    primaryValuesPath: "/repo/.helm/values.yaml",
    werfSecretValuesPath: "/repo/.helm/secret-values.yaml",
  });

  assert.deepEqual(plan, {
    basePath: "/repo/.helm/values.yaml",
    mergePaths: ["/repo/.helm/secret-values.yaml"],
  });
});

test("mergeChartValues deep-merges maps and appends _include arrays", () => {
  const merged = mergeChartValues(
    {
      global: {
        env: "dev",
      },
      "apps-stateless": {
        api: {
          _include: ["base"],
          enabled: false,
        },
      },
    },
    {
      global: {
        minioSecrets: {
          accessKey: "enc",
        },
      },
      "apps-stateless": {
        api: {
          _include: "secret-base",
          enabled: true,
        },
      },
    },
  );

  assert.deepEqual(merged, {
    global: {
      env: "dev",
      minioSecrets: {
        accessKey: "enc",
      },
    },
    "apps-stateless": {
      api: {
        _include: ["base", "secret-base"],
        enabled: true,
      },
    },
  });
});

test("isWerfSecretValuesFilePath matches default werf secret values filenames", () => {
  assert.equal(isWerfSecretValuesFilePath("/repo/.helm/secret-values.yaml"), true);
  assert.equal(isWerfSecretValuesFilePath("/repo/.helm/secret-values.yml"), true);
  assert.equal(isWerfSecretValuesFilePath("/repo/.helm/deployments-values.yaml"), false);
});

test("createChartValuesReadFile prefers current in-editor file over disk read", async () => {
  const readFile = createChartValuesReadFile(
    async (filePath) => `disk:${filePath}`,
    "/repo/.helm/deployments-values.yaml",
    "editor:deployments-values",
  );

  await assert.doesNotReject(async () => {
    assert.equal(
      await readFile("/repo/.helm/deployments-values.yaml"),
      "editor:deployments-values",
    );
    assert.equal(
      await readFile("/repo/.helm/helm-apps-defaults.yaml"),
      "disk:/repo/.helm/helm-apps-defaults.yaml",
    );
  });
});
