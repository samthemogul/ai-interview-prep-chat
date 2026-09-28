# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-28

### Added

- Chat sidebar with streaming answers, Stop, Retry, Copy, New conversation and Markdown/code rendering.
- Local Ollama integration: detection (not installed / not running / running), model discovery, model picker, guided model download with confirmation, configurable endpoint.
- Codebase context: current file, selection, `@file`, `@selection`, `@workspace`, `@diagnostics`, and automatic retrieval of relevant snippets with a lightweight local index that respects `.gitignore`.
- Guarded Interview Mode (default) with three helper tracks, approach-directed implementation, and a streaming output guard that removes solution code, rewrites and diffs.
- Normal Mode, with confirmation and transcript recording when switching away from Guarded Mode.
- Local practice transcripts with review, export and delete commands.
- First-run onboarding, command palette commands, editor and explorer context menus.
- Privacy and security hardening: no telemetry, no command execution, strict webview CSP, prompt-injection mitigations.
