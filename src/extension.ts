import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import * as YAML from "yaml";

import { buildFieldDocMarkdownLocalized, findFieldDoc, findKeyPathAtPosition } from "./hover/fieldHover";
import { buildHelmCommandCandidates } from "./library/helmRunner";
import { compareSemver, resolveHelmRepositoryURL } from "./library/repository";
import { extractIncludeProfileBlock, extractLocalIncludeBlock, trimPreview } from "./hover/includeHover";
import { buildDependencyGraphModel } from "./language/dependencyGraph";
import { buildHelmAppsDocumentSymbols } from "./language/documentSymbols";
import {
  buildIncludeCandidates,
  collectIncludeFileRefs,
  collectIncludeFileRefsWithContext,
  isTemplatedIncludePath,
  selectHelmAppsRootDocuments,
} from "./language/renderFiles";
import {
  renderIncludeReferenceSite,
  summarizeIncludedFileContexts,
  type IncludeReferenceContext,
  type IncludedFileContextSummary,
} from "./language/includeFileContext";
import { collectSymbolOccurrences, findSymbolAtPosition, type SymbolRef } from "./language/symbols";
import { discoverEnvironments, findAppScopeAtLine, resolveEnvMaps, type EnvironmentDiscovery } from "./preview/includeResolver";
import {
  buildManifestEntityIsolationSetValues,
  buildManifestEntityIsolationSetValuesFromEnabledEntities,
  forceEntityEnabled,
  withManifestRenderEntityEnabled,
} from "./preview/entityRenderOverrides";
import {
  buildManifestBackendArgs as buildManifestBackendArgsForCommand,
  resolveManifestBackendCommand as resolveManifestBackendCommandForConfig,
  selectManifestValuesFiles,
} from "./preview/manifestBackend";
import {
  buildPreviewEntityMenuModel,
  buildPreviewEntityMenuModelFromGroups,
  buildPreviewGlobalProjection,
  type PreviewEntityMenuModel,
} from "./preview/previewFlow";
import { formatManifestPreviewError } from "./preview/manifestError";
import {
  createChartValuesReadFile,
  isWerfSecretValuesFilePath,
  mergeChartValues,
  planChartValuesLoad,
} from "./loader/chartValues";
import { expandValuesWithFileIncludes, type IncludeDefinition } from "./loader/fileIncludes";
import { extractAppChildToGlobalInclude, safeRenameAppKey } from "./refactor/appRefactor";
import { ValuesStructureProvider } from "./structure/valuesTreeProvider";
import { HelmAppsWorkbenchActionsProvider } from "./structure/workbenchActionsProvider";
import { buildStarterChartFiles, isValidChartVersion, sanitizeChartName } from "./scaffold/chartScaffold";
import { DEFAULT_HAPP_LSP_ARGS, HappLspClient, type HappPreviewTheme, type LanguageMode } from "./lsp/client";
import { HAPP_LSP_METHODS } from "./core/happProtocol";
import {
  buildOptimizeValuesRequest,
  classifyOptimizeValuesGuard,
  classifyOptimizeValuesResult,
} from "./commands/optimizeValuesIncludesFlow";
import { validateUnexpectedNativeLists } from "./validator/listPolicy";
import {
  BUILTIN_GROUP_TYPES,
  ENTITY_TEMPLATE_COMMAND_SPECS,
  INSERT_ENTITY_TEMPLATE_MENU_CONTEXT,
  LEGACY_INSERT_ENTITY_EXAMPLE_MENU_CONTEXT,
  getAllowedAppRootKeysByGroup,
  type EntityTemplateCommandSpec,
} from "./catalog/entityGroups";
import {
  buildAllowedTemplateGroupTypes,
  collectTopLevelGroupBlocks,
  findPreferredGroupNameByType,
  findTopLevelGroupBlockAtLine,
  resolveEffectiveGroupType,
} from "./templates/templateInsertionContext";
import { planEntityTemplateInsertion } from "./templates/templateInsertionPlanner";

const execFileAsync = promisify(execFile);
let previewPanel: vscode.WebviewPanel | undefined;
let previewMessageSubscription: vscode.Disposable | undefined;
let entityPreviewState: EntityPreviewState | undefined;
let previewRenderTimer: NodeJS.Timeout | undefined;
let previewRenderVersion = 0;
let lastPreviewMenuModel: PreviewEntityMenuModel | undefined;
const manifestPreviewCache = new Map<string, string>();
const manifestPreviewInFlight = new Set<string>();
const MANIFEST_PREVIEW_CACHE_LIMIT = 24;
let completionSchemaCache: JsonSchema | null = null;
const chartDetectionCache = new Map<string, boolean>();
const includeFilesByChartCache = new Map<string, { scannedAt: number; files: Set<string> }>();
const includeOwnersByChartCache = new Map<string, { scannedAt: number; owners: Map<string, Set<string>> }>();
const includeContextsByChartCache = new Map<string, { scannedAt: number; contexts: Map<string, IncludeReferenceContext[]> }>();
const HELM_APPS_DEP_NAME = "helm-apps";
const happLspBootstrapOutput = vscode.window.createOutputChannel("helm-apps / happ-lsp bootstrap");
const happLspClient = new HappLspClient(happLspBootstrapOutput);
const listPolicyDiagnostics = vscode.languages.createDiagnosticCollection("helm-apps-list-policy");
let previewThemeCache: HappPreviewTheme | null = null;
let previewThemeFetchFailed = false;
let templateAssistUnavailable = false;
const INCLUDE_FILE_CACHE_TTL_MS = 2000;
const HAPP_OPTIMIZE_VALUES_CONTEXT_KEY = "helmApps.happOptimizeValuesIncludesAvailable";
const HELM_APPS_LANGUAGE_DOCUMENT_CONTEXT_KEY = "helmApps.languageDocument";

type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  patternProperties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  items?: JsonSchema;
};

interface PreviewOptions {
  env: string;
  applyIncludes: boolean;
  applyEnvResolution: boolean;
  showDiff: boolean;
  renderMode: "values" | "manifest";
  manifestBackend: ManifestPreviewBackend;
}

type ManifestPreviewBackend = "fast" | "helm" | "werf";

const MANIFEST_PREVIEW_BACKENDS: readonly ManifestPreviewBackend[] = ["fast", "helm", "werf"];

type EnvironmentDiscoveryModel = { literals: string[]; regexes: string[] };

interface EntityPreviewState {
  documentUri: vscode.Uri;
  group: string;
  app: string;
  options: PreviewOptions;
}

const DEFAULT_PREVIEW_THEME: HappPreviewTheme = {
  ui: {
    bg: "#1e1f22",
    surface: "#2b2d30",
    surface2: "#323437",
    surface3: "#25272a",
    surface4: "#2f3238",
    text: "#bcbec4",
    muted: "#7e8288",
    accent: "#7aa2ff",
    accent2: "#6ed1bb",
    border: "#3c3f41",
    danger: "#ff8f8f",
    ok: "#7ad8ab",
    title: "#f3f4f7",
    controlHoverBorder: "#455368",
    controlFocusBorder: "#7f9de2",
    controlFocusRing: "rgba(126,156,233,.24)",
    quickEnvBg: "#20242b",
    quickEnvBorder: "#353c48",
    quickEnvText: "#cdd3dd",
    quickEnvHoverBg: "#2b3240",
    quickEnvHoverBorder: "#6a7890",
  },
  syntax: {
    key: "#d19a66",
    bool: "#c678dd",
    number: "#d19a66",
    comment: "#6a8f74",
    string: "#98c379",
    block: "#9aa5b1",
  },
};

const ENTITY_TEMPLATE_COMMANDS: readonly EntityTemplateCommandSpec[] = ENTITY_TEMPLATE_COMMAND_SPECS;
let insertTemplateContextTimer: NodeJS.Timeout | undefined;
let insertTemplateContextVersion = 0;
const INCLUDE_ENTRY_HELPER_KEYS = new Set(["_include", "_include_from_file", "_include_files"]);
let insertTemplateContextStateKey = "";

interface LibrarySettingDef {
  key: string;
  path: string[];
  title: string;
  titleRu: string;
  description: string;
  descriptionRu: string;
  enabledHelp: string;
  enabledHelpRu: string;
  disabledHelp: string;
  disabledHelpRu: string;
}

const LIBRARY_SETTINGS: LibrarySettingDef[] = [
  {
    key: "validation.strict",
    path: ["global", "validation", "strict"],
    title: "Strict validation",
    titleRu: "Строгая валидация",
    description: "Enables strict contract checks for unsupported keys.",
    descriptionRu: "Включает строгие контрактные проверки для неподдерживаемых ключей.",
    enabledHelp: "Validation fails fast on unsupported/ambiguous keys. Safer, but stricter for legacy values.",
    enabledHelpRu: "Валидация сразу падает на неподдерживаемых/неоднозначных ключах. Безопаснее, но строже для legacy values.",
    disabledHelp: "Validation remains compatible-first and allows legacy shapes where possible.",
    disabledHelpRu: "Валидация работает в режиме совместимости и по возможности пропускает legacy-формы.",
  },
  {
    key: "validation.allowNativeListsInBuiltInListFields",
    path: ["global", "validation", "allowNativeListsInBuiltInListFields"],
    title: "Allow native lists in built-in list fields",
    titleRu: "Разрешить native list в встроенных list-полях",
    description: "Allows YAML native lists in selected built-in list fields (migration mode).",
    descriptionRu: "Разрешает YAML native list в части встроенных list-полей (режим миграции).",
    enabledHelp: "Native YAML lists are accepted in selected built-in list fields for migration.",
    enabledHelpRu: "Native YAML list разрешены в выбранных встроенных list-полях для миграции.",
    disabledHelp: "Use library-preferred YAML block strings for list-like fields.",
    disabledHelpRu: "Используйте рекомендуемые библиотекой YAML block string для list-полей.",
  },
  {
    key: "validation.validateFlValueTemplates",
    path: ["global", "validation", "validateFlValueTemplates"],
    title: "Validate fl.value template delimiters",
    titleRu: "Проверять шаблоны fl.value",
    description: "Checks '{{' / '}}' balance for string templates rendered via fl.value.",
    descriptionRu: "Проверяет баланс '{{' / '}}' в строковых шаблонах, рендеримых через fl.value.",
    enabledHelp: "Template delimiter balance is checked before render for fl.value strings.",
    enabledHelpRu: "Перед рендером проверяется баланс шаблонных скобок в fl.value-строках.",
    disabledHelp: "No delimiter pre-check; malformed templates may fail later at render time.",
    disabledHelpRu: "Предпроверка не выполняется; ошибки шаблонов могут проявиться позже при рендере.",
  },
  {
    key: "labels.addEnv",
    path: ["global", "labels", "addEnv"],
    title: "Add environment label",
    titleRu: "Добавлять label окружения",
    description: "Adds app.kubernetes.io/environment=<current env> label to rendered resources.",
    descriptionRu: "Добавляет label app.kubernetes.io/environment=<текущее окружение> в ресурсы.",
    enabledHelp: "Rendered resources include app.kubernetes.io/environment label.",
    enabledHelpRu: "В отрендеренных ресурсах появляется label app.kubernetes.io/environment.",
    disabledHelp: "Environment label is not added automatically by the library.",
    disabledHelpRu: "Label окружения библиотека автоматически не добавляет.",
  },
  {
    key: "deploy.enabled",
    path: ["global", "deploy", "enabled"],
    title: "Enable release matrix auto-app activation",
    titleRu: "Включить автоактивацию release matrix",
    description: "Auto-enables apps if version is found in global.releases for selected release.",
    descriptionRu: "Автовключает app, если версия найдена в global.releases для выбранного релиза.",
    enabledHelp: "Apps can be enabled automatically from global.releases and deploy release mapping.",
    enabledHelpRu: "Приложения могут включаться автоматически по global.releases и deploy release mapping.",
    disabledHelp: "Only explicit app.enabled controls app activation.",
    disabledHelpRu: "Активация приложения определяется только явным app.enabled.",
  },
  {
    key: "deploy.annotateAllWithRelease",
    path: ["global", "deploy", "annotateAllWithRelease"],
    title: "Annotate all resources with release",
    titleRu: "Аннотировать все ресурсы релизом",
    description: "Adds helm-apps/release annotation to all resources of current deploy release.",
    descriptionRu: "Добавляет аннотацию helm-apps/release ко всем ресурсам текущего deploy-релиза.",
    enabledHelp: "All rendered resources are annotated with helm-apps/release.",
    enabledHelpRu: "Все отрендеренные ресурсы получают аннотацию helm-apps/release.",
    disabledHelp: "Release annotation is not forced globally.",
    disabledHelpRu: "Глобальное принудительное добавление release-аннотации отключено.",
  },
];

export function activate(context: vscode.ExtensionContext): void {
  void happLspClient.setAvailableContext(false);
  void setHappOptimizeValuesContext(false);
  void setHelmAppsLanguageDocumentContext(false);
  void applyInsertTemplateContextState(false, new Set<string>());
  context.subscriptions.push(happLspBootstrapOutput);
  context.subscriptions.push(listPolicyDiagnostics);
  const valuesStructure = new ValuesStructureProvider();
  const workbenchActions = new HelmAppsWorkbenchActionsProvider(vscode.env.language);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("helmAppsValuesStructure", valuesStructure),
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("helmAppsWorkbenchActions", workbenchActions),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      valuesStructure.setDocument(editor?.document);
      void refreshListPolicyDiagnosticsForDocument(editor?.document);
      scheduleInsertTemplateContextRefresh(editor, 10);
      void refreshHelmAppsLanguageDocumentContext(editor);
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      scheduleInsertTemplateContextRefresh(event.textEditor, 40);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      void clearHelmAppsDocumentCaches(event.document);
      const active = vscode.window.activeTextEditor?.document;
      if (!active || event.document.uri.toString() !== active.uri.toString()) {
        scheduleEntityPreviewRefreshFor(event.document, 90);
        void refreshListPolicyDiagnosticsForDocument(event.document);
        return;
      }
      valuesStructure.setDocument(active);
      scheduleEntityPreviewRefreshFor(event.document, 90);
      void refreshListPolicyDiagnosticsForDocument(event.document);
      scheduleInsertTemplateContextRefresh(vscode.window.activeTextEditor, 80);
      void refreshHelmAppsLanguageDocumentContext(vscode.window.activeTextEditor);
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      void clearHelmAppsDocumentCaches(document);
      const p = document.uri.fsPath;
      if (p.endsWith("Chart.yaml") || p.includes(`${path.sep}templates${path.sep}`)) {
        chartDetectionCache.clear();
      }
      scheduleEntityPreviewRefreshFor(document, 0);
      void refreshListPolicyDiagnosticsForDocument(document);
      scheduleInsertTemplateContextRefresh(vscode.window.activeTextEditor, 80);
      void refreshHelmAppsLanguageDocumentContext(vscode.window.activeTextEditor);
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      listPolicyDiagnostics.delete(document.uri);
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ language: "yaml" }, {
      provideCodeActions: async (document, range, codeContext) => await provideCodeActions(document, range, codeContext),
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider({ language: "yaml" }, {
      provideDefinition: async (document, position) => await provideDefinition(document, position),
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider({ language: "yaml" }, {
      provideReferences: async (document, position) => await provideReferences(document, position),
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerRenameProvider({ language: "yaml" }, {
      provideRenameEdits: async (document, position, newName) => await provideRenameEdits(document, position, newName),
      prepareRename: async (document, position) => await prepareRename(document, position),
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: "yaml" }, {
      provideCompletionItems: async (document, position, _token, completionContext) =>
        await provideCompletionItems(document, position, completionContext),
    }, " ", ":", "-", ".", "$"),
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider({ language: "yaml" }, {
      provideDocumentSymbols: async (document) => {
        if (!(await isHelmAppsLanguageDocument(document))) {
          return [];
        }
        return buildHelmAppsDocumentSymbols(document);
      },
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: "yaml" }, {
      provideHover: async (document, position) => await provideIncludeHover(document, position),
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "yaml" }, {
      provideCodeLenses: async (document) => await provideIncludedFileCodeLenses(document),
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.goToIncludeDefinition", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const locations = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        "vscode.executeDefinitionProvider",
        editor.document.uri,
        editor.selection.active,
      );
      const first = firstDefinitionLocation(locations);
      if (first) {
        const targetDoc = await vscode.workspace.openTextDocument(first.uri);
        const targetEditor = await vscode.window.showTextDocument(targetDoc, { preview: false });
        targetEditor.selection = new vscode.Selection(first.range.start, first.range.start);
        targetEditor.revealRange(first.range, vscode.TextEditorRevealType.InCenter);
        return;
      }

      const localDef = await provideIncludeDefinition(editor.document, editor.selection.active);
      if (!localDef) {
        void vscode.window.showWarningMessage(t("No include definition found under cursor", "Под курсором не найдено определение include-профиля"));
        return;
      }
      const location = Array.isArray(localDef) ? localDef[0] : localDef;
      const targetDoc = await vscode.workspace.openTextDocument(location.uri);
      const targetEditor = await vscode.window.showTextDocument(targetDoc, { preview: false });
      targetEditor.selection = new vscode.Selection(location.range.start, location.range.start);
      targetEditor.revealRange(location.range, vscode.TextEditorRevealType.InCenter);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.findUsages", async () => {
      await vscode.commands.executeCommand("editor.action.referenceSearch.trigger");
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.explainIncludeFileContext", async (uri?: vscode.Uri) => {
      const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(targetUri);
      await explainIncludedFileContext(document);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.pasteAsHelmApps", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await pasteClipboardAsHelmApps(editor);
    }),
  );
  for (const spec of ENTITY_TEMPLATE_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(spec.commandId, async () => {
        await insertEntityTemplate(spec);
      }),
    );
    if (spec.legacyCommandId) {
      context.subscriptions.push(
        vscode.commands.registerCommand(spec.legacyCommandId, async () => {
          await insertEntityTemplate(spec);
        }),
      );
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.openDependencyGraph", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      if (!(await isHelmAppsValuesDocument(editor.document))) {
        void vscode.window.showWarningMessage(t("Open helm-apps values.yaml to view dependency graph.", "Откройте helm-apps values.yaml для просмотра графа зависимостей."));
        return;
      }
      await openDependencyGraphPanel(editor.document.getText());
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.revealValuesNode", async (uri: vscode.Uri, line: number) => {
      if (!uri) {
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.configureSchema", async () => {
      await configureSchema(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.validateCurrentFile", async () => {
      await validateCurrentFile();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.previewResolvedEntity", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      try {
        const loaded = await loadExpandedValuesForPreview(editor.document);
        const values = loaded.values;
        const text = editor.document.getText();
        const scope = findAppScopeAtLine(text, editor.selection.active.line);
        const context = await resolvePreviewMenuAndEnv(
          editor.document,
          text,
          values,
          scope?.group ?? "",
          scope?.app ?? "",
          "",
        );
        const menu = context.menuModel;
        if (menu.groups.length === 0) {
          void vscode.window.showWarningMessage(t("No entities found in values file", "В values-файле не найдены сущности"));
          return;
        }

        const targetGroup = scope?.group ?? menu.selectedGroup;
        const targetApp = scope?.app ?? menu.selectedApp;
        const defaultEnv = context.defaultEnv;
        const options: PreviewOptions = {
          env: defaultEnv,
          applyIncludes: true,
          applyEnvResolution: true,
          showDiff: false,
          renderMode: "values",
          manifestBackend: readPreviewManifestBackend(),
        };
        showEntityPreview(editor.document, targetGroup, targetApp, options);
      } catch (err) {
        void vscode.window.showErrorMessage(`helm-apps preview failed: ${extractErrorMessage(err)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.extractToGlobalInclude", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const includeName = await vscode.window.showInputBox({
        prompt: "Include profile name (global._includes.<name>)",
        placeHolder: "apps-common",
        validateInput: (v) => (/^[a-z0-9][a-z0-9.-]*$/.test(v) ? null : "Use ^[a-z0-9][a-z0-9.-]*$"),
      });
      if (!includeName) {
        return;
      }

      await rewriteEditorText(editor, (text) =>
        extractAppChildToGlobalInclude(text, editor.selection.active.line, includeName),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.optimizeValuesIncludes", async () => {
      const editor = vscode.window.activeTextEditor;
      const blocker = classifyOptimizeValuesGuard({
        hasActiveEditor: Boolean(editor),
        isHelmAppsLanguageDocument: editor ? await isHelmAppsLanguageDocument(editor.document) : false,
        happRunning: happLspClient.isRunning(),
        methodAdvertised: happLspClient.advertisesMethod(HAPP_LSP_METHODS.optimizeValuesIncludes),
      });
      if (blocker) {
        if (blocker === "wrongDocument") {
          void vscode.window.showWarningMessage(
            t(
              "Open helm-apps values/include YAML to optimize include profiles.",
              "Откройте YAML-файл values/include helm-apps для оптимизации include-профилей.",
            ),
          );
          return;
        }
        if (blocker === "happUnavailable") {
          void vscode.window.showWarningMessage(
            t(
              "happ LSP is unavailable. Include optimization requires happ.",
              "happ LSP недоступен. Оптимизация include-профилей требует happ.",
            ),
          );
          return;
        }
        if (blocker === "methodUnavailable") {
          void vscode.window.showWarningMessage(
            t(
              "Current happ binary does not support include optimization method. Update happ.",
              "Текущий бинарник happ не поддерживает метод оптимизации include. Обновите happ.",
            ),
          );
          return;
        }
        return;
      }
      const activeEditor = editor as vscode.TextEditor;
      const currentText = activeEditor.document.getText();
      try {
        const result = await happLspClient.optimizeValuesIncludes(
          buildOptimizeValuesRequest({
            uri: activeEditor.document.uri.toString(),
            text: currentText,
          }),
        );
        const resultPlan = classifyOptimizeValuesResult(result);
        if (resultPlan.kind === "noChanges") {
          void vscode.window.showInformationMessage(
            t(
              "No shared fragments found for include optimization.",
              "Общие фрагменты для оптимизации include-профилей не найдены.",
            ),
          );
          return;
        }
        const fullRange = new vscode.Range(
          activeEditor.document.positionAt(0),
          activeEditor.document.positionAt(currentText.length),
        );
        const applied = await activeEditor.edit((builder) => {
          builder.replace(fullRange, resultPlan.optimizedText);
        });
        if (!applied) {
          throw new Error("unable to apply optimized values into editor");
        }
        void vscode.window.showInformationMessage(
          t(
            `Optimized values: added ${resultPlan.profilesAdded} include profile(s).`,
            `Оптимизация values завершена: добавлено include-профилей: ${resultPlan.profilesAdded}.`,
          ),
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `${t("helm-apps include optimization failed", "Оптимизация include-профилей helm-apps не удалась")}: ${extractErrorMessage(err)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.safeRenameAppKey", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const newKey = await vscode.window.showInputBox({
        prompt: "New app key",
        placeHolder: "api-v2",
        validateInput: (v) => (/^[a-z0-9][a-z0-9.-]*$/.test(v) ? null : "Use ^[a-z0-9][a-z0-9.-]*$"),
      });
      if (!newKey) {
        return;
      }

      try {
        const lspEdit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | null>(
          "vscode.executeDocumentRenameProvider",
          editor.document.uri,
          editor.selection.active,
          newKey,
        );
        if (lspEdit) {
          await vscode.workspace.applyEdit(lspEdit);
          void vscode.window.showInformationMessage(`helm-apps: renamed to '${newKey}'`);
          return;
        }
      } catch (err) {
        void vscode.window.showWarningMessage(`helm-apps workspace rename fallback: ${extractErrorMessage(err)}`);
      }

      await rewriteEditorText(editor, (text) => safeRenameAppKey(text, editor.selection.active.line, newKey));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.openLibrarySettings", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      if (!(await isHelmAppsValuesDocument(editor.document))) {
        void vscode.window.showWarningMessage(t("Open helm-apps values.yaml to edit library settings.", "Откройте helm-apps values.yaml для редактирования настроек библиотеки."));
        return;
      }
      await openLibrarySettingsPanel(editor);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.generateLibraryHelp", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      if (!(await isHelmAppsValuesDocument(editor.document))) {
        void vscode.window.showWarningMessage(t("Open helm-apps values.yaml to generate settings help.", "Откройте helm-apps values.yaml для формирования справки по настройкам."));
        return;
      }
      const ru = vscode.env.language.toLowerCase().startsWith("ru");
      const values = parseValuesObject(editor.document.getText());
      const current = new Map<string, boolean>();
      for (const setting of LIBRARY_SETTINGS) {
        current.set(setting.key, readBooleanByPath(values, setting.path));
      }
      await openLibrarySettingsHelp(current, ru, editor.document.uri.fsPath);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.createStarterChart", async (uri?: vscode.Uri) => {
      await createStarterChart(context, uri);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.manageLibrarySource", async () => {
      await manageLibrarySource(context);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.checkLibraryUpdate", async () => {
      await checkLibraryUpdate(context);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.cacheLibraryFromGithub", async () => {
      await cacheLibraryFromGithub(context, true);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.updateLibraryDependency", async () => {
      await updateLibraryDependencyInChart(context);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("helm-apps.updateLibraryLockfile", async () => {
      await updateChartLockfile();
    }),
  );

  void configureSchemaOnStartup(context);
  valuesStructure.setDocument(vscode.window.activeTextEditor?.document);
  void refreshHelmAppsLanguageDocumentContext(vscode.window.activeTextEditor);
  scheduleInsertTemplateContextRefresh(vscode.window.activeTextEditor, 0);
  for (const document of vscode.workspace.textDocuments) {
    void refreshListPolicyDiagnosticsForDocument(document);
  }
  void initializeLanguageFeatures(context);
}

export function deactivate(): Thenable<void> | void {
  return happLspClient.stop();
}

async function initializeLanguageFeatures(context: vscode.ExtensionContext): Promise<void> {
  resetPreviewThemeState();
  templateAssistUnavailable = false;
  await setHappOptimizeValuesContext(false);
  const cfg = getExtensionConfig();
  const mode = cfg.get<LanguageMode>("languageServerMode", "happ");
  const devHappPathOverride = await resolveDevHappPathOverride(context);
  happLspBootstrapOutput.clear();
  happLspBootstrapOutput.appendLine(`[${new Date().toISOString()}] initializeLanguageFeatures mode=${mode}`);
  happLspBootstrapOutput.appendLine(`extensionMode=${context.extensionMode}`);
  if (devHappPathOverride) {
    happLspBootstrapOutput.appendLine(`dev happ override=${devHappPathOverride}`);
  }
  if (mode === "fallback") {
    happLspBootstrapOutput.appendLine("languageServerMode=fallback; stopping happ client");
    await happLspClient.stop();
    await setHappOptimizeValuesContext(false);
    applyLightFallbackMode();
    return;
  }

  const happPath = cfg.get<string>("happPath", "happ").trim() || "happ";
  const configuredArgs = cfg.get<string[]>("happLspArgs", DEFAULT_HAPP_LSP_ARGS);
  const happArgsRaw = Array.isArray(configuredArgs)
    ? configuredArgs.map((it) => String(it).trim()).filter((it) => it.length > 0)
    : [];
  const happArgs = normalizeHappLspArgs(happArgsRaw);
  const args = happArgs.length > 0 ? happArgs : [...DEFAULT_HAPP_LSP_ARGS];
  const pathCandidates = devHappPathOverride
    ? [devHappPathOverride]
    : await resolveHappPathCandidates(happPath);
  if (devHappPathOverride) {
    happLspBootstrapOutput.appendLine("development mode: using strict happ binary path");
  }
  happLspBootstrapOutput.appendLine(`configured happPath=${happPath}`);
  happLspBootstrapOutput.appendLine(`lsp args=${JSON.stringify(args)}`);
  happLspBootstrapOutput.appendLine(`path candidates=${JSON.stringify(pathCandidates)}`);

  const startErrors: string[] = [];
  for (const candidatePath of pathCandidates) {
    // Log exact binary version for deterministic troubleshooting.
    // This helps distinguish PATH/fallback mismatches when multiple happ builds are present.
     
    const candidateVersion = await readHappVersion(candidatePath);
    happLspBootstrapOutput.appendLine(`candidate version: ${candidatePath} :: ${candidateVersion ?? "unknown"}`);

    happLspBootstrapOutput.appendLine(`trying: ${candidatePath}`);
    const result = await happLspClient.start(context, candidatePath, args);
    if (!result.started) {
      happLspBootstrapOutput.appendLine(`failed: ${candidatePath} :: ${result.errorMessage ?? "unknown error"}`);
      startErrors.push(`${candidatePath}: ${result.errorMessage ?? "unknown error"}`);
      continue;
    }
    happLspBootstrapOutput.appendLine(
      `started: ${candidatePath}; fullLanguageSupport=${result.fullLanguageSupport ? "true" : "false"}`,
    );
    await setHappOptimizeValuesContext(happLspClient.advertisesMethod(HAPP_LSP_METHODS.optimizeValuesIncludes));
    if (candidatePath !== happPath) {
      void vscode.window.showInformationMessage(
        t(
          `happ LSP started with fallback binary: ${candidatePath}`,
          `happ LSP запущен через резервный бинарник: ${candidatePath}`,
        ),
      );
    }
    if (result.fullLanguageSupport) {
      return;
    }
    happLspBootstrapOutput.appendLine("happ LSP started in partial mode; lightweight client fallback remains active");
    return;
  }

  if (startErrors.length > 0) {
    const details = startErrors.join(" | ");
    happLspBootstrapOutput.appendLine(`all candidates failed: ${details}`);
    happLspBootstrapOutput.show(true);
    void vscode.window.showWarningMessage(
      t(
        `happ LSP unavailable (${details}); switched to basic mode. See 'helm-apps / happ-lsp bootstrap' output.`,
        `happ LSP недоступен (${details}); включён базовый режим. См. вывод 'helm-apps / happ-lsp bootstrap'.`,
      ),
    );
  }
  await setHappOptimizeValuesContext(false);
  applyLightFallbackMode();
}

function applyLightFallbackMode(): void {
  // Keep extension-side fallback intentionally lightweight when happ is unavailable.
}

async function setHappOptimizeValuesContext(available: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", HAPP_OPTIMIZE_VALUES_CONTEXT_KEY, available);
}

async function setHelmAppsLanguageDocumentContext(available: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", HELM_APPS_LANGUAGE_DOCUMENT_CONTEXT_KEY, available);
}

async function refreshHelmAppsLanguageDocumentContext(editor: vscode.TextEditor | undefined): Promise<void> {
  if (!editor) {
    await setHelmAppsLanguageDocumentContext(false);
    return;
  }
  const available = await isHelmAppsLanguageDocument(editor.document);
  await setHelmAppsLanguageDocumentContext(available);
}

async function clearHelmAppsDocumentCaches(document: vscode.TextDocument): Promise<void> {
  if (document.languageId !== "yaml") {
    return;
  }
  const chart = await findNearestChartYaml(document.uri.fsPath);
  if (!chart) {
    return;
  }
  const chartDir = path.dirname(chart.fsPath);
  includeFilesByChartCache.delete(chartDir);
  includeOwnersByChartCache.delete(chartDir);
  includeContextsByChartCache.delete(chartDir);
}

function resetPreviewThemeState(): void {
  previewThemeCache = null;
  previewThemeFetchFailed = false;
}

function normalizeHappLspArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (arg === "--stdio") {
      return "--stdio=true";
    }
    return arg;
  });
}

async function resolveHappPathCandidates(configuredPath: string): Promise<string[]> {
  const primary = configuredPath.trim().length > 0 ? configuredPath.trim() : "happ";
  // Do not auto-probe fallback paths inside extension.
  // Resolution is explicit: configured path (or PATH when value is `happ`).
  return [primary];
}

async function resolveDevHappPathOverride(context: vscode.ExtensionContext): Promise<string | undefined> {
  if (context.extensionMode !== vscode.ExtensionMode.Development) {
    return undefined;
  }
  const candidate = process.env.HELM_APPS_DEV_HAPP_PATH?.trim() ?? "";
  if (candidate.length === 0) {
    return undefined;
  }
  try {
    await access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

async function readHappVersion(candidatePath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(candidatePath, ["--version"], {
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    const line = `${stdout ?? ""}\n${stderr ?? ""}`
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    return line ?? null;
  } catch {
    return null;
  }
}

async function refreshListPolicyDiagnosticsForDocument(document: vscode.TextDocument | undefined): Promise<void> {
  if (!document) {
    return;
  }
  if (document.languageId !== "yaml") {
    listPolicyDiagnostics.delete(document.uri);
    return;
  }
  if (!(await isHelmAppsLanguageDocument(document))) {
    listPolicyDiagnostics.delete(document.uri);
    return;
  }

  const text = document.getText();
  const values = parseValuesObject(text);
  const allowBuiltInLists = readBooleanByPath(values, ["global", "validation", "allowNativeListsInBuiltInListFields"]);
  const issues = validateUnexpectedNativeLists(text, {
    allowNativeListsInBuiltInListFields: allowBuiltInLists,
  });
  const lines = text.split(/\r?\n/);
  const diagnostics = issues.map((issue) => {
    const lineIndex = Math.max(0, Math.min(lines.length - 1, issue.line - 1));
    const lineText = lines[lineIndex] ?? "";
    const listMarker = lineText.match(/^(\s*-\s*)/);
    const startChar = listMarker ? listMarker[1].length - 2 : Math.max(0, lineText.search(/\S/));
    const endChar = Math.min(lineText.length, startChar + 1);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(
        new vscode.Position(lineIndex, startChar),
        new vscode.Position(lineIndex, Math.max(startChar + 1, endChar)),
      ),
      t(
        `Native YAML list is not allowed here (${issue.path}). Use YAML block string: key: |-. Quick Fix: "Convert native list to YAML block string". For migration only: set global.validation.allowNativeListsInBuiltInListFields=true. Docs: docs/faq.md#2-почему-list-в-values-почти-везде-запрещены`,
        `Native YAML list здесь запрещён (${issue.path}). Используйте YAML block string: key: |-. Быстрое исправление: "Convert native list to YAML block string". Только для миграции: global.validation.allowNativeListsInBuiltInListFields=true. Документация: docs/faq.md#2-почему-list-в-values-почти-везде-запрещены`,
      ),
      vscode.DiagnosticSeverity.Error,
    );
    diagnostic.source = "helm-apps";
    diagnostic.code = issue.code;
    return diagnostic;
  });
  listPolicyDiagnostics.set(document.uri, diagnostics);
}

function firstDefinitionLocation(
  locations: Array<vscode.Location | vscode.LocationLink> | undefined,
): vscode.Location | null {
  if (!locations || locations.length === 0) {
    return null;
  }
  const first = locations[0];
  if (first instanceof vscode.Location) {
    return first;
  }
  return new vscode.Location(first.targetUri, first.targetSelectionRange ?? first.targetRange);
}

async function configureSchema(context: vscode.ExtensionContext, silent = false): Promise<void> {
  const manualFileMatch = vscode.workspace.getConfiguration("helm-apps").get<string[]>("schemaFileMatch", []);
  const rawFileMatch = manualFileMatch.length > 0 ? manualFileMatch : await discoverHelmAppsSchemaTargets();
  const fileMatch = rawFileMatch.filter((filePath) => !isWerfSecretValuesFilePath(filePath));

  const yamlConfig = vscode.workspace.getConfiguration("yaml");
  const current = (yamlConfig.get<Record<string, string[]>>("schemas") ?? {}) as Record<string, string[]>;

  const schemaUri = vscode.Uri.file(path.join(context.extensionPath, "schemas", "values.schema.json")).toString();
  const next = { ...current };
  for (const existingSchemaUri of Object.keys(next)) {
    if (shouldReplaceLegacyHelmAppsSchema(existingSchemaUri, schemaUri)) {
      delete next[existingSchemaUri];
    }
  }
  if (fileMatch.length > 0) {
    next[schemaUri] = fileMatch;
  } else {
    delete next[schemaUri];
  }

  if (jsonStringifyStable(current) === jsonStringifyStable(next)) {
    return;
  }

  try {
    await yamlConfig.update("schemas", next, vscode.ConfigurationTarget.Workspace);
    await configureYamlHoverBehavior();
    await configureYamlSuggestionBehavior();
  } catch (err) {
    const message = extractErrorMessage(err);
    if (!silent) {
      void vscode.window.showWarningMessage(`helm-apps: unable to configure YAML schema automatically: ${message}`);
    }
    return;
  }

  if (!silent) {
    void vscode.window.showInformationMessage(
      fileMatch.length > 0
        ? `helm-apps schema configured for ${fileMatch.length} file(s)`
        : "helm-apps schema mapping cleared (no helm-apps charts detected)",
    );
  }
}

async function configureSchemaOnStartup(context: vscode.ExtensionContext): Promise<void> {
  const yamlConfig = vscode.workspace.getConfiguration("yaml");
  const current = (yamlConfig.get<Record<string, string[]>>("schemas") ?? {}) as Record<string, string[]>;
  const activeSchemaUri = vscode.Uri.file(path.join(context.extensionPath, "schemas", "values.schema.json")).toString();
  if (current[activeSchemaUri]) {
    return;
  }
  await configureSchema(context, true);
}

function jsonStringifyStable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => jsonStringifyStable(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${jsonStringifyStable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function shouldReplaceLegacyHelmAppsSchema(existingSchemaUri: string, activeSchemaUri: string): boolean {
  if (existingSchemaUri === activeSchemaUri) {
    return false;
  }
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(existingSchemaUri, true);
  } catch {
    return false;
  }
  if (uri.scheme !== "file") {
    return false;
  }
  const fsPath = uri.fsPath.replace(/\\/g, "/").toLowerCase();
  if (!fsPath.endsWith("/schemas/values.schema.json")) {
    return false;
  }
  // Replace stale schema mappings from old helm-apps extension locations.
  return fsPath.includes("/extensions/helm-apps/")
    || fsPath.includes("/helm-apps-extensions/")
    || (fsPath.includes("/.vscode/extensions/") && fsPath.includes("helm-apps"));
}

async function configureYamlHoverBehavior(): Promise<void> {
  const disableSchemaHover = vscode.workspace
    .getConfiguration("helm-apps")
    .get<boolean>("disableYamlSchemaHover", true);
  if (!disableSchemaHover) {
    return;
  }
  const yamlConfig = vscode.workspace.getConfiguration("yaml");
  const current = yamlConfig.get<boolean>("hover");
  if (current !== false) {
    await yamlConfig.update("hover", false, vscode.ConfigurationTarget.Workspace);
  }
}

async function configureYamlSuggestionBehavior(): Promise<void> {
  const rootConfig = vscode.workspace.getConfiguration();
  const current = (rootConfig.get<Record<string, unknown>>("[yaml]") ?? {}) as Record<string, unknown>;
  if (current["editor.suggest.showSnippets"] === false) {
    return;
  }
  await rootConfig.update(
    "[yaml]",
    {
      ...current,
      "editor.suggest.showSnippets": false,
    },
    vscode.ConfigurationTarget.Workspace,
  );
}

async function openLibrarySettingsPanel(editor: vscode.TextEditor): Promise<void> {
  const ru = vscode.env.language.toLowerCase().startsWith("ru");
  const panel = vscode.window.createWebviewPanel(
    "helmAppsLibrarySettings",
    ru ? "helm-apps: настройки библиотеки" : "helm-apps: library settings",
    vscode.ViewColumn.Beside,
    { enableScripts: true },
  );

  const values = parseValuesObject(editor.document.getText());
  const current = new Map<string, boolean>();
  for (const setting of LIBRARY_SETTINGS) {
    current.set(setting.key, readBooleanByPath(values, setting.path));
  }
  panel.webview.html = renderLibrarySettingsHtml(current, ru);

  panel.webview.onDidReceiveMessage(async (msg: unknown) => {
    if (!msg || typeof msg !== "object") {
      return;
    }
    const payload = msg as { type?: string; values?: Record<string, boolean> };
    if (payload.type === "close") {
      panel.dispose();
      return;
    }
    if (payload.type === "generateHelp" && payload.values) {
      await openLibrarySettingsHelp(new Map(Object.entries(payload.values)), ru, editor.document.uri.fsPath);
      return;
    }
    if (payload.type !== "applySettings" || !payload.values) {
      return;
    }
    try {
      const text = editor.document.getText();
      const updated = applyLibrarySettingsToValues(text, payload.values);
      const fullRange = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(text.length),
      );
      await editor.edit((builder) => builder.replace(fullRange, updated));
      void vscode.window.showInformationMessage(ru ? "Настройки библиотеки обновлены в values.yaml" : "Library settings updated in values.yaml");
      panel.dispose();
    } catch (err) {
      void vscode.window.showErrorMessage(`${ru ? "Не удалось применить настройки" : "Failed to apply settings"}: ${extractErrorMessage(err)}`);
    }
  });
}

function parseValuesObject(text: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(text) as unknown;
    return isMap(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function scheduleInsertTemplateContextRefresh(editor: vscode.TextEditor | undefined, delayMs: number): void {
  const targetEditor = editor;
  if (insertTemplateContextTimer) {
    clearTimeout(insertTemplateContextTimer);
  }
  const requestVersion = ++insertTemplateContextVersion;
  insertTemplateContextTimer = setTimeout(() => {
    insertTemplateContextTimer = undefined;
    void refreshInsertTemplateContext(targetEditor, requestVersion);
  }, Math.max(0, delayMs));
}

async function refreshInsertTemplateContext(editor: vscode.TextEditor | undefined, requestVersion: number): Promise<void> {
  const activeEditor = editor ?? vscode.window.activeTextEditor;
  if (!activeEditor || activeEditor.document.languageId !== "yaml") {
    if (requestVersion === insertTemplateContextVersion) {
      await applyInsertTemplateContextState(false, new Set<string>());
    }
    return;
  }

  if (!(await isHelmAppsLanguageDocument(activeEditor.document))) {
    if (requestVersion === insertTemplateContextVersion) {
      await applyInsertTemplateContextState(false, new Set<string>());
    }
    return;
  }

  const text = activeEditor.document.getText();
  const blocks = collectTopLevelGroupBlocks(text);
  const activeBlock = findTopLevelGroupBlockAtLine(text, blocks, activeEditor.selection.active.line);
  const allowed = buildAllowedTemplateGroupTypes(text, blocks, activeBlock, ENTITY_TEMPLATE_COMMANDS);

  if (requestVersion !== insertTemplateContextVersion) {
    return;
  }
  await applyInsertTemplateContextState(allowed.size > 0, allowed);
}

async function applyInsertTemplateContextState(visible: boolean, allowedTypes: Set<string>): Promise<void> {
  const key = `${visible ? "1" : "0"}|${[...allowedTypes].sort().join(",")}`;
  if (key === insertTemplateContextStateKey) {
    return;
  }
  insertTemplateContextStateKey = key;
  await vscode.commands.executeCommand("setContext", INSERT_ENTITY_TEMPLATE_MENU_CONTEXT, visible);
  await vscode.commands.executeCommand("setContext", LEGACY_INSERT_ENTITY_EXAMPLE_MENU_CONTEXT, visible);
  for (const spec of ENTITY_TEMPLATE_COMMANDS) {
    await vscode.commands.executeCommand("setContext", spec.contextKey, allowedTypes.has(spec.groupType));
    if (spec.legacyContextKey) {
      await vscode.commands.executeCommand("setContext", spec.legacyContextKey, allowedTypes.has(spec.groupType));
    }
  }
}

async function insertEntityTemplate(spec: EntityTemplateCommandSpec): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  if (!(await isHelmAppsValuesDocument(editor.document))) {
    void vscode.window.showWarningMessage(
      t(
        "Open helm-apps values.yaml to insert an entity template.",
        "Откройте helm-apps values.yaml, чтобы вставить шаблон сущности.",
      ),
    );
    return;
  }

  const text = editor.document.getText();
  const blocks = collectTopLevelGroupBlocks(text);
  const activeBlock = findTopLevelGroupBlockAtLine(text, blocks, editor.selection.active.line);
  if (activeBlock && activeBlock.effectiveType !== spec.groupType) {
    void vscode.window.showWarningMessage(
      t(
        `Cursor is inside '${activeBlock.name}' (${activeBlock.effectiveType}); insert for '${spec.groupType}' is hidden in this context.`,
        `Курсор находится в '${activeBlock.name}' (${activeBlock.effectiveType}); вставка '${spec.groupType}' в этом контексте недоступна.`,
      ),
    );
    return;
  }

  const targetGroupName = activeBlock?.name
    ?? findPreferredGroupNameByType(blocks, spec.groupType)
    ?? spec.groupType;

  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const insertion = planEntityTemplateInsertion(text, eol, targetGroupName, spec);
  if (!insertion) {
    void vscode.window.showInformationMessage(
      t(
        `Template scaffold is already present in '${targetGroupName}'.`,
        `Шаблон уже присутствует в '${targetGroupName}'.`,
      ),
    );
    return;
  }
  const applied = await editor.edit((builder) => {
    builder.insert(new vscode.Position(insertion.line, 0), insertion.text);
  });
  if (!applied) {
    return;
  }
  scheduleInsertTemplateContextRefresh(editor, 30);
  void vscode.window.showInformationMessage(
    t(
      `Inserted template '${insertion.insertedLabel}' (${spec.groupType})`,
      `Вставлен шаблон '${insertion.insertedLabel}' (${spec.groupType})`,
    ),
  );
}

function readBooleanByPath(root: Record<string, unknown>, pathParts: string[]): boolean {
  let current: unknown = root;
  for (const part of pathParts) {
    if (!isMap(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return false;
    }
    current = current[part];
  }
  return current === true;
}

function applyLibrarySettingsToValues(text: string, selected: Record<string, boolean>): string {
  const doc = YAML.parseDocument(text);
  for (const setting of LIBRARY_SETTINGS) {
    const enabled = selected[setting.key] === true;
    doc.setIn(setting.path, enabled);
  }
  return String(doc);
}

function renderLibrarySettingsHtml(current: Map<string, boolean>, ru: boolean): string {
  const rows = LIBRARY_SETTINGS
    .map((s) => {
      const checked = current.get(s.key) ? "checked" : "";
      const title = ru ? s.titleRu : s.title;
      const description = ru ? s.descriptionRu : s.description;
      return `<label class="row">
        <input type="checkbox" data-key="${escapeHtml(s.key)}" ${checked} />
        <span class="meta">
          <span class="title">${escapeHtml(title)}</span>
          <span class="desc">${escapeHtml(description)}</span>
          <code>${escapeHtml(s.path.join("."))}</code>
        </span>
      </label>`;
    })
    .join("");

  const header = ru ? "Настройки библиотеки" : "Library Settings";
  const sub = ru
    ? "Выберите опции и примените их в values.yaml (блок global.*)."
    : "Choose options and apply them into values.yaml (global.* section).";
  const apply = ru ? "Применить в values.yaml" : "Apply to values.yaml";
  const genHelp = ru ? "Сформировать справку" : "Generate help";
  const cancel = ru ? "Закрыть" : "Close";

  return `<!doctype html>
<html lang="${ru ? "ru" : "en"}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 14px; color: var(--vscode-foreground); }
    h2 { margin: 0 0 6px; }
    .sub { opacity: .85; margin-bottom: 14px; }
    .list { display: grid; gap: 10px; }
    .row { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; }
    .meta { display: grid; gap: 4px; }
    .title { font-weight: 600; }
    .desc { opacity: .9; }
    code { opacity: .8; }
    .actions { margin-top: 14px; display: flex; gap: 8px; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.secondary { background: var(--vscode-editorWidget-background); color: var(--vscode-foreground); }
  </style>
</head>
<body>
  <h2>${escapeHtml(header)}</h2>
  <div class="sub">${escapeHtml(sub)}</div>
  <div class="list">${rows}</div>
  <div class="actions">
    <button id="apply" class="primary">${escapeHtml(apply)}</button>
    <button id="help" class="secondary">${escapeHtml(genHelp)}</button>
    <button id="cancel" class="secondary">${escapeHtml(cancel)}</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const collectValues = () => {
      const values = {};
      document.querySelectorAll("input[data-key]").forEach((el) => {
        values[el.dataset.key] = el.checked;
      });
      return values;
    };
    document.getElementById("apply").addEventListener("click", () => {
      vscode.postMessage({ type: "applySettings", values: collectValues() });
    });
    document.getElementById("help").addEventListener("click", () => {
      vscode.postMessage({ type: "generateHelp", values: collectValues() });
    });
    document.getElementById("cancel").addEventListener("click", () => {
      vscode.postMessage({ type: "close" });
    });
  </script>
</body>
</html>`;
}

async function openLibrarySettingsHelp(current: Map<string, boolean>, ru: boolean, filePath: string): Promise<void> {
  const statusEnabled = ru ? "включено" : "enabled";
  const statusDisabled = ru ? "выключено" : "disabled";
  const title = ru ? "# Настройки библиотеки helm-apps" : "# helm-apps Library Settings";
  const source = ru ? `Файл: \`${filePath}\`` : `File: \`${filePath}\``;

  const lines: string[] = [title, "", source, ""];
  for (const setting of LIBRARY_SETTINGS) {
    const enabled = current.get(setting.key) === true;
    const sTitle = ru ? setting.titleRu : setting.title;
    const sDesc = ru ? setting.descriptionRu : setting.description;
    const sEnabledHelp = ru ? setting.enabledHelpRu : setting.enabledHelp;
    const sDisabledHelp = ru ? setting.disabledHelpRu : setting.disabledHelp;
    lines.push(`## ${sTitle}`);
    lines.push("");
    lines.push(`- ${ru ? "Путь" : "Path"}: \`${setting.path.join(".")}\``);
    lines.push(`- ${ru ? "Статус" : "Status"}: **${enabled ? statusEnabled : statusDisabled}**`);
    lines.push(`- ${ru ? "Что это" : "What it does"}: ${sDesc}`);
    lines.push(`- ${ru ? "Эффект сейчас" : "Current effect"}: ${enabled ? sEnabledHelp : sDisabledHelp}`);
    lines.push("");
  }

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: lines.join("\n"),
  });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

async function openDependencyGraphPanel(valuesText: string): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "helmAppsDependencyGraph",
    "helm-apps: dependency graph",
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );
  const model = buildDependencyGraphModel(valuesText);
  panel.webview.html = renderDependencyGraphHtml(model);
}

function renderDependencyGraphHtml(model: {
  apps: Array<{ group: string; app: string; includes: string[] }>;
  includes: string[];
  includeFiles: string[];
}): string {
  const includeSet = new Set(model.includes);
  const appRows = model.apps
    .map((a) => {
      const links = a.includes.length === 0
        ? `<span class="muted">no includes</span>`
        : a.includes.map((inc) => {
          const cls = includeSet.has(inc) ? "ok" : "warn";
          const suffix = includeSet.has(inc) ? "" : " (unresolved)";
          return `<span class="chip ${cls}">${escapeHtml(inc)}${suffix}</span>`;
        }).join(" ");
      return `<tr><td><code>${escapeHtml(a.group)}</code></td><td><code>${escapeHtml(a.app)}</code></td><td>${links}</td></tr>`;
    })
    .join("");
  const includeRows = model.includes.map((i) => `<li><code>${escapeHtml(i)}</code></li>`).join("");
  const fileRows = model.includeFiles.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 14px; color: var(--vscode-foreground); }
    h2 { margin: 0 0 10px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; }
    .muted { opacity: .7; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); text-align: left; padding: 6px; vertical-align: top; }
    th { opacity: .9; }
    .chip { display: inline-block; border-radius: 999px; padding: 2px 8px; margin: 2px 4px 2px 0; font-size: 12px; }
    .chip.ok { background: rgba(40,180,99,.2); border: 1px solid rgba(40,180,99,.5); }
    .chip.warn { background: rgba(230,126,34,.2); border: 1px solid rgba(230,126,34,.5); }
  </style>
</head>
<body>
  <h2>helm-apps dependency graph</h2>
  <div class="grid">
    <div class="card">
      <div><b>global._includes</b></div>
      <ul>${includeRows || "<li class='muted'>none</li>"}</ul>
    </div>
    <div class="card">
      <div><b>include files</b></div>
      <ul>${fileRows || "<li class='muted'>none</li>"}</ul>
    </div>
  </div>
  <div class="card">
    <div><b>apps -> includes</b></div>
    <table>
      <thead><tr><th>Group</th><th>App</th><th>Includes</th></tr></thead>
      <tbody>${appRows || "<tr><td colspan='3' class='muted'>no apps found</td></tr>"}</tbody>
    </table>
  </div>
</body>
</html>`;
}

async function validateCurrentFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(t("No active editor", "Нет активного редактора"));
    return;
  }

  const document = editor.document;
  if (document.languageId !== "yaml") {
    void vscode.window.showWarningMessage(t("Validation is available for YAML files only", "Проверка доступна только для YAML-файлов"));
    return;
  }
  if (!(await isHelmAppsValuesDocument(document))) {
    void vscode.window.showWarningMessage(t("Current file is not detected as helm-apps values", "Текущий файл не распознан как helm-apps values"));
    return;
  }

  try {
    if (!happLspClient.isRunning()) {
      const parsed = YAML.parseDocument(document.getText());
      const parseErrors = parsed.errors.length;
      if (parseErrors === 0) {
        void vscode.window.showInformationMessage(
          t(
            "Basic YAML validation passed. Install/start happ for semantic helm-apps diagnostics.",
            "Базовая YAML-проверка пройдена. Для семантической диагностики helm-apps запустите happ.",
          ),
        );
      } else {
        void vscode.window.showWarningMessage(
          t(
            `YAML parse errors: ${parseErrors}. Install/start happ for semantic helm-apps diagnostics.`,
            `Ошибки парсинга YAML: ${parseErrors}. Для семантической диагностики helm-apps запустите happ.`,
          ),
        );
      }
      return;
    }

    const fromEditors = vscode.languages.getDiagnostics(document.uri);
    const scoped = fromEditors.filter((d) => {
      const source = (d.source ?? "").toLowerCase();
      return source.includes("happ") || source.includes("helm-apps");
    });
    const all = scoped.length > 0 ? scoped : fromEditors;
    const errors = all.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = all.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;
    const infos = all.filter((d) => d.severity === vscode.DiagnosticSeverity.Information).length;
    if (errors === 0 && warnings === 0) {
      const infoText = infos > 0 ? `, info: ${infos}` : "";
      void vscode.window.showInformationMessage(
        isRuLocale()
          ? `Проверка helm-apps пройдена (предупреждений: 0${infos > 0 ? `, info: ${infos}` : ""})`
          : `helm-apps validation passed (warnings: 0${infoText})`,
      );
      return;
    }
    void vscode.window.showWarningMessage(
      isRuLocale()
        ? `Проверка helm-apps: ошибок ${errors}, предупреждений ${warnings}, info ${infos}`
        : `helm-apps validation: errors ${errors}, warnings ${warnings}, info ${infos}`,
    );
  } catch (err) {
    const message = extractErrorMessage(err);
    void vscode.window.showErrorMessage(
      isRuLocale() ? `Проверка helm-apps завершилась ошибкой: ${message}` : `helm-apps validation failed: ${message}`,
    );
  }
}

async function pasteClipboardAsHelmApps(editor: vscode.TextEditor): Promise<void> {
  const clipboard = (await vscode.env.clipboard.readText()).trim();
  if (clipboard.length === 0) {
    void vscode.window.showWarningMessage(t("Clipboard is empty", "Буфер обмена пуст"));
    return;
  }

  const happPath = vscode.workspace.getConfiguration("helm-apps").get<string>("happPath", "happ");
  if (!(await ensureHappReady(happPath))) {
    return;
  }
  const envDiscovery = discoverEnvironments(editor.document.getText());
  const env = detectDefaultEnv(parseValuesObject(editor.document.getText()), envDiscovery);
  const cwd = workspaceRoot(editor.document.uri) ?? path.dirname(editor.document.uri.fsPath);

  let tempDir = "";
  try {
    tempDir = await mkdtemp(path.join(tmpdir(), "happ-paste-"));
    const inputPath = path.join(tempDir, "clipboard-manifest.yaml");
    await writeFile(inputPath, clipboard, "utf8");

    const { stdout, stderr } = await execFileAsync(
      happPath,
      ["manifests", "--path", inputPath, "--import-strategy", "helpers-experimental", "--env", env],
      {
        cwd,
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    const generated = (stdout ?? "").trim();
    if (generated.length === 0) {
      const details = (stderr ?? "").trim();
      throw new Error(details.length > 0 ? details : "happ returned empty output");
    }

    await editor.edit((builder) => {
      if (!editor.selection.isEmpty) {
        builder.replace(editor.selection, generated);
      } else {
        builder.insert(editor.selection.active, generated);
      }
    });
    void vscode.window.showInformationMessage(t("Inserted clipboard as helm-apps values", "Содержимое буфера вставлено как helm-apps values"));
  } catch (err) {
    void vscode.window.showErrorMessage(
      isRuLocale()
        ? `Вставка как helm-apps завершилась ошибкой: ${extractErrorMessage(err)}`
        : `Paste as helm-apps failed: ${extractErrorMessage(err)}`,
    );
  } finally {
    if (tempDir.length > 0) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup errors
      }
    }
  }
}

async function createStarterChart(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const targetBaseDir = await resolveStarterChartBaseDir(uri);
  if (!targetBaseDir) {
    return;
  }

  const defaultChartName = sanitizeChartName(path.basename(targetBaseDir));
  const chartName = await vscode.window.showInputBox({
    prompt: "Helm chart name",
    value: defaultChartName,
    validateInput: (v) => (sanitizeChartName(v).length > 0 ? null : "Enter non-empty chart name"),
  });
  if (!chartName) {
    return;
  }

  const chartVersion = await vscode.window.showInputBox({
    prompt: "Chart version",
    value: "0.1.0",
    validateInput: (v) => (isValidChartVersion(v) ? null : "Use semver-like version, e.g. 0.1.0"),
  });
  if (!chartVersion) {
    return;
  }

  const chartRelDir = await vscode.window.showInputBox({
    prompt: "Chart directory (relative to selected folder)",
    value: ".helm",
    validateInput: (v) => (v.trim().length > 0 ? null : "Directory cannot be empty"),
  });
  if (!chartRelDir) {
    return;
  }

  const chartDir = path.resolve(targetBaseDir, chartRelDir.trim());
  const happPath = await resolveReadyHappPathForLocalLibrary(context);
  if (!happPath) {
    return;
  }
  let libraryVersion: string;
  try {
    libraryVersion = await readEmbeddedHelmAppsVersionFromHapp(happPath);
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to read embedded helm-apps version from happ: ${extractErrorMessage(err)}`);
    return;
  }
  const files = buildStarterChartFiles({
    chartName,
    chartVersion,
    libraryVersion,
  });

  const existing = await findExistingScaffoldFiles(chartDir, Object.keys(files));
  if (existing.length > 0) {
    const overwrite = await vscode.window.showWarningMessage(
      `Some files already exist in '${chartRelDir}': ${existing.join(", ")}`,
      "Overwrite",
      "Cancel",
    );
    if (overwrite !== "Overwrite") {
      return;
    }
  }

  await mkdir(path.join(chartDir, "templates"), { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(chartDir, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  const embeddedResult = await extractEmbeddedHelmAppsLibraryFromHapp(
    happPath,
    path.join(chartDir, "charts", HELM_APPS_DEP_NAME),
  );

  const chartYamlPath = path.join(chartDir, "Chart.yaml");
  const doc = await vscode.workspace.openTextDocument(chartYamlPath);
  await vscode.window.showTextDocument(doc, { preview: false });
  if (embeddedResult === "ok") {
    void vscode.window.showInformationMessage(
      `Starter chart created in '${chartDir}', embedded helm-apps library extracted via happ into charts/helm-apps.`,
    );
  } else {
    void vscode.window.showWarningMessage(
      `Starter chart created in '${chartDir}', but happ could not extract the embedded helm-apps library into charts/helm-apps.`,
    );
  }
}

type LibrarySourceMode = "local" | "github";

interface ResolvedLibraryChart {
  chartPath: string;
  version: string;
  source: LibrarySourceMode;
}

function isRuLocale(): boolean {
  return vscode.env.language.toLowerCase().startsWith("ru");
}

function t(en: string, ru: string): string {
  return isRuLocale() ? ru : en;
}

function getExtensionConfig() {
  return vscode.workspace.getConfiguration("helm-apps");
}

function readPreviewManifestBackend(cfg = getExtensionConfig()): ManifestPreviewBackend {
  const value = cfg.get<string>("previewManifestBackend", "fast").trim();
  if (MANIFEST_PREVIEW_BACKENDS.includes(value as ManifestPreviewBackend)) {
    return value as ManifestPreviewBackend;
  }
  return "fast";
}

function getLibraryRepositoryURL(cfg = getExtensionConfig()): string {
  const preferred = cfg.get<string>("libraryRepositoryUrl", "").trim();
  if (preferred.length > 0) {
    return preferred;
  }
  return cfg.get<string>("libraryGithubRepo", "https://github.com/alvnukov/helm-apps.git").trim();
}

async function manageLibrarySource(context: vscode.ExtensionContext): Promise<void> {
  const ru = isRuLocale();
  const cfg = getExtensionConfig();
  const source = cfg.get<LibrarySourceMode>("librarySource", "local");
  const localPath = cfg.get<string>("libraryLocalChartPath", "");
  const githubRepo = getLibraryRepositoryURL(cfg);
  const cachedVersion = cfg.get<string>("libraryGithubCachedVersion", "");

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: ru ? "Режим: local" : "Mode: local",
        description: source === "local" ? (ru ? "Текущий" : "Current") : undefined,
        action: "switch-local" as const,
      },
      {
        label: ru ? "Режим: github" : "Mode: github",
        description: source === "github" ? (ru ? "Текущий" : "Current") : undefined,
        action: "switch-github" as const,
      },
      {
        label: ru ? "Указать локальный путь к чарту" : "Set local chart path",
        description:
          localPath || (ru ? "Не задан (будет использован встроенный чарт из happ)" : "Not set (embedded chart from happ will be used)"),
        action: "set-local-path" as const,
      },
      {
        label: ru ? "Указать репозиторий библиотеки" : "Set library repository",
        description: githubRepo,
        action: "set-github-repo" as const,
      },
      {
        label: ru ? "Проверить новую версию в репозитории" : "Check latest repository version",
        description: cachedVersion ? `${ru ? "Кэш" : "Cached"}: ${cachedVersion}` : undefined,
        action: "check-update" as const,
      },
      {
        label: ru ? "Скачать библиотеку из репозитория в кэш расширения" : "Download library from repository into extension cache",
        description: cachedVersion ? `${ru ? "Текущий кэш" : "Current cache"}: ${cachedVersion}` : undefined,
        action: "cache-github" as const,
      },
    ],
    {
      placeHolder: ru ? "Управление источником библиотеки helm-apps" : "Manage helm-apps library source",
    },
  );

  if (!picked) {
    return;
  }
  switch (picked.action) {
    case "switch-local":
      await cfg.update("librarySource", "local", vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(ru ? "Источник библиотеки: local" : "Library source: local");
      break;
    case "switch-github":
      await cfg.update("librarySource", "github", vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(ru ? "Источник библиотеки: github" : "Library source: github");
      break;
    case "set-local-path": {
      const pickedPath = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: ru ? "Выбрать каталог чарта" : "Select chart directory",
      });
      if (!pickedPath || pickedPath.length === 0) {
        return;
      }
      const candidate = pickedPath[0].fsPath;
      const chartYaml = path.join(candidate, "Chart.yaml");
      try {
        await access(chartYaml);
      } catch {
        void vscode.window.showErrorMessage(ru ? "В выбранном каталоге нет Chart.yaml" : "Selected directory does not contain Chart.yaml");
        return;
      }
      await cfg.update("libraryLocalChartPath", candidate, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`${ru ? "Локальный путь сохранен" : "Local chart path saved"}: ${candidate}`);
      break;
    }
    case "set-github-repo": {
      const next = await vscode.window.showInputBox({
        prompt: ru ? "URL репозитория (Helm repo или GitHub repo)" : "Repository URL (Helm repo or GitHub repo)",
        value: githubRepo,
      });
      if (!next || next.trim().length === 0) {
        return;
      }
      await cfg.update("libraryRepositoryUrl", next.trim(), vscode.ConfigurationTarget.Global);
      await cfg.update("libraryGithubRepo", next.trim(), vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(ru ? "URL репозитория сохранен" : "Repository URL saved");
      break;
    }
    case "check-update":
      await checkLibraryUpdate(context);
      break;
    case "cache-github":
      await cacheLibraryFromGithub(context, true);
      break;
    default:
      break;
  }
}

async function checkLibraryUpdate(context: vscode.ExtensionContext): Promise<void> {
  const ru = isRuLocale();
  try {
    const latest = await fetchLatestGithubVersion();
    const cfg = getExtensionConfig();
    const source = cfg.get<LibrarySourceMode>("librarySource", "local");
    const current = await resolveCurrentLibraryVersionForComparison(context, source);
    if (!current) {
      void vscode.window.showInformationMessage(`${ru ? "Последняя версия в репозитории" : "Latest repository version"}: ${latest}`);
      return;
    }
    if (compareSemver(current, latest) >= 0) {
      void vscode.window.showInformationMessage(ru ? `Обновлений нет: ${current}` : `Up to date: ${current}`);
      return;
    }
    void vscode.window.showInformationMessage(
      ru ? `Доступна новая версия: ${latest} (текущая ${current})` : `New version available: ${latest} (current ${current})`,
      ru ? "Скачать" : "Download",
    ).then(async (choice) => {
      if (choice === (ru ? "Скачать" : "Download")) {
        await cacheLibraryFromGithub(context, true);
      }
    });
  } catch (err) {
    void vscode.window.showErrorMessage(`${ru ? "Не удалось проверить обновления в репозитории" : "Failed to check repository updates"}: ${extractErrorMessage(err)}`);
  }
}

async function resolveCurrentLibraryVersionForComparison(
  context: vscode.ExtensionContext,
  source: LibrarySourceMode,
): Promise<string | undefined> {
  const cfg = getExtensionConfig();
  if (source === "github") {
    const cached = cfg.get<string>("libraryGithubCachedVersion", "").trim();
    if (cached) {
      return cached;
    }
  }

  if (source === "local") {
    const localPath = cfg.get<string>("libraryLocalChartPath", "").trim();
    if (localPath) {
      return await detectChartVersionFromDir(localPath);
    }
  }
  const happPath = await resolveReadyHappPathForLocalLibrary(context);
  if (!happPath) {
    return undefined;
  }
  try {
    return await readEmbeddedHelmAppsVersionFromHapp(happPath);
  } catch {
    return undefined;
  }
}

async function cacheLibraryFromGithub(context: vscode.ExtensionContext, setAsCurrentSource: boolean): Promise<ResolvedLibraryChart> {
  const ru = isRuLocale();
  const cfg = getExtensionConfig();
  const repoUrl = getLibraryRepositoryURL(cfg);
  const helmRepoUrl = resolveHelmRepositoryURL(repoUrl);
  const latest = await fetchLatestGithubVersion(repoUrl);
  const globalStoragePath = context.globalStorageUri.fsPath;
  await mkdir(globalStoragePath, { recursive: true });

  const cacheBase = path.join(globalStoragePath, "library-cache");
  const cacheDir = path.join(cacheBase, `helm-apps-${latest}`);
  const chartDir = path.join(cacheDir, HELM_APPS_DEP_NAME);
  const chartYaml = path.join(chartDir, "Chart.yaml");
  try {
    await access(chartYaml);
  } catch {
    await mkdir(cacheBase, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await runHelmOrWerf([
      "pull",
      HELM_APPS_DEP_NAME,
      "--repo",
      helmRepoUrl,
      "--version",
      latest,
      "--untar",
      "--untardir",
      cacheDir,
    ], {
      timeout: 240000,
      maxBuffer: 16 * 1024 * 1024,
    });
    await access(chartYaml);
  }

  await cfg.update("libraryGithubCachedChartPath", chartDir, vscode.ConfigurationTarget.Global);
  await cfg.update("libraryGithubCachedVersion", latest, vscode.ConfigurationTarget.Global);
  if (setAsCurrentSource) {
    await cfg.update("librarySource", "github", vscode.ConfigurationTarget.Global);
  }
  void vscode.window.showInformationMessage(
    ru
      ? `Библиотека ${latest} сохранена в кэш расширения`
      : `Library ${latest} saved in extension cache`,
  );
  return { chartPath: chartDir, version: latest, source: "github" };
}

async function updateLibraryDependencyInChart(context: vscode.ExtensionContext): Promise<void> {
  const ru = isRuLocale();
  const chartYamlUri = await pickTargetChartYaml();
  if (!chartYamlUri) {
    void vscode.window.showWarningMessage(ru ? "Не найден Chart.yaml для обновления" : "No Chart.yaml found to update");
    return;
  }

  try {
    const resolved = await resolveLibraryChartForDependency(context);
    await upsertHelmAppsDependency(chartYamlUri.fsPath, resolved.version, resolved.chartPath);
    void vscode.window.showInformationMessage(
      ru
        ? `Зависимость helm-apps обновлена в ${chartYamlUri.fsPath}`
        : `helm-apps dependency updated in ${chartYamlUri.fsPath}`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`${ru ? "Не удалось обновить зависимость" : "Failed to update dependency"}: ${extractErrorMessage(err)}`);
  }
}

async function updateChartLockfile(): Promise<void> {
  const ru = isRuLocale();
  const chartYamlUri = await pickTargetChartYaml();
  if (!chartYamlUri) {
    void vscode.window.showWarningMessage(ru ? "Не найден Chart.yaml для lockfile" : "No Chart.yaml found for lockfile update");
    return;
  }

  const chartDir = path.dirname(chartYamlUri.fsPath);
  try {
    const { stdout, stderr } = await runHelmOrWerf(["dependency", "update", chartDir], {
      timeout: 240000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const tail = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    if (tail.length > 0) {
      void vscode.window.showInformationMessage(ru ? "Chart.lock обновлен" : "Chart.lock updated");
    } else {
      void vscode.window.showInformationMessage(ru ? "Chart.lock обновлен" : "Chart.lock updated");
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`${ru ? "Не удалось обновить lockfile" : "Failed to update lockfile"}: ${extractErrorMessage(err)}`);
  }
}

async function resolveLibraryChartForDependency(context: vscode.ExtensionContext): Promise<ResolvedLibraryChart> {
  const cfg = getExtensionConfig();
  const source = cfg.get<LibrarySourceMode>("librarySource", "local");
  if (source === "github") {
    const cachedPath = cfg.get<string>("libraryGithubCachedChartPath", "").trim();
    const cachedVersion = cfg.get<string>("libraryGithubCachedVersion", "").trim();
    if (cachedPath && cachedVersion) {
      try {
        await access(path.join(cachedPath, "Chart.yaml"));
        return { chartPath: cachedPath, version: cachedVersion, source: "github" };
      } catch {
        // fallthrough to refresh cache
      }
    }
    return await cacheLibraryFromGithub(context, false);
  }

  const configuredLocal = cfg.get<string>("libraryLocalChartPath", "").trim();
  if (configuredLocal.length > 0) {
    const version = await detectChartVersionFromDir(configuredLocal);
    if (!version) {
      throw new Error(`unable to read library version from '${configuredLocal}/Chart.yaml'`);
    }
    return { chartPath: configuredLocal, version, source: "local" };
  }
  return await resolveEmbeddedLibraryChartFromHapp(context);
}

async function upsertHelmAppsDependency(chartYamlPath: string, version: string, chartPath: string): Promise<void> {
  const raw = await readFile(chartYamlPath, "utf8");
  const doc = YAML.parse(raw) as unknown;
  const chartObj = isMap(doc) ? { ...doc } : {};
  const dependencies = Array.isArray((chartObj as Record<string, unknown>).dependencies)
    ? [...((chartObj as Record<string, unknown>).dependencies as unknown[])]
    : [];
  const normalizedRepo = `file://${normalizePathForChartRepository(chartPath)}`;
  let found = false;
  const nextDeps = dependencies.map((dep) => {
    if (!isMap(dep)) {
      return dep;
    }
    if (dep.name !== HELM_APPS_DEP_NAME) {
      return dep;
    }
    found = true;
    return {
      ...dep,
      version,
      repository: normalizedRepo,
    };
  });
  if (!found) {
    nextDeps.push({
      name: HELM_APPS_DEP_NAME,
      version,
      repository: normalizedRepo,
    });
  }
  (chartObj as Record<string, unknown>).dependencies = nextDeps;
  const output = YAML.stringify(chartObj, { lineWidth: 0 }).replace(/\n+$/g, "\n");
  await writeFile(chartYamlPath, output, "utf8");
}

function normalizePathForChartRepository(p: string): string {
  const abs = path.resolve(p);
  if (process.platform === "win32") {
    return `/${abs.replace(/\\/g, "/")}`;
  }
  return abs;
}

async function pickTargetChartYaml(): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") {
    const nearest = await findNearestChartYaml(active.fsPath);
    if (nearest) {
      return nearest;
    }
  }

  const charts = await vscode.workspace.findFiles("**/Chart.yaml", "**/{.git,node_modules,vendor,tmp,.werf}/**", 100);
  if (charts.length === 0) {
    return undefined;
  }
  if (charts.length === 1) {
    return charts[0];
  }
  const picked = await vscode.window.showQuickPick(
    charts.map((uri) => ({
      label: vscode.workspace.asRelativePath(uri),
      description: uri.fsPath,
      uri,
    })),
    { placeHolder: isRuLocale() ? "Выберите Chart.yaml" : "Select Chart.yaml" },
  );
  return picked?.uri;
}

async function detectChartVersionFromDir(chartDir: string): Promise<string | undefined> {
  const chartYamlPath = path.join(chartDir, "Chart.yaml");
  try {
    const text = await readFile(chartYamlPath, "utf8");
    const parsed = YAML.parse(text) as unknown;
    if (isMap(parsed) && typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function fetchLatestGithubVersion(repoUrl?: string): Promise<string> {
  const configured = repoUrl ?? getLibraryRepositoryURL(getExtensionConfig());
  const helmRepoUrl = resolveHelmRepositoryURL(configured);
  const { stdout } = await runHelmOrWerf(["show", "chart", HELM_APPS_DEP_NAME, "--repo", helmRepoUrl], {
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = YAML.parse(stdout) as unknown;
  if (!isMap(parsed) || typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
    throw new Error(`failed to resolve latest helm-apps version from repository: ${helmRepoUrl}`);
  }
  return parsed.version.trim().replace(/^v/, "");
}

async function runHelmOrWerf(
  helmArgs: string[],
  options: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const configured = getExtensionConfig().get<string>("helmPath", "helm");
  const candidates = buildHelmCommandCandidates(configured, helmArgs);

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return await execFileAsync(candidate.cmd, candidate.args, options);
    } catch (err) {
      errors.push(`${candidate.cmd}: ${extractErrorMessage(err)}`);
    }
  }

  throw new Error(`unable to execute Helm command (tried helm and werf helm): ${errors.join(" | ")}`);
}

async function findExistingScaffoldFiles(chartDir: string, relPaths: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const rel of relPaths) {
    const abs = path.join(chartDir, rel);
    try {
       
      await access(abs);
      existing.push(rel);
    } catch {
      // ignore missing file
    }
  }
  return existing;
}

async function resolveStarterChartBaseDir(uri?: vscode.Uri): Promise<string | undefined> {
  if (uri && uri.scheme === "file") {
    return uri.fsPath;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Select target folder for starter chart",
  });
  if (!picked || picked.length === 0) {
    return undefined;
  }
  return picked[0].fsPath;
}

async function resolveReadyHappPathForLocalLibrary(context: vscode.ExtensionContext): Promise<string | undefined> {
  const configuredHappPath = await resolveOperationalHappPath(context);
  if (!(await ensureHappReady(configuredHappPath))) {
    return undefined;
  }
  return configuredHappPath;
}

async function resolveOperationalHappPath(context: vscode.ExtensionContext): Promise<string> {
  const configuredPath = getExtensionConfig().get<string>("happPath", "happ").trim() || "happ";
  const devOverride = await resolveDevHappPathOverride(context);
  return devOverride ?? configuredPath;
}

async function readEmbeddedHelmAppsVersionFromHapp(happPath: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(happPath, ["library", "version"], {
    timeout: 30000,
    maxBuffer: 256 * 1024,
  });
  const version = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
  if (version.length === 0) {
    throw new Error("happ returned empty embedded helm-apps version");
  }
  return version.split(/\r?\n/)[0].trim();
}

async function extractEmbeddedHelmAppsLibraryFromHapp(happPath: string, chartDir: string): Promise<"ok" | "failed"> {
  try {
    await rm(chartDir, { recursive: true, force: true });
    await execFileAsync(happPath, ["library", "extract", "--out-dir", chartDir], {
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
    });
    await access(path.join(chartDir, "Chart.yaml"));
    return "ok";
  } catch {
    return "failed";
  }
}

async function resolveEmbeddedLibraryChartFromHapp(context: vscode.ExtensionContext): Promise<ResolvedLibraryChart> {
  const happPath = await resolveReadyHappPathForLocalLibrary(context);
  if (!happPath) {
    throw new Error("happ is unavailable, unable to extract embedded helm-apps chart");
  }
  const version = await readEmbeddedHelmAppsVersionFromHapp(happPath);
  const cacheBase = path.join(context.globalStorageUri.fsPath, "library-cache", "embedded");
  const chartDir = path.join(cacheBase, `${HELM_APPS_DEP_NAME}-${version}`);
  const chartYamlPath = path.join(chartDir, "Chart.yaml");
  try {
    await access(chartYamlPath);
  } catch {
    await mkdir(cacheBase, { recursive: true });
    const extracted = await extractEmbeddedHelmAppsLibraryFromHapp(happPath, chartDir);
    if (extracted !== "ok") {
      throw new Error(`failed to extract embedded helm-apps ${version} from happ`);
    }
  }
  return { chartPath: chartDir, version, source: "local" };
}

async function ensureHappReady(happPath: string): Promise<boolean> {
  const ru = isRuLocale();
  try {
    const { stdout, stderr } = await execFileAsync(happPath, ["--version"], {
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    if (!/\bhapp\b/i.test(output)) {
      void vscode.window.showWarningMessage(
        ru
          ? "Настроенный бинарник happ ответил неожиданно. Проверьте helm-apps.happPath."
          : "Configured happ binary responded unexpectedly. Check helm-apps.happPath.",
      );
    }
    return true;
  } catch (err) {
    const message = extractErrorMessage(err);
    if (message.includes("ENOENT")) {
      const choice = await vscode.window.showErrorMessage(
        ru
          ? "Бинарник happ не найден. Установите happ или задайте helm-apps.happPath."
          : "happ binary not found. Install happ or set helm-apps.happPath.",
        ru ? "Указать путь к happ" : "Set happ path",
        ru ? "Установить через Homebrew" : "Install with Homebrew",
        ru ? "Открыть Releases" : "Open Releases",
      );
      if (choice === (ru ? "Указать путь к happ" : "Set happ path")) {
        const next = await vscode.window.showInputBox({
          prompt: ru ? "Путь к бинарнику happ" : "Path to happ binary",
          placeHolder: ru ? "happ или /usr/local/bin/happ" : "happ or /usr/local/bin/happ",
        });
        if (next && next.trim().length > 0) {
          await vscode.workspace.getConfiguration("helm-apps").update("happPath", next.trim(), vscode.ConfigurationTarget.Workspace);
          void vscode.window.showInformationMessage(
            ru ? `helm-apps.happPath установлен: '${next.trim()}'` : `helm-apps.happPath set to '${next.trim()}'`,
          );
        }
      } else if (choice === (ru ? "Установить через Homebrew" : "Install with Homebrew")) {
        void vscode.env.openExternal(vscode.Uri.parse("https://github.com/alvnukov/helm-apps#%D1%83%D1%81%D1%82%D0%B0%D0%BD%D0%BE%D0%B2%D0%BA%D0%B0-happ-cli"));
      } else if (choice === (ru ? "Открыть Releases" : "Open Releases")) {
        void vscode.env.openExternal(vscode.Uri.parse("https://github.com/alvnukov/helm-apps/releases"));
      }
      return false;
    }
    void vscode.window.showErrorMessage(ru ? `Проверка happ завершилась ошибкой: ${message}` : `happ check failed: ${message}`);
    return false;
  }
}

function workspaceRoot(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder?.uri.fsPath;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function rewriteEditorText(
  editor: vscode.TextEditor,
  action: (text: string) => { updatedText: string; details: string },
): Promise<void> {
  const text = editor.document.getText();
  try {
    const result = action(text);
    const fullRange = new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(text.length),
    );
    await editor.edit((builder) => {
      builder.replace(fullRange, result.updatedText);
    });
    void vscode.window.showInformationMessage(`helm-apps: ${result.details}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`helm-apps refactor failed: ${extractErrorMessage(err)}`);
  }
}

function showEntityPreview(
  document: vscode.TextDocument,
  group: string,
  app: string,
  options: PreviewOptions,
): void {
  const title = `helm-apps preview: ${group}.${app}`;
  entityPreviewState = {
    documentUri: document.uri,
    group,
    app,
    options: {
      env: options.env,
      applyIncludes: options.applyIncludes,
      applyEnvResolution: options.applyEnvResolution,
      showDiff: options.showDiff,
      renderMode: options.renderMode,
      manifestBackend: options.manifestBackend,
    },
  };

  if (!previewPanel) {
    previewPanel = vscode.window.createWebviewPanel(
      "helmAppsResolvedEntityPreview",
      title,
      vscode.ViewColumn.Beside,
      { enableFindWidget: true, enableScripts: true },
    );
    previewPanel.onDidDispose(() => {
      if (previewRenderTimer) {
        clearTimeout(previewRenderTimer);
        previewRenderTimer = undefined;
      }
      previewMessageSubscription?.dispose();
      previewMessageSubscription = undefined;
      entityPreviewState = undefined;
      lastPreviewMenuModel = undefined;
      previewPanel = undefined;
    });
  } else {
    previewPanel.title = title;
    previewPanel.reveal(vscode.ViewColumn.Beside, true);
  }

  previewMessageSubscription?.dispose();
  previewMessageSubscription = previewPanel.webview.onDidReceiveMessage((msg: unknown) => {
    if (!isWebviewMessage(msg)) {
      return;
    }
    if (msg.type === "optionsChanged" && entityPreviewState) {
      if (typeof msg.group === "string" && msg.group.trim().length > 0) {
        entityPreviewState.group = msg.group;
      }
      if (typeof msg.app === "string" && msg.app.trim().length > 0) {
        entityPreviewState.app = msg.app;
      }
      entityPreviewState.options = {
        env: msg.env,
        applyIncludes: msg.applyIncludes,
        applyEnvResolution: msg.applyEnvResolution,
        showDiff: false,
        renderMode: msg.renderMode,
        manifestBackend: msg.manifestBackend,
      };
      scheduleEntityPreviewRefresh(0);
    }
  });

  scheduleEntityPreviewRefresh(0);
}

function scheduleEntityPreviewRefreshFor(document: vscode.TextDocument, delayMs = 120): void {
  if (!previewPanel || !entityPreviewState) {
    return;
  }
  if (entityPreviewState.documentUri.toString() !== document.uri.toString()) {
    return;
  }
  scheduleEntityPreviewRefresh(delayMs);
}

function scheduleEntityPreviewRefresh(delayMs = 120): void {
  if (!previewPanel || !entityPreviewState) {
    return;
  }
  if (previewRenderTimer) {
    clearTimeout(previewRenderTimer);
  }
  previewRenderTimer = setTimeout(() => {
    previewRenderTimer = undefined;
    void renderEntityPreview();
  }, Math.max(0, delayMs));
}

async function renderEntityPreview(): Promise<void> {
  const panel = previewPanel;
  const state = entityPreviewState;
  if (!panel || !state) {
    return;
  }

  const renderId = ++previewRenderVersion;
  try {
    const document = await vscode.workspace.openTextDocument(state.documentUri);
    const documentText = document.getText();
    const loaded = await loadExpandedValuesForPreview(document);
    const values = loaded.values;
    const previewContext = await resolvePreviewMenuAndEnv(
      document,
      documentText,
      values,
      state.group,
      state.app,
      state.options.env,
    );
    const menuModel = previewContext.menuModel;
    if (menuModel.groups.length === 0) {
      throw new Error("No entities found in values");
    }
    state.group = menuModel.selectedGroup;
    state.app = menuModel.selectedApp;
    lastPreviewMenuModel = menuModel;
    if (state.options.env.trim().length === 0 && previewContext.defaultEnv.trim().length > 0) {
      state.options.env = previewContext.defaultEnv.trim();
    }
    const title = `helm-apps preview: ${state.group}.${state.app}`;
    const envDiscovery = previewContext.envDiscovery;
    const previewTheme = await getPreviewThemeForRender();
    const payload = await buildEntityPreviewPayload(
      document,
      documentText,
      values,
      state.group,
      state.app,
      state.options,
    );
    let renderText = payload.yamlText;

    if (state.options.renderMode === "manifest") {
      const cacheKey = buildManifestPreviewCacheKey(document, state);
      const cached = manifestPreviewCache.get(cacheKey);
      if (cached) {
        renderText = cached;
      } else {
        renderText = await renderManifest(
          document,
          documentText,
          state,
        );
        cacheManifestPreview(cacheKey, renderText);
      }
    }

    if (!previewPanel || previewPanel !== panel || !entityPreviewState || entityPreviewState !== state || renderId !== previewRenderVersion) {
      return;
    }
    panel.title = title;
    panel.webview.html = renderPreviewHtml(
      title,
      renderText,
      payload.diffSummary,
      envDiscovery,
      state.options,
      loaded.missingFiles.map((m) => m.rawPath),
      menuModel,
      previewTheme,
    );

    if (state.options.renderMode === "values" && state.options.manifestBackend === "fast") {
      void prewarmManifestPreview(document, documentText, state);
    }
  } catch (err) {
    if (!previewPanel || previewPanel !== panel || !entityPreviewState || entityPreviewState !== state || renderId !== previewRenderVersion) {
      return;
    }
    let fallbackMenuModel = lastPreviewMenuModel;
    if (!fallbackMenuModel || fallbackMenuModel.groups.length === 0) {
      try {
        const document = await vscode.workspace.openTextDocument(state.documentUri);
        const documentText = document.getText();
        const loaded = await loadExpandedValuesForPreview(document);
        const values = loaded.values;
        const previewContext = await resolvePreviewMenuAndEnv(
          document,
          documentText,
          values,
          state.group,
          state.app,
          state.options.env,
        );
        fallbackMenuModel = previewContext.menuModel;
      } catch {
        // keep empty fallback when menu model cannot be rebuilt
      }
    }
    if (fallbackMenuModel && fallbackMenuModel.groups.length > 0) {
      state.group = fallbackMenuModel.selectedGroup;
      state.app = fallbackMenuModel.selectedApp;
      lastPreviewMenuModel = fallbackMenuModel;
    }
    const message = extractErrorMessage(err);
    const renderText = state.options.renderMode === "manifest"
      ? formatManifestPreviewError(err, {
        fileUri: state.documentUri.toString(),
        group: state.group,
        app: state.app,
        env: state.options.env,
        renderer: state.options.manifestBackend,
      })
      : `# preview unavailable\n# ${message}`;
    const title = `helm-apps preview: ${state.group}.${state.app}`;
    panel.title = title;
    panel.webview.html = renderPreviewHtml(
      title,
      renderText,
      [],
      { literals: [state.options.env], regexes: [] },
      state.options,
      [],
      fallbackMenuModel && fallbackMenuModel.groups.length > 0
        ? fallbackMenuModel
        : {
          groups: [],
          selectedGroup: state.group,
          selectedApp: state.app,
        },
      DEFAULT_PREVIEW_THEME,
    );
  }
}

async function prewarmManifestPreview(
  document: vscode.TextDocument,
  documentText: string,
  state: EntityPreviewState,
): Promise<void> {
  if (!happLspClient.isRunning()) {
    return;
  }
  const cacheKey = buildManifestPreviewCacheKey(document, state);
  if (manifestPreviewCache.has(cacheKey) || manifestPreviewInFlight.has(cacheKey)) {
    return;
  }

  manifestPreviewInFlight.add(cacheKey);
  const snapshot: EntityPreviewState = {
    documentUri: state.documentUri,
    group: state.group,
    app: state.app,
      options: {
        ...state.options,
        renderMode: "manifest",
      },
    };
  try {
    const manifest = await renderManifest(document, documentText, snapshot);
    cacheManifestPreview(cacheKey, manifest);
  } catch {
    // ignore prewarm errors; primary render path will show explicit errors on demand
  } finally {
    manifestPreviewInFlight.delete(cacheKey);
  }
}

async function buildEntityPreviewPayload(
  document: vscode.TextDocument,
  documentText: string,
  values: unknown,
  group: string,
  app: string,
  options: PreviewOptions,
): Promise<{ yamlText: string; diffSummary: string[] }> {
  const rawEntity = readRawEntity(values, group, app);
  const entity = await resolvePreviewEntity(document, documentText, values, group, app, options);
  const previewGlobal = buildPreviewGlobalProjection(values, entity, options.env);
  const diffSummary = options.showDiff ? diffObjects(rawEntity, entity) : [];
  const yamlText = YAML.stringify({
    global: previewGlobal,
    [group]: { [app]: entity },
  });
  return { yamlText, diffSummary };
}

async function renderManifestFromHappLsp(
  document: vscode.TextDocument,
  documentText: string,
  state: EntityPreviewState,
): Promise<string> {
  const result = await happLspClient.renderEntityManifest({
    uri: document.uri.toString(),
    text: documentText,
    group: state.group,
    app: state.app,
    env: state.options.env,
    renderer: state.options.manifestBackend,
    applyIncludes: state.options.applyIncludes,
    applyEnvResolution: state.options.applyEnvResolution,
  });
  const text = result.manifest.trim();
  if (text.length === 0) {
    throw new Error("happ LSP returned empty manifest output");
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function renderManifest(
  document: vscode.TextDocument,
  documentText: string,
  state: EntityPreviewState,
): Promise<string> {
  return await renderManifestFromHappLsp(document, documentText, state);
}

async function renderManifestFromHelmOrWerf(
  document: vscode.TextDocument,
  documentText: string,
  state: EntityPreviewState,
  backend: "helm" | "werf",
  resolvedEnabledEntities?: ReadonlyArray<{ group: string; app: string }>,
): Promise<string> {
  const chartYaml = await findNearestChartYaml(document.uri.fsPath);
  if (!chartYaml) {
    throw new Error(`Chart.yaml not found for values file: ${document.uri.fsPath}`);
  }

  const chartDir = path.dirname(chartYaml.fsPath);
  const manifestWorkDir = backend === "werf"
    ? await resolveWerfProjectDir(chartDir)
    : chartDir;

  try {
    const valuesFiles = await resolveManifestValuesFiles(document, chartDir);
    const isolationSetValues = resolvedEnabledEntities && resolvedEnabledEntities.length > 0
      ? buildManifestEntityIsolationSetValuesFromEnabledEntities(
        resolvedEnabledEntities,
        state.group,
        state.app,
      )
      : buildManifestEntityIsolationSetValues(
        documentText,
        state.group,
        state.app,
      );
    if (!isolationSetValues) {
      throw new Error(`unable to isolate entity ${state.group}.${state.app} for manifest render`);
    }
    const configuredHelmPath = getExtensionConfig().get<string>("helmPath", "helm");
    const command = resolveManifestBackendCommandForConfig(backend, configuredHelmPath);
    const args = buildManifestBackendArgsForCommand(
      backend,
      backend === "werf" ? manifestWorkDir : chartDir,
      valuesFiles,
      isolationSetValues,
      state.options.env,
    );
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: manifestWorkDir,
      timeout: 240000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const text = String(stdout ?? "").trim();
    if (text.length === 0) {
      const details = String(stderr ?? "").trim();
      throw new Error(details.length > 0 ? details : `${backend} render returned empty output`);
    }
    return text.endsWith("\n") ? text : `${text}\n`;
  } catch (err) {
    const prefix = backend === "helm" ? "helm template failed" : "werf render failed";
    throw new Error(`${prefix}: ${extractErrorMessage(err)}`);
  }
}

async function resolveWerfProjectDir(chartDir: string): Promise<string> {
  let current = chartDir;
  while (true) {
    const configPath = path.join(current, "werf.yaml");
    try {
      await access(configPath, fsConstants.R_OK);
      return current;
    } catch {
      // continue walking up
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return chartDir;
    }
    current = parent;
  }
}

async function resolveManifestValuesFiles(
  document: vscode.TextDocument,
  chartDir: string,
): Promise<string[]> {
  const currentPath = path.resolve(document.uri.fsPath);
  const rootDocs = await findHelmAppsRootDocuments(chartDir);
  const primaryValues = await findPrimaryValuesFileForChart(chartDir);
  const includeOwners = await collectIncludeOwnersForChart(chartDir);
  return selectManifestValuesFiles({
    currentPath,
    rootDocuments: rootDocs,
    primaryValues,
    includeOwners: [...(includeOwners.get(currentPath) ?? [])],
  });
}

async function findPrimaryValuesFileForChart(chartDir: string): Promise<string | undefined> {
  const candidates = [path.join(chartDir, "values.yaml"), path.join(chartDir, "values.yml")];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK);
      return path.resolve(candidate);
    } catch {
      // continue
    }
  }
  return undefined;
}

async function findWerfSecretValuesFileForChart(chartDir: string): Promise<string | undefined> {
  const candidates = [path.join(chartDir, "secret-values.yaml"), path.join(chartDir, "secret-values.yml")];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK);
      if (isWerfSecretValuesFilePath(candidate)) {
        return path.resolve(candidate);
      }
    } catch {
      // continue
    }
  }
  return undefined;
}

function buildManifestPreviewCacheKey(
  document: vscode.TextDocument,
  state: EntityPreviewState,
): string {
  return [
    document.uri.toString(),
    String(document.version),
    state.group,
    state.app,
    state.options.env,
    state.options.applyIncludes ? "1" : "0",
    state.options.applyEnvResolution ? "1" : "0",
    state.options.manifestBackend,
  ].join("|");
}

function cacheManifestPreview(key: string, value: string): void {
  if (manifestPreviewCache.has(key)) {
    manifestPreviewCache.delete(key);
  }
  manifestPreviewCache.set(key, value);
  while (manifestPreviewCache.size > MANIFEST_PREVIEW_CACHE_LIMIT) {
    const oldest = manifestPreviewCache.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    manifestPreviewCache.delete(oldest);
  }
}

async function getPreviewThemeForRender(): Promise<HappPreviewTheme> {
  if (previewThemeCache) {
    return previewThemeCache;
  }
  if (!happLspClient.isRunning() || previewThemeFetchFailed) {
    return DEFAULT_PREVIEW_THEME;
  }
  try {
    const theme = await happLspClient.getPreviewTheme();
    previewThemeCache = sanitizePreviewTheme(theme);
    return previewThemeCache;
  } catch (err) {
    previewThemeFetchFailed = true;
    happLspBootstrapOutput.appendLine(`[preview-theme] fallback to built-in theme: ${extractErrorMessage(err)}`);
    return DEFAULT_PREVIEW_THEME;
  }
}

function sanitizePreviewTheme(theme: unknown): HappPreviewTheme {
  const root = (theme && typeof theme === "object" ? theme : {}) as {
    ui?: Record<string, unknown>;
    syntax?: Record<string, unknown>;
  };
  const ui = root.ui ?? {};
  const syntax = root.syntax ?? {};
  const fallback = DEFAULT_PREVIEW_THEME;
  return {
    ui: {
      bg: sanitizeCssColor(ui.bg, fallback.ui.bg),
      surface: sanitizeCssColor(ui.surface, fallback.ui.surface),
      surface2: sanitizeCssColor(ui.surface2, fallback.ui.surface2),
      surface3: sanitizeCssColor(ui.surface3, fallback.ui.surface3),
      surface4: sanitizeCssColor(ui.surface4, fallback.ui.surface4),
      text: sanitizeCssColor(ui.text, fallback.ui.text),
      muted: sanitizeCssColor(ui.muted, fallback.ui.muted),
      accent: sanitizeCssColor(ui.accent, fallback.ui.accent),
      accent2: sanitizeCssColor(ui.accent2, fallback.ui.accent2),
      border: sanitizeCssColor(ui.border, fallback.ui.border),
      danger: sanitizeCssColor(ui.danger, fallback.ui.danger),
      ok: sanitizeCssColor(ui.ok, fallback.ui.ok),
      title: sanitizeCssColor(ui.title, fallback.ui.title),
      controlHoverBorder: sanitizeCssColor(ui.controlHoverBorder, fallback.ui.controlHoverBorder),
      controlFocusBorder: sanitizeCssColor(ui.controlFocusBorder, fallback.ui.controlFocusBorder),
      controlFocusRing: sanitizeCssColor(ui.controlFocusRing, fallback.ui.controlFocusRing),
      quickEnvBg: sanitizeCssColor(ui.quickEnvBg, fallback.ui.quickEnvBg),
      quickEnvBorder: sanitizeCssColor(ui.quickEnvBorder, fallback.ui.quickEnvBorder),
      quickEnvText: sanitizeCssColor(ui.quickEnvText, fallback.ui.quickEnvText),
      quickEnvHoverBg: sanitizeCssColor(ui.quickEnvHoverBg, fallback.ui.quickEnvHoverBg),
      quickEnvHoverBorder: sanitizeCssColor(ui.quickEnvHoverBorder, fallback.ui.quickEnvHoverBorder),
    },
    syntax: {
      key: sanitizeCssColor(syntax.key, fallback.syntax.key),
      bool: sanitizeCssColor(syntax.bool, fallback.syntax.bool),
      number: sanitizeCssColor(syntax.number, fallback.syntax.number),
      comment: sanitizeCssColor(syntax.comment, fallback.syntax.comment),
      string: sanitizeCssColor(syntax.string, fallback.syntax.string),
      block: sanitizeCssColor(syntax.block, fallback.syntax.block),
    },
  };
}

function sanitizeCssColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 60) {
    return fallback;
  }
  if (/^#[0-9a-fA-F]{3,8}$/.test(raw)) {
    return raw;
  }
  if (/^rgba?\(\s*[-+0-9.%\s,]+\)$/.test(raw)) {
    return raw;
  }
  return fallback;
}

async function resolvePreviewEntity(
  document: vscode.TextDocument,
  documentText: string,
  values: unknown,
  group: string,
  app: string,
  options: PreviewOptions,
): Promise<unknown> {
  if (options.applyIncludes) {
    if (!happLspClient.isRunning()) {
      throw new Error("happ LSP is required for include resolution in preview");
    }
    try {
      const resolved = await happLspClient.resolveEntity({
        uri: document.uri.toString(),
        text: documentText,
        group,
        app,
        env: options.env,
        applyIncludes: true,
        applyEnvResolution: options.applyEnvResolution,
      });
      return forceEntityEnabled(resolved.entity);
    } catch (err) {
      throw new Error(`happ resolveEntity failed: ${extractErrorMessage(err)}`);
    }
  }

  let entity: unknown = readRawEntity(values, group, app);
  if (options.applyEnvResolution) {
    entity = resolveEnvMaps(entity, options.env);
  }
  return forceEntityEnabled(entity);
}

function readRawEntity(values: unknown, group: string, app: string): unknown {
  const parsed = values as Record<string, unknown>;
  return (((parsed[group] as Record<string, unknown> | undefined) ?? {})[app] ?? {}) as unknown;
}

async function resolvePreviewMenuAndEnv(
  document: vscode.TextDocument,
  documentText: string,
  values: unknown,
  selectedGroup: string,
  selectedApp: string,
  env: string,
): Promise<{
  menuModel: PreviewEntityMenuModel;
  envDiscovery: EnvironmentDiscovery;
  defaultEnv: string;
  enabledEntities: Array<{ group: string; app: string }>;
}> {
  let menuModel = buildPreviewEntityMenuModel(values, selectedGroup, selectedApp);
  let envDiscovery = discoverEnvironments(values);
  let defaultEnv = detectDefaultEnv(values, envDiscovery);
  let enabledEntities: Array<{ group: string; app: string }> = [];

  if (!happLspClient.isRunning()) {
    return { menuModel, envDiscovery, defaultEnv, enabledEntities };
  }

  try {
    const listed = await happLspClient.listEntities({
      uri: document.uri.toString(),
      text: documentText,
      env,
      applyIncludes: true,
      applyEnvResolution: true,
    });
    const fromHapp = buildPreviewEntityMenuModelFromGroups(
      listed.groups,
      selectedGroup,
      selectedApp,
    );
    if (fromHapp.groups.length > 0) {
      menuModel = fromHapp;
    }
    envDiscovery = {
      literals: [...listed.envDiscovery.literals],
      regexes: [...listed.envDiscovery.regexes],
    };
    enabledEntities = Array.isArray(listed.enabledEntities)
      ? listed.enabledEntities
        .filter((entity): entity is { group: string; app: string } =>
          !!entity
          && typeof entity.group === "string"
          && entity.group.trim().length > 0
          && typeof entity.app === "string"
          && entity.app.trim().length > 0)
        .map((entity) => ({ group: entity.group.trim(), app: entity.app.trim() }))
      : [];
    if (listed.defaultEnv.trim().length > 0) {
      defaultEnv = listed.defaultEnv.trim();
    }
  } catch (err) {
    happLspBootstrapOutput.appendLine(
      `[preview] listEntities fallback to local model: ${extractErrorMessage(err)}`,
    );
  }

  return { menuModel, envDiscovery, defaultEnv, enabledEntities };
}

async function loadExpandedValues(document: vscode.TextDocument): Promise<{
  values: Record<string, unknown>;
  includeDefinitions: IncludeDefinition[];
  missingFiles: Array<{ rawPath: string; tried: string[] }>;
}> {
  const currentPath = path.resolve(document.uri.fsPath);
  const currentText = document.getText();
  const currentParsed = YAML.parse(currentText) as unknown;
  if (!isMap(currentParsed)) {
    throw new Error("values file must be a YAML map");
  }
  const chartReadFile = createChartValuesReadFile(
    async (filePath) => await readFile(filePath, "utf8"),
    currentPath,
    currentText,
  );

  let root = currentParsed;
  let basePath = currentPath;
  const chart = await findNearestChartYaml(document.uri.fsPath);
  if (chart && await isHelmAppsChart(chart)) {
    const chartDir = path.dirname(chart.fsPath);
    const plan = planChartValuesLoad({
      currentPath,
      primaryValuesPath: await findPrimaryValuesFileForChart(chartDir),
      werfSecretValuesPath: await findWerfSecretValuesFileForChart(chartDir),
    });
    basePath = plan.basePath;

    const readParsedMap = async (filePath: string): Promise<Record<string, unknown>> => {
      if (path.resolve(filePath) === currentPath) {
        return currentParsed;
      }
      const raw = await chartReadFile(filePath);
      const parsed = YAML.parse(raw) as unknown;
      if (!isMap(parsed)) {
        throw new Error(`values file must be a YAML map: ${filePath}`);
      }
      return parsed;
    };

    root = await readParsedMap(basePath);
    for (const mergePath of plan.mergePaths) {
      root = mergeChartValues(root, await readParsedMap(mergePath));
    }
  }

  return await expandValuesWithFileIncludes(root, basePath, chartReadFile);
}

async function loadExpandedValuesForPreview(document: vscode.TextDocument): Promise<{
  values: Record<string, unknown>;
  includeDefinitions: IncludeDefinition[];
  missingFiles: Array<{ rawPath: string; tried: string[] }>;
}> {
  try {
    return await loadExpandedValues(document);
  } catch (err) {
    if (!happLspClient.isRunning()) {
      throw err;
    }
    happLspBootstrapOutput.appendLine(
      `[preview] local YAML parse fallback to happ model: ${extractErrorMessage(err)}`,
    );
    return {
      values: {},
      includeDefinitions: [],
      missingFiles: [],
    };
  }
}

async function provideDefinition(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Definition | undefined> {
  const includeDefinition = await provideIncludeDefinition(document, position);
  if (includeDefinition) {
    return includeDefinition;
  }
  return await provideAppDefinition(document, position);
}

async function provideAppDefinition(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Definition | undefined> {
  if (!(await isHelmAppsLanguageDocument(document))) {
    return undefined;
  }
  const symbol = findSymbolAtPosition(document.getText(), position.line, position.character);
  if (!symbol || symbol.kind !== "app") {
    return undefined;
  }

  const occurrences = collectSymbolOccurrences(document.getText(), symbol);
  const definition = occurrences.find((it) => it.role === "definition");
  if (!definition) {
    return undefined;
  }
  return new vscode.Location(
    document.uri,
    new vscode.Range(
      new vscode.Position(definition.line, definition.start),
      new vscode.Position(definition.line, definition.end),
    ),
  );
}

async function provideIncludeDefinition(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Definition | undefined> {
  if (!(await isHelmAppsLanguageDocument(document))) {
    return undefined;
  }
  const includeName = getIncludeNameUnderCursor(document, position);
  if (!includeName) {
    return undefined;
  }

  // Always try local definitions first; this path should work even when YAML has parse issues.
  const localDefs = findLocalGlobalIncludeLines(document);
  const localLine = localDefs.get(includeName);
  if (localLine !== undefined) {
    return new vscode.Location(document.uri, new vscode.Position(localLine, 0));
  }

  try {
    const loaded = await loadExpandedValues(document);
    const map = indexIncludeDefinitions(document, loaded.values, loaded.includeDefinitions);
    const loc = map.get(includeName);
    if (loc) {
      return loc;
    }
  } catch {
    // Ignore parse/include expansion errors and continue with file-based lookup fallback.
  }

  return await findIncludeDefinitionInReferencedFiles(document, includeName);
}

async function provideReferences(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Location[] | undefined> {
  if (!(await isHelmAppsLanguageDocument(document))) {
    return undefined;
  }

  const symbol = findSymbolAtPosition(document.getText(), position.line, position.character);
  if (!symbol) {
    return undefined;
  }

  const occurrences = await collectWorkspaceSymbolOccurrences(document, symbol);
  if (occurrences.length === 0) {
    return undefined;
  }

  return occurrences.map((it) =>
    new vscode.Location(
      it.uri,
      new vscode.Range(new vscode.Position(it.line, it.start), new vscode.Position(it.line, it.end)),
    ));
}

async function prepareRename(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Range | { range: vscode.Range; placeholder: string } | undefined> {
  if (!(await isHelmAppsLanguageDocument(document))) {
    return undefined;
  }
  const symbol = findSymbolAtPosition(document.getText(), position.line, position.character);
  if (!symbol) {
    return undefined;
  }
  const occurrences = collectSymbolOccurrences(document.getText(), symbol);
  if (occurrences.length === 0) {
    return undefined;
  }
  const anchor = occurrences.find((it) =>
    it.line === position.line && position.character >= it.start && position.character <= it.end);
  if (!anchor) {
    return undefined;
  }
  return {
    range: new vscode.Range(
      new vscode.Position(anchor.line, anchor.start),
      new vscode.Position(anchor.line, anchor.end),
    ),
    placeholder: symbol.name,
  };
}

async function provideRenameEdits(
  document: vscode.TextDocument,
  position: vscode.Position,
  newName: string,
): Promise<vscode.WorkspaceEdit | undefined> {
  if (!(await isHelmAppsLanguageDocument(document))) {
    return undefined;
  }
  const symbol = findSymbolAtPosition(document.getText(), position.line, position.character);
  if (!symbol) {
    throw new Error("No renameable helm-apps symbol under cursor");
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(newName)) {
    throw new Error("Use ^[A-Za-z0-9_.-]+$ for symbol rename");
  }

  const occurrences = await collectWorkspaceSymbolOccurrences(document, symbol);
  if (occurrences.length === 0) {
    throw new Error("No symbol occurrences found");
  }

  const edit = new vscode.WorkspaceEdit();
  for (const occ of occurrences) {
    edit.replace(
      occ.uri,
      new vscode.Range(new vscode.Position(occ.line, occ.start), new vscode.Position(occ.line, occ.end)),
      newName,
    );
  }
  return edit;
}

type SymbolOccurrenceWithUri = ReturnType<typeof collectSymbolOccurrences>[number] & { uri: vscode.Uri };

async function collectWorkspaceSymbolOccurrences(
  document: vscode.TextDocument,
  symbol: SymbolRef,
): Promise<SymbolOccurrenceWithUri[]> {
  const out: SymbolOccurrenceWithUri[] = [];
  const seen = new Set<string>();

  const chart = await findNearestChartYaml(document.uri.fsPath);
  const chartRoot = chart ? path.dirname(chart.fsPath) : workspaceRoot(document.uri);
  if (!chartRoot) {
    const local = collectSymbolOccurrences(document.getText(), symbol);
    for (const occ of local) {
      out.push({ ...occ, uri: document.uri });
    }
    return out;
  }

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(chartRoot, "**/*.{yaml,yml}"),
    "**/{.git,node_modules,vendor,tmp,.werf}/**",
  );
  const rootDocs = new Set((await findHelmAppsRootDocuments(chartRoot)).map((current) => path.resolve(current)));
  const includeFiles = await collectIncludeFilesForChart(chartRoot);

  for (const uri of files) {
    try {
       
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const isRootDocument = rootDocs.has(path.resolve(uri.fsPath));
      const isIncludedFile = includeFiles.has(path.resolve(uri.fsPath));
      if (!isRootDocument && !isIncludedFile) {
        continue;
      }
      const occs = collectSymbolOccurrences(text, symbol);
      for (const occ of occs) {
        const key = `${uri.toString()}:${occ.line}:${occ.start}:${occ.end}:${occ.role}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push({ ...occ, uri });
      }
    } catch {
      // ignore unreadable file
    }
  }

  return out;
}

async function provideCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  completionContext?: vscode.CompletionContext,
): Promise<vscode.CompletionItem[] | undefined> {
  if (!(await isHelmAppsLanguageDocument(document))) {
    return undefined;
  }

  const templateCompletions = await buildTemplateCompletionItems(document, position, completionContext);
  if (templateCompletions) {
    return templateCompletions;
  }

  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const line = lines[position.line] ?? "";
  const indent = countIndent(line);
  const contextPath = completionContextPath(text, position.line, position.character, indent);
  const items: vscode.CompletionItem[] = [];

  if (contextPath.length === 0 && indent <= 2) {
    for (const group of BUILTIN_GROUP_TYPES) {
      const item = new vscode.CompletionItem(group, vscode.CompletionItemKind.Module);
      item.insertText = `${group}:`;
      item.detail = "helm-apps group";
      items.push(item);
    }
  }

  const schemaItems = buildSchemaCompletionItems(text, contextPath);
  for (const it of schemaItems) {
    items.push(it);
  }

  const includeItems = await buildIncludeCompletionItems(document, text, position.line);
  for (const it of includeItems) {
    items.push(it);
  }

  const atAppRoot = contextPath.length === 2 && contextPath[0] !== "global" && contextPath[1] !== "__GroupVars__";
  if (atAppRoot && indent >= 4) {
    const group = contextPath[0];
    const effectiveGroup = resolveEffectiveGroupType(text, group);
    const filtered = applyGroupAwareRootFiltering(items, effectiveGroup);
    items.length = 0;
    for (const it of filtered) {
      items.push(it);
    }
  }

  const last = contextPath[contextPath.length - 1] ?? "";
  if ((last === "containers" || last === "initContainers") && indent >= 6) {
    const defaultName = last === "initContainers" ? "init-container-1" : "container-1";
    pushSnippet(items, defaultName, `${defaultName}:\n  image:\n    name: \${1:nginx}\n  command: |-\n    - \${2:sleep}\n  args: |-\n    - \${3:10}\n`, "Named container entry");
  }

  const inContainer = contextPath.length >= 4
    && (contextPath[contextPath.length - 2] === "containers" || contextPath[contextPath.length - 2] === "initContainers");
  if (inContainer && indent >= 8) {
    pushSnippet(items, "image", "image:\n  name: ${1:nginx}\n  staticTag: ${2:\"latest\"}", "Container image");
    pushSnippet(items, "command", "command: |-\n  - ${1:/bin/sh}", "Container command");
    pushSnippet(items, "args", "args: |-\n  - ${1:-c}\n  - ${2:echo hi}", "Container args");
    pushSnippet(items, "envVars", "envVars:\n  ${1:LOG_LEVEL}: ${2:info}", "envVars map");
    pushSnippet(items, "envFrom", "envFrom: |-\n  - secretRef:\n      name: ${1:app-secrets}", "envFrom list");
    pushSnippet(items, "resources", "resources:\n  requests:\n    mcpu: 100\n    memoryMb: 128\n  limits:\n    mcpu: 500\n    memoryMb: 512", "Resources map");
    pushSnippet(items, "ports", "ports: |-\n  - name: ${1:http}\n    containerPort: ${2:8080}", "Container ports");
    pushSnippet(items, "volumeMounts", "volumeMounts: |-\n  - name: ${1:config}\n    mountPath: ${2:/etc/app}", "Volume mounts");
    pushSnippet(items, "readinessProbe", "readinessProbe:\n  enabled: true\n  httpGet:\n    path: ${1:/healthz}\n    port: ${2:8080}", "Readiness probe");
    pushSnippet(items, "livenessProbe", "livenessProbe:\n  enabled: true\n  httpGet:\n    path: ${1:/healthz}\n    port: ${2:8080}", "Liveness probe");
  }

  if (last === "image" && indent >= 10) {
    pushSnippet(items, "name", "name: ${1:nginx}", "Image name");
    pushSnippet(items, "staticTag", "staticTag: ${1:\"latest\"}", "Fixed image tag");
  }

  if (last === "service" && indent >= 6) {
    pushSnippet(items, "enabled", "enabled: true", "Enable service");
    pushSnippet(items, "name", "name: ${1:\"{{ $.CurrentApp.name }}\"}", "Service name");
    pushSnippet(items, "ports", "ports: |-\n  - name: ${1:http}\n    port: ${2:80}\n    targetPort: ${3:http}", "Service ports");
    pushSnippet(items, "type", "type: ${1:ClusterIP}", "Service type");
  }

  if (items.length === 0) {
    return undefined;
  }
  return dedupeCompletionItems(items);
}

async function buildTemplateCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  completionContext?: vscode.CompletionContext,
): Promise<vscode.CompletionItem[] | undefined> {
  if (!happLspClient.isRunning() || templateAssistUnavailable) {
    return undefined;
  }
  if (!shouldRequestTemplateAssist(document, position, completionContext)) {
    return undefined;
  }
  try {
    const result = await happLspClient.templateAssist({
      uri: document.uri.toString(),
      text: document.getText(),
      line: position.line,
      character: position.character,
    });
    if (!result.insideTemplate) {
      return undefined;
    }
    const items = result.completions.map((completion) =>
      mapTemplateAssistCompletionToItem(completion, position.line),
    );
    return dedupeCompletionItems(items);
  } catch (err) {
    const message = extractErrorMessage(err);
    if (
      message.includes("does not support template assist request")
      || message.includes("method not implemented")
    ) {
      templateAssistUnavailable = true;
    }
    happLspBootstrapOutput.appendLine(`[completion] templateAssist fallback: ${message}`);
    return undefined;
  }
}

function shouldRequestTemplateAssist(
  document: vscode.TextDocument,
  position: vscode.Position,
  completionContext?: vscode.CompletionContext,
): boolean {
  const trigger = completionContext?.triggerCharacter;
  if (trigger === "$" || trigger === ".") {
    return true;
  }
  const startLine = Math.max(0, position.line - 40);
  const prefixRange = new vscode.Range(startLine, 0, position.line, position.character);
  const prefix = document.getText(prefixRange);
  const open = prefix.lastIndexOf("{{");
  if (open < 0) {
    return false;
  }
  const close = prefix.lastIndexOf("}}");
  return close < open;
}

function mapTemplateAssistCompletionToItem(
  completion: {
    label: string;
    insertText: string;
    detail: string;
    kind: string;
    replaceStart: number;
    replaceEnd: number;
  },
  line: number,
): vscode.CompletionItem {
  let kind = vscode.CompletionItemKind.Text;
  if (completion.kind === "property") {
    kind = vscode.CompletionItemKind.Field;
  } else if (completion.kind === "keyword") {
    kind = vscode.CompletionItemKind.Keyword;
  } else if (completion.kind === "snippet") {
    kind = vscode.CompletionItemKind.Snippet;
  }
  const item = new vscode.CompletionItem(completion.label, kind);
  if (completion.kind === "snippet") {
    item.insertText = new vscode.SnippetString(completion.insertText);
  } else {
    item.insertText = completion.insertText;
  }
  item.detail = completion.detail;
  item.sortText = `00_tpl_${completion.label}`;
  const start = Math.max(0, completion.replaceStart);
  const end = Math.max(start, completion.replaceEnd);
  item.range = new vscode.Range(new vscode.Position(line, start), new vscode.Position(line, end));
  return item;
}

function pushSnippet(items: vscode.CompletionItem[], label: string, insert: string, detail: string): void {
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
  item.insertText = new vscode.SnippetString(insert);
  item.detail = detail;
  items.push(item);
}

function dedupeCompletionItems(items: vscode.CompletionItem[]): vscode.CompletionItem[] {
  const out: vscode.CompletionItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.label}:${String(item.kind)}:${item.detail ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildSchemaCompletionItems(text: string, contextPath: string[]): vscode.CompletionItem[] {
  const root = loadCompletionSchemaRoot();
  if (!root) {
    return [];
  }
  const path = schemaPathForContext(text, contextPath);
  const schema = resolveSchemaAtPathLocal(root, path);
  if (!schema) {
    return [];
  }
  const keys = collectSchemaPropertyKeysLocal(schema, root, path[path.length - 1] ?? "");
  const items: vscode.CompletionItem[] = [];
  for (const key of keys) {
    const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Field);
    item.insertText = `${key}: `;
    item.detail = "Schema key";
    items.push(item);
  }
  return items;
}

async function buildIncludeCompletionItems(
  document: vscode.TextDocument,
  text: string,
  line: number,
): Promise<vscode.CompletionItem[]> {
  if (parentKeyForLine(text, line) !== "_include") {
    return [];
  }
  const includeNames = await collectAvailableIncludeNames(document, text);
  return includeNames.map((name) => {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Reference);
    item.insertText = name;
    item.detail = "global._includes";
    item.sortText = `00_${name}`;
    return item;
  });
}

function applyGroupAwareRootFiltering(items: vscode.CompletionItem[], effectiveGroup: string): vscode.CompletionItem[] {
  const allowed = getAllowedAppRootKeysByGroup(effectiveGroup);
  if (allowed.size > 0) {
    const filtered: vscode.CompletionItem[] = [];
    for (const item of items) {
      const label = typeof item.label === "string" ? item.label : item.label.label;
      const isRootKeyCandidate = item.kind === vscode.CompletionItemKind.Field || item.kind === vscode.CompletionItemKind.Snippet;
      if (isRootKeyCandidate && !allowed.has(label)) {
        continue;
      }
      item.sortText = `10_${label}`;
      filtered.push(item);
    }
    return filtered;
  }
  for (const item of items) {
    const label = typeof item.label === "string" ? item.label : item.label.label;
    if (!item.sortText) {
      item.sortText = `20_${label}`;
    }
  }
  return items;
}

function schemaPathForContext(text: string, contextPath: string[]): string[] {
  if (contextPath.length === 0) {
    return [];
  }
  const first = contextPath[0];
  if (first === "global" || first.startsWith("apps-")) {
    return contextPath;
  }
  const effective = resolveEffectiveGroupType(text, first);
  return [effective, ...contextPath.slice(1)];
}

function extractGlobalIncludeNames(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const names = new Set<string>();
  let inGlobal = false;
  let inIncludes = false;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    const indent = m[1].length;
    const key = m[2];
    if (indent === 0) {
      inGlobal = key === "global";
      inIncludes = false;
      continue;
    }
    if (inGlobal && indent === 2) {
      inIncludes = key === "_includes";
      continue;
    }
    if (inGlobal && inIncludes && indent === 4) {
      if (!isIncludeEntryHelperKey(key)) {
        names.add(key);
      }
    }
  }
  return [...names].sort();
}

function parentKeyForLine(text: string, line: number): string | null {
  const lines = text.split(/\r?\n/);
  const current = lines[line] ?? "";
  const indent = countIndent(current);
  for (let i = line - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    const keyIndent = m[1].length;
    if (keyIndent < indent) {
      return m[2];
    }
  }
  return null;
}

function completionContextPath(text: string, line: number, character: number, cursorIndent: number): string[] {
  const lines = text.split(/\r?\n/);
  const stack: Array<{ indent: number; key: string; line: number; start: number; end: number }> = [];

  for (let i = 0; i <= line; i += 1) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const m = raw.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    const indent = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const key = m[2];
    const start = raw.indexOf(key);
    stack.push({ indent, key, line: i, start, end: start + key.length });
  }

  const currentLine = lines[line] ?? "";
  const currentKey = currentLine.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
  let effectiveIndent = cursorIndent;
  if (currentKey) {
    const keyIndent = currentKey[1].length;
    const keyStart = keyIndent;
    const keyEnd = keyStart + currentKey[2].length;
    if (character <= keyEnd + 1) {
      effectiveIndent = keyIndent;
    } else {
      effectiveIndent = keyIndent + 2;
    }
  }

  while (stack.length > 0 && stack[stack.length - 1].indent >= effectiveIndent) {
    stack.pop();
  }
  return stack.map((s) => s.key);
}

function loadCompletionSchemaRoot(): JsonSchema | null {
  if (completionSchemaCache) {
    return completionSchemaCache;
  }
  const candidates = [
    path.resolve(__dirname, "../../schemas/values.schema.json"),
    path.resolve(__dirname, "../../../schemas/values.schema.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf8");
      completionSchemaCache = JSON.parse(raw) as JsonSchema;
      return completionSchemaCache;
    } catch {
      // try next
    }
  }
  return null;
}

function resolveSchemaAtPathLocal(root: JsonSchema, pathParts: string[]): JsonSchema | null {
  return walkSchemaLocal(root, pathParts, 0, root);
}

function walkSchemaLocal(current: JsonSchema, pathParts: string[], index: number, root: JsonSchema): JsonSchema | null {
  const schema = resolveRefsLocal(current, root);
  if (!schema) {
    return null;
  }
  if (index >= pathParts.length) {
    return schema;
  }
  const segment = pathParts[index];
  const candidates = nextSchemasForSegmentLocal(schema, segment, root);
  for (const c of candidates) {
    const resolved = walkSchemaLocal(c, pathParts, index + 1, root);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function nextSchemasForSegmentLocal(schema: JsonSchema, segment: string, root: JsonSchema): JsonSchema[] {
  const out: JsonSchema[] = [];
  for (const variant of schemaVariantsLocal(schema, root)) {
    if (variant.properties && variant.properties[segment]) {
      out.push(variant.properties[segment]);
    }
    if (variant.patternProperties) {
      for (const [pattern, child] of Object.entries(variant.patternProperties)) {
        try {
          const re = new RegExp(pattern);
          if (re.test(segment)) {
            out.push(child);
          }
        } catch {
          // bad regex in schema, ignore
        }
      }
    }
    if (typeof variant.additionalProperties === "object") {
      out.push(variant.additionalProperties);
    }
  }
  return out;
}

function schemaVariantsLocal(schema: JsonSchema, root: JsonSchema): JsonSchema[] {
  const base = resolveRefsLocal(schema, root);
  if (!base) {
    return [];
  }
  const out: JsonSchema[] = [base];
  for (const arr of [base.allOf, base.anyOf, base.oneOf]) {
    if (!arr) {
      continue;
    }
    for (const item of arr) {
      const resolved = resolveRefsLocal(item, root);
      if (resolved) {
        out.push(resolved);
      }
    }
  }
  return out;
}

function resolveRefsLocal(schema: JsonSchema | undefined, root: JsonSchema): JsonSchema | null {
  if (!schema) {
    return null;
  }
  let current: JsonSchema | undefined = schema;
  const seen = new Set<string>();
  while (current && current.$ref) {
    const ref = current.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) {
      break;
    }
    seen.add(ref);
    current = getByPointerLocal(root, ref);
  }
  return current ?? null;
}

function getByPointerLocal(root: JsonSchema, pointer: string): JsonSchema | undefined {
  const chunks = pointer
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const c of chunks) {
    if (!cur || typeof cur !== "object" || !(c in (cur as Record<string, unknown>))) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[c];
  }
  return cur as JsonSchema;
}

function collectSchemaPropertyKeysLocal(schema: JsonSchema, root: JsonSchema, parentKey: string): string[] {
  const out = new Set<string>();
  for (const variant of schemaVariantsLocal(schema, root)) {
    if (variant.properties) {
      for (const key of Object.keys(variant.properties)) {
        out.add(key);
      }
    }
    if (variant.patternProperties) {
      for (const key of Object.keys(variant.patternProperties)) {
        const sample = sampleKeyFromPattern(key, parentKey);
        if (sample) {
          out.add(sample);
        }
      }
    }
  }
  if (parentKey === "containers" && !out.has("container-1")) {
    out.add("container-1");
  }
  if (parentKey === "initContainers" && !out.has("init-container-1")) {
    out.add("init-container-1");
  }
  if (parentKey === "_includes" && !out.has("apps-default")) {
    out.add("apps-default");
  }
  return [...out];
}

function sampleKeyFromPattern(pattern: string, parentKey: string): string | null {
  if (pattern === "^[A-Za-z0-9][A-Za-z0-9_.-]*$") {
    if (parentKey === "containers") {
      return "container-1";
    }
    if (parentKey === "initContainers") {
      return "init-container-1";
    }
    return "app-1";
  }
  if (pattern.includes("container")) {
    return parentKey === "initContainers" ? "init-container-1" : "container-1";
  }
  return null;
}

async function provideCodeActions(
  document: vscode.TextDocument,
  range: vscode.Range | vscode.Selection,
  context?: vscode.CodeActionContext,
): Promise<vscode.CodeAction[] | undefined> {
  if (!(await isHelmAppsLanguageDocument(document))) {
    return undefined;
  }
  const lineNumber = range.start.line;
  const line = document.lineAt(lineNumber).text;
  const actions: vscode.CodeAction[] = [];

  const inlineInclude = line.match(/^(\s*)_include:\s*\[(.+)\]\s*$/);
  if (inlineInclude) {
    const indent = inlineInclude[1];
    const values = inlineInclude[2]
      .split(",")
      .map((v) => unquote(v.trim()))
      .filter((v) => v.length > 0);
    if (values.length > 0) {
      const replacement = `${indent}_include:\n${values.map((v) => `${indent}  - ${v}`).join("\n")}`;
      const action = new vscode.CodeAction("Convert inline _include list to multiline", vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(
        document.uri,
        new vscode.Range(new vscode.Position(lineNumber, 0), new vscode.Position(lineNumber, line.length)),
        replacement,
      );
      actions.push(action);
    }
  }

  const appScope = findAppScopeAtLine(document.getText(), lineNumber);
  if (appScope && /^(\s*)([A-Za-z0-9_.-]+):\s*$/.test(line) && countIndent(line) === 2) {
    const nextLine = lineNumber + 1;
    const action = new vscode.CodeAction("Add enabled: true", vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, new vscode.Position(nextLine, 0), "    enabled: true\n");
    actions.push(action);
  }

  const unresolved = (context?.diagnostics ?? []).find((d) =>
    typeof d.code === "string" && d.code.startsWith("E_UNRESOLVED_INCLUDE:"));
  const includeNameFromDiagnostic = unresolved
    ? String(unresolved.code).slice("E_UNRESOLVED_INCLUDE:".length).trim()
    : "";
  const unresolvedIncludeNames = await findUnresolvedIncludeNamesAtLine(document, lineNumber);
  const includeName = /^[A-Za-z0-9_.-]+$/.test(includeNameFromDiagnostic)
    ? includeNameFromDiagnostic
    : (unresolvedIncludeNames[0] ?? "");
  if (/^[A-Za-z0-9_.-]+$/.test(includeName)) {
    const action = new vscode.CodeAction(`Create include profile '${includeName}'`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    const insertion = buildIncludeProfileInsertion(document, includeName);
    action.edit.insert(document.uri, insertion.position, insertion.text);
    actions.push(action);

    const includeFileTarget = await findFirstExistingIncludeFile(document);
    if (includeFileTarget) {
      const targetDoc = await vscode.workspace.openTextDocument(includeFileTarget);
      if (findTopLevelKeyLine(targetDoc.getText(), includeName) < 0) {
        const actionInFile = new vscode.CodeAction(
          `Create include profile '${includeName}' in ${path.basename(includeFileTarget.fsPath)}`,
          vscode.CodeActionKind.QuickFix,
        );
        actionInFile.edit = new vscode.WorkspaceEdit();
        const insertionInFile = buildIncludeProfileInsertionForIncludeFile(targetDoc, includeName);
        actionInFile.edit.insert(targetDoc.uri, insertionInFile.position, insertionInFile.text);
        actions.push(actionInFile);
      }
    }
  }

  const missingInclude = (context?.diagnostics ?? []).find((d) =>
    typeof d.code === "string" && d.code.startsWith("E_INCLUDE_FILE_NOT_FOUND:"));
  if (missingInclude) {
    const rawPath = String(missingInclude.code).slice("E_INCLUDE_FILE_NOT_FOUND:".length).trim();
    if (rawPath.length > 0 && !isTemplatedIncludePath(rawPath)) {
      const candidates = buildIncludeCandidates(rawPath, path.dirname(document.uri.fsPath));
      const target = candidates[0];
      if (target) {
        const action = new vscode.CodeAction(`Create include file '${rawPath}'`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.createFile(vscode.Uri.file(target), { ignoreIfExists: true });
        action.edit.insert(vscode.Uri.file(target), new vscode.Position(0, 0), "# include profiles\n");
        actions.push(action);
      }
    }
  }

  const listPolicyViolation = (context?.diagnostics ?? []).find((d) => String(d.code ?? "") === "E_UNEXPECTED_LIST");
  if (listPolicyViolation) {
    const lines = document.getText().split(/\r?\n/);
    const listLine = listPolicyViolation.range.start.line;
    const parentKeyLine = findParentKeyLineForList(lines, listLine);
    if (parentKeyLine >= 0) {
      const parentText = lines[parentKeyLine] ?? "";
      const keyMatch = parentText.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (keyMatch && !/^[|>][-+]?/.test((keyMatch[3] ?? "").trim())) {
        const replacement = `${keyMatch[1]}${keyMatch[2]}: |-`;
        const action = new vscode.CodeAction("Convert native list to YAML block string", vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(
          document.uri,
          new vscode.Range(new vscode.Position(parentKeyLine, 0), new vscode.Position(parentKeyLine, parentText.length)),
          replacement,
        );
        actions.push(action);
      }
    }
  }

  if (actions.length === 0) {
    return undefined;
  }
  return actions;
}

async function findUnresolvedIncludeNamesAtLine(document: vscode.TextDocument, lineNumber: number): Promise<string[]> {
  const text = document.getText();
  const includeNames = extractIncludeNamesAtLine(text, lineNumber);
  if (includeNames.length === 0) {
    return [];
  }

  const definedNames = new Set(extractGlobalIncludeNames(text));
  if (text.includes("_include_files") || text.includes("_include_from_file")) {
    try {
      const loaded = await loadExpandedValues(document);
      for (const def of loaded.includeDefinitions) {
        definedNames.add(def.name);
      }
    } catch {
      // ignore include-file load errors here; provider should stay best-effort
    }
  }

  const out: string[] = [];
  for (const name of includeNames) {
    if (!definedNames.has(name) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

function extractIncludeNamesAtLine(text: string, lineNumber: number): string[] {
  const lines = text.split(/\r?\n/);
  const line = lines[lineNumber] ?? "";
  const out: string[] = [];

  const includeKey = line.match(/^(\s*)_include:\s*(.+)\s*$/);
  if (includeKey) {
    const tail = includeKey[2].trim();
    if (tail.startsWith("[") && tail.endsWith("]")) {
      const inside = tail.slice(1, -1);
      for (const part of inside.split(",")) {
        const token = unquote(part.trim());
        if (/^[A-Za-z0-9_.-]+$/.test(token)) {
          out.push(token);
        }
      }
      return out;
    }
    const token = unquote(tail);
    if (/^[A-Za-z0-9_.-]+$/.test(token)) {
      out.push(token);
      return out;
    }
  }

  const item = line.match(/^(\s*)-\s+(.+)\s*$/);
  if (!item) {
    return out;
  }
  if (parentKeyForLine(text, lineNumber) !== "_include") {
    return out;
  }
  const token = unquote(item[2].trim());
  if (/^[A-Za-z0-9_.-]+$/.test(token)) {
    out.push(token);
  }
  return out;
}

function buildIncludeProfileInsertion(
  document: vscode.TextDocument,
  includeName: string,
): { position: vscode.Position; text: string } {
  const lines = document.getText().split(/\r?\n/);
  let globalLine = -1;
  let includesLine = -1;
  let includesIndent = 2;

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    const indent = m[1].length;
    const key = m[2];
    if (indent === 0 && key === "global") {
      globalLine = i;
      continue;
    }
    if (globalLine >= 0 && indent === 2 && key === "_includes") {
      includesLine = i;
      includesIndent = indent;
      break;
    }
    if (globalLine >= 0 && indent === 0 && key !== "global") {
      break;
    }
  }

  if (includesLine >= 0) {
    let end = lines.length;
    for (let i = includesLine + 1; i < lines.length; i += 1) {
      const m = lines[i].match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (!m) {
        continue;
      }
      const indent = m[1].length;
      if (indent <= includesIndent) {
        end = i;
        break;
      }
    }
    return {
      position: new vscode.Position(end, 0),
      text: `    ${includeName}:\n      enabled: true\n`,
    };
  }

  if (globalLine >= 0) {
    return {
      position: new vscode.Position(globalLine + 1, 0),
      text: `  _includes:\n    ${includeName}:\n      enabled: true\n`,
    };
  }

  const prefix = document.getText().trim().length > 0 ? "\n" : "";
  return {
    position: new vscode.Position(lines.length, 0),
    text: `${prefix}global:\n  _includes:\n    ${includeName}:\n      enabled: true\n`,
  };
}

function buildIncludeProfileInsertionForIncludeFile(
  document: vscode.TextDocument,
  includeName: string,
): { position: vscode.Position; text: string } {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const hasTrailingNewline = text.endsWith("\n");
  const prefix = text.trim().length > 0 ? (hasTrailingNewline ? "" : "\n") : "";
  return {
    position: new vscode.Position(lines.length, 0),
    text: `${prefix}${includeName}:\n  enabled: true\n`,
  };
}

async function findFirstExistingIncludeFile(document: vscode.TextDocument): Promise<vscode.Uri | undefined> {
  const refs = collectIncludeFileRefs(document.getText());
  const baseDir = path.dirname(document.uri.fsPath);
  for (const ref of refs) {
    if (isTemplatedIncludePath(ref.path)) {
      continue;
    }
    const candidates = buildIncludeCandidates(ref.path, baseDir);
    for (const candidate of candidates) {
      try {
         
        await access(candidate);
        return vscode.Uri.file(candidate);
      } catch {
        // try next
      }
    }
  }
  return undefined;
}

function findParentKeyLineForList(lines: string[], listLine: number): number {
  const current = lines[listLine] ?? "";
  const listIndent = countIndent(current);
  for (let i = listLine - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) {
      continue;
    }
    const m = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    const indent = m[1].length;
    if (indent < listIndent) {
      return i;
    }
  }
  return -1;
}

async function provideIncludeHover(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Hover | undefined> {
  if (!(await isHelmAppsLanguageDocument(document))) {
    return undefined;
  }
  const ru = vscode.env.language.toLowerCase().startsWith("ru");
  const includeLabel = ru ? "include-профиль" : "include profile";
  const sourceLabel = ru ? "источник" : "source";

  const includeName = getIncludeNameUnderCursor(document, position);
  if (includeName) {
    const localBlock = extractLocalIncludeBlock(document.getText(), includeName);
    if (localBlock) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${includeLabel}** \`${includeName}\`  \n`);
      md.appendMarkdown(`${sourceLabel}: \`${document.uri.fsPath}\`\n\n`);
      md.appendCodeblock(trimPreview(localBlock), "yaml");
      return new vscode.Hover(md);
    }

    try {
      const loaded = await loadExpandedValues(document);
      const fileDef = loaded.includeDefinitions.find((d) => d.name === includeName);
      if (fileDef) {
        const raw = await readFile(fileDef.filePath, "utf8");
        const previewBlock = extractIncludeProfileBlock(raw, includeName);
        const previewText = previewBlock
          ? previewBlock
          : trimPreview(raw, 48, 3200);
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${includeLabel}** \`${includeName}\`  \n`);
        md.appendMarkdown(`${sourceLabel}: \`${fileDef.filePath}\`\n\n`);
        md.appendCodeblock(previewText, "yaml");
        return new vscode.Hover(md);
      }

      const resolved = toMap(toMap(loaded.values.global)?._includes)?.[includeName];
      if (resolved !== undefined) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${includeLabel}** \`${includeName}\`  \n`);
        md.appendMarkdown(`${sourceLabel}: ${ru ? "разрешённый global._includes" : "resolved global._includes"}\n\n`);
        md.appendCodeblock(trimPreview(YAML.stringify({ [includeName]: resolved }), 90, 7000), "yaml");
        return new vscode.Hover(md);
      }
    } catch {
      // Ignore parse/include expansion errors and continue with file-based lookup fallback.
    }

    const discovered = await findIncludeDefinitionInReferencedFiles(document, includeName);
    if (discovered) {
      try {
        const raw = await readFile(discovered.uri.fsPath, "utf8");
        const previewBlock = extractIncludeProfileBlock(raw, includeName);
        const previewText = previewBlock
          ? previewBlock
          : trimPreview(raw, 48, 3200);
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${includeLabel}** \`${includeName}\`  \n`);
        md.appendMarkdown(`${sourceLabel}: \`${discovered.uri.fsPath}\`\n\n`);
        md.appendCodeblock(previewText, "yaml");
        return new vscode.Hover(md);
      } catch {
        // skip unreadable file include refs
      }
    }
  }

  const includeDefinitionHover = await provideIncludedFileDefinitionHover(document, position);
  if (includeDefinitionHover) {
    return includeDefinitionHover;
  }

  const fieldHover = provideFieldHover(document, position);
  if (fieldHover) {
    return fieldHover;
  }

  return undefined;
}

async function provideIncludedFileCodeLenses(
  document: vscode.TextDocument,
): Promise<vscode.CodeLens[] | undefined> {
  if (!(await isHelmAppsIncludedFileDocument(document))) {
    return undefined;
  }
  const summary = await resolveIncludedFileContextSummary(document);
  if (!summary) {
    return undefined;
  }
  const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
  const lenses: vscode.CodeLens[] = [];
  const ru = vscode.env.language.toLowerCase().startsWith("ru");

  lenses.push(new vscode.CodeLens(range, {
    command: "helm-apps.explainIncludeFileContext",
    title: buildIncludedFilePrimaryLensTitle(summary, ru),
    arguments: [document.uri],
  }));

  const ownersTitle = buildIncludedFileOwnersLensTitle(summary, ru);
  if (ownersTitle) {
    lenses.push(new vscode.CodeLens(range, {
      command: "helm-apps.explainIncludeFileContext",
      title: ownersTitle,
      arguments: [document.uri],
    }));
  }
  return lenses;
}

async function provideIncludedFileDefinitionHover(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Hover | undefined> {
  if (!(await isHelmAppsIncludedFileDocument(document))) {
    return undefined;
  }
  const summary = await resolveIncludedFileContextSummary(document);
  if (!summary || summary.mode !== "global-includes") {
    return undefined;
  }
  const pathAtCursor = findKeyPathAtPosition(document.getText(), position.line, position.character);
  if (!pathAtCursor || pathAtCursor.length !== 1) {
    return undefined;
  }
  const includeName = pathAtCursor[0] ?? "";
  if (!/^[A-Za-z0-9_.-]+$/.test(includeName) || isIncludeEntryHelperKey(includeName)) {
    return undefined;
  }
  const previewBlock = extractIncludeProfileBlock(document.getText(), includeName);
  const ru = vscode.env.language.toLowerCase().startsWith("ru");
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${ru ? "include-профиль" : "include profile"}** \`${includeName}\`  \n`);
  md.appendMarkdown(`${ru ? "Источник" : "Source"}: \`${document.uri.fsPath}\`  \n`);
  md.appendMarkdown(`${ru ? "Контекст" : "Context"}: \`global._includes\`\n\n`);
  md.appendMarkdown(ru
    ? "Top-level ключ этого файла становится доступным как reusable include-профиль через `_include`.\n\n"
    : "This top-level key becomes a reusable include profile available through `_include`.\n\n");
  if (previewBlock) {
    md.appendCodeblock(trimPreview(previewBlock), "yaml");
  }
  return new vscode.Hover(md);
}

async function explainIncludedFileContext(document: vscode.TextDocument): Promise<void> {
  const summary = await resolveIncludedFileContextSummary(document);
  if (!summary) {
    return;
  }
  const ru = vscode.env.language.toLowerCase().startsWith("ru");
  const lines: string[] = [];
  lines.push(`# helm-apps ${ru ? "контекст include-файла" : "include file context"}`);
  lines.push("");
  lines.push(`- ${ru ? "Файл" : "File"}: \`${document.uri.fsPath}\``);
  lines.push(`- ${ru ? "Роль" : "Role"}: ${buildIncludedFilePrimaryLensTitle(summary, ru)}`);
  lines.push(`- ${ru ? "Root values-файлы" : "Root values files"}: ${summary.ownerRoots.map((item) => `\`${path.basename(item)}\``).join(", ")}`);
  lines.push("");
  lines.push(ru ? "## Что это значит" : "## What this means");
  lines.push("");
  for (const line of buildIncludedFileMeaningLines(summary, ru)) {
    lines.push(`- ${line}`);
  }
  lines.push("");
  lines.push(ru ? "## Где файл подключается" : "## Where this file is included");
  lines.push("");
  for (const context of summary.contexts) {
    const owner = path.basename(context.rootDocument);
    const source = path.basename(context.sourceFile);
    lines.push(`- \`${owner}\` -> \`${source}:${context.line + 1}\` -> \`${renderIncludeReferenceSite(context)}\``);
  }

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: lines.join("\n"),
  });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

function buildIncludedFilePrimaryLensTitle(summary: IncludedFileContextSummary, ru: boolean): string {
  switch (summary.mode) {
    case "global-includes":
      return ru
        ? "helm-apps include-файл: мержится в global._includes"
        : "helm-apps include file: merged into global._includes";
    case "merged-path":
      return ru
        ? `helm-apps include-файл: мержится в ${summary.primaryPath ?? "<root>"}`
        : `helm-apps include file: merged into ${summary.primaryPath ?? "<root>"}`;
    case "include-files":
      return ru
        ? `helm-apps include-файл: используется через _include_files в ${summary.primaryPath ?? "<root>"}`
        : `helm-apps include file: used via _include_files at ${summary.primaryPath ?? "<root>"}`;
    case "mixed":
    default:
      return ru
        ? "helm-apps include-файл: используется в нескольких include-контекстах"
        : "helm-apps include file: used in multiple include contexts";
  }
}

function buildIncludedFileOwnersLensTitle(summary: IncludedFileContextSummary, ru: boolean): string | undefined {
  if (summary.ownerRoots.length === 0) {
    return undefined;
  }
  const owners = summary.ownerRoots.map((item) => path.basename(item)).join(", ");
  return ru ? `root values: ${owners}` : `root values: ${owners}`;
}

function buildIncludedFileMeaningLines(summary: IncludedFileContextSummary, ru: boolean): string[] {
  switch (summary.mode) {
    case "global-includes":
      return ru
        ? [
          "Top-level ключи этого файла становятся include-профилями в `global._includes`.",
          "Их можно использовать из приложений через `_include`.",
          "Внутри каждого профиля значения трактуются как обычный helm-apps payload.",
        ]
        : [
          "Top-level keys in this file become include profiles inside `global._includes`.",
          "Apps can reference them via `_include`.",
          "Values inside each profile are treated as regular helm-apps payload.",
        ];
    case "merged-path":
      return ru
        ? [
          `Содержимое файла мержится в путь \`${summary.primaryPath ?? "<root>"}\`.`,
          "Top-level ключи здесь трактуются как payload этого узла, а не как глобальные include-профили.",
        ]
        : [
          `The file content is merged into \`${summary.primaryPath ?? "<root>"}\`.`,
          "Top-level keys here are treated as payload for that node, not as global include profiles.",
        ];
    case "include-files":
      return ru
        ? [
          `Файл подхватывается через \`_include_files\` из узла \`${summary.primaryPath ?? "<root>"}\`.`,
          "Его YAML используется как вставляемый payload для этого поля.",
        ]
        : [
          `The file is referenced via \`_include_files\` from \`${summary.primaryPath ?? "<root>"}\`.`,
          "Its YAML is used as injected payload for that field.",
        ];
    case "mixed":
    default:
      return ru
        ? [
          "Этот файл используется более чем в одном include-контексте.",
          "Ниже показаны конкретные точки подключения.",
        ]
        : [
          "This file is used in more than one include context.",
          "See concrete inclusion points below.",
        ];
  }
}

async function resolveIncludedFileContextSummary(
  document: vscode.TextDocument,
): Promise<IncludedFileContextSummary | undefined> {
  const chart = await findNearestChartYaml(document.uri.fsPath);
  if (!chart || !(await isHelmAppsChart(chart))) {
    return undefined;
  }
  const chartDir = path.dirname(chart.fsPath);
  const contextsByFile = await collectIncludeContextsForChart(chartDir);
  return summarizeIncludedFileContexts(contextsByFile.get(path.resolve(document.uri.fsPath)) ?? []);
}

function provideFieldHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
  const documentText = document.getText();
  const path = findKeyPathAtPosition(documentText, position.line, position.character);
  if (!path) {
    return undefined;
  }
  const doc = findFieldDoc(path, { documentText });
  if (!doc) {
    return undefined;
  }

  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendMarkdown(buildFieldDocMarkdownLocalized(path, doc, vscode.env.language));
  return new vscode.Hover(md);
}

async function discoverHelmAppsSchemaTargets(): Promise<string[]> {
  const charts = await vscode.workspace.findFiles("**/Chart.yaml", "**/{.git,node_modules,vendor,tmp,.werf}/**");
  const out = new Set<string>();

  for (const chart of charts) {
     
    const enabled = await isHelmAppsChart(chart);
    if (!enabled) {
      continue;
    }
    const chartDir = path.dirname(chart.fsPath);
    // Root helm-apps values files may have arbitrary names.
    // Use content-based detection instead of values*.yaml convention.
     
    const rootDocs = await findHelmAppsRootDocuments(chartDir);
    for (const filePath of rootDocs) {
      out.add(vscode.workspace.asRelativePath(vscode.Uri.file(filePath), false));
    }

    // Do not auto-attach the strict values.schema.json to werf secret-values files.
    // They overlay the chart values tree at render time, but encrypted leaf scalars
    // may intentionally violate plain values leaf types (for example string|null).

    // Include files referenced from values/_include_files are chart-related documents
    // and should receive the same schema support.
    const includeFiles = await collectIncludeFilesForChart(chartDir);
    for (const filePath of includeFiles) {
      out.add(vscode.workspace.asRelativePath(vscode.Uri.file(filePath), false));
    }
  }

  return [...out].sort();
}

async function isHelmAppsChart(chartYamlUri: vscode.Uri): Promise<boolean> {
  const cacheKey = chartYamlUri.fsPath;
  const cached = chartDetectionCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const chartDir = path.dirname(chartYamlUri.fsPath);
  const templates = await vscode.workspace.findFiles(
    new vscode.RelativePattern(chartDir, "templates/**/*.{yaml,yml,tpl}"),
    "**/{.git,node_modules,vendor,tmp,.werf}/**",
  );

  for (const t of templates.slice(0, 80)) {
    try {
       
      const raw = await readFile(t.fsPath, "utf8");
      if (raw.includes(`include "apps-utils.init-library"`)) {
        chartDetectionCache.set(cacheKey, true);
        return true;
      }
    } catch {
      // skip unreadable template
    }
  }
  chartDetectionCache.set(cacheKey, false);
  return false;
}

async function isHelmAppsValuesDocument(document: vscode.TextDocument): Promise<boolean> {
  if (document.languageId !== "yaml") {
    return false;
  }
  const chart = await findNearestChartYaml(document.uri.fsPath);
  if (!chart) {
    return false;
  }
  if (!(await isHelmAppsChart(chart))) {
    return false;
  }
  const chartDir = path.dirname(chart.fsPath);
  const currentPath = path.resolve(document.uri.fsPath);
  const werfSecretValues = await findWerfSecretValuesFileForChart(chartDir);
  if (werfSecretValues && path.resolve(werfSecretValues) === currentPath) {
    return true;
  }
  const rootDocuments = await findHelmAppsRootDocuments(chartDir);
  return rootDocuments.includes(currentPath);
}

async function isHelmAppsLanguageDocument(document: vscode.TextDocument): Promise<boolean> {
  if (await isHelmAppsValuesDocument(document)) {
    return true;
  }
  return await isHelmAppsIncludedFileDocument(document);
}

async function isHelmAppsIncludedFileDocument(document: vscode.TextDocument): Promise<boolean> {
  if (document.languageId !== "yaml") {
    return false;
  }
  const chart = await findNearestChartYaml(document.uri.fsPath);
  if (!chart) {
    return false;
  }
  if (!(await isHelmAppsChart(chart))) {
    return false;
  }
  const chartDir = path.dirname(chart.fsPath);
  const includedFiles = await collectIncludeFilesForChart(chartDir);
  return includedFiles.has(path.resolve(document.uri.fsPath));
}

async function collectIncludeFilesForChart(chartDir: string): Promise<Set<string>> {
  const now = Date.now();
  const cached = includeFilesByChartCache.get(chartDir);
  if (cached && now - cached.scannedAt <= INCLUDE_FILE_CACHE_TTL_MS) {
    return new Set(cached.files);
  }

  const discovered = new Set<string>();
  const scanned = new Set<string>();
  const queue = await findHelmAppsRootDocuments(chartDir);

  while (queue.length > 0) {
    const current = path.resolve(String(queue.pop() ?? ""));
    if (current.length === 0 || scanned.has(current)) {
      continue;
    }
    scanned.add(current);

    let text = "";
    try {
       
      text = await readFile(current, "utf8");
    } catch {
      continue;
    }

    const refs = collectIncludeFileRefs(text);
    const baseDir = path.dirname(current);
    for (const ref of refs) {
      if (isTemplatedIncludePath(ref.path)) {
        continue;
      }
      const candidates = buildIncludeCandidates(ref.path, baseDir);
      for (const candidate of candidates) {
        const abs = path.resolve(candidate);
        try {
           
          await access(abs);
          if (!discovered.has(abs)) {
            discovered.add(abs);
            queue.push(abs);
          }
          break;
        } catch {
          // try next candidate
        }
      }
    }
  }

  includeFilesByChartCache.set(chartDir, { scannedAt: now, files: discovered });
  return new Set(discovered);
}

async function collectIncludeOwnersForChart(chartDir: string): Promise<Map<string, Set<string>>> {
  const now = Date.now();
  const cached = includeOwnersByChartCache.get(chartDir);
  if (cached && now - cached.scannedAt <= INCLUDE_FILE_CACHE_TTL_MS) {
    return cloneIncludeOwnersMap(cached.owners);
  }

  const owners = new Map<string, Set<string>>();
  const roots = (await findHelmAppsRootDocuments(chartDir)).map((current) => path.resolve(current));
  for (const root of roots) {
    const visited = new Set<string>();
    const queue: string[] = [root];
    while (queue.length > 0) {
      const current = path.resolve(String(queue.pop() ?? ""));
      if (current.length === 0 || visited.has(current)) {
        continue;
      }
      visited.add(current);

      let text = "";
      try {
         
        text = await readFile(current, "utf8");
      } catch {
        continue;
      }

      const refs = collectIncludeFileRefs(text);
      const baseDir = path.dirname(current);
      for (const ref of refs) {
        if (isTemplatedIncludePath(ref.path)) {
          continue;
        }
        const candidates = buildIncludeCandidates(ref.path, baseDir);
        for (const candidate of candidates) {
          const includedPath = path.resolve(candidate);
          try {
             
            await access(includedPath, fsConstants.R_OK);
            if (!owners.has(includedPath)) {
              owners.set(includedPath, new Set<string>());
            }
            owners.get(includedPath)?.add(root);
            if (!visited.has(includedPath)) {
              queue.push(includedPath);
            }
            break;
          } catch {
            // try next candidate
          }
        }
      }
    }
  }

  includeOwnersByChartCache.set(chartDir, {
    scannedAt: now,
    owners: cloneIncludeOwnersMap(owners),
  });
  return owners;
}

async function collectIncludeContextsForChart(chartDir: string): Promise<Map<string, IncludeReferenceContext[]>> {
  const now = Date.now();
  const cached = includeContextsByChartCache.get(chartDir);
  if (cached && now - cached.scannedAt <= INCLUDE_FILE_CACHE_TTL_MS) {
    return cloneIncludeContextsMap(cached.contexts);
  }

  const contexts = new Map<string, IncludeReferenceContext[]>();
  const roots = (await findHelmAppsRootDocuments(chartDir)).map((current) => path.resolve(current));

  for (const root of roots) {
    const visited = new Set<string>();
    const queue: string[] = [root];
    while (queue.length > 0) {
      const current = path.resolve(String(queue.pop() ?? ""));
      if (current.length === 0 || visited.has(current)) {
        continue;
      }
      visited.add(current);

      let text = "";
      try {
        text = await readFile(current, "utf8");
      } catch {
        continue;
      }

      const refs = collectIncludeFileRefsWithContext(text);
      const baseDir = path.dirname(current);
      for (const ref of refs) {
        if (isTemplatedIncludePath(ref.path)) {
          continue;
        }
        const candidates = buildIncludeCandidates(ref.path, baseDir);
        for (const candidate of candidates) {
          const includedPath = path.resolve(candidate);
          try {
            await access(includedPath, fsConstants.R_OK);
            if (!contexts.has(includedPath)) {
              contexts.set(includedPath, []);
            }
            const bucket = contexts.get(includedPath) ?? [];
            if (!bucket.some((item) =>
              item.rootDocument === root
              && item.sourceFile === current
              && item.line === ref.line
              && item.kind === ref.kind
              && item.rawPath === ref.path
              && item.parentPath.join(".") === ref.parentPath.join("."))) {
              bucket.push({
                rootDocument: root,
                sourceFile: current,
                rawPath: ref.path,
                line: ref.line,
                kind: ref.kind,
                parentPath: [...ref.parentPath],
              });
            }
            contexts.set(includedPath, bucket);
            if (!visited.has(includedPath)) {
              queue.push(includedPath);
            }
            break;
          } catch {
            // try next candidate
          }
        }
      }
    }
  }

  includeContextsByChartCache.set(chartDir, {
    scannedAt: now,
    contexts: cloneIncludeContextsMap(contexts),
  });
  return contexts;
}

function cloneIncludeOwnersMap(source: Map<string, Set<string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [key, owners] of source) {
    out.set(key, new Set<string>(owners));
  }
  return out;
}

function cloneIncludeContextsMap(source: Map<string, IncludeReferenceContext[]>): Map<string, IncludeReferenceContext[]> {
  const out = new Map<string, IncludeReferenceContext[]>();
  for (const [key, contexts] of source) {
    out.set(key, contexts.map((context) => ({
      ...context,
      parentPath: [...context.parentPath],
    })));
  }
  return out;
}

async function findHelmAppsRootDocuments(chartDir: string): Promise<string[]> {
  const yamlFiles = await vscode.workspace.findFiles(
    new vscode.RelativePattern(chartDir, "**/*.{yaml,yml}"),
    "**/{.git,node_modules,vendor,tmp,.werf,templates}/**",
  );
  const documents: Array<{ filePath: string; text: string }> = [];
  for (const file of yamlFiles) {
    try {
      const text = await readFile(file.fsPath, "utf8");
      documents.push({ filePath: file.fsPath, text });
    } catch {
      // ignore unreadable yaml file
    }
  }
  return selectHelmAppsRootDocuments(documents);
}

async function findNearestChartYaml(fromFile: string): Promise<vscode.Uri | undefined> {
  let dir = path.dirname(fromFile);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, "Chart.yaml");
    try {
       
      await access(candidate);
      return vscode.Uri.file(candidate);
    } catch {
      // continue
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

function getIncludeNameUnderCursor(document: vscode.TextDocument, position: vscode.Position): string | null {
  const lines = document.getText().split(/\r?\n/);
  const line = lines[position.line] ?? "";
  const token = tokenNearCursor(line, position.character);
  if (!token) {
    return null;
  }

  const inlineInclude = line.match(/^(\s*)_include:\s*(.+)$/);
  if (inlineInclude) {
    const valuePart = inlineInclude[2];
    if (valuePart.includes(token)) {
      return token;
    }
  }

  const m = line.match(/^(\s*)-\s+(.+?)\s*$/);
  if (!m) {
    return null;
  }

  const listIndent = m[1].length;
  let parentKey = "";
  for (let i = position.line - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (t.length === 0 || t.startsWith("#")) {
      continue;
    }
    const k = lines[i].match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (k) {
      const ind = k[1].length;
      if (ind < listIndent) {
        parentKey = k[2];
        break;
      }
    }
  }
  if (parentKey !== "_include") {
    return null;
  }
  return token;
}

function tokenNearCursor(line: string, char: number): string | null {
  const clamped = Math.max(0, Math.min(char, line.length));
  const maxDistance = 2;
  for (let d = 0; d <= maxDistance; d += 1) {
    const left = clamped - d;
    if (left >= 0) {
      const token = tokenUnderCursor(line, left);
      if (token) {
        return token;
      }
    }
    if (d > 0) {
      const right = clamped + d;
      if (right <= line.length) {
        const token = tokenUnderCursor(line, right);
        if (token) {
          return token;
        }
      }
    }
  }
  return null;
}

function indexIncludeDefinitions(
  document: vscode.TextDocument,
  values: Record<string, unknown>,
  fileDefs: IncludeDefinition[],
): Map<string, vscode.Location> {
  const index = new Map<string, vscode.Location>();
  const localDefs = findLocalGlobalIncludeLines(document);
  for (const [name, line] of localDefs.entries()) {
    index.set(name, new vscode.Location(document.uri, new vscode.Position(line, 0)));
  }

  for (const def of fileDefs) {
    if (!index.has(def.name)) {
      index.set(def.name, new vscode.Location(vscode.Uri.file(def.filePath), new vscode.Position(def.line, 0)));
    }
  }
  return index;
}

async function findIncludeDefinitionInReferencedFiles(
  document: vscode.TextDocument,
  includeName: string,
): Promise<vscode.Location | undefined> {
  const refs = collectIncludeFileRefs(document.getText());
  const seen = new Set<string>();
  const baseDir = path.dirname(document.uri.fsPath);

  for (const ref of refs) {
    if (isTemplatedIncludePath(ref.path)) {
      continue;
    }
    const candidates = buildIncludeCandidates(ref.path, baseDir);
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      try {
         
        const raw = await readFile(candidate, "utf8");
        const line = findTopLevelKeyLine(raw, includeName);
        if (line >= 0) {
          return new vscode.Location(vscode.Uri.file(candidate), new vscode.Position(line, 0));
        }
      } catch {
        // skip unreadable/missing include refs
      }
    }
  }
  return undefined;
}

function findTopLevelKeyLine(yamlText: string, key: string): number {
  const lines = yamlText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0 || line.trim().startsWith("#")) {
      continue;
    }
    const m = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    if (m[1].length !== 0) {
      continue;
    }
    if (m[2] === key) {
      return i;
    }
  }
  return -1;
}

function findLocalGlobalIncludeLines(document: vscode.TextDocument): Map<string, number> {
  const lines = document.getText().split(/\r?\n/);
  const out = new Map<string, number>();
  let inGlobal = false;
  let globalIndent = -1;
  let includesIndent = -1;
  let includeProfileIndent = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const m = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    const indent = m[1].length;
    const key = m[2];

    if (!inGlobal) {
      if (key === "global") {
        inGlobal = true;
        globalIndent = indent;
      }
      continue;
    }

    if (indent <= globalIndent) {
      inGlobal = key === "global";
      globalIndent = inGlobal ? indent : -1;
      includesIndent = -1;
      includeProfileIndent = -1;
      continue;
    }

    if (includesIndent < 0) {
      if (key === "_includes") {
        includesIndent = indent;
        includeProfileIndent = -1;
      }
      continue;
    }

    if (indent <= includesIndent) {
      includesIndent = -1;
      includeProfileIndent = -1;
      if (key === "_includes") {
        includesIndent = indent;
      }
      continue;
    }

    if (includeProfileIndent < 0) {
      includeProfileIndent = indent;
    }
    if (indent === includeProfileIndent) {
      if (!isIncludeEntryHelperKey(key)) {
        out.set(key, i);
      }
    }
  }
  return out;
}

async function collectAvailableIncludeNames(document: vscode.TextDocument, text: string): Promise<string[]> {
  const names = new Set(extractGlobalIncludeNames(text));
  if (text.includes("_include_files") || text.includes("_include_from_file")) {
    try {
      const loaded = await loadExpandedValues(document);
      for (const def of loaded.includeDefinitions) {
        if (!isIncludeEntryHelperKey(def.name)) {
          names.add(def.name);
        }
      }
    } catch {
      // ignore include-file parsing errors; completion should stay best-effort
    }
  }
  return [...names].sort();
}

function isIncludeEntryHelperKey(name: string): boolean {
  return INCLUDE_ENTRY_HELPER_KEYS.has(name);
}

function renderPreviewHtml(
  title: string,
  yamlText: string,
  diffSummary: string[],
  envDiscovery: EnvironmentDiscoveryModel,
  options: PreviewOptions,
  missingFiles: string[],
  menu: PreviewEntityMenuModel,
  theme: HappPreviewTheme,
): string {
  const safeTitle = escapeHtml(title);
  const optionsJson = serializeJsonForInlineScript(options);
  const menuJson = serializeJsonForInlineScript(menu);
  const ui = theme.ui;
  const syntax = theme.syntax;
  const literalEnvs = [...new Set(envDiscovery.literals.map((v) => v.trim()).filter((v) => v.length > 0))];
  const regexEnvOptions = envDiscovery.regexes
    .map((re) => {
      const sample = sampleEnvFromRegex(re);
      return sample ? { regex: re, sample } : null;
    })
    .filter((v): v is { regex: string; sample: string } => v !== null);
  const knownEnvs = [...new Set([
    ...literalEnvs,
    ...regexEnvOptions.map((r) => r.sample),
  ])];
  const knownEnvSelect = knownEnvs.length > 0
    ? `<label>known env
        <select id="envSelect">
          <option value="">custom...</option>
          ${
            knownEnvs
              .map((env) => `<option value="${escapeHtml(env)}"${env === options.env ? " selected" : ""}>${escapeHtml(env)}</option>`)
              .join("")
          }
        </select>
      </label>`
    : "";
  const details = (envDiscovery.regexes.length > 0 || missingFiles.length > 0)
    ? `<details class="details-panel">
        <summary>Details</summary>
        ${
          envDiscovery.regexes.length > 0
            ? `<div class="hint">regex env keys: ${escapeHtml(envDiscovery.regexes.join(", "))}</div>`
            : ""
        }
        ${
          missingFiles.length > 0
            ? `<div class="warn">missing include files (skipped): ${escapeHtml(missingFiles.join(", "))}</div>`
            : ""
        }
      </details>`
      : "";
  const renderModeValuesActive = options.renderMode === "values" ? "active" : "";
  const renderModeManifestActive = options.renderMode === "manifest" ? "active" : "";
  const renderModeValuesSelected = options.renderMode === "values" ? "true" : "false";
  const renderModeManifestSelected = options.renderMode === "manifest" ? "true" : "false";
  const manifestBackendFastSelected = options.manifestBackend === "fast" ? "selected" : "";
  const manifestBackendHelmSelected = options.manifestBackend === "helm" ? "selected" : "";
  const manifestBackendWerfSelected = options.manifestBackend === "werf" ? "selected" : "";
  const hasEntities = menu.groups.length > 0;
  const entityDisabled = hasEntities ? "" : "disabled";
  const entityLabel = hasEntities ? `${menu.selectedGroup}.${menu.selectedApp}` : "no entities";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle}</title>
    <style>
      :root {
        --bg: ${ui.bg};
        --surface: ${ui.surface};
        --surface-2: ${ui.surface2};
        --surface-3: ${ui.surface3};
        --surface-4: ${ui.surface4};
        --text: ${ui.text};
        --muted: ${ui.muted};
        --accent: ${ui.accent};
        --accent-2: ${ui.accent2};
        --border: ${ui.border};
        --danger: ${ui.danger};
        --ok: ${ui.ok};
        --shadow-soft: 0 10px 24px rgba(0, 0, 0, 0.18);
        --shadow-pop: 0 14px 32px rgba(0, 0, 0, 0.28);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 16px;
        font-family: "IBM Plex Sans", "Inter Tight", "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      .preview-shell {
        max-width: 1180px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .header {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      h2 {
        margin: 0;
        font-size: clamp(28px, 4vw, 40px);
        line-height: 1.06;
        letter-spacing: -0.025em;
        font-weight: 760;
        color: ${ui.title};
      }
      .sub {
        font-size: 12px;
        letter-spacing: .08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .bar {
        display: grid;
        grid-template-columns: minmax(260px, 1.3fr) minmax(180px, 1fr) minmax(180px, 1fr) minmax(160px, .9fr);
        gap: 10px;
        align-items: end;
        padding: 14px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 14px;
        box-shadow: var(--shadow-soft);
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 11px;
        color: var(--muted);
        letter-spacing: .04em;
        text-transform: uppercase;
        min-width: 0;
      }
      input[type="text"] {
        min-width: 0;
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 9px 12px;
        background: var(--surface);
        color: var(--text);
        transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease;
      }
      input[type="text"]:hover { border-color: ${ui.controlHoverBorder}; }
      input[type="text"]:focus {
        outline: none;
        border-color: ${ui.controlFocusBorder};
        box-shadow: 0 0 0 2px ${ui.controlFocusRing};
      }
      select {
        min-width: 0;
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 9px 12px;
        background: var(--surface);
        color: var(--text);
        transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease;
      }
      select:hover { border-color: ${ui.controlHoverBorder}; }
      select:focus {
        outline: none;
        border-color: ${ui.controlFocusBorder};
        box-shadow: 0 0 0 2px ${ui.controlFocusRing};
      }
      input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); }
      .entity-control {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
        min-width: 0;
      }
      .entity-trigger {
        min-width: 0;
        width: 100%;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text);
        border-radius: 10px;
        padding: 9px 12px;
        min-height: 38px;
        text-align: left;
        cursor: pointer;
        transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .entity-trigger:hover { border-color: ${ui.controlHoverBorder}; }
      .entity-trigger:focus {
        outline: none;
        border-color: ${ui.controlFocusBorder};
        box-shadow: 0 0 0 2px ${ui.controlFocusRing};
      }
      .entity-trigger:disabled { opacity: 0.65; cursor: default; }
      .entity-popup {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        z-index: 30;
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: 9px;
        box-shadow: var(--shadow-pop);
        width: min(620px, calc(100vw - 48px));
        max-width: calc(100vw - 48px);
        overflow: hidden;
      }
      .entity-menu {
        min-width: 0;
        padding: 4px;
        overflow: auto;
        flex: 1 1 auto;
        min-height: 0;
      }
      .entity-trigger-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .entity-trigger-icon {
        flex: 0 0 auto;
        color: var(--muted);
        font-size: 12px;
      }
      .entity-picker-search {
        padding: 10px;
        border-bottom: 1px solid var(--border);
        background: var(--surface-2);
      }
      .entity-picker-search input {
        font-size: 13px;
      }
      .entity-picker-grid {
        display: grid;
        grid-template-columns: minmax(190px, 220px) minmax(0, 1fr);
        height: 320px;
        min-height: 320px;
      }
      .entity-pane {
        min-width: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .entity-pane + .entity-pane {
        border-left: 1px solid var(--border);
      }
      .entity-pane-title {
        padding: 10px 12px 8px;
        font-size: 11px;
        letter-spacing: .06em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .entity-item {
        width: 100%;
        text-align: left;
        border: 0;
        background: transparent;
        color: var(--text);
        border-radius: 6px;
        padding: 7px 11px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 13px;
        line-height: 1.3;
      }
      .entity-item:hover { background: var(--surface-4); }
      .entity-item.active { background: ${ui.quickEnvHoverBg}; color: ${ui.title}; }
      .entity-item-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .entity-item-meta {
        color: var(--muted);
        padding-left: 10px;
        font-size: 11px;
        flex: 0 0 auto;
      }
      .entity-empty { font-size: 12px; color: var(--muted); padding: 6px 8px; }
      .hint { font-size: 11px; color: var(--muted); margin-top: 8px; }
      .warn { font-size: 11px; color: var(--danger); margin-top: 8px; }
      .mode-tabs {
        display: flex;
        align-items: stretch;
        width: 100%;
        border-bottom: 1px solid var(--border);
        overflow: hidden;
        background: var(--surface-2);
      }
      .mode-tab {
        flex: 1 1 0;
        border: 0;
        border-right: 1px solid var(--border);
        background: var(--surface-2);
        color: var(--muted);
        padding: 10px 12px;
        cursor: pointer;
        font-family: inherit;
        font-size: 12px;
        letter-spacing: .08em;
        text-transform: uppercase;
        text-align: center;
        position: relative;
        transition: background-color .16s ease, color .16s ease;
      }
      .mode-tab:last-child { border-right: 0; }
      .mode-tab:hover { background: var(--surface-4); color: var(--text); }
      .mode-tab.active {
        background: var(--surface);
        color: ${ui.title};
        font-weight: 700;
        box-shadow: inset 1px 0 0 var(--border), inset -1px 0 0 var(--border);
      }
      .mode-tab.active:first-child { border-top-left-radius: 6px; }
      .mode-tab.active:last-child { border-top-right-radius: 6px; }
      .mode-tab.active::before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 2px;
        background: ${ui.accent};
      }
      .mode-tab.active::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: -1px;
        height: 1px;
        background: var(--surface);
      }
      .mode-tab:focus-visible {
        outline: none;
        box-shadow: inset 0 0 0 1px ${ui.controlFocusBorder};
      }
      .diff-list {
        margin-top: 8px;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px;
        background: var(--surface-3);
        max-height: 180px;
        overflow: auto;
      }
      .diff-item { font-size: 12px; margin-bottom: 4px; }
      .render-shell {
        position: relative;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: var(--surface);
        overflow: hidden;
        box-shadow: var(--shadow-soft);
      }
      .find-bar {
        position: absolute;
        top: 48px;
        right: 14px;
        z-index: 24;
        width: min(460px, calc(100% - 28px));
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: color-mix(in srgb, var(--surface-2) 92%, transparent);
        backdrop-filter: blur(10px);
        box-shadow: var(--shadow-pop);
      }
      .find-bar[hidden] { display: none; }
      .find-input {
        flex: 1 1 auto;
        min-width: 0;
      }
      .find-input input {
        font-size: 13px;
      }
      .find-count {
        flex: 0 0 auto;
        min-width: 58px;
        text-align: right;
        font-size: 11px;
        letter-spacing: .04em;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
      }
      .find-count.empty {
        color: var(--danger);
      }
      .find-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: 0 0 auto;
      }
      .find-action {
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text);
        border-radius: 8px;
        min-width: 30px;
        height: 30px;
        padding: 0 8px;
        cursor: pointer;
        font: inherit;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: border-color .16s ease, background-color .16s ease, color .16s ease;
      }
      .find-action:hover:not(:disabled) {
        border-color: ${ui.controlHoverBorder};
        background: var(--surface-4);
      }
      .find-action:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .find-action.active {
        border-color: ${ui.controlFocusBorder};
        background: ${ui.quickEnvHoverBg};
        color: ${ui.title};
      }
      .find-action.close {
        color: var(--muted);
      }
      .render {
        margin-top: 0;
        border: 0;
        border-radius: 0;
        background: var(--surface);
        overflow: auto;
        max-height: calc(100vh - 292px);
      }
      pre {
        margin: 0;
        padding: 16px;
        color: var(--text);
        font-family: "JetBrains Mono", Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.45;
        white-space: pre;
      }
      .y-key { color: ${syntax.key}; font-weight: 600; }
      .y-bool { color: ${syntax.bool}; font-weight: 600; }
      .y-num { color: ${syntax.number}; }
      .y-comment { color: ${syntax.comment}; font-style: italic; }
      .y-string { color: ${syntax.string}; }
      .y-block { color: ${syntax.block}; font-weight: 600; }
      .find-match {
        background: color-mix(in srgb, ${ui.accent} 20%, transparent);
        border-radius: 3px;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, ${ui.accent} 26%, transparent);
      }
      .find-match.active {
        background: color-mix(in srgb, ${ui.accent2} 34%, transparent);
        box-shadow: inset 0 0 0 1px ${ui.accent2};
      }
      details {
        margin: 0;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface-2);
        padding: 8px 10px;
      }
      summary { cursor: pointer; font-size: 12px; user-select: none; color: var(--text); }
      .details-panel summary {
        letter-spacing: .06em;
        text-transform: uppercase;
        color: var(--muted);
      }
      @media (max-width: 1024px) {
        .bar {
          grid-template-columns: 1fr 1fr;
        }
      }
      @media (max-width: 720px) {
        body { padding: 12px; }
        .bar { grid-template-columns: 1fr; }
        .entity-control { width: 100%; }
        .entity-trigger { width: 100%; }
        .render { max-height: calc(100vh - 320px); }
      }
      @media (max-width: 560px) {
        .entity-popup {
          width: 100%;
          max-width: none;
        }
        .find-bar {
          left: 12px;
          right: 12px;
          width: auto;
        }
        .entity-picker-grid {
          grid-template-columns: 1fr;
          height: min(70vh, 520px);
          min-height: 0;
        }
        .entity-pane + .entity-pane {
          border-left: 0;
          border-top: 1px solid var(--border);
        }
      }
    </style>
  </head>
  <body>
    <div class="preview-shell">
      <div class="header">
        <h2>${safeTitle}</h2>
        <div class="sub">resolved preview</div>
      </div>
      <div class="bar">
        <div class="entity-control">
          <label for="entityTrigger">entity</label>
          <button id="entityTrigger" type="button" class="entity-trigger" ${entityDisabled}>
            <span id="entityTriggerLabel" class="entity-trigger-label">${escapeHtml(entityLabel)}</span>
            <span class="entity-trigger-icon">▾</span>
          </button>
          <div id="entityPopup" class="entity-popup" hidden>
            <div class="entity-picker-search">
              <input id="entitySearch" type="text" value="" placeholder="search group/app" autocomplete="off" spellcheck="false" />
            </div>
            <div class="entity-picker-grid">
              <div class="entity-pane">
                <div class="entity-pane-title">groups</div>
                <div id="groupMenu" class="entity-menu"></div>
              </div>
              <div class="entity-pane">
                <div class="entity-pane-title">apps</div>
                <div id="appMenu" class="entity-menu"></div>
              </div>
            </div>
          </div>
        </div>
        <label>env
          <input id="envInput" type="text" value="${escapeHtml(options.env)}" />
        </label>
        ${knownEnvSelect}
        <label>manifest via
          <select id="manifestBackendSelect">
            <option value="fast" ${manifestBackendFastSelected}>fast (happ)</option>
            <option value="helm" ${manifestBackendHelmSelected}>helm</option>
            <option value="werf" ${manifestBackendWerfSelected}>werf</option>
          </select>
        </label>
      </div>
      <div class="render-shell">
        <div class="mode-tabs" role="tablist" aria-label="render mode">
          <button id="renderModeValues" type="button" class="mode-tab ${renderModeValuesActive}" data-mode="values" role="tab" aria-selected="${renderModeValuesSelected}">values</button>
          <button id="renderModeManifest" type="button" class="mode-tab ${renderModeManifestActive}" data-mode="manifest" role="tab" aria-selected="${renderModeManifestSelected}">manifest</button>
        </div>
        <div id="findBar" class="find-bar" hidden>
          <div class="find-input">
            <input id="findInput" type="text" value="" placeholder="find in preview" autocomplete="off" spellcheck="false" />
          </div>
          <div id="findCount" class="find-count">0 / 0</div>
          <div class="find-actions">
            <button id="findCase" type="button" class="find-action" title="Match Case">Aa</button>
            <button id="findPrev" type="button" class="find-action" title="Previous Match">↑</button>
            <button id="findNext" type="button" class="find-action" title="Next Match">↓</button>
            <button id="findClose" type="button" class="find-action close" title="Close Find">✕</button>
          </div>
        </div>
        <div class="render"><pre id="yamlPreview">${renderYamlHighlightedHtml(yamlText)}</pre></div>
      </div>
      ${details}
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      const rawYamlText = ${serializeJsonForInlineScript(yamlText)};
      const persistedState = vscode.getState() || {};
      const options = ${optionsJson};
      const menu = ${menuJson};
      const envInput = document.getElementById("envInput");
      const envSelect = document.getElementById("envSelect");
      const manifestBackendSelect = document.getElementById("manifestBackendSelect");
      const renderModeTabs = document.querySelectorAll(".mode-tab");
      const entityTrigger = document.getElementById("entityTrigger");
      const entityTriggerLabel = document.getElementById("entityTriggerLabel");
      const entityPopup = document.getElementById("entityPopup");
      const entitySearch = document.getElementById("entitySearch");
      const groupMenu = document.getElementById("groupMenu");
      const appMenu = document.getElementById("appMenu");
      const yamlPreview = document.getElementById("yamlPreview");
      const findBar = document.getElementById("findBar");
      const findInput = document.getElementById("findInput");
      const findCount = document.getElementById("findCount");
      const findCase = document.getElementById("findCase");
      const findPrev = document.getElementById("findPrev");
      const findNext = document.getElementById("findNext");
      const findClose = document.getElementById("findClose");
      let selectedGroup = menu.selectedGroup;
      let selectedApp = menu.selectedApp;
      let pickerGroup = menu.selectedGroup;
      let pickerQuery = "";
      let selectedRenderMode = options.renderMode === "manifest" ? "manifest" : "values";
      let selectedManifestBackend = options.manifestBackend === "helm" || options.manifestBackend === "werf"
        ? options.manifestBackend
        : "fast";
      let findQuery = typeof persistedState.findQuery === "string" ? persistedState.findQuery : "";
      let findCaseSensitive = persistedState.findCaseSensitive === true;
      let findVisible = persistedState.findVisible === true;
      let activeFindIndex = Number.isInteger(persistedState.activeFindIndex) ? persistedState.activeFindIndex : 0;
      let renderedFindMatches = [];

      const emitDebounced = (() => {
        let timer;
        return () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = undefined;
            emit();
          }, 120);
        };
      })();

      envInput.addEventListener("input", () => {
        syncEnvSelectWithInput();
        emitDebounced();
      });
      envInput.addEventListener("change", () => {
        syncEnvSelectWithInput();
        emit();
      });
      envInput.addEventListener("keyup", (e) => {
        if (e.key === "Enter") {
          syncEnvSelectWithInput();
          emit();
        }
      });
      if (envSelect instanceof HTMLSelectElement) {
        envSelect.addEventListener("change", () => {
          if (!envSelect.value) {
            return;
          }
          envInput.value = envSelect.value;
          emit();
        });
      }
      if (manifestBackendSelect instanceof HTMLSelectElement) {
        manifestBackendSelect.addEventListener("change", () => {
          const mode = manifestBackendSelect.value;
          if (mode !== "fast" && mode !== "helm" && mode !== "werf") {
            return;
          }
          if (selectedManifestBackend === mode) {
            return;
          }
          selectedManifestBackend = mode;
          emit();
        });
      }
      renderModeTabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          const mode = tab.getAttribute("data-mode");
          if (mode !== "values" && mode !== "manifest") {
            return;
          }
          if (selectedRenderMode === mode) {
            return;
          }
          selectedRenderMode = mode;
          updateRenderModeTabs();
          emit();
        });
      });
      updateRenderModeTabs();
      syncEnvSelectWithInput();
      normalizeSelection();
      initializeFind();
      if (entityTrigger && entityPopup && groupMenu && appMenu && entitySearch instanceof HTMLInputElement) {
        updateEntityLabel();
        renderEntityPicker();

        entityTrigger.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (entityTrigger.disabled) {
            return;
          }
          if (entityPopup.hidden) {
            openEntityPopup();
            return;
          }
          closeEntityPopup();
        });

        entityPopup.addEventListener("click", (event) => {
          event.stopPropagation();
        });
        entitySearch.addEventListener("click", (event) => {
          event.stopPropagation();
        });
        entitySearch.addEventListener("input", () => {
          pickerQuery = entitySearch.value || "";
          renderEntityPicker();
        });
        entitySearch.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            const visibleApps = getVisibleAppsForPickerGroup();
            if (visibleApps.length === 1 && pickerGroup) {
              selectedGroup = pickerGroup;
              selectedApp = visibleApps[0];
              updateEntityLabel();
              closeEntityPopup();
              emit();
            }
          }
        });
        document.addEventListener("click", closeEntityPopup);
        document.addEventListener("keydown", (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
            event.preventDefault();
            openFindBar(true);
            return;
          }
          if (findVisible) {
            if (event.key === "Escape") {
              event.preventDefault();
              closeFindBar();
              return;
            }
            if (event.key === "Enter" && document.activeElement === findInput) {
              event.preventDefault();
              navigateFind(event.shiftKey ? -1 : 1);
              return;
            }
            if (event.key === "F3") {
              event.preventDefault();
              navigateFind(event.shiftKey ? -1 : 1);
              return;
            }
          }
          if (event.key === "Escape") {
            closeEntityPopup();
          }
        });
      }

      function initializeFind() {
        if (!(yamlPreview instanceof HTMLElement) || !(findInput instanceof HTMLInputElement) || !findBar) {
          return;
        }
        findInput.value = findQuery;
        updateFindCaseButton();
        findInput.addEventListener("input", () => {
          findQuery = findInput.value || "";
          activeFindIndex = 0;
          renderPreview();
        });
        findCase?.addEventListener("click", () => {
          findCaseSensitive = !findCaseSensitive;
          updateFindCaseButton();
          activeFindIndex = 0;
          renderPreview();
        });
        findPrev?.addEventListener("click", () => navigateFind(-1));
        findNext?.addEventListener("click", () => navigateFind(1));
        findClose?.addEventListener("click", () => closeFindBar());
        renderPreview();
        if (findVisible) {
          openFindBar(false);
        }
      }

      function openFindBar(prefillFromSelection) {
        if (!(findInput instanceof HTMLInputElement) || !findBar) {
          return;
        }
        if (prefillFromSelection) {
          const selectedText = getSelectedPreviewText();
          if (selectedText) {
            findQuery = selectedText;
            findInput.value = selectedText;
            activeFindIndex = 0;
          }
        }
        findVisible = true;
        findBar.hidden = false;
        renderPreview();
        requestAnimationFrame(() => {
          findInput.focus();
          findInput.select();
        });
      }

      function closeFindBar() {
        if (!(findInput instanceof HTMLInputElement) || !findBar) {
          return;
        }
        findVisible = false;
        findBar.hidden = true;
        findInput.blur();
        renderPreview();
      }

      function renderPreview() {
        if (!(yamlPreview instanceof HTMLElement)) {
          return;
        }
        const matchGroups = [];
        let nextMatchIndex = 0;
        const html = rawYamlText
          .split(/\\r?\\n/)
          .map((line) => {
            const segments = highlightYamlLineSegmentsClient(line);
            if (!findVisible || findQuery.length === 0) {
              return renderSegmentsWithoutFind(segments);
            }
            const lineText = segments.map((segment) => segment.text).join("");
            const matches = collectLineMatches(lineText, findQuery, findCaseSensitive)
              .map((match) => ({ ...match, index: nextMatchIndex++ }));
            if (matches.length === 0) {
              return renderSegmentsWithoutFind(segments);
            }
            matches.forEach((match) => {
              matchGroups.push(match.index);
            });
            return renderSegmentsWithFind(segments, matches);
          })
          .join("\\n");
        yamlPreview.innerHTML = html;
        renderedFindMatches = buildRenderedFindMatches();
        if (!findVisible || findQuery.length === 0) {
          updateFindCount(0, 0);
          syncFindButtons();
          syncPreviewState();
          return;
        }
        if (renderedFindMatches.length === 0) {
          activeFindIndex = 0;
          updateFindCount(0, 0);
          syncFindButtons();
          syncPreviewState();
          return;
        }
        if (activeFindIndex >= renderedFindMatches.length) {
          activeFindIndex = renderedFindMatches.length - 1;
        }
        if (activeFindIndex < 0) {
          activeFindIndex = 0;
        }
        applyActiveFind(true);
        syncFindButtons();
        syncPreviewState();
      }

      function buildRenderedFindMatches() {
        if (!(yamlPreview instanceof HTMLElement)) {
          return [];
        }
        const grouped = new Map();
        yamlPreview.querySelectorAll("[data-find-index]").forEach((node) => {
          if (!(node instanceof HTMLElement)) {
            return;
          }
          const index = Number(node.getAttribute("data-find-index"));
          if (!Number.isFinite(index)) {
            return;
          }
          const items = grouped.get(index) ?? [];
          items.push(node);
          grouped.set(index, items);
        });
        return Array.from(grouped.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, nodes]) => nodes);
      }

      function navigateFind(direction) {
        if (renderedFindMatches.length === 0) {
          return;
        }
        const total = renderedFindMatches.length;
        activeFindIndex = (activeFindIndex + direction + total) % total;
        applyActiveFind(false);
        syncPreviewState();
      }

      function applyActiveFind(scrollIntoView) {
        renderedFindMatches.forEach((nodes, index) => {
          nodes.forEach((node) => {
            node.classList.toggle("active", index === activeFindIndex);
          });
        });
        const total = renderedFindMatches.length;
        const current = total === 0 ? 0 : activeFindIndex + 1;
        updateFindCount(current, total);
        if (!scrollIntoView || total === 0) {
          return;
        }
        const firstNode = renderedFindMatches[activeFindIndex]?.[0];
        if (firstNode instanceof HTMLElement) {
          firstNode.scrollIntoView({ block: "center", inline: "nearest" });
        }
      }

      function updateFindCount(current, total) {
        if (!(findCount instanceof HTMLElement)) {
          return;
        }
        if (!findVisible || findQuery.length === 0) {
          findCount.textContent = "0 / 0";
          findCount.classList.remove("empty");
          return;
        }
        if (total === 0) {
          findCount.textContent = "no results";
          findCount.classList.add("empty");
          return;
        }
        findCount.textContent = String(current) + " / " + String(total);
        findCount.classList.remove("empty");
      }

      function syncFindButtons() {
        const hasMatches = renderedFindMatches.length > 0;
        if (findPrev instanceof HTMLButtonElement) {
          findPrev.disabled = !hasMatches;
        }
        if (findNext instanceof HTMLButtonElement) {
          findNext.disabled = !hasMatches;
        }
      }

      function updateFindCaseButton() {
        if (!(findCase instanceof HTMLButtonElement)) {
          return;
        }
        findCase.classList.toggle("active", findCaseSensitive);
        findCase.setAttribute("aria-pressed", findCaseSensitive ? "true" : "false");
      }

      function syncPreviewState() {
        vscode.setState({
          findQuery,
          findCaseSensitive,
          findVisible,
          activeFindIndex
        });
      }

      function getSelectedPreviewText() {
        if (!(yamlPreview instanceof HTMLElement)) {
          return "";
        }
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
          return "";
        }
        const text = selection.toString().trim();
        if (!text || text.length > 160) {
          return "";
        }
        const range = selection.getRangeAt(0);
        if (!yamlPreview.contains(range.commonAncestorContainer)) {
          return "";
        }
        return text;
      }

      function collectLineMatches(text, query, caseSensitive) {
        if (!query) {
          return [];
        }
        const source = caseSensitive ? text : text.toLowerCase();
        const needle = caseSensitive ? query : query.toLowerCase();
        const matches = [];
        let cursor = 0;
        while (cursor <= source.length - needle.length) {
          const index = source.indexOf(needle, cursor);
          if (index === -1) {
            break;
          }
          matches.push({ start: index, end: index + needle.length });
          cursor = index + Math.max(needle.length, 1);
        }
        return matches;
      }

      function renderSegmentsWithoutFind(segments) {
        return segments.map((segment) => renderSegmentText(segment.text, segment.className)).join("");
      }

      function renderSegmentsWithFind(segments, matches) {
        let absoluteOffset = 0;
        let matchPointer = 0;
        let html = "";
        for (const segment of segments) {
          const segmentStart = absoluteOffset;
          const segmentEnd = segmentStart + segment.text.length;
          let cursor = segmentStart;
          while (cursor < segmentEnd) {
            while (matchPointer < matches.length && matches[matchPointer].end <= cursor) {
              matchPointer += 1;
            }
            const match = matches[matchPointer];
            if (!match || match.start >= segmentEnd || match.end <= cursor) {
              html += renderSegmentText(segment.text.slice(cursor - segmentStart), segment.className);
              cursor = segmentEnd;
              continue;
            }
            if (match.start > cursor) {
              html += renderSegmentText(
                segment.text.slice(cursor - segmentStart, match.start - segmentStart),
                segment.className,
              );
              cursor = match.start;
            }
            const sliceEnd = Math.min(segmentEnd, match.end);
            html += renderFindSegmentText(
              segment.text.slice(cursor - segmentStart, sliceEnd - segmentStart),
              segment.className,
              match.index,
            );
            cursor = sliceEnd;
          }
          absoluteOffset = segmentEnd;
        }
        return html;
      }

      function renderSegmentText(text, className) {
        if (!text) {
          return "";
        }
        const escaped = escapeHtmlClient(text);
        return className ? '<span class="' + className + '">' + escaped + '</span>' : escaped;
      }

      function renderFindSegmentText(text, className, matchIndex) {
        if (!text) {
          return "";
        }
        const content = className
          ? '<span class="' + className + '">' + escapeHtmlClient(text) + '</span>'
          : escapeHtmlClient(text);
        return '<mark class="find-match" data-find-index="' + String(matchIndex) + '">' + content + "</mark>";
      }

      function highlightYamlLineSegmentsClient(line) {
        const commentIdx = line.indexOf("#");
        let code = line;
        let comment = "";
        if (commentIdx >= 0) {
          code = line.slice(0, commentIdx);
          comment = line.slice(commentIdx);
        }
        const keyMatch = code.match(/^(\\s*)([^:#\\n][^:\\n]*):(\\s*)(.*)$/);
        if (keyMatch) {
          const segments = [];
          if (keyMatch[1]) segments.push({ text: keyMatch[1] });
          segments.push({ text: keyMatch[2], className: "y-key" });
          segments.push({ text: ":" });
          if (keyMatch[3]) segments.push({ text: keyMatch[3] });
          const rawVal = keyMatch[4] ?? "";
          if (rawVal) {
            const trimmed = rawVal.trim();
            let className = "";
            if (trimmed === "|" || trimmed === "|-" || trimmed === ">") {
              className = "y-block";
            } else if (/^(true|false|null)$/.test(trimmed)) {
              className = "y-bool";
            } else if (/^-?\\d+(\\.\\d+)?$/.test(trimmed)) {
              className = "y-num";
            } else if (/^['\"].*['\"]$/.test(trimmed)) {
              className = "y-string";
            }
            segments.push(className ? { text: rawVal, className } : { text: rawVal });
          }
          if (comment) {
            segments.push({ text: comment, className: "y-comment" });
          }
          return segments;
        }
        if (comment && code.trim().length === 0) {
          return [{ text: comment, className: "y-comment" }];
        }
        const segments = [];
        if (code) segments.push({ text: code });
        if (comment) segments.push({ text: comment, className: "y-comment" });
        return segments.length > 0 ? segments : [{ text: "" }];
      }

      function escapeHtmlClient(value) {
        return value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function normalizeSelection() {
        if (!Array.isArray(menu.groups) || menu.groups.length === 0) {
          return;
        }
        if (!menu.groups.some((group) => group.name === selectedGroup)) {
          selectedGroup = menu.groups[0].name;
        }
        const apps = menu.groups.find((group) => group.name === selectedGroup)?.apps ?? [];
        if (apps.length === 0) {
          selectedApp = "";
        } else if (!apps.includes(selectedApp)) {
          selectedApp = apps[0];
        }
        if (!menu.groups.some((group) => group.name === pickerGroup)) {
          pickerGroup = selectedGroup;
        }
      }

      function openEntityPopup() {
        if (!entityPopup || !(entitySearch instanceof HTMLInputElement)) {
          return;
        }
        pickerGroup = selectedGroup;
        pickerQuery = "";
        entitySearch.value = "";
        renderEntityPicker();
        entityPopup.hidden = false;
        entityTrigger?.setAttribute("aria-expanded", "true");
        requestAnimationFrame(() => entitySearch.focus());
      }

      function closeEntityPopup() {
        if (!entityPopup) {
          return;
        }
        entityPopup.hidden = true;
        entityTrigger?.setAttribute("aria-expanded", "false");
      }

      function updateEntityLabel() {
        if (!entityTriggerLabel) {
          return;
        }
        if (!selectedGroup || !selectedApp) {
          entityTriggerLabel.textContent = "no entities";
          return;
        }
        entityTriggerLabel.textContent = selectedGroup + " / " + selectedApp;
      }

      function renderEntityPicker() {
        renderGroupMenu();
        renderAppMenu();
      }

      function getFilteredGroups() {
        const normalized = pickerQuery.trim().toLowerCase();
        if (!normalized) {
          return Array.isArray(menu.groups) ? menu.groups.map((group) => ({ name: group.name, apps: group.apps.slice() })) : [];
        }
        return (Array.isArray(menu.groups) ? menu.groups : [])
          .map((group) => {
            const groupMatch = group.name.toLowerCase().includes(normalized);
            const apps = groupMatch
              ? group.apps.slice()
              : group.apps.filter((app) => app.toLowerCase().includes(normalized));
            return {
              name: group.name,
              apps
            };
          })
          .filter((group) => group.apps.length > 0);
      }

      function normalizePickerGroup(filteredGroups = getFilteredGroups()) {
        if (filteredGroups.length === 0) {
          pickerGroup = "";
          return;
        }
        if (filteredGroups.some((group) => group.name === pickerGroup)) {
          return;
        }
        if (filteredGroups.some((group) => group.name === selectedGroup)) {
          pickerGroup = selectedGroup;
          return;
        }
        pickerGroup = filteredGroups[0].name;
      }

      function getVisibleAppsForPickerGroup() {
        const filteredGroups = getFilteredGroups();
        normalizePickerGroup(filteredGroups);
        return filteredGroups.find((group) => group.name === pickerGroup)?.apps ?? [];
      }

      function renderGroupMenu() {
        if (!groupMenu) {
          return;
        }
        groupMenu.innerHTML = "";
        const filteredGroups = getFilteredGroups();
        normalizePickerGroup(filteredGroups);
        if (filteredGroups.length === 0) {
          groupMenu.innerHTML = '<div class="entity-empty">no groups</div>';
          return;
        }

        for (const group of filteredGroups) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "entity-item" + (group.name === pickerGroup ? " active" : "");
          const label = document.createElement("span");
          label.className = "entity-item-label";
          label.textContent = group.name;
          const meta = document.createElement("span");
          meta.className = "entity-item-meta";
          meta.textContent = String(group.apps.length);
          item.appendChild(label);
          item.appendChild(meta);
          item.addEventListener("click", () => {
            pickerGroup = group.name;
            renderEntityPicker();
          });
          groupMenu.appendChild(item);
        }
        const activeItem = groupMenu.querySelector(".entity-item.active");
        if (activeItem instanceof HTMLElement) {
          activeItem.scrollIntoView({ block: "nearest" });
        }
      }

      function renderAppMenu() {
        if (!appMenu) {
          return;
        }
        appMenu.innerHTML = "";

        const apps = getVisibleAppsForPickerGroup();
        if (apps.length === 0) {
          appMenu.innerHTML = '<div class="entity-empty">no apps</div>';
          return;
        }
        for (const app of apps) {
          const item = document.createElement("button");
          item.type = "button";
          const isCurrent = pickerGroup === selectedGroup && app === selectedApp;
          item.className = "entity-item" + (isCurrent ? " active" : "");
          const label = document.createElement("span");
          label.className = "entity-item-label";
          label.textContent = app;
          item.appendChild(label);
          item.addEventListener("click", () => {
            selectedGroup = pickerGroup;
            selectedApp = app;
            updateEntityLabel();
            closeEntityPopup();
            emit();
          });
          appMenu.appendChild(item);
        }
        const activeItem = appMenu.querySelector(".entity-item.active");
        if (activeItem instanceof HTMLElement) {
          activeItem.scrollIntoView({ block: "nearest" });
        }
      }

      function emit() {
        normalizeSelection();
        const renderMode = selectedRenderMode;
        const group = selectedGroup || menu.selectedGroup;
        const app = selectedApp || menu.selectedApp;
        vscode.postMessage({
          type: "optionsChanged",
          group,
          app,
          env: envInput.value || options.env,
          applyIncludes: true,
          applyEnvResolution: true,
          showDiff: false,
          renderMode,
          manifestBackend: selectedManifestBackend
        });
      }

      function syncEnvSelectWithInput() {
        if (!(envSelect instanceof HTMLSelectElement)) {
          return;
        }
        const current = (envInput.value || "").trim();
        const known = Array.from(envSelect.options).some((opt) => opt.value === current);
        envSelect.value = known ? current : "";
      }

      function updateRenderModeTabs() {
        renderModeTabs.forEach((tab) => {
          const mode = tab.getAttribute("data-mode");
          const isActive = mode === selectedRenderMode;
          tab.classList.toggle("active", isActive);
          tab.setAttribute("aria-selected", isActive ? "true" : "false");
        });
      }
    </script>
  </body>
</html>`;
}

function renderYamlHighlightedHtml(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line) => highlightYamlLine(line))
    .join("\n");
}

function highlightYamlLine(line: string): string {
  const commentIdx = line.indexOf("#");
  let code = line;
  let comment = "";
  if (commentIdx >= 0) {
    code = line.slice(0, commentIdx);
    comment = line.slice(commentIdx);
  }

  const keyMatch = code.match(/^(\s*)([^:#\n][^:\n]*):(\s*)(.*)$/);
  if (keyMatch) {
    const indent = escapeHtml(keyMatch[1]);
    const key = `<span class="y-key">${escapeHtml(keyMatch[2])}</span>:`;
    const ws = escapeHtml(keyMatch[3]);
    const rawVal = keyMatch[4] ?? "";
    let val = escapeHtml(rawVal);
    const trimmed = rawVal.trim();

    if (trimmed === "|" || trimmed === "|-" || trimmed === ">") {
      val = `<span class="y-block">${escapeHtml(rawVal)}</span>`;
    } else if (/^(true|false|null)$/.test(trimmed)) {
      val = `<span class="y-bool">${escapeHtml(rawVal)}</span>`;
    } else if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      val = `<span class="y-num">${escapeHtml(rawVal)}</span>`;
    } else if (/^['"].*['"]$/.test(trimmed)) {
      val = `<span class="y-string">${escapeHtml(rawVal)}</span>`;
    }

    const commentHtml = comment ? `<span class="y-comment">${escapeHtml(comment)}</span>` : "";
    return `${indent}${key}${ws}${val}${commentHtml}`;
  }

  const commentOnly = comment && code.trim().length === 0
    ? `<span class="y-comment">${escapeHtml(comment)}</span>`
    : "";
  const codeHtml = escapeHtml(code);
  return `${codeHtml}${commentOnly}`;
}

function sampleEnvFromRegex(regex: string): string | null {
  if (regex.length === 0) {
    return null;
  }
  let s = regex.trim();
  if (s.startsWith("^")) {
    s = s.slice(1);
  }
  if (s.endsWith("$")) {
    s = s.slice(0, -1);
  }
  s = s
    .replace(/\.\*/g, "")
    .replace(/\.\+/g, "")
    .replace(/\.\?/g, "")
    .replace(/\[[^\]]*]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[\\|?+*()[\]{}]/g, "")
    .trim();
  return s.length > 0 ? s : null;
}

function diffObjects(before: unknown, after: unknown, prefix = ""): string[] {
  if (before === after) {
    return [];
  }
  if (typeof before !== typeof after) {
    return [`${prefix || "<root>"}: type ${typeof before} -> ${typeof after}`];
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) {
      return [`${prefix || "<root>"}: list/other changed`];
    }
    if (before.length !== after.length) {
      return [`${prefix || "<root>"}: list length ${before.length} -> ${after.length}`];
    }
    const out: string[] = [];
    for (let i = 0; i < before.length; i += 1) {
      const childPrefix = `${prefix}[${i}]`;
      out.push(...diffObjects(before[i], after[i], childPrefix));
      if (out.length >= 300) {
        break;
      }
    }
    return out;
  }
  if (isMap(before) && isMap(after)) {
    const out: string[] = [];
    const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPrefix = prefix.length > 0 ? `${prefix}.${key}` : key;
      if (!Object.prototype.hasOwnProperty.call(before, key)) {
        out.push(`${childPrefix}: added`);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(after, key)) {
        out.push(`${childPrefix}: removed`);
        continue;
      }
      out.push(...diffObjects(before[key], after[key], childPrefix));
      if (out.length >= 300) {
        break;
      }
    }
    return out;
  }
  return [`${prefix || "<root>"}: '${String(before)}' -> '${String(after)}'`];
}

function escapeHtml(input: string): string {
  return input
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;");
}

function serializeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function isWebviewMessage(
  value: unknown,
): value is {
  type: "optionsChanged";
  group?: string;
  app?: string;
  env: string;
  applyIncludes: boolean;
  applyEnvResolution: boolean;
  showDiff: boolean;
  renderMode: "values" | "manifest";
  manifestBackend: ManifestPreviewBackend;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.type === "optionsChanged" && typeof v.env === "string"
    && (v.group === undefined || typeof v.group === "string")
    && (v.app === undefined || typeof v.app === "string")
    && typeof v.applyIncludes === "boolean"
    && typeof v.applyEnvResolution === "boolean"
    && typeof v.showDiff === "boolean"
    && (v.renderMode === "values" || v.renderMode === "manifest")
    && (v.manifestBackend === "fast" || v.manifestBackend === "helm" || v.manifestBackend === "werf");
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toMap(value: unknown): Record<string, unknown> | null {
  return isMap(value) ? value : null;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length < 2) {
    return v;
  }
  if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function detectDefaultEnv(values: unknown, envDiscovery: EnvironmentDiscovery): string {
  const root = toMap(values);
  const globalEnv = root && typeof toMap(root.global)?.env === "string"
    ? String(toMap(root.global)?.env).trim()
    : "";
  if (globalEnv.length > 0) {
    return globalEnv;
  }
  return envDiscovery.literals[0] ?? "dev";
}

function tokenUnderCursor(line: string, char: number): string | null {
  const re = /[A-Za-z0-9_.-]+/g;
  for (const m of line.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (char >= start && char <= end) {
      return m[0];
    }
  }
  return null;
}

function countIndent(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") {
    n += 1;
  }
  return n;
}
