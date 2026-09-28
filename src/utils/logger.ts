/** Minimal logger interface so core logic doesn't depend on the VS Code API. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export const nullLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** Output sink with the subset of vscode.OutputChannel that we use. */
export interface OutputSink {
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
}

/**
 * Logger that writes to a VS Code output channel. Debug lines are dropped unless enabled.
 * Callers must never pass source code or chat content to the logger.
 */
export class ChannelLogger implements Logger {
  constructor(
    private readonly sink: OutputSink,
    private readonly isDebugEnabled: () => boolean,
  ) {}

  info(message: string): void {
    this.write('info', message);
  }
  warn(message: string): void {
    this.write('warn', message);
  }
  error(message: string): void {
    this.write('error', message);
  }
  debug(message: string): void {
    if (this.isDebugEnabled()) this.write('debug', message);
  }
  show(): void {
    this.sink.show(true);
  }

  private write(level: string, message: string): void {
    this.sink.appendLine(`[${new Date().toISOString()}] [${level}] ${message}`);
  }
}
