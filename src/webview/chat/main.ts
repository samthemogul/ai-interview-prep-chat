import type { Chips, HostToWebview, Mode, UiMessage, ViewState, WebviewToHost } from '../../chat/protocol';
import { escapeHtml, renderMarkdown } from './markdown';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const persisted = (vscode.getState() ?? {}) as { draft?: string; step?: number };

let state: ViewState | undefined;
let onboardingStep = typeof persisted.step === 'number' ? persisted.step : 0;
let onboardingMode: Mode = 'guarded';
const pendingRender = new Set<string>();
let frameRequested = false;

const post = (m: WebviewToHost) => vscode.postMessage(m);
const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const icon = (name: string, extra = '') =>
  `<span class="codicon codicon-${name}${extra ? ' ' + extra : ''}" aria-hidden="true"></span>`;

function saveUiState(): void {
  const input = $<HTMLTextAreaElement>('#input');
  vscode.setState({ draft: input?.value ?? '', step: onboardingStep });
}

// ------------------------------------------------------------------ skeleton

function mountSkeleton(): void {
  const app = $('#app')!;
  app.innerHTML = `
    <header class="header" id="header"></header>
    <div class="banner-area" id="banners"></div>
    <main class="main" id="main" tabindex="-1"></main>
    <footer class="composer" id="composer">
      <div class="chips" id="chips" role="group" aria-label="Context to include"></div>
      <div class="input-wrap">
        <textarea id="input" rows="1" placeholder="Ask about this codebase…  (@file, @selection, @workspace, @diagnostics)" aria-label="Message"></textarea>
        <button class="send-btn" id="send" data-action="send" title="Send (Enter)" aria-label="Send">${icon('send')}</button>
      </div>
      <div class="status-line" id="status"></div>
    </footer>`;
  const input = $<HTMLTextAreaElement>('#input')!;
  input.value = persisted.draft ?? '';
  autosize(input);
  input.addEventListener('input', () => {
    autosize(input);
    saveUiState();
    updateSendButton();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (state?.busy) return;
      sendMessage();
    } else if (e.key === 'Escape' && state?.busy) {
      post({ type: 'stop' });
    }
  });
}

function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

function sendMessage(): void {
  const input = $<HTMLTextAreaElement>('#input')!;
  const text = input.value.trim();
  if (!text || !state) return;
  post({ type: 'send', text, chips: state.chips });
  input.value = '';
  autosize(input);
  saveUiState();
}

// ------------------------------------------------------------------ rendering

function render(): void {
  if (!state) return;
  document.body.dataset.mode = state.mode;
  renderHeader();
  renderBanners();
  renderMain();
  renderComposer();
}

function renderHeader(): void {
  const s = state!;
  const connected = s.ollama.state === 'running';
  const statusLabel = connected
    ? `Ollama connected${s.ollama.version ? ` (v${s.ollama.version})` : ''}`
    : s.ollama.state === 'checking'
      ? 'Checking for Ollama…'
      : 'Ollama not connected';
  const modelOptions = s.models.length
    ? s.models
        .map(
          (m) =>
            `<option value="${escapeHtml(m.name)}"${m.name === s.model ? ' selected' : ''}>${escapeHtml(m.name)}${m.chat ? '' : ' (embedding)'}</option>`,
        )
        .join('')
    : `<option value="">${connected ? 'No models installed' : 'No models'}</option>`;
  $('#header')!.innerHTML = `
    <div class="header-row">
      <div class="brand">
        <span class="status-dot ${connected ? 'ok' : s.ollama.state === 'checking' ? 'pending' : 'bad'}" title="${escapeHtml(statusLabel)}" aria-label="${escapeHtml(statusLabel)}"></span>
        <span class="brand-name">${escapeHtml(s.displayName)}</span>
      </div>
      <div class="header-actions">
        <button class="icon-btn" data-action="review-transcript" title="Review session transcript" aria-label="Review session transcript">${icon('history')}</button>
        <button class="icon-btn" data-action="new" title="New conversation" aria-label="New conversation">${icon('add')}</button>
        <button class="icon-btn" data-action="settings" title="Settings" aria-label="Settings">${icon('gear')}</button>
      </div>
    </div>
    <div class="header-row controls">
      <div class="segmented" role="radiogroup" aria-label="Assistant mode">
        <button role="radio" aria-checked="${s.mode === 'guarded'}" class="${s.mode === 'guarded' ? 'active' : ''}" data-action="set-mode" data-mode="guarded" title="Guarded Interview Mode">${icon('shield')} Guarded</button>
        <button role="radio" aria-checked="${s.mode === 'normal'}" class="${s.mode === 'normal' ? 'active warn' : ''}" data-action="set-mode" data-mode="normal" title="Normal Mode (no interview guard)">${icon('unlock')} Normal</button>
      </div>
      <div class="model-picker">
        <select id="model-select" aria-label="Model" ${s.models.length ? '' : 'disabled'}>${modelOptions}</select>
        <button class="icon-btn" data-action="refresh-models" title="Refresh model list" aria-label="Refresh model list">${icon('refresh')}</button>
      </div>
    </div>`;
  $<HTMLSelectElement>('#model-select')?.addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    if (name) post({ type: 'selectModel', name });
  });
}

function banner(kind: 'warn' | 'error' | 'info', html: string, actions: string): string {
  const ic = kind === 'error' ? 'error' : kind === 'warn' ? 'warning' : 'info';
  return `<div class="banner ${kind}" role="${kind === 'info' ? 'status' : 'alert'}">${icon(ic)}<div class="banner-body">${html}${actions ? `<div class="banner-actions">${actions}</div>` : ''}</div></div>`;
}

function renderBanners(): void {
  const s = state!;
  const out: string[] = [];
  if (!s.showOnboarding) {
    const st = s.ollama.state;
    if (st === 'not-installed') {
      out.push(
        banner(
          'error',
          `${escapeHtml(s.displayName)} couldn't find Ollama. Install Ollama to use the local AI assistant.`,
          `<button class="btn" data-action="install">Install Ollama</button><button class="btn secondary" data-action="check">Check again</button>`,
        ),
      );
    } else if (st === 'installed-not-running' || st === 'unreachable-remote') {
      out.push(
        banner(
          'error',
          `${escapeHtml(s.displayName)} found Ollama but could not connect to it. Start the Ollama app, then check again.`,
          `<button class="btn" data-action="check">Check again</button><button class="btn secondary" data-action="logs">View Logs</button>`,
        ),
      );
    } else if (st === 'invalid-endpoint') {
      out.push(
        banner(
          'error',
          'The Ollama endpoint setting is not a valid http(s) URL.',
          `<button class="btn" data-action="settings">Open Settings</button>`,
        ),
      );
    } else if (st === 'running' && s.modelMissing) {
      out.push(
        banner(
          'warn',
          'The selected model is no longer available. Choose another model in the header.',
          `<button class="btn" data-action="refresh-models">Refresh</button>`,
        ),
      );
    } else if (st === 'running' && s.models.length === 0) {
      out.push(
        banner(
          'warn',
          'No Ollama models are currently installed.',
          `<button class="btn" data-action="download">Download a model…</button><button class="btn secondary" data-action="library">Browse models</button>`,
        ),
      );
    }
  }
  if (s.mode === 'normal') {
    out.push(
      banner(
        'warn',
        '<strong>Normal Mode</strong>: no interview guard. The AI can write the solution for you.',
        `<button class="btn secondary" data-action="set-mode" data-mode="guarded">${icon('shield')} Back to Guarded</button>`,
      ),
    );
  }
  if (!s.ollama.isLocal) {
    out.push(
      banner(
        'warn',
        `The Ollama endpoint <code>${escapeHtml(s.ollama.endpoint)}</code> is not on this machine. Your code and questions are sent to that server.`,
        '',
      ),
    );
  }
  $('#banners')!.innerHTML = out.join('');
}

function renderMain(): void {
  const main = $('#main')!;
  if (state!.showOnboarding) {
    main.classList.add('onboarding-mode');
    main.innerHTML = renderOnboarding();
    $('#composer')!.hidden = true;
    return;
  }
  main.classList.remove('onboarding-mode');
  $('#composer')!.hidden = false;
  const stick = isNearBottom(main);
  main.innerHTML = state!.messages.length ? state!.messages.map(renderMessage).join('') : renderEmpty();
  if (stick) main.scrollTop = main.scrollHeight;
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function renderEmpty(): string {
  const s = state!;
  const examples = [
    'Explain how requests flow through @workspace',
    'Where is authentication handled?',
    'What files are related to database connections?',
    'Give me a hint about where I should look.',
  ];
  return `
    <div class="empty">
      <div class="empty-icon">${icon(s.mode === 'guarded' ? 'shield' : 'comment-discussion')}</div>
      <h2>${s.mode === 'guarded' ? 'Guarded Interview Mode' : 'Normal Mode'}</h2>
      <p class="muted">${
        s.mode === 'guarded'
          ? 'The AI explains code, errors and concepts and helps you navigate. It won’t solve the task for you, but it will write code for an approach you describe.'
          : 'The AI behaves like an ordinary coding assistant.'
      }</p>
      <div class="examples">
        ${examples.map((e) => `<button class="example" data-action="example" data-prompt="${escapeHtml(e)}">${icon('lightbulb')}<span>${escapeHtml(e)}</span></button>`).join('')}
      </div>
      <div class="tips">
        <div><code>@file:path</code> include a file</div>
        <div><code>@selection</code> the selected code</div>
        <div><code>@workspace</code> repository overview</div>
        <div><code>@diagnostics</code> errors &amp; warnings</div>
      </div>
      ${s.hasWorkspace ? '' : `<p class="muted small">${icon('folder')} Open a folder to ask about a codebase.</p>`}
      <p class="privacy small">${icon('lock')} ${escapeHtml(s.privacy)}</p>
    </div>`;
}

function renderMessage(m: UiMessage): string {
  if (m.role === 'user') {
    return `<article class="msg user" data-id="${m.id}" aria-label="You">
      <div class="msg-head">${icon('account')}<span class="who">You</span></div>
      <div class="msg-body">${renderUserText(m.text)}</div>
    </article>`;
  }
  const badges: string[] = [];
  if (m.mode === 'guarded') {
    badges.push(
      `<span class="badge shield" title="Answered in Guarded Interview Mode">${icon('shield')}Guarded</span>`,
    );
  } else {
    badges.push(
      `<span class="badge warn" title="Answered without the interview guard">${icon('unlock')}Normal</span>`,
    );
  }
  if (m.approach) {
    badges.push(
      `<span class="badge ok" title="The AI implemented the approach you described">${icon('check')}Your approach</span>`,
    );
  }
  if (m.guardRemovals) {
    badges.push(
      `<span class="badge warn" title="The output guard removed code">${icon('eye-closed')}Guard removed ${m.guardRemovals} block${m.guardRemovals === 1 ? '' : 's'}</span>`,
    );
  }

  const sources = m.sources.length
    ? `<details class="sources"${m.status === 'streaming' ? ' open' : ''}>
        <summary>${icon('references')}Using context from ${m.sources.length} item${m.sources.length === 1 ? '' : 's'}</summary>
        <ul>${m.sources.map(renderSource).join('')}</ul>
      </details>`
    : '';
  const notes = m.notes
    .map((n) => `<div class="note">${icon('info')}<span>${renderInlineNote(n)}</span></div>`)
    .join('');
  const actions =
    m.status === 'streaming'
      ? ''
      : `<div class="msg-actions">
          ${m.text ? `<button class="icon-btn" data-action="copy-message" data-id="${m.id}" title="Copy response" aria-label="Copy response">${icon('copy')}</button>` : ''}
          ${m.retryable ? `<button class="icon-btn" data-action="retry" data-id="${m.id}" title="Retry" aria-label="Retry">${icon('refresh')}</button>` : ''}
          ${m.status === 'stopped' ? '<span class="tag">Stopped</span>' : ''}
        </div>`;
  const error =
    m.status === 'error'
      ? `<div class="error-box" role="alert">${icon('error')}<span>${escapeHtml(m.error ?? 'Something went wrong while generating the response.')}</span>
        <button class="link-btn" data-action="logs">View Logs</button></div>`
      : '';
  return `<article class="msg assistant ${m.status}" data-id="${m.id}" aria-label="AI">
    <div class="msg-head">${icon('sparkle')}<span class="who">AI</span>${m.model ? `<span class="model-tag">${escapeHtml(m.model)}</span>` : ''}<span class="badges">${badges.join('')}</span></div>
    ${sources}${notes}
    <div class="msg-body markdown" id="body-${m.id}">${renderAssistantBody(m)}</div>
    ${error}${actions}
  </article>`;
}

function renderAssistantBody(m: UiMessage): string {
  if (m.status === 'streaming' && !m.text) {
    return `<div class="thinking"><span></span><span></span><span></span></div>`;
  }
  if (m.status !== 'streaming') return renderMarkdown(m.text);
  // Render a caret placeholder inline so the cursor sits at the end of the text being written.
  return renderMarkdown(`${m.text}\u0001`, { streaming: true }).replace(
    '\u0001',
    '<span class="caret" aria-hidden="true"></span>',
  );
}

function renderSource(label: string): string {
  const m = /^(.+?):(\d+)(?:-\d+)?(?: \(selection\))?$/.exec(label);
  const path = m ? m[1]! : label.replace(/ \(selection\)$/, '');
  const line = m ? Number(m[2]) : undefined;
  const clickable = /[./]/.test(path) && !label.startsWith('Diagnostics') && label !== 'workspace tree';
  return clickable
    ? `<li><button class="link-btn file" data-action="open-file" data-path="${escapeHtml(path)}"${line ? ` data-line="${line}"` : ''}>${escapeHtml(label)}</button></li>`
    : `<li>${escapeHtml(label)}</li>`;
}

function renderInlineNote(n: string): string {
  return escapeHtml(n).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderUserText(text: string): string {
  return escapeHtml(text)
    .replace(
      /(^|\s)(@(?:file:(?:&quot;[^&]+&quot;|\S+)|selection|workspace|diagnostics|currentFile))/g,
      '$1<span class="ref">$2</span>',
    )
    .replace(/\n/g, '<br>');
}

function renderComposer(): void {
  const s = state!;
  const chip = (key: keyof Chips, ic: string, label: string, enabled: boolean, title: string) =>
    `<button class="chip ${s.chips[key] ? 'on' : ''}" data-action="chip" data-chip="${key}" aria-pressed="${s.chips[key]}" ${enabled ? '' : 'disabled'} title="${escapeHtml(title)}">${icon(ic)}<span>${escapeHtml(label)}</span></button>`;
  const fileName = s.activeFile ? s.activeFile.split('/').pop()! : 'Current file';
  $('#chips')!.innerHTML =
    chip(
      'currentFile',
      'file',
      s.activeFile ? fileName : 'Current file',
      !!s.activeFile,
      s.activeFile ? `Include ${s.activeFile} with the next message` : 'Open a workspace file to include it',
    ) +
    chip(
      'selection',
      'selection',
      'Selection',
      s.hasSelection,
      s.hasSelection
        ? 'Include the selected code with the next message'
        : 'Select code in the editor to include it',
    ) +
    chip('diagnostics', 'warning', 'Diagnostics', true, 'Include errors and warnings with the next message');

  const connected = s.ollama.state === 'running';
  const model = s.model ? escapeHtml(s.model) : 'no model';
  $('#status')!.innerHTML = `
    <span class="${s.ollama.isLocal ? '' : 'warn-text'}" title="${escapeHtml(s.privacy)}">${icon(s.ollama.isLocal ? 'lock' : 'globe')}${s.ollama.isLocal ? 'Local' : 'Remote'}</span>
    <span class="sep">·</span><span class="${connected ? '' : 'warn-text'}">${connected ? model : 'Ollama offline'}</span>
    <span class="sep">·</span><span class="${s.mode === 'normal' ? 'warn-text' : ''}">${s.mode === 'guarded' ? 'Guarded' : 'Normal'}</span>`;
  updateSendButton();
}

function updateSendButton(): void {
  const btn = $<HTMLButtonElement>('#send');
  if (!btn || !state) return;
  if (state.busy) {
    btn.dataset.action = 'stop';
    btn.title = 'Stop generating (Esc)';
    btn.setAttribute('aria-label', 'Stop generating');
    btn.innerHTML = icon('debug-stop');
    btn.classList.add('stop');
    btn.disabled = false;
  } else {
    btn.dataset.action = 'send';
    btn.title = 'Send (Enter)';
    btn.setAttribute('aria-label', 'Send');
    btn.innerHTML = icon('send');
    btn.classList.remove('stop');
    btn.disabled = !$<HTMLTextAreaElement>('#input')?.value.trim();
  }
}

// ------------------------------------------------------------------ onboarding

function renderOnboarding(): string {
  const s = state!;
  const steps = ['Welcome', 'Local AI', 'Ollama', 'Model', 'Mode'];
  const progress = `<ol class="ob-progress" aria-label="Setup progress">${steps
    .map(
      (t, i) =>
        `<li class="${i < onboardingStep ? 'done' : i === onboardingStep ? 'current' : ''}" ${i === onboardingStep ? 'aria-current="step"' : ''}><span>${t}</span></li>`,
    )
    .join('')}</ol>`;
  let body: string;
  const next = (label = 'Continue', disabled = false) =>
    `<button class="btn" data-action="ob-next" ${disabled ? 'disabled' : ''}>${label}</button>`;
  const back = onboardingStep > 0 ? `<button class="btn secondary" data-action="ob-back">Back</button>` : '';

  switch (onboardingStep) {
    case 0:
      body = `<div class="ob-hero">${icon('shield')}</div>
        <h2>Welcome to ${escapeHtml(s.displayName)}</h2>
        <p>Practice AI-assisted software engineering interviews directly inside VS Code.</p>
        <p class="muted">Open any repository, ask questions about it, and practise with an assistant that behaves like the guarded AI in real assessments.</p>
        <div class="ob-actions">${next('Get started')}</div>`;
      break;
    case 1:
      body = `<h2>Your AI runs locally</h2>
        <p>${escapeHtml(s.displayName)} uses <strong>Ollama</strong> to run your AI assistant on this machine.</p>
        <p class="privacy">${icon('lock')} ${escapeHtml(s.privacy)}</p>
        <p class="muted">No account, no API key, and it works offline once a model is installed.</p>
        <div class="ob-actions">${back}${next()}</div>`;
      break;
    case 2: {
      const st = s.ollama.state;
      let status: string;
      if (st === 'checking') {
        status = `<div class="ob-status">${icon('loading', 'codicon-modifier-spin')} Checking for Ollama…</div>`;
      } else if (st === 'running') {
        status = `<div class="ob-status ok">${icon('pass-filled')} Ollama is running${s.ollama.version ? ` (v${escapeHtml(s.ollama.version)})` : ''}.</div>`;
      } else if (st === 'not-installed') {
        status = `<div class="ob-status bad">${icon('error')} ${escapeHtml(s.displayName)} couldn't find Ollama.</div>
          <p>Install Ollama, open it, and this screen will update automatically.</p>
          <div class="ob-actions left"><button class="btn" data-action="install">${icon('link-external')} Install Ollama</button><button class="btn secondary" data-action="check">Check again</button></div>`;
      } else if (st === 'installed-not-running') {
        status = `<div class="ob-status bad">${icon('warning')} Ollama is installed but not running.</div>
          <p>Start the Ollama app (or run <code>ollama serve</code> in a terminal). This screen updates automatically.</p>
          <div class="ob-actions left"><button class="btn secondary" data-action="check">Check again</button></div>`;
      } else {
        status = `<div class="ob-status bad">${icon('warning')} ${escapeHtml(s.displayName)} found no Ollama server at <code>${escapeHtml(s.ollama.endpoint)}</code>.</div>
          <div class="ob-actions left"><button class="btn secondary" data-action="check">Check again</button><button class="btn secondary" data-action="settings">Open Settings</button></div>`;
      }
      body = `<h2>Checking for Ollama</h2>${status}
        <div class="ob-actions">${back}${next('Continue', st !== 'running')}</div>`;
      break;
    }
    case 3: {
      const list = s.models.length
        ? `<div class="ob-list" role="radiogroup" aria-label="Installed models">${s.models
            .map(
              (
                m,
              ) => `<button role="radio" aria-checked="${m.name === s.model}" class="ob-option ${m.name === s.model ? 'selected' : ''}" data-action="ob-model" data-name="${escapeHtml(m.name)}" ${m.chat ? '' : 'disabled title="Embedding models cannot chat"'}>
                ${icon(m.name === s.model ? 'pass-filled' : 'circle-large-outline')}<span class="ob-option-text"><strong>${escapeHtml(m.name)}</strong><span class="muted">${escapeHtml(m.detail)}${m.chat ? '' : ' · embedding only'}</span></span></button>`,
            )
            .join('')}</div>`
        : `<p>No Ollama models are currently installed. Pick one to download. Nothing downloads until you confirm.</p>
           <div class="ob-list">${s.suggestedModels
             .map(
               (
                 m,
               ) => `<div class="ob-option static"><span class="ob-option-text"><strong>${escapeHtml(m.name)}</strong><span class="muted">${escapeHtml(m.approxSize)} · ${escapeHtml(m.description)}</span></span>
               <button class="btn small" data-action="download" data-name="${escapeHtml(m.name)}">${icon('cloud-download')} Download</button></div>`,
             )
             .join('')}</div>
           <div class="ob-actions left"><button class="btn secondary" data-action="library">${icon('link-external')} Browse the Ollama library</button><button class="btn secondary" data-action="refresh-models">${icon('refresh')} I installed one</button></div>`;
      body = `<h2>Choose your interview model</h2>${list}
        <p class="muted small">Code-focused models such as <code>qwen2.5-coder</code> work well. Larger models give better answers but need more memory.</p>
        <div class="ob-actions">${back}${next('Continue', !s.model)}</div>`;
      break;
    }
    default:
      body = `<h2>Choose a mode</h2>
        <div class="ob-list" role="radiogroup" aria-label="Mode">
          <button role="radio" aria-checked="${onboardingMode === 'guarded'}" class="ob-option ${onboardingMode === 'guarded' ? 'selected' : ''}" data-action="ob-mode" data-mode="guarded">
            ${icon('shield')}<span class="ob-option-text"><strong>Guarded Interview Mode <span class="badge ok">Recommended</span></strong><span class="muted">Explains code, errors and concepts and helps you navigate. Won’t solve the task, but writes code for approaches you describe.</span></span></button>
          <button role="radio" aria-checked="${onboardingMode === 'normal'}" class="ob-option ${onboardingMode === 'normal' ? 'selected' : ''}" data-action="ob-mode" data-mode="normal">
            ${icon('unlock')}<span class="ob-option-text"><strong>Normal Mode</strong><span class="muted">An ordinary coding assistant. Good for learning, not for interview practice.</span></span></button>
        </div>
        <p class="muted small">You can switch modes any time from the header.</p>
        <div class="ob-actions">${back}<button class="btn" data-action="ob-finish">Finish</button></div>`;
  }
  return `<section class="onboarding">${progress}<div class="ob-card">${body}</div>
    ${onboardingStep < 4 ? `<button class="link-btn skip" data-action="ob-skip">Skip setup</button>` : ''}</section>`;
}

// ------------------------------------------------------------------ events

document.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action], code.file-link');
  if (!target || (target as HTMLButtonElement).disabled) return;
  if (target.matches('code.file-link')) {
    openFileFrom(target);
    return;
  }
  const action = target.dataset.action!;
  switch (action) {
    case 'send':
      sendMessage();
      break;
    case 'stop':
      post({ type: 'stop' });
      break;
    case 'new':
      post({ type: 'newConversation' });
      break;
    case 'settings':
      post({ type: 'openSettings' });
      break;
    case 'logs':
      post({ type: 'viewLogs' });
      break;
    case 'review-transcript':
      post({ type: 'reviewTranscript' });
      break;
    case 'refresh-models':
    case 'check':
      post({ type: 'checkOllama' });
      break;
    case 'install':
      post({ type: 'openInstallPage' });
      break;
    case 'library':
      post({ type: 'openModelLibrary' });
      break;
    case 'download':
      post({ type: 'downloadModel', name: target.dataset.name });
      break;
    case 'set-mode':
      post({ type: 'setMode', mode: target.dataset.mode === 'normal' ? 'normal' : 'guarded' });
      break;
    case 'chip': {
      const chip = target.dataset.chip as keyof Chips;
      post({ type: 'setChip', chip, value: !state?.chips[chip] });
      break;
    }
    case 'example': {
      const input = $<HTMLTextAreaElement>('#input')!;
      input.value = target.dataset.prompt ?? '';
      autosize(input);
      input.focus();
      updateSendButton();
      break;
    }
    case 'copy-message': {
      const m = state?.messages.find((x) => x.id === target.dataset.id);
      if (m) {
        post({ type: 'copy', text: m.text });
        flash(target);
      }
      break;
    }
    case 'copy-code': {
      const code = document.getElementById(target.dataset.codeId ?? '');
      if (code) {
        post({ type: 'copy', text: code.textContent ?? '' });
        flash(target);
      }
      break;
    }
    case 'retry':
      post({ type: 'retry', id: target.dataset.id! });
      break;
    case 'open-file':
      openFileFrom(target);
      break;
    case 'ob-next':
      onboardingStep = Math.min(4, onboardingStep + 1);
      if (onboardingStep === 2) post({ type: 'checkOllama' });
      saveUiState();
      renderMain();
      break;
    case 'ob-back':
      onboardingStep = Math.max(0, onboardingStep - 1);
      saveUiState();
      renderMain();
      break;
    case 'ob-model':
      if (target.dataset.name) post({ type: 'selectModel', name: target.dataset.name });
      break;
    case 'ob-mode':
      onboardingMode = target.dataset.mode === 'normal' ? 'normal' : 'guarded';
      renderMain();
      break;
    case 'ob-finish':
      post({ type: 'completeOnboarding', mode: onboardingMode });
      onboardingStep = 0;
      saveUiState();
      break;
    case 'ob-skip':
      post({ type: 'completeOnboarding', mode: state?.mode ?? 'guarded' });
      break;
  }
});

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if ((e.key === 'Enter' || e.key === ' ') && t.matches('code.file-link')) {
    e.preventDefault();
    openFileFrom(t);
  }
});

function openFileFrom(el: HTMLElement): void {
  const relPath = el.dataset.path;
  if (!relPath) return;
  const line = el.dataset.line ? Number(el.dataset.line) : undefined;
  post({ type: 'openFile', relPath, line });
}

function flash(el: HTMLElement): void {
  const ic = el.querySelector('.codicon');
  if (!ic) return;
  ic.classList.replace('codicon-copy', 'codicon-check');
  setTimeout(() => ic.classList.replace('codicon-check', 'codicon-copy'), 1200);
}

function scheduleMessageRender(id: string): void {
  pendingRender.add(id);
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    const main = $('#main')!;
    const stick = isNearBottom(main);
    for (const pid of pendingRender) {
      const m = state?.messages.find((x) => x.id === pid);
      const body = document.getElementById(`body-${pid}`);
      if (m && body) body.innerHTML = renderAssistantBody(m);
    }
    pendingRender.clear();
    if (stick) main.scrollTop = main.scrollHeight;
  });
}

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      state = msg.state;
      render();
      break;
    case 'append': {
      const m = state?.messages.find((x) => x.id === msg.id);
      if (m) {
        m.text += msg.text;
        scheduleMessageRender(msg.id);
      }
      break;
    }
    case 'message': {
      if (!state) break;
      const i = state.messages.findIndex((x) => x.id === msg.message.id);
      if (i >= 0) {
        state.messages[i] = msg.message;
        const el = document.querySelector(`article[data-id="${msg.message.id}"]`);
        if (el) el.outerHTML = renderMessage(msg.message);
      }
      break;
    }
    case 'editor':
      if (state) {
        state.activeFile = msg.activeFile;
        state.hasSelection = msg.hasSelection;
        renderComposer();
      }
      break;
    case 'prefill': {
      const input = $<HTMLTextAreaElement>('#input');
      if (!input) break;
      input.value = msg.text + (input.value && !input.value.startsWith(msg.text) ? input.value : '');
      autosize(input);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      updateSendButton();
      if (msg.send) sendMessage();
      break;
    }
    case 'focusInput':
      $<HTMLTextAreaElement>('#input')?.focus();
      break;
  }
});

mountSkeleton();
post({ type: 'ready' });
