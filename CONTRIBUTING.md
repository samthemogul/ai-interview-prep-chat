# Contributing

Thanks for helping improve AIInterviewPrepChat.

## Ground rules

- **Keep it local.** No telemetry, no cloud services, no accounts. The only network target is the configured Ollama endpoint.
- **Never execute anything.** Don't add process spawning, file writes to the workspace, or any way for model output to run. ESLint blocks `child_process`.
- **Keep Guarded Interview Mode strict.** Changes to `src/interview/` need tests showing the guard still blocks solutions, rewrites and diffs.
- **Don't over-engineer v1.** No vector databases, agents or MCP servers.

## Setup

```bash
npm install
npm run build
```

Press **F5** in VS Code to start an Extension Development Host. Run `npm run watch` to rebuild on change.

## Before opening a pull request

```bash
npm run check          # typecheck + lint + tests
npm run format         # Prettier
```

Then go through the relevant parts of [QA_CHECKLIST.md](QA_CHECKLIST.md).

## Code layout

- Logic that doesn't need VS Code lives in plain TypeScript modules and is unit tested with Vitest (`test/`).
- `src/host/VscodeHost.ts`, `src/context/WorkspaceIndexer.ts`, `src/chat/ChatViewProvider.ts` and `src/commands/` are the only places that use the `vscode` API directly.
- The webview (`src/webview/chat/`) has its own `tsconfig.json` and is bundled separately. Its only shared import is `src/chat/protocol.ts`.
- System prompts and guard limits are in `src/interview/GuardedPrompt.ts`.

## Commit messages

Use short, imperative subjects ("Add diagnostics chip", "Fix fence detection in guard").
