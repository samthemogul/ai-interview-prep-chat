/**
 * Single source of truth for the extension's name and identifiers.
 * To rename the extension, change these values and the matching fields in package.json.
 */
export const EXTENSION_DISPLAY_NAME = 'AIInterviewPrepChat';
/** Prefix used for command IDs, settings keys, views and context keys. */
export const ID = 'aiInterviewPrepChat';

export const VIEW_CONTAINER_ID = ID;
export const CHAT_VIEW_ID = `${ID}.chat`;
export const TRANSCRIPT_SCHEME = `${ID}-transcript`;

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
export const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';

export const PRIVACY_STATEMENT =
  `Your code and conversations are processed locally using Ollama. ` +
  `${EXTENSION_DISPLAY_NAME} does not send your source code to a remote AI service.`;

export const COMMANDS = {
  openChat: `${ID}.openChat`,
  newConversation: `${ID}.newConversation`,
  clearConversation: `${ID}.clearConversation`,
  explainSelection: `${ID}.explainSelection`,
  askAboutSelection: `${ID}.askAboutSelection`,
  findPotentialIssues: `${ID}.findPotentialIssues`,
  askGuidingQuestions: `${ID}.askGuidingQuestions`,
  explainCurrentFile: `${ID}.explainCurrentFile`,
  explainFile: `${ID}.explainFile`,
  askAboutFile: `${ID}.askAboutFile`,
  askAboutWorkspace: `${ID}.askAboutWorkspace`,
  toggleInterviewMode: `${ID}.toggleInterviewMode`,
  selectModel: `${ID}.selectModel`,
  downloadModel: `${ID}.downloadModel`,
  checkOllama: `${ID}.checkOllama`,
  openSettings: `${ID}.openSettings`,
  reviewTranscript: `${ID}.reviewTranscript`,
  exportTranscript: `${ID}.exportTranscript`,
  deleteTranscripts: `${ID}.deleteTranscripts`,
  viewLogs: `${ID}.viewLogs`,
} as const;

export const STATE_KEYS = {
  onboardingComplete: `${ID}.onboardingComplete`,
  conversation: `${ID}.conversation`,
} as const;
