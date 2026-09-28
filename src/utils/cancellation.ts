/** Returns a signal that aborts when any input signal aborts, or after `timeoutMs` if given. */
export function linkSignals(signals: Array<AbortSignal | undefined>, timeoutMs?: number): AbortSignal {
  const controller = new AbortController();
  const cleanup: Array<() => void> = [];
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
    for (const fn of cleanup) fn();
  };
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      abort(s.reason);
      return controller.signal;
    }
    const onAbort = () => abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    cleanup.push(() => s.removeEventListener('abort', onAbort));
  }
  if (timeoutMs !== undefined) {
    const timer = setTimeout(() => {
      const err = new Error('Timed out');
      err.name = 'TimeoutError';
      abort(err);
    }, timeoutMs);
    cleanup.push(() => clearTimeout(timer));
  }
  return controller.signal;
}

/** Tracks the in-flight generation so a new request or Stop cancels the previous one. */
export class RequestTracker {
  private current: AbortController | undefined;

  /** Cancels any in-flight request and returns a fresh controller for the next one. */
  begin(): AbortController {
    this.cancel();
    this.current = new AbortController();
    return this.current;
  }

  cancel(): boolean {
    if (this.current && !this.current.signal.aborted) {
      this.current.abort();
      this.current = undefined;
      return true;
    }
    this.current = undefined;
    return false;
  }

  end(controller: AbortController): void {
    if (this.current === controller) this.current = undefined;
  }

  get active(): boolean {
    return this.current !== undefined && !this.current.signal.aborted;
  }
}
