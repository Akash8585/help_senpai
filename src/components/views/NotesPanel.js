import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

const EMPTY_DRAFT = { title: '', body: '', shareWithAI: false };

const escapeHtml = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Note bodies are markdown (saved AI answers often are). Scripts, embeds and event handlers are stripped. */
function renderMarkdown(text) {
    if (!window.marked) return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
    const doc = new DOMParser().parseFromString(window.marked.parse(text, { breaks: true, gfm: true }), 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, link, meta, form').forEach(node => node.remove());
    for (const node of doc.body.querySelectorAll('*')) {
        for (const attr of [...node.attributes]) {
            if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
        }
    }
    return doc.body.innerHTML;
}

/**
 * Split pasted text into note chunks: by markdown headings if present, else by --- separators,
 * else by blank-line separated blocks. The first short line of a block becomes its title.
 */
export function splitIntoChunks(text) {
    const source = (text || '').replace(/\r\n/g, '\n').trim();
    if (!source) return [];
    const lines = source.split('\n');

    let parts;
    if (lines.some(line => /^#{1,6}\s+\S/.test(line))) {
        parts = [];
        let current = null;
        for (const line of lines) {
            const heading = line.match(/^#{1,6}\s+(.*)$/);
            if (heading) {
                if (current) parts.push(current);
                current = { title: heading[1].trim(), body: [] };
            } else {
                (current ??= { title: '', body: [] }).body.push(line);
            }
        }
        if (current) parts.push(current);
        parts = parts.map(part => ({ title: part.title, body: part.body.join('\n').trim() }));
    } else {
        const blocks = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/m.test(source) ? source.split(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/m) : source.split(/\n\s*\n/);
        parts = blocks
            .map(block => block.trim())
            .filter(Boolean)
            .map(block => {
                const [first, ...rest] = block.split('\n');
                const useFirstAsTitle = rest.length > 0 && first.length <= 80;
                return useFirstAsTitle
                    ? {
                          title: first
                              .replace(/^[-*•]\s*/, '')
                              .replace(/:$/, '')
                              .trim(),
                          body: rest.join('\n').trim(),
                      }
                    : { title: '', body: block };
            });
    }

    return parts.filter(part => part.title || part.body);
}

export class NotesPanel extends LitElement {
    static styles = css`
        * {
            box-sizing: border-box;
            font-family: var(--font);
        }

        :host {
            display: flex;
            flex-direction: column;
            min-height: 0;
            height: 100%;
            color: var(--text-primary);
        }

        :host([compact]) {
            background: var(--bg-surface);
            border-left: 1px solid var(--border);
        }

        .toolbar {
            display: flex;
            gap: var(--space-xs);
            align-items: center;
            padding: var(--space-sm);
            flex-wrap: wrap;
        }

        :host(:not([compact])) .toolbar {
            padding: 0 0 var(--space-sm);
        }

        .panel-title {
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-semibold);
            margin-right: auto;
        }

        .search {
            flex: 1;
            min-width: 120px;
        }

        :host([compact]) .search {
            flex-basis: 100%;
            order: 3;
        }

        input,
        textarea {
            width: 100%;
            background: var(--bg-elevated);
            color: var(--text-primary);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            padding: 6px 10px;
            font-size: var(--font-size-sm);
            font-family: var(--font);
        }

        input:focus,
        textarea:focus {
            outline: none;
            border-color: var(--accent);
        }

        textarea {
            resize: vertical;
            min-height: 90px;
            line-height: 1.45;
        }

        .btn {
            background: var(--bg-elevated);
            color: var(--text-primary);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            padding: 5px 10px;
            font-size: var(--font-size-xs);
            cursor: pointer;
            white-space: nowrap;
        }

        .btn:hover:not(:disabled) {
            border-color: var(--text-muted);
            background: var(--bg-hover);
        }

        .btn:disabled {
            opacity: 0.45;
            cursor: not-allowed;
        }

        .btn.primary {
            background: var(--btn-primary-bg);
            color: var(--btn-primary-text);
            border-color: var(--btn-primary-bg);
        }

        .btn.ghost {
            background: none;
            border-color: transparent;
            color: var(--text-secondary);
            padding: 3px 6px;
        }

        .btn.ghost:hover:not(:disabled) {
            color: var(--text-primary);
            background: var(--bg-hover);
        }

        .btn.danger {
            color: var(--danger, #ef4444);
        }

        .list {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: var(--space-xs);
            padding: 0 var(--space-sm) var(--space-sm);
        }

        :host(:not([compact])) .list {
            padding: 0;
            overflow: visible;
        }

        .card {
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            background: var(--bg-elevated);
            padding: 8px 10px;
        }

        .card-head {
            display: flex;
            align-items: flex-start;
            gap: var(--space-xs);
            cursor: pointer;
        }

        .card-title {
            flex: 1;
            min-width: 0;
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-medium);
            overflow-wrap: anywhere;
        }

        .card-title.untitled {
            color: var(--text-muted);
            font-weight: normal;
        }

        .ai-badge {
            font-size: 10px;
            padding: 1px 5px;
            border-radius: 999px;
            border: 1px solid var(--accent);
            color: var(--accent);
            flex-shrink: 0;
        }

        .card-body {
            margin-top: 4px;
            font-size: var(--font-size-xs);
            color: var(--text-secondary);
            line-height: 1.5;
            overflow-wrap: anywhere;
            user-select: text;
            cursor: text;
        }

        .card-body.clamped {
            max-height: 4.6em;
            overflow: hidden;
            -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent);
        }

        :host(:not([compact])) .card-body.clamped {
            max-height: 9.2em;
        }

        .card-body > :first-child {
            margin-top: 0;
        }

        .card-body > :last-child {
            margin-bottom: 0;
        }

        .card-body p,
        .card-body ul,
        .card-body ol,
        .card-body pre {
            margin: 0 0 0.5em;
        }

        .card-body ul,
        .card-body ol {
            padding-left: 1.3em;
        }

        .card-body h1,
        .card-body h2,
        .card-body h3,
        .card-body h4 {
            font-size: 1em;
            margin: 0.6em 0 0.3em;
            color: var(--text-primary);
        }

        .card-body strong {
            color: var(--text-primary);
        }

        .card-body code {
            font-family: var(--font-mono);
            font-size: 0.95em;
            background: var(--bg-app);
            padding: 1px 4px;
            border-radius: 3px;
        }

        .card-body pre {
            background: var(--bg-app);
            padding: 6px 8px;
            border-radius: var(--radius-sm);
            overflow-x: auto;
        }

        .card-body pre code {
            padding: 0;
            background: none;
        }

        .card-actions {
            display: flex;
            align-items: center;
            gap: 2px;
            margin-top: 6px;
            flex-wrap: wrap;
        }

        .share-toggle {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: var(--font-size-xs);
            color: var(--text-secondary);
            margin-right: auto;
            cursor: pointer;
        }

        .share-toggle input {
            width: 13px;
            height: 13px;
            padding: 0;
            accent-color: var(--accent);
        }

        .editor {
            display: flex;
            flex-direction: column;
            gap: var(--space-xs);
            border: 1px solid var(--accent);
            border-radius: var(--radius-sm);
            background: var(--bg-elevated);
            padding: var(--space-sm);
            margin: 0 var(--space-sm) var(--space-sm);
        }

        :host(:not([compact])) .editor {
            margin: 0 0 var(--space-sm);
        }

        .card .editor {
            margin: 0;
            border: none;
            padding: 0;
        }

        .editor-actions {
            display: flex;
            gap: var(--space-xs);
            align-items: center;
        }

        .hint {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            margin-right: auto;
        }

        .empty {
            color: var(--text-muted);
            font-size: var(--font-size-xs);
            text-align: center;
            padding: var(--space-lg) var(--space-sm);
            line-height: 1.5;
        }

        .error {
            color: var(--danger, #ef4444);
            font-size: var(--font-size-xs);
            padding: 0 var(--space-sm) var(--space-xs);
        }

        .split {
            display: flex;
            flex-direction: column;
            gap: var(--space-xs);
            margin-bottom: var(--space-sm);
            padding: var(--space-sm);
            border: 1px dashed var(--border);
            border-radius: var(--radius-sm);
        }

        .split textarea {
            min-height: 140px;
        }
    `;

    static properties = {
        compact: { type: Boolean, reflect: true },
        currentAnswer: { type: String },
        _notes: { state: true },
        _query: { state: true },
        _editingId: { state: true },
        _draft: { state: true },
        _expanded: { state: true },
        _copiedId: { state: true },
        _confirmDeleteId: { state: true },
        _error: { state: true },
        _splitOpen: { state: true },
        _splitText: { state: true },
    };

    constructor() {
        super();
        this.compact = false;
        this.currentAnswer = '';
        this._notes = [];
        this._query = '';
        this._editingId = null;
        this._draft = { ...EMPTY_DRAFT };
        this._expanded = new Set();
        this._copiedId = null;
        this._confirmDeleteId = null;
        this._error = '';
        this._splitOpen = false;
        this._splitText = '';
    }

    connectedCallback() {
        super.connectedCallback();
        this._unsubscribe = senpai.notes.onUpdate(list => (this._notes = list));
        senpai.notes.list().then(result => {
            if (result.success) this._notes = result.data;
        });
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._unsubscribe?.();
        clearTimeout(this._copiedTimer);
    }

    _filtered() {
        const query = this._query.trim().toLowerCase();
        if (!query) return this._notes;
        return this._notes.filter(note => `${note.title}\n${note.body}`.toLowerCase().includes(query));
    }

    _startNew(prefill = {}) {
        this._editingId = 'new';
        this._draft = { ...EMPTY_DRAFT, ...prefill };
        this._error = '';
        this.updateComplete.then(() => this.shadowRoot.querySelector('.editor textarea')?.focus());
    }

    _startEdit(note) {
        this._editingId = note.id;
        this._draft = { title: note.title, body: note.body, shareWithAI: note.shareWithAI };
        this._error = '';
    }

    _cancelEdit() {
        this._editingId = null;
        this._draft = { ...EMPTY_DRAFT };
        this._error = '';
    }

    async _saveDraft() {
        const payload = { ...this._draft, ...(this._editingId !== 'new' ? { id: this._editingId } : {}) };
        const result = await senpai.notes.save(payload);
        if (!result.success) {
            this._error = result.error;
            return;
        }
        this._cancelEdit();
    }

    _saveAnswer() {
        const answer = (this.currentAnswer || '').trim();
        if (!answer) return;
        const firstLine = answer
            .split('\n')
            .find(line => line.trim())
            .replace(/[#*_`>]/g, '')
            .trim();
        this._startNew({ title: firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine, body: answer });
    }

    async _toggleShare(note) {
        await senpai.notes.save({ ...note, shareWithAI: !note.shareWithAI });
    }

    async _copy(note) {
        const text = note.title && note.body ? `${note.title}\n\n${note.body}` : note.title || note.body;
        await senpai.notes.copy(text);
        this._copiedId = note.id;
        clearTimeout(this._copiedTimer);
        this._copiedTimer = setTimeout(() => (this._copiedId = null), 1500);
    }

    async _delete(note) {
        if (this._confirmDeleteId !== note.id) {
            this._confirmDeleteId = note.id;
            return;
        }
        this._confirmDeleteId = null;
        await senpai.notes.remove(note.id);
    }

    _toggleExpanded(id) {
        const next = new Set(this._expanded);
        next.has(id) ? next.delete(id) : next.add(id);
        this._expanded = next;
    }

    async _importSplit() {
        const chunks = splitIntoChunks(this._splitText);
        if (!chunks.length) return;
        const result = await senpai.notes.addMany(chunks);
        if (!result.success) {
            this._error = result.error;
            return;
        }
        this._splitText = '';
        this._splitOpen = false;
        this._error = '';
    }

    _onEditorKeydown(e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            this._saveDraft();
        } else if (e.key === 'Escape') {
            this._cancelEdit();
        }
    }

    _renderEditor() {
        return html`
            <div class="editor" @keydown=${this._onEditorKeydown}>
                <input
                    placeholder="Title (optional)"
                    .value=${this._draft.title}
                    @input=${e => (this._draft = { ...this._draft, title: e.target.value })}
                />
                <textarea
                    placeholder="Write the note chunk..."
                    .value=${this._draft.body}
                    @input=${e => (this._draft = { ...this._draft, body: e.target.value })}
                ></textarea>
                <label class="share-toggle">
                    <input
                        type="checkbox"
                        .checked=${this._draft.shareWithAI}
                        @change=${e => (this._draft = { ...this._draft, shareWithAI: e.target.checked })}
                    />
                    Share with AI
                </label>
                <div class="editor-actions">
                    <span class="hint">Ctrl+S to save · Esc to cancel</span>
                    <button class="btn ghost" @click=${this._cancelEdit}>Cancel</button>
                    <button class="btn primary" @click=${this._saveDraft}>Save</button>
                </div>
            </div>
        `;
    }

    _renderCard(note) {
        if (this._editingId === note.id) {
            return html`<div class="card">${this._renderEditor()}</div>`;
        }

        const expanded = this._expanded.has(note.id);
        return html`
            <div class="card">
                <div class="card-head" @click=${() => this._toggleExpanded(note.id)} title=${expanded ? 'Collapse' : 'Expand'}>
                    <span class="card-title ${note.title ? '' : 'untitled'}">${note.title || 'Untitled note'}</span>
                    ${note.shareWithAI ? html`<span class="ai-badge" title="Shared with the AI">AI</span>` : ''}
                </div>
                ${note.body ? html`<div class="card-body ${expanded ? '' : 'clamped'}" .innerHTML=${renderMarkdown(note.body)}></div>` : ''}
                <div class="card-actions">
                    ${
                        this.compact
                            ? html`<span style="margin-right:auto"></span>`
                            : html`
                                  <label class="share-toggle" title="Include this note in the AI's context for new sessions">
                                      <input type="checkbox" .checked=${note.shareWithAI} @change=${() => this._toggleShare(note)} />
                                      Share with AI
                                  </label>
                              `
                    }
                    <button class="btn ghost" @click=${() => this._copy(note)}>${this._copiedId === note.id ? 'Copied' : 'Copy'}</button>
                    <button class="btn ghost" @click=${() => this._startEdit(note)}>Edit</button>
                    <button class="btn ghost danger" @click=${() => this._delete(note)} @mouseleave=${() => (this._confirmDeleteId = null)}>
                        ${this._confirmDeleteId === note.id ? 'Confirm' : 'Delete'}
                    </button>
                </div>
            </div>
        `;
    }

    _renderSplit() {
        const chunks = splitIntoChunks(this._splitText);
        return html`
            <div class="split">
                <textarea
                    placeholder="Paste a long doc. It is split into chunks at # headings, --- lines, or blank lines."
                    .value=${this._splitText}
                    @input=${e => (this._splitText = e.target.value)}
                ></textarea>
                <div class="editor-actions">
                    <span class="hint"
                        >${chunks.length ? `Will create ${chunks.length} note${chunks.length === 1 ? '' : 's'}` : 'Nothing to split yet'}</span
                    >
                    <button class="btn ghost" @click=${() => (this._splitOpen = false)}>Cancel</button>
                    <button class="btn primary" ?disabled=${!chunks.length} @click=${this._importSplit}>Add ${chunks.length || ''} notes</button>
                </div>
            </div>
        `;
    }

    render() {
        const notes = this._filtered();

        return html`
            <div class="toolbar">
                ${this.compact ? html`<span class="panel-title">Notes</span>` : ''}
                <input class="search" type="search" placeholder="Search notes" .value=${this._query} @input=${e => (this._query = e.target.value)} />
                ${
                    this.compact
                        ? html`<button
                              class="btn"
                              ?disabled=${!this.currentAnswer}
                              @click=${this._saveAnswer}
                              title="Save the answer on screen as a note"
                          >
                              Save answer
                          </button>`
                        : html`<button class="btn" @click=${() => (this._splitOpen = !this._splitOpen)}>Paste &amp; split</button>`
                }
                <button class="btn primary" @click=${() => this._startNew()}>+ New</button>
            </div>

            ${!this.compact && this._splitOpen ? this._renderSplit() : ''} ${this._error ? html`<div class="error">${this._error}</div>` : ''}
            ${this._editingId === 'new' ? this._renderEditor() : ''}

            <div class="list">
                ${
                    notes.length
                        ? notes.map(note => this._renderCard(note))
                        : html`<div class="empty">
                              ${
                                  this._notes.length
                                      ? 'No notes match your search.'
                                      : 'No notes yet. Add chunks like STAR stories, project talking points, formulas or questions to ask.'
                              }
                          </div>`
                }
            </div>
        `;
    }
}

customElements.define('notes-panel', NotesPanel);
