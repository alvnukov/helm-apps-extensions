# Multi-IDE Architecture (VS Code + JetBrains)

Цель: минимизировать дублирование логики между IDE-клиентами.

## Базовый принцип

Общее ядро вынесено в `happ` LSP (Rust).  
IDE-клиенты остаются тонкими:

- определяют контекст файла;
- поднимают LSP-процесс;
- отображают UI и IDE-специфичные действия.

## Общий protocol layer

- `src/core/happProtocol.ts` — единые TS-типы и имена custom методов.
- `shared/happ-lsp-contract.json` — IDE-agnostic контракт методов/параметров.

Методы:

- `happ/resolveEntity`
- `happ/renderEntityManifest`
- `happ/getPreviewTheme`

## Клиенты

- VS Code: `src/lsp/client.ts`
- JetBrains: `jetbrains/src/main/kotlin/.../HelmAppsLspServerSupportProvider.kt`

Оба клиента запускают один и тот же backend: `happ lsp [--parent-pid=...]`.
