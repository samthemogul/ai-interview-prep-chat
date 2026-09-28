# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-09-28

### Fixed

- **Agent mode now works with small models.** Models like `qwen2.5-coder:1.5b` rarely write the edit format; they write ordinary code blocks (often copying the context's line numbers). Agent mode now turns those code blocks into edits itself: it reads the file from a path line or a `# file.py:12` comment, strips copied line numbers, and places the code by replacing the function it redefines or inserting new code after similar code (for example after the last route).
- Code the model merely echoes back (including commented-out code) is recognised as no change and not shown as an edit.
- Safety: a partial snippet can never overwrite a whole function or class (unbalanced braces or a much shorter replacement are refused).
- **Only what you asked for:** test code is left out unless you asked for tests (with a note saying so), and the prompts forbid unrequested tests, examples and curl commands.
- **Guarded refusals are short, enforced in code:** the reply is buffered and reduced to one refusal sentence plus one guiding question or hint; lists and step-by-step explanations are dropped. The token cap is now 120.

### Changed

- The first proposed edit of an answer opens as a diff automatically, with **Accept** and **Reject** buttons in the diff editor's title bar. The diff closes after you decide.
- Agent mode sends code without line numbers and keeps a shorter history, so small models copy exact lines and don't repeat earlier answers.
- In Agent mode, code blocks only become edits when you ask for a change (or, in Guarded Mode, describe an approach). Answers to questions keep their examples as normal code blocks.

## [0.2.0] - 2026-09-28

### Added

- **Ask, Plan and Agent modes**, available in both Guarded and Unguarded, switchable above the message box or with **Switch Chat Mode**.
- **Agent mode**: the AI proposes search-and-replace edits that appear as edit cards with a preview, **Review diff** (VS Code's diff editor), **Accept**, **Reject** and **Revert**. Nothing is written until you accept; accepted edits go through VS Code's undo stack. Guarded Agent only edits files to implement an approach you describe.
- **Plan mode**: Unguarded drafts a plan (goal, files, steps, risks, how to verify) with an **Implement with Agent** button; Guarded reviews the candidate's own plan with questions.
- Transcripts record proposed edits, accept/reject/revert decisions, and whether the diff was opened first. Unguarded sessions are recorded too.

### Changed

- **Normal Mode is now called Unguarded Mode** in the UI (the setting value stays `normal`).
- Guarded refusals are short: the prompt asks for one sentence plus a hint, and the reply is capped (`num_predict`) and trimmed to the last full sentence.
- Approach answers show only the new or changed code. If the model repeats the whole file, the guard trims it to the changed lines.

## [0.1.1] - 2026-09-28

### Fixed

- Approach implementations were blocked when a model wrote the `[APPROACH]` marker on the same line as its answer (common with small models such as `qwen2.5-coder:1.5b`). The marker is now recognised at the start of any line and is always hidden from the chat.
- A model can no longer unlock code by adding the marker to an outcome-only request ("add a get-one-user endpoint"). The marker only counts when the message describes an approach or starts with `/implement`.

### Changed

- Approach detection recognises more plain-English steps (query, find, fetch, insert, update, delete, "not found", …).
- The "Code removed" notice now mentions `/implement`.

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
