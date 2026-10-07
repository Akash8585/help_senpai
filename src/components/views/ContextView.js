import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

const SECTIONS = [
    {
        kind: 'resume',
        title: 'Resume',
        subtitle: 'Used to answer "tell me about yourself", experience and project questions in your own words.',
        inputs: ['file', 'text'],
    },
    {
        kind: 'portfolio',
        title: 'Portfolio',
        subtitle: 'Personal site, GitHub profile, Behance or Dribbble. LinkedIn needs a login, so upload its PDF export as your resume instead.',
        inputs: ['url'],
        placeholder: 'https://yourname.dev',
    },
    {
        kind: 'assignment',
        title: 'Company assignment',
        subtitle: 'Take-home brief, job description or task. Works with web pages, Google Docs shared by link, PDFs, Notion pages and GitHub links.',
        inputs: ['url', 'file', 'text'],
        placeholder: 'https://company.com/assignment or a Google Doc link',
    },
    {
        kind: 'repo',
        title: 'GitHub repositories',
        subtitle: 'Your take-home solution or projects you will be asked about. README, manifests and the most relevant source files are read.',
        inputs: ['url'],
        placeholder: 'https://github.com/you/repo',
    },
];

const formatTokens = chars => {
    const tokens = Math.round(chars / 4);
    return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
};

export class ContextView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            .summary {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-md);
                flex-wrap: wrap;
            }

            .section-head {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: var(--space-md);
            }

            .input-row {
                display: flex;
                gap: var(--space-sm);
                flex-wrap: wrap;
            }

            .input-row .control {
                flex: 1;
                min-width: 220px;
                width: auto;
            }

            .control.wide {
                width: 100%;
            }

            .btn {
                background: var(--bg-elevated);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 8px 12px;
                font-size: var(--font-size-sm);
                cursor: pointer;
                white-space: nowrap;
                transition:
                    border-color var(--transition),
                    background var(--transition);
            }

            .btn:hover:not(:disabled) {
                border-color: var(--text-muted);
                background: var(--bg-hover);
            }

            .btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .btn.primary {
                background: var(--btn-primary-bg);
                color: var(--btn-primary-text);
                border-color: var(--btn-primary-bg);
            }

            .btn.primary:hover:not(:disabled) {
                background: var(--btn-primary-hover);
            }

            .btn.small {
                padding: 4px 8px;
                font-size: var(--font-size-xs);
            }

            .btn.link {
                background: none;
                border: none;
                padding: 4px 6px;
                color: var(--text-secondary);
            }

            .btn.link:hover:not(:disabled) {
                color: var(--text-primary);
                background: none;
            }

            .btn.link.danger:hover:not(:disabled) {
                color: var(--danger, #ef4444);
            }

            .items {
                display: flex;
                flex-direction: column;
                gap: var(--space-xs);
                margin-top: var(--space-sm);
            }

            .item {
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
                padding: 8px 10px;
            }

            .item-row {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
            }

            .status-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                flex-shrink: 0;
                background: var(--text-muted);
            }

            .status-dot.ready {
                background: var(--success-color, #4caf50);
            }

            .status-dot.error {
                background: var(--danger, #ef4444);
            }

            .status-dot.loading {
                background: var(--accent);
                animation: pulse 1s ease-in-out infinite;
            }

            @keyframes pulse {
                50% {
                    opacity: 0.3;
                }
            }

            .item-text {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .item-title {
                color: var(--text-primary);
                font-size: var(--font-size-sm);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .item-meta {
                color: var(--text-muted);
                font-size: var(--font-size-xs);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .item-meta.error {
                color: var(--danger, #ef4444);
                white-space: normal;
            }

            .preview {
                margin-top: var(--space-sm);
                max-height: 280px;
                overflow: auto;
                padding: var(--space-sm);
                border-radius: var(--radius-sm);
                background: var(--bg-app);
                color: var(--text-secondary);
                font-family: var(--font-mono);
                font-size: 11px;
                line-height: 1.5;
                white-space: pre-wrap;
                word-break: break-word;
                user-select: text;
                cursor: text;
            }

            .preview * {
                user-select: text;
            }

            .paste-box {
                display: flex;
                flex-direction: column;
                gap: var(--space-sm);
                margin-top: var(--space-sm);
            }

            .paste-actions {
                display: flex;
                gap: var(--space-sm);
                justify-content: flex-end;
            }

            .error-text {
                color: var(--danger, #ef4444);
                font-size: var(--font-size-xs);
                margin-top: var(--space-xs);
            }

            .subsection {
                margin-top: var(--space-md);
                padding-top: var(--space-md);
                border-top: 1px solid var(--border);
                display: flex;
                flex-direction: column;
                gap: var(--space-xs);
            }

            .label {
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
            }

            input[type='file'] {
                display: none;
            }
        `,
    ];

    static properties = {
        _summary: { state: true },
        _urls: { state: true },
        _pasteOpen: { state: true },
        _pasteText: { state: true },
        _errors: { state: true },
        _previews: { state: true },
        _instructions: { state: true },
        _githubToken: { state: true },
        _showToken: { state: true },
    };

    constructor() {
        super();
        this._summary = { items: [], repoInstructions: '', hasGithubToken: false, promptChars: 0 };
        this._urls = {};
        this._pasteOpen = {};
        this._pasteText = {};
        this._errors = {};
        this._previews = {};
        this._instructions = '';
        this._githubToken = '';
        this._showToken = false;
        this._instructionsTimer = null;
    }

    connectedCallback() {
        super.connectedCallback();
        this._unsubscribe = senpai.knowledge.onUpdate(summary => this._applySummary(summary));
        senpai.knowledge.get().then(result => {
            if (result.success) {
                this._applySummary(result.data);
                this._instructions = result.data.repoInstructions;
            }
        });
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._unsubscribe?.();
        clearTimeout(this._instructionsTimer);
    }

    _applySummary(summary) {
        this._summary = summary;
        // Refresh open previews whose items finished re-fetching.
        for (const id of Object.keys(this._previews)) {
            if (!summary.items.some(item => item.id === id)) {
                const { [id]: _, ...rest } = this._previews;
                this._previews = rest;
            }
        }
    }

    _setError(kind, message) {
        this._errors = { ...this._errors, [kind]: message };
    }

    async _run(kind, action) {
        this._setError(kind, '');
        const result = await action();
        if (!result.success) this._setError(kind, result.error);
        return result;
    }

    async _addUrl(kind) {
        const url = (this._urls[kind] || '').trim();
        if (!url) return;
        this._urls = { ...this._urls, [kind]: '' };
        const result = await this._run(kind, () => senpai.knowledge.addUrl(kind, url));
        if (!result.success) this._urls = { ...this._urls, [kind]: url };
    }

    _pickFile(kind) {
        this.shadowRoot.querySelector(`input[type='file'][data-kind='${kind}']`)?.click();
    }

    async _onFileChosen(kind, event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (file.size > 15 * 1024 * 1024) {
            this._setError(kind, 'File is larger than 15 MB');
            return;
        }
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
        await this._run(kind, () => senpai.knowledge.addFile(kind, file.name, base64));
    }

    _togglePaste(kind) {
        this._pasteOpen = { ...this._pasteOpen, [kind]: !this._pasteOpen[kind] };
    }

    async _savePaste(kind, title) {
        const text = (this._pasteText[kind] || '').trim();
        if (!text) return;
        const result = await this._run(kind, () => senpai.knowledge.addText(kind, text, title));
        if (result.success) {
            this._pasteText = { ...this._pasteText, [kind]: '' };
            this._pasteOpen = { ...this._pasteOpen, [kind]: false };
        }
    }

    async _togglePreview(item) {
        if (this._previews[item.id] !== undefined) {
            const { [item.id]: _, ...rest } = this._previews;
            this._previews = rest;
            return;
        }
        const result = await senpai.knowledge.getContent(item.id);
        this._previews = { ...this._previews, [item.id]: result.success ? result.data : result.error };
    }

    _saveInstructions(value) {
        this._instructions = value;
        clearTimeout(this._instructionsTimer);
        this._instructionsTimer = setTimeout(() => senpai.knowledge.setRepoInstructions(value), 400);
    }

    async _saveToken() {
        await this._run('repo', () => senpai.knowledge.setGithubToken(this._githubToken));
        this._githubToken = '';
        this._showToken = false;
    }

    _itemMeta(item) {
        if (item.status === 'loading') return 'Fetching and reading…';
        if (item.status === 'error') return item.error;
        const parts = [];
        if (item.sourceType === 'url' && item.source !== item.title) parts.push(item.source);
        if (item.meta?.files) parts.push(`${item.meta.files} of ${item.meta.totalFiles} files`);
        parts.push(`~${formatTokens(item.chars)} tokens`);
        return parts.join(' · ');
    }

    _renderItem(item) {
        const preview = this._previews[item.id];
        return html`
            <div class="item">
                <div class="item-row">
                    <span class="status-dot ${item.status}"></span>
                    <div class="item-text">
                        <span class="item-title" title=${item.title}>${item.title}</span>
                        <span class="item-meta ${item.status === 'error' ? 'error' : ''}" title=${item.source}>${this._itemMeta(item)}</span>
                    </div>
                    ${item.status === 'ready' ? html`<button class="btn link small" @click=${() => this._togglePreview(item)}>${preview !== undefined ? 'Hide' : 'View'}</button>` : ''}
                    ${
                        item.sourceType === 'url' && item.status !== 'loading'
                            ? html`<button class="btn link small" @click=${() => this._run(item.kind, () => senpai.knowledge.refresh(item.id))}>
                                  Refresh
                              </button>`
                            : ''
                    }
                    <button class="btn link small danger" @click=${() => senpai.knowledge.remove(item.id)}>Remove</button>
                </div>
                ${preview !== undefined ? html`<div class="preview">${preview}</div>` : ''}
            </div>
        `;
    }

    _renderSection(section) {
        const { kind } = section;
        const items = this._summary.items.filter(item => item.kind === kind);

        return html`
            <section class="surface">
                <div class="surface-title">${section.title}</div>
                <div class="surface-subtitle">${section.subtitle}</div>

                <div class="input-row">
                    ${
                        section.inputs.includes('url')
                            ? html`
                                  <input
                                      class="control"
                                      type="url"
                                      placeholder=${section.placeholder}
                                      .value=${this._urls[kind] || ''}
                                      @input=${e => (this._urls = { ...this._urls, [kind]: e.target.value })}
                                      @keydown=${e => e.key === 'Enter' && this._addUrl(kind)}
                                  />
                                  <button class="btn primary" ?disabled=${!(this._urls[kind] || '').trim()} @click=${() => this._addUrl(kind)}>
                                      Add link
                                  </button>
                              `
                            : ''
                    }
                    ${
                        section.inputs.includes('file')
                            ? html`
                                  <input type="file" data-kind=${kind} accept=".pdf,.docx,.txt,.md" @change=${e => this._onFileChosen(kind, e)} />
                                  <button class="btn ${section.inputs.includes('url') ? '' : 'primary'}" @click=${() => this._pickFile(kind)}>
                                      Upload PDF / DOCX / TXT
                                  </button>
                              `
                            : ''
                    }
                    ${
                        section.inputs.includes('text')
                            ? html`<button class="btn" @click=${() => this._togglePaste(kind)}>
                                  ${this._pasteOpen[kind] ? 'Cancel' : 'Paste text'}
                              </button>`
                            : ''
                    }
                </div>

                ${
                    this._pasteOpen[kind]
                        ? html`
                              <div class="paste-box">
                                  <textarea
                                      class="control"
                                      placeholder="Paste the full text here"
                                      .value=${this._pasteText[kind] || ''}
                                      @input=${e => (this._pasteText = { ...this._pasteText, [kind]: e.target.value })}
                                  ></textarea>
                                  <div class="paste-actions">
                                      <button class="btn primary" @click=${() => this._savePaste(kind, `${section.title} (pasted)`)}>Save</button>
                                  </div>
                              </div>
                          `
                        : ''
                }
                ${this._errors[kind] ? html`<div class="error-text">${this._errors[kind]}</div>` : ''}
                ${items.length ? html`<div class="items">${items.map(item => this._renderItem(item))}</div>` : ''}
                ${kind === 'repo' ? this._renderRepoExtras() : ''}
            </section>
        `;
    }

    _renderRepoExtras() {
        return html`
            <div class="subsection">
                <label class="label">What should Senpai do with these repos?</label>
                <textarea
                    class="control"
                    placeholder="e.g. This is my take-home for Acme. The interviewer will ask me to walk through the architecture, justify the database choice, and live-code pagination for GET /orders. Help me explain decisions and write the extension in the same style."
                    .value=${this._instructions}
                    @input=${e => this._saveInstructions(e.target.value)}
                ></textarea>
            </div>

            <div class="subsection">
                <label class="label"
                    >GitHub token
                    ${this._summary.hasGithubToken ? html`<span class="pill">saved</span>` : html`<span class="muted">(optional)</span>`}</label
                >
                <div class="form-help">
                    Needed for private repos, or if you hit GitHub's limit of 60 requests per hour. A fine-grained token with read-only "Contents"
                    access is enough.
                </div>
                ${
                    this._showToken
                        ? html`
                              <div class="input-row">
                                  <input
                                      class="control"
                                      type="password"
                                      placeholder="github_pat_..."
                                      .value=${this._githubToken}
                                      @input=${e => (this._githubToken = e.target.value)}
                                  />
                                  <button class="btn primary" @click=${() => this._saveToken()}>
                                      ${this._githubToken.trim() ? 'Save token' : 'Clear token'}
                                  </button>
                              </div>
                          `
                        : html`<div>
                              <button class="btn small" @click=${() => (this._showToken = true)}>
                                  ${this._summary.hasGithubToken ? 'Replace or clear token' : 'Add token'}
                              </button>
                          </div>`
                }
            </div>
        `;
    }

    render() {
        const { items, promptChars } = this._summary;
        const loading = items.filter(item => item.status === 'loading').length;

        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div>
                        <div class="page-title">Context</div>
                        <div class="page-subtitle">
                            Add your resume, portfolio, repos and the company assignment. Senpai answers questions about them, along with coding, DSA
                            and system design questions.
                        </div>
                    </div>

                    <section class="surface summary">
                        <span class="label">
                            ${
                                promptChars
                                    ? html`About <strong>${formatTokens(promptChars)} tokens</strong> of context are sent with every answer`
                                    : 'Nothing added yet'
                            }
                            ${loading ? html` · <span class="muted">${loading} still loading</span>` : ''}
                        </span>
                        <span class="form-help">Applies to the next session you start.</span>
                    </section>

                    ${SECTIONS.map(section => this._renderSection(section))}
                </div>
            </div>
        `;
    }
}

customElements.define('context-view', ContextView);
