# helm-apps JetBrains Plugin (beta)

JetBrains plugin that connects IDE YAML editing to `happ` LSP.

## Что работает в MVP

- Автозапуск `happ lsp` для `values*.yaml`, которые похожи на `helm-apps` values.
- LSP-фичи через `happ` (diagnostics, completion, hover, navigation — зависит от возможностей сервера).
- Настройка пути к `happ` и аргументов LSP в `Settings | Tools | helm-apps`.

## Поддержка IDE

- Базовая совместимость: JetBrains IDE на платформе `252+` (2025.2+).
- LSP-функции включаются, когда в IDE доступен модуль `com.intellij.modules.lsp`.

## Общее ядро

- Единый backend для VS Code и JetBrains: `happ` LSP.
- Общий protocol contract в репозитории:
  - `shared/happ-lsp-contract.json`
  - `src/core/happProtocol.ts`

## Пользовательские требования

- `happ` должен быть доступен в `PATH` или указан через настройки плагина.
- Файл должен соответствовать паттерну `values*.yaml` и содержать структуру `global` + `apps-*`.
