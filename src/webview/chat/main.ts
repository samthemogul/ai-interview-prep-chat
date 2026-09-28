import type {
  ChatMode,
  Chips,
  EditAction,
  HostToWebview,
  Mode,
  UiEdit,
  UiMessage,
  ViewState,
  WebviewToHost,
} from '../../chat/protocol';
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
      <div class="composer-bar">
        <div class="segmented small" id="chat-modes" role="radiogroup" aria-label="Chat mode"></div>
        <div class="chips" id="chips" role="group" aria-label="Context to include"></div>
      </div>
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
        <button role="radio" aria-checked="${s.mode === 'normal'}" class="${s.mode === 'normal' ? 'active warn' : ''}" data-action="set-mode" data-mode="normal" title="Unguarded Mode (no interview guard)">${icon('unlock')} Unguarded</button>
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
        '<strong>Unguarded Mode</strong>: no interview guard. The AI can write the solution for you.',
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
      <div class="empty-icon">${icon(s.mode === 'guarded' ? 'shield' : 'unlock')}</div>
      <h2>${s.mode === 'guarded' ? 'Guarded' : 'Unguarded'} · ${CHAT_MODE_NAMES[s.chatMode]}</h2>
      <p class="muted">${escapeHtml(emptyDescription(s.mode, s.chatMode))}</p>
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

const CHAT_MODE_NAMES: Record<ChatMode, string> = { ask: 'Ask', plan: 'Plan', agent: 'Agent' };
const CHAT_MODE_ICONS: Record<ChatMode, string> = { ask: 'comment', plan: 'checklist', agent: 'tools' };
const CHAT_MODE_TITLES: Record<ChatMode, string> = {
  ask: 'Ask: questions and answers. The AI never touches your files.',
  plan: 'Plan: build an implementation plan before writing code.',
  agent: 'Agent: the AI proposes file edits you review as a diff and accept or reject.',
};

function emptyDescription(mode: Mode, chatMode: ChatMode): string {
  if (mode === 'guarded') {
    if (chatMode === 'plan') {
      return 'Outline your plan and the AI reviews it with questions. It won’t write the plan or the solution for you.';
    }
    if (chatMode === 'agent') {
      return 'Describe how to do something and the AI edits your files to implement exactly that. You review each edit as a diff. It won’t solve the task for you.';
    }
    return 'The AI explains code, errors and concepts and helps you navigate. It won’t solve the task for you, but it will write code for an approach you describe.';
  }
  if (chatMode === 'plan') {
    return 'The AI drafts and refines an implementation plan with you. When it looks right, hand it to the agent.';
  }
  if (chatMode === 'agent') {
    return 'The AI edits your files. Every change is shown as a diff that you accept or reject.';
  }
  return 'The AI behaves like an ordinary coding assistant and can solve the task for you.';
}

function placeholderFor(mode: Mode, chatMode: ChatMode): string {
  if (chatMode === 'plan') return mode === 'guarded' ? 'Outline your plan…' : 'What should we plan?';
  if (chatMode === 'agent') {
    return mode === 'guarded' ? 'Describe the change and how to do it…' : 'What should the agent change?';
  }
  return 'Ask about this codebase…  (@file, @selection, @workspace, @diagnostics)';
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
      `<span class="badge warn" title="Answered without the interview guard">${icon('unlock')}Unguarded</span>`,
    );
  }
  if (m.chatMode && m.chatMode !== 'ask') {
    badges.push(
      `<span class="badge">${icon(CHAT_MODE_ICONS[m.chatMode])}${CHAT_MODE_NAMES[m.chatMode]}</span>`,
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
          ${m.retryable && m.chatMode === 'plan' && m.mode === 'normal' && m.status === 'done' ? `<button class="btn small" data-action="implement-plan" data-id="${m.id}" title="Switch to Agent mode and implement this plan">${icon('tools')} Implement with Agent</button>` : ''}
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
  const streaming = m.status === 'streaming';
  // Split the text on edit placeholders; each placeholder becomes an edit card.
  const parts = m.text.split(/^%%EDIT:([\w-]+)%%$/m);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      html += renderEditCard(m, parts[i]!);
      continue;
    }
    const segment = parts[i]!;
    const last = i === parts.length - 1;
    if (streaming && last) {
      // Render a caret placeholder inline so the cursor sits at the end of the text being written.
      html += renderMarkdown(`${segment}\u0001`, { streaming: true }).replace(
        '\u0001',
        '<span class="caret" aria-hidden="true"></span>',
      );
    } else if (segment.trim()) {
      html += renderMarkdown(segment);
    }
  }
  return html;
}

const EDIT_STATUS: Record<UiEdit['status'], { label: string; icon: string; cls: string }> = {
  pending: { label: 'Waiting for your review', icon: 'circle-large-outline', cls: 'pending' },
  accepted: { label: 'Applied', icon: 'pass-filled', cls: 'ok' },
  rejected: { label: 'Rejected', icon: 'circle-slash', cls: 'muted' },
  reverted: { label: 'Reverted', icon: 'discard', cls: 'muted' },
  failed: { label: 'Not applied', icon: 'error', cls: 'bad' },
  expired: { label: 'Expired (proposed in an earlier session)', icon: 'history', cls: 'muted' },
};

function renderEditCard(m: UiMessage, editId: string): string {
  const e = m.edits?.find((x) => x.id === editId);
  if (!e) {
    return `<div class="edit-card preparing">${icon('loading', 'codicon-modifier-spin')}<span>Preparing edit…</span></div>`;
  }
  const st = EDIT_STATUS[e.status];
  const name = e.path.split('/').pop() ?? e.path;
  const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
  const btn = (action: EditAction, label: string, ic: string, cls = 'secondary') =>
    `<button class="btn small ${cls}" data-action="edit" data-edit-action="${action}" data-msg="${m.id}" data-edit="${e.id}">${icon(ic)} ${label}</button>`;
  const preview = e.preview.length
    ? `<pre class="edit-preview">${e.preview
        .map((l) =>
          l.t === '…'
            ? `<span class="ln skip">${escapeHtml(l.s || '…')}</span>`
            : `<span class="ln ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}"><span class="sign">${l.t}</span>${escapeHtml(l.s) || ' '}</span>`,
        )
        .join('')}</pre>`
    : '';
  const actions =
    e.status === 'pending'
      ? `${btn('diff', 'Review diff', 'diff')}${btn('accept', 'Accept', 'check', '')}${btn('reject', 'Reject', 'close')}`
      : e.status === 'accepted'
        ? `${btn('diff', 'View diff', 'diff')}${btn('revert', 'Revert', 'discard')}`
        : '';
  return `<div class="edit-card ${st.cls}" data-edit-id="${e.id}">
    <div class="edit-head">
      ${icon(e.isNew ? 'new-file' : 'edit')}
      <button class="link-btn file" data-action="open-file" data-path="${escapeHtml(e.path)}" title="${escapeHtml(e.path)}">${escapeHtml(name)}</button>
      ${dir ? `<span class="muted small">${escapeHtml(dir)}</span>` : ''}
      ${e.added || e.removed ? `<span class="counts"><span class="add">+${e.added}</span> <span class="del">−${e.removed}</span></span>` : ''}
      <span class="edit-status ${st.cls}" title="${escapeHtml(st.label)}">${icon(st.icon)}<span>${escapeHtml(st.label)}</span></span>
    </div>
    ${e.inferredPath ? `<div class="note">${icon('info')}<span>The model didn't name a file, so this edit targets <code>${escapeHtml(e.path)}</code>.</span></div>` : ''}
    ${e.error ? `<div class="note warn-text">${icon('warning')}<span>${escapeHtml(e.error)}</span></div>` : ''}
    ${preview}
    ${actions ? `<div class="edit-actions">${actions}</div>` : ''}
  </div>`;
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
    <span class="sep">·</span><span class="${s.mode === 'normal' ? 'warn-text' : ''}">${s.mode === 'guarded' ? 'Guarded' : 'Unguarded'}</span>
    <span class="sep">·</span><span>${CHAT_MODE_NAMES[s.chatMode]}</span>`;
  $('#chat-modes')!.innerHTML = (['ask', 'plan', 'agent'] as ChatMode[])
    .map(
      (cm) =>
        `<button role="radio" aria-checked="${s.chatMode === cm}" class="${s.chatMode === cm ? 'active' : ''}" data-action="set-chat-mode" data-chat-mode="${cm}" title="${escapeHtml(CHAT_MODE_TITLES[cm])}">${icon(CHAT_MODE_ICONS[cm])} ${CHAT_MODE_NAMES[cm]}</button>`,
    )
    .join('');
  const input = $<HTMLTextAreaElement>('#input');
  if (input) input.placeholder = placeholderFor(s.mode, s.chatMode);
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
            ${icon('unlock')}<span class="ob-option-text"><strong>Unguarded Mode</strong><span class="muted">An ordinary coding assistant that can solve the task, like the unguarded Code Repos assistant in real assessments.</span></span></button>
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
        post({
          type: 'copy',
          text: m.text
            .replace(/^%%EDIT:[\w-]+%%$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim(),
        });
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
    case 'set-chat-mode': {
      const cm = target.dataset.chatMode;
      if (cm === 'ask' || cm === 'plan' || cm === 'agent') post({ type: 'setChatMode', chatMode: cm });
      break;
    }
    case 'edit': {
      const a = target.dataset.editAction as EditAction | undefined;
      if (a && target.dataset.msg && target.dataset.edit) {
        post({ type: 'editAction', messageId: target.dataset.msg, editId: target.dataset.edit, action: a });
      }
      break;
    }
    case 'implement-plan':
      post({ type: 'implementPlan', messageId: target.dataset.id ?? '' });
      break;
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
