import { EXTENSION_DISPLAY_NAME } from '../constants';

/** Error codes the UI knows how to explain. Raw stack traces are never shown to users. */
export type ErrorCode =
  | 'ollama-not-installed'
  | 'ollama-not-running'
  | 'no-models'
  | 'no-model-selected'
  | 'model-unavailable'
  | 'generation-failed'
  | 'invalid-endpoint'
  | 'cancelled';

export const USER_MESSAGES: Record<ErrorCode, string> = {
  'ollama-not-installed': `${EXTENSION_DISPLAY_NAME} couldn't find Ollama. Install Ollama to use the local AI assistant.`,
  'ollama-not-running': `${EXTENSION_DISPLAY_NAME} found Ollama but could not connect to it.`,
  'no-models': 'No Ollama models are currently installed.',
  'no-model-selected': 'Choose a model in the chat header before sending a message.',
  'model-unavailable': 'The selected model is no longer available.',
  'generation-failed': 'Something went wrong while generating the response.',
  'invalid-endpoint': 'The Ollama endpoint setting is not a valid http(s) URL.',
  cancelled: 'Generation stopped.',
};

export const LARGE_REPO_MESSAGE = `The repository is large. ${EXTENSION_DISPLAY_NAME} will retrieve only the most relevant files.`;

/** An error that is safe to show to the user; `detail` is only written to the log. */
export class UserFacingError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
  ) {
    super(USER_MESSAGES[code]);
    this.name = 'UserFacingError';
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof UserFacingError) return err.code === 'cancelled';
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    ((err as { name: string }).name === 'AbortError' || (err as { name: string }).name === 'TimeoutError')
  );
}

/** Converts anything thrown into a message suitable for the UI. */
export function toUserMessage(err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  return USER_MESSAGES['generation-failed'];
}

export function describeForLog(err: unknown): string {
  if (err instanceof UserFacingError) return `${err.code}${err.detail ? `: ${err.detail}` : ''}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
