# Privacy

**Your code and conversations are processed locally using Ollama. AIInterviewPrepChat does not send your source code to a remote AI service.**

## What the extension does with your data

| Data                                   | Where it goes                                                                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your questions and the model's answers | Sent to the Ollama server at `aiInterviewPrepChat.ollamaEndpoint` (default `http://localhost:11434`).                                                                                                                                                                      |
| Repository context (snippets, files)   | Sent to the same Ollama server, only for the message it belongs to. Never stored by the extension.                                                                                                                                                                         |
| Conversation history                   | Stored in VS Code's local workspace storage on this machine so the chat survives a reload. Contains your messages and the answers, not repository context.                                                                                                                 |
| Practice transcripts                   | Stored as JSON in VS Code's local extension storage on this machine. Contains prompts, answers, workspace-relative file names used as context, and flags. You can turn this off (`aiInterviewPrepChat.saveTranscripts`) and delete everything with **Delete Transcripts**. |
| Logs                                   | Written to the local "AIInterviewPrepChat" output channel. Logs contain status information and file names, never source code or chat content.                                                                                                                              |

## What the extension does not do

- No telemetry, analytics, crash reporting or usage tracking.
- No accounts, sign-in or API keys.
- No requests to any server other than your configured Ollama endpoint.
- No reading of files outside the open workspace.
- No uploading of source code, chat messages, repository contents or personal information.

## Remote endpoints

If you change `aiInterviewPrepChat.ollamaEndpoint` to a server that is not on this machine, your questions and repository context are sent to that server. The extension warns you when this happens and marks the chat as **Remote** in the status line.

## Model downloads

Downloading a model is done by Ollama from the Ollama registry, and only after you confirm the download. After that, the extension works fully offline.

## Future telemetry

If telemetry is ever added, it will be opt-in, will respect VS Code's `telemetry.telemetryLevel` setting, and will never include source code, chat messages, repository contents or personal information.
