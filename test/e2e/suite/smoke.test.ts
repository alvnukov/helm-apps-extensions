import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import { suite, suiteSetup, test } from "mocha";

async function openFixture(relPath: string): Promise<vscode.TextEditor> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? path.resolve(__dirname, "../../../fixtures");
  if (!root) {
    throw new Error("workspace root not found");
  }
  const doc = await vscode.workspace.openTextDocument(path.join(root, relPath));
  return await vscode.window.showTextDocument(doc);
}

async function waitFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCodeActionTitles(
  uri: vscode.Uri,
  range: vscode.Range,
  predicate: (titles: string[]) => boolean,
  timeoutMs = 6000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastTitles: string[] = [];

  while (Date.now() < deadline) {
    const quickFixActions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      uri,
      range,
      vscode.CodeActionKind.QuickFix.value,
    );
    lastTitles = (quickFixActions ?? []).map((a) => a.title);
    if (predicate(lastTitles)) {
      return lastTitles;
    }
    await waitFor(150);
  }

  return lastTitles;
}

suite("helm-apps extension host smoke", () => {
  suiteSetup(async () => {
    await vscode.workspace
      .getConfiguration("helm-apps")
      .update("languageServerMode", "fallback", vscode.ConfigurationTarget.Global);
  });

  test("commands are registered", async () => {
    await vscode.extensions.getExtension("alvnukov.helm-apps")?.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("helm-apps.previewResolvedEntity"));
    assert.ok(commands.includes("helm-apps.validateCurrentFile"));
    assert.ok(commands.includes("helm-apps.pasteAsHelmApps"));
  });

  test("preview command can be invoked in editor session", async () => {
    await openFixture("e2e/values.yaml");
    await vscode.commands.executeCommand("helm-apps.previewResolvedEntity");
    assert.ok(true);
  });

  test("definition provider resolves include from include file", async () => {
    const editor = await openFixture("e2e/values.yaml");
    const pos = new vscode.Position(10, 10);
    const result = await vscode.commands.executeCommand<vscode.Location[] | vscode.Location>(
      "vscode.executeDefinitionProvider",
      editor.document.uri,
      pos,
    );
    const locations = Array.isArray(result) ? result : result ? [result] : [];
    assert.ok(locations.length > 0);
    assert.ok(locations.some((l) => l.uri.fsPath.endsWith("include-profiles.yaml")));
  });

  test("definition provider resolves scalar _include usage", async () => {
    const editor = await openFixture("e2e/values.yaml");
    try {
      await editor.edit((eb) => {
        eb.replace(
          new vscode.Range(new vscode.Position(9, 0), new vscode.Position(11, 999)),
          "    _include: file-profile",
        );
      });
      const pos = new vscode.Position(9, 18);
      const result = await vscode.commands.executeCommand<vscode.Location[] | vscode.Location>(
        "vscode.executeDefinitionProvider",
        editor.document.uri,
        pos,
      );
      const locations = Array.isArray(result) ? result : result ? [result] : [];
      assert.ok(locations.length > 0);
      assert.ok(locations.some((l) => l.uri.fsPath.endsWith("include-profiles.yaml")));
    } finally {
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  });

  test("rename provider returns workspace edit across files", async () => {
    const editor = await openFixture("e2e/values.yaml");
    const pos = new vscode.Position(8, 5);
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
      "vscode.executeDocumentRenameProvider",
      editor.document.uri,
      pos,
      "app-renamed",
    );
    assert.ok(edit);
    const entries = edit?.entries() ?? [];
    assert.ok(entries.length >= 2);
    const touched = entries.map(([uri]) => uri.fsPath);
    assert.ok(touched.some((p) => p.endsWith("values.yaml")));
    assert.ok(touched.some((p) => p.endsWith("values-extra.yaml")));
  });

  test("code actions contain unresolved-include and list-policy quick fixes", async () => {
    const editor = await openFixture("e2e/values.yaml");
    const includeRange = new vscode.Range(new vscode.Position(11, 0), new vscode.Position(11, 20));
    const includeTitles = await waitForCodeActionTitles(
      editor.document.uri,
      includeRange,
      (titles) => titles.some((t) => t.includes("missing-profile")),
    );
    assert.ok(
      includeTitles.some((t) => t.includes("missing-profile")),
      `include quick-fix not found, got: ${includeTitles.join(" | ")}`,
    );

    const listRange = new vscode.Range(new vscode.Position(16, 0), new vscode.Position(16, 20));
    const listTitles = await waitForCodeActionTitles(
      editor.document.uri,
      listRange,
      (titles) => titles.some((t) => t.includes("Convert native list to YAML block string")),
    );
    assert.ok(
      listTitles.some((t) => t.includes("Convert native list to YAML block string")),
      `list-policy quick-fix not found, got: ${listTitles.join(" | ")}`,
    );
  });

  test("code actions suggest include quick fix for scalar _include", async () => {
    const editor = await openFixture("e2e/values.yaml");
    try {
      await editor.edit((eb) => {
        eb.replace(
          new vscode.Range(new vscode.Position(9, 0), new vscode.Position(11, 999)),
          "    _include: missing-profile-scalar",
        );
      });
      const includeRange = new vscode.Range(new vscode.Position(9, 0), new vscode.Position(9, 40));
    const includeTitles = await waitForCodeActionTitles(
      editor.document.uri,
      includeRange,
      (titles) => titles.some((t) => t.includes("missing-profile-scalar")),
    );
    assert.ok(
      includeTitles.some((t) => t.includes("missing-profile-scalar")),
      `scalar include quick-fix not found, got: ${includeTitles.join(" | ")}`,
    );
    } finally {
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  });
});
