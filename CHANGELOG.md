# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.5] - 2026-09-28

### Fixed

- **A second edit in the same chat now works.** Past edits were described back to the model as a structured tag (`[Proposed edit to file (+6 −0): accepted]`). Small models copied that line verbatim on the next turn instead of writing new code, so the follow-up "edit" was just narration and nothing changed. Past edits are now described to the model as plain narration (`(I edited pyserver.py.)`), and the Agent prompt states that every change must be a real code block — a note is not an edit. The current file contents, sent fresh each turn, remain what tells the model what already changed.

## [0.2.4] - 2026-09-28

### Fixed

- **An accepted edit that doesn't actually reach disk is now reported as failed, not "Applied".** After writing, the extension re-reads the file and checks the change landed; if it didn't (a read-only file, a path that resolved to a different copy than the one on screen, or an editor that rejected the change), the edit card shows a clear error instead of claiming success. This also stops the follow-on confusion where the model, seeing the file unchanged, keeps re-proposing the same endpoint.

## [0.2.3] - 2026-09-28

### Fixed

- **The agent no longer cuts itself off.** 0.2.2 could stop generation once it judged the rest of the answer would be trimmed; when a model wrote a sentence or an explanation *before* its code block, the stream was aborted and the edit never arrived — you'd see one sentence and no diff to review. Generation now always runs to completion, so a code block that comes after prose is delivered in full and shows its diff.

### Changed

- **Short answers now come from the prompt, not from truncation.** The model is asked for one or two sentences of prose around its code; the display no longer caps prose by length or stops the model early. The only cleanup left is removing pure filler ("Let me know if…") and whole labelled "Explanation" / "Summary" / "Testing" sections — it never shortens the actual answer and never touches code or edits.

## [0.2.2] - 2026-09-28

### Fixed

- **Agent edits touch only the affected part of the file.** When a small model answered "add an endpoint" by repeating the whole file (rewritten imports, the database setup, every existing function and commented-out code, with the new function somewhere inside), the extension used to insert all of it and duplicate everything. It now splits such a block into its top-level parts and applies only what changed: the new function is inserted next to its neighbours, unchanged functions, setup lines and comments are skipped, and imports are merged — only the names the new code actually uses are added (for example `HTTPException` into an existing `from fastapi import FastAPI`), never a duplicate import line. Incidental rewrites of code you didn't ask about (for example `from pymongo import MongoClient` turned into `import pymongo`) are left alone, with a short note saying so.
- Comments the model added to code are dropped unless you asked for comments.

### Changed

- **Explanations, hints and comments are short by default,** like a frontier model. Prose beyond a per-mode budget (3 sentences in Agent, 5 in Ask), filler ("Let me know if…"), and whole "Explanation", "How it works", "Summary" and "Testing" sections are removed — the code and the edits always come through in full. Ask for detail ("explain in detail", "step by step") and the budget is lifted.

### Performance

- Once the visible answer is complete, generation stops instead of letting the model keep writing text that would be hidden — noticeably faster on small local models that ramble after the code.
- The model is loaded into memory in the background when you open the panel or pick a model, and kept loaded for 30 minutes (`keep_alive`), so the first question doesn't wait for the model to load and later questions don't reload it.
- Streamed text is sent to the panel in ~40 ms batches and the panel re-renders only the newly added part of a long answer, rather than re-rendering the whole message on every token.
- Context retrieval reads candidate files in parallel and runs the symbol lookup alongside the content search; the diff preview uses a faster line-diff.

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
