// Knowledge base: resume, portfolio, company assignment and GitHub repositories the user adds
// on the Context page. Everything is fetched/extracted once, stored locally as text, and injected
// into the system prompt at session start.

const fs = require('fs');
const path = require('path');
const { getConfigDir, getCredentials, setCredentials } = require('../storage');
const { getSharedNotesText } = require('./notes');

const KINDS = {
    resume: { label: 'Resume', maxChars: 40000 },
    portfolio: { label: 'Portfolio', maxChars: 30000 },
    assignment: { label: 'Company assignment', maxChars: 60000 },
    repo: { label: 'GitHub repository', maxChars: 150000 },
    notes: { label: 'Notes', maxChars: 30000 },
};
const KIND_ORDER = ['resume', 'portfolio', 'assignment', 'notes', 'repo'];

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;
const REPO_MAX_FILES = 250;
const REPO_MAX_FILE_BYTES = 400 * 1024;
// Below this per-file share, drop the lowest-priority files instead of shrinking everything further.
const REPO_MIN_FILE_SHARE = 2500;
const REPO_TREE_LINES = 400;
const PAGE_TIMEOUT_MS = 25000;

let state = null;
let notify = () => {};

// ============ PERSISTENCE ============

function getKnowledgePath() {
    return path.join(getConfigDir(), 'knowledge.json');
}

function loadState() {
    if (state) return state;
    try {
        state = JSON.parse(fs.readFileSync(getKnowledgePath(), 'utf8'));
    } catch {
        state = null;
    }
    if (!state || !Array.isArray(state.items)) {
        state = { items: [], repoInstructions: '' };
    }
    // Anything still "loading" was interrupted by an app restart.
    for (const item of state.items) {
        if (item.status === 'loading') {
            item.status = 'error';
            item.error = 'Interrupted, refresh to retry';
        }
    }
    return state;
}

function saveState() {
    try {
        fs.mkdirSync(path.dirname(getKnowledgePath()), { recursive: true });
        fs.writeFileSync(getKnowledgePath(), JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.error('[Knowledge] Save failed:', error.message);
    }
}

function summarize(item) {
    const { content, ...rest } = item;
    return { ...rest, chars: content ? content.length : 0 };
}

function getSummary() {
    const s = loadState();
    return {
        items: s.items.map(summarize),
        repoInstructions: s.repoInstructions || '',
        hasGithubToken: Boolean(getCredentials().githubToken),
        promptChars: buildKnowledgeSection().length,
    };
}

function changed() {
    saveState();
    notify(getSummary());
}

function newItem(kind, sourceType, source, title) {
    return {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        kind,
        sourceType,
        source,
        title: title || source,
        content: '',
        status: 'loading',
        error: null,
        meta: {},
        updatedAt: Date.now(),
    };
}

async function runItem(item, loader) {
    try {
        const result = await loader();
        item.title = result.title || item.title;
        item.content = normalizeText(result.content || '');
        item.meta = result.meta || {};
        if (!item.content.trim()) throw new Error('No text could be extracted');
        item.status = 'ready';
        item.error = null;
    } catch (error) {
        console.error(`[Knowledge] ${item.kind} failed:`, error);
        item.status = 'error';
        item.error = error.message;
    }
    item.updatedAt = Date.now();
    changed();
    return summarize(item);
}

function normalizeText(text) {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ============ PUBLIC OPERATIONS ============

function assertKind(kind) {
    if (!KINDS[kind]) throw new Error(`Unknown context type: ${kind}`);
}

function addUrl(kind, url) {
    assertKind(kind);
    const parsed = parseHttpUrl(url);
    if (kind === 'repo' && parseGitHubUrl(parsed.href)?.type !== 'repo') {
        throw new Error('Use a GitHub repository link like https://github.com/owner/repo');
    }

    const item = newItem(kind, 'url', parsed.href);
    loadState().items.push(item);
    changed();
    return runItem(item, () => resolveUrl(parsed.href));
}

function addFile(kind, name, base64Data) {
    assertKind(kind);
    if (typeof name !== 'string' || typeof base64Data !== 'string') throw new Error('Invalid file');
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > MAX_FILE_BYTES) throw new Error('File is larger than 15 MB');

    const item = newItem(kind, 'file', path.basename(name));
    loadState().items.push(item);
    changed();
    return runItem(item, async () => ({ content: await extractFileText(name, buffer) }));
}

function addText(kind, text, title) {
    assertKind(kind);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Text is empty');
    const item = newItem(kind, 'text', 'Pasted text', title || `${KINDS[kind].label} (pasted)`);
    loadState().items.push(item);
    changed();
    return runItem(item, async () => ({ content: text.slice(0, MAX_TEXT_CHARS) }));
}

function refresh(id) {
    const item = loadState().items.find(i => i.id === id);
    if (!item) throw new Error('Item not found');
    if (item.sourceType !== 'url') throw new Error('Only links can be refreshed');
    item.status = 'loading';
    item.error = null;
    changed();
    return runItem(item, () => resolveUrl(item.source));
}

function remove(id) {
    const s = loadState();
    s.items = s.items.filter(i => i.id !== id);
    changed();
}

function getContent(id) {
    const item = loadState().items.find(i => i.id === id);
    return item ? item.content : '';
}

function setRepoInstructions(text) {
    loadState().repoInstructions = typeof text === 'string' ? text.slice(0, 20000) : '';
    changed();
}

function setGithubToken(token) {
    setCredentials({ githubToken: typeof token === 'string' ? token.trim() : '' });
    notify(getSummary());
}

// ============ PROMPT ============

function truncate(text, max) {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n[... truncated to fit the context budget]`;
}

function escapeAttr(value) {
    return String(value).replace(/"/g, "'");
}

/**
 * Build the knowledge-base section for the system prompt. Small documents are included in full
 * (up to their per-kind cap); repositories share whatever budget remains.
 */
function buildKnowledgeSection(maxChars = 220000) {
    const s = loadState();
    const ready = s.items.filter(i => i.status === 'ready' && i.content);
    const instructions = (s.repoInstructions || '').trim();
    const sharedNotes = getSharedNotesText();
    if (ready.length === 0 && !instructions && !sharedNotes) return '';

    const blocks = [];
    let used = 0;

    const docs = ready.filter(i => i.kind !== 'repo').sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    for (const item of docs) {
        const cap = Math.min(KINDS[item.kind].maxChars, Math.max(0, maxChars - used));
        if (cap < 500) break;
        const block = `<${item.kind} source="${escapeAttr(item.source)}">\n${truncate(item.content, cap)}\n</${item.kind}>`;
        blocks.push(block);
        used += block.length;
    }

    if (sharedNotes) {
        const cap = Math.min(KINDS.notes.maxChars, Math.max(500, maxChars - used));
        const block = `<user_notes>\n${truncate(sharedNotes, cap)}\n</user_notes>`;
        blocks.push(block);
        used += block.length;
    }

    if (instructions) {
        const block = `<repo_instructions>\n${truncate(instructions, 20000)}\n</repo_instructions>`;
        blocks.push(block);
        used += block.length;
    }

    const repos = ready.filter(i => i.kind === 'repo');
    if (repos.length > 0) {
        const perRepo = Math.floor(Math.max(0, maxChars - used) / repos.length);
        for (const item of repos) {
            const cap = Math.min(KINDS.repo.maxChars, perRepo);
            if (cap < 2000) break;
            blocks.push(`<repository source="${escapeAttr(item.source)}">\n${truncate(item.content, cap)}\n</repository>`);
        }
    }

    return `**USER KNOWLEDGE BASE:**
The user (the person you are assisting) provided the materials below. Treat them as the ground truth about their background, their work, and the assignment they are being evaluated on.

${blocks.join('\n\n')}`;
}

// ============ URL RESOLUTION ============

function parseHttpUrl(url) {
    let parsed;
    try {
        parsed = new URL(String(url).trim());
    } catch {
        throw new Error('That does not look like a valid link');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) links are supported');
    return parsed;
}

function parseGitHubUrl(url) {
    const u = new URL(url);
    if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return { type: 'profile', owner: parts[0] };

    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (parts.length === 2) return { type: 'repo', owner, repo };
    if (parts[2] === 'tree' && parts[3]) return { type: 'repo', owner, repo, ref: parts[3], subpath: parts.slice(4).join('/') };
    if (parts[2] === 'blob' && parts[3]) return { type: 'file', owner, repo, ref: parts[3], filePath: parts.slice(4).join('/') };
    return { type: 'page', owner, repo };
}

async function resolveUrl(url) {
    const github = parseGitHubUrl(url);
    if (github?.type === 'repo') return fetchGitHubRepo(github);
    if (github?.type === 'file') return fetchGitHubFile(github);

    // Publicly shared Google Docs can be exported as plain text.
    const googleDoc = url.match(/^https:\/\/docs\.google\.com\/document\/d\/([\w-]+)/);
    if (googleDoc) {
        const response = await fetch(`https://docs.google.com/document/d/${googleDoc[1]}/export?format=txt`);
        if (!response.ok) throw new Error('Could not read the Google Doc. Make sure it is shared as "Anyone with the link".');
        return { title: 'Google Doc', content: await response.text() };
    }

    // Documents served directly (PDF, DOCX, plain text) are downloaded and parsed.
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
    const contentType = head?.headers.get('content-type') || '';
    const looksLikeDocument = /\.(pdf|docx|txt|md)(\?|#|$)/i.test(new URL(url).pathname);
    if (/application\/pdf|officedocument|text\/plain|text\/markdown/i.test(contentType) || looksLikeDocument) {
        const response = await fetch(url, { redirect: 'follow' });
        if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const name = guessFileName(url, response.headers.get('content-type'));
        return { title: name, content: await extractFileText(name, buffer) };
    }

    // Everything else is rendered in a hidden browser window so JavaScript-built sites work.
    return renderPageText(url);
}

function guessFileName(url, contentType = '') {
    const base = path.basename(new URL(url).pathname) || 'document';
    if (path.extname(base)) return base;
    if (/pdf/i.test(contentType)) return `${base}.pdf`;
    if (/officedocument/i.test(contentType)) return `${base}.docx`;
    return `${base}.txt`;
}

async function renderPageText(url) {
    const { BrowserWindow } = require('electron');
    const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'senpai-fetch' },
    });
    win.isSenpaiFetchWindow = true;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.setAudioMuted(true);

    try {
        await Promise.race([
            win.loadURL(url),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Page took too long to load')), PAGE_TIMEOUT_MS)),
        ]);

        // Wait for client-rendered content to settle.
        let previousLength = -1;
        for (let i = 0; i < 12; i++) {
            const length = await win.webContents.executeJavaScript('document.body ? document.body.innerText.length : 0');
            if (length > 200 && length === previousLength) break;
            previousLength = length;
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const page = await win.webContents.executeJavaScript(`(() => {
            const links = [];
            const seen = new Set();
            for (const a of document.querySelectorAll('a[href]')) {
                const href = a.href;
                const text = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
                if (!/^https?:/.test(href) || seen.has(href)) continue;
                seen.add(href);
                links.push(text ? text.slice(0, 80) + ' -> ' + href : href);
                if (links.length >= 80) break;
            }
            return { title: document.title, text: document.body ? document.body.innerText : '', links };
        })()`);

        const finalUrl = win.webContents.getURL();
        const hitLoginWall =
            /authwall|\/login|\/signin|\/signup|\/uas\//i.test(new URL(finalUrl).pathname) ||
            (/sign ?in|sign ?up|log ?in|join now/i.test(page.title) && page.text.length < 6000);
        if (hitLoginWall) {
            throw new Error(
                /linkedin\./i.test(url)
                    ? 'LinkedIn requires a login. On your profile use More → Save to PDF, then upload that file as your resume.'
                    : 'This page needs a login. Upload a PDF or paste the text instead.'
            );
        }

        const content = `# ${page.title}\nURL: ${url}\n\n${page.text}${page.links.length ? `\n\n## Links on the page\n${page.links.join('\n')}` : ''}`;
        return { title: page.title || url, content };
    } finally {
        win.destroy();
    }
}

// ============ GITHUB ============

const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    '.svelte-kit',
    'coverage',
    'vendor',
    'target',
    '__pycache__',
    '.venv',
    'venv',
    'env',
    '.idea',
    '.vscode',
    'bin',
    'obj',
    '.gradle',
    'Pods',
    'DerivedData',
    '.turbo',
    '.cache',
]);
const SKIP_FILES = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'cargo.lock',
    'poetry.lock',
    'composer.lock',
    'gemfile.lock',
    'go.sum',
    'pipfile.lock',
]);
const MANIFESTS = new Set([
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'setup.py',
    'go.mod',
    'cargo.toml',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'gemfile',
    'composer.json',
    'dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    'makefile',
    'tsconfig.json',
]);
const SOURCE_EXTS = new Set(
    (
        'js jsx ts tsx mjs cjs py java kt kts go rs rb php cs cpp cc cxx c h hpp swift m mm scala dart vue svelte astro html css scss sass less ' +
        'sql sh bash zsh ps1 r lua ex exs erl hs clj elm sol graphql gql prisma proto ipynb'
    ).split(' ')
);
const CONFIG_EXTS = new Set(['json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'env', 'example', 'tf']);

function filePriority(filePath) {
    const lower = filePath.toLowerCase();
    const name = path.posix.basename(lower);
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const depth = filePath.split('/').length - 1;

    if (SKIP_FILES.has(name) || /\.min\.(js|css)$/.test(name) || ext === 'map') return null;
    if (name.startsWith('readme') && depth === 0) return 0;
    if (MANIFESTS.has(name) && depth <= 1) return 1;
    if (ext === 'md' || ext === 'mdx' || ext === 'rst') return 2;
    if (/(^|\/)(test|tests|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[a-z]+$/.test(lower)) return 5;
    if (SOURCE_EXTS.has(ext)) return 3;
    if (MANIFESTS.has(name) || CONFIG_EXTS.has(ext)) return 4;
    return null;
}

function isSkippedPath(filePath) {
    return filePath.split('/').some(segment => SKIP_DIRS.has(segment));
}

async function githubRequest(apiPath) {
    const token = getCredentials().githubToken;
    const response = await fetch(`https://api.github.com${apiPath}`, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Senpai',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });

    if (response.ok) return response.json();
    if (response.status === 404) {
        throw new Error(
            token ? 'Repository not found, or your GitHub token cannot access it' : 'Repository not found. If it is private, add a GitHub token.'
        );
    }
    if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
        throw new Error('GitHub rate limit reached. Add a GitHub token to continue.');
    }
    if (response.status === 401) throw new Error('GitHub token is invalid');
    throw new Error(`GitHub API error (HTTP ${response.status})`);
}

async function fetchRaw({ owner, repo, ref, filePath }) {
    const token = getCredentials().githubToken;
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${encodedPath}`, {
        headers: { 'User-Agent': 'Senpai', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]).catch(() => null);
        }
    });
    await Promise.all(workers);
    return results;
}

/** Water-filling: small items get their full size, the rest split what remains equally. */
function allocateBudget(sizes, budget) {
    const limits = new Array(sizes.length).fill(0);
    const order = sizes.map((size, index) => index).sort((a, b) => sizes[a] - sizes[b]);
    let remaining = budget;
    for (let i = 0; i < order.length; i++) {
        const share = Math.floor(remaining / (order.length - i));
        const index = order[i];
        limits[index] = Math.min(sizes[index], share);
        remaining -= limits[index];
    }
    return limits;
}

// Declaration-looking lines (functions, classes, routes) across common languages.
const DECLARATION =
    /^\s*(export\s+)?(default\s+)?(async\s+)?(function\*?|class|interface|type|enum|def|func|fn|pub\s+(fn|struct|enum)|struct|impl|trait|module|object)\s+[\w(]|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>|^\s*(public|private|protected|static|override|async)[\w\s<>,[\]]*\s\w+\s*\(|^\s*(@\w+\.(get|post|put|delete|patch|route)|(app|router)\.(get|post|put|delete|patch|use)\s*\()|^\s{0,4}(async\s+)?(?!(if|for|while|switch|catch|with|return|else)\b)[a-zA-Z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/;

/** Keep the head of a long file, then an outline of declarations in the part that was cut. */
function truncateWithOutline(text, limit) {
    if (text.length <= limit) return text;
    const head = text.slice(0, limit);
    const rest = text.slice(limit).split('\n');
    const outline = rest
        .filter(line => DECLARATION.test(line))
        .slice(0, 60)
        .map(line => line.trim().slice(0, 160));
    return `${head}\n\n[... ${text.length - limit} more characters truncated${outline.length ? '. Outline of the rest:' : ''}]${outline.length ? `\n${outline.join('\n')}` : ''}`;
}

async function fetchGitHubRepo({ owner, repo, ref, subpath = '' }) {
    const info = await githubRequest(`/repos/${owner}/${repo}`);
    const branch = ref || info.default_branch;
    const tree = await githubRequest(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);

    const prefix = subpath ? `${subpath.replace(/\/$/, '')}/` : '';
    const blobs = tree.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith(prefix) && !isSkippedPath(entry.path));

    const treeLines = blobs.map(entry => entry.path);
    const treeListing =
        treeLines.slice(0, REPO_TREE_LINES).join('\n') +
        (treeLines.length > REPO_TREE_LINES ? `\n... and ${treeLines.length - REPO_TREE_LINES} more files` : '');

    const candidates = blobs
        .map(entry => ({ ...entry, priority: filePriority(entry.path.slice(prefix.length) || entry.path) }))
        .filter(entry => entry.priority !== null && entry.size <= REPO_MAX_FILE_BYTES)
        .sort((a, b) => a.priority - b.priority || a.path.split('/').length - b.path.split('/').length || a.size - b.size);

    // Breadth beats depth for "walk me through your code": every relevant file gets a fair share of
    // the budget. Lowest-priority files are dropped only if shares would get too small.
    let selected = candidates.slice(0, REPO_MAX_FILES);
    let limits = allocateBudget(
        selected.map(entry => entry.size),
        KINDS.repo.maxChars
    );
    const starved = () => selected.some((entry, index) => limits[index] < Math.min(REPO_MIN_FILE_SHARE, entry.size));
    while (selected.length > 1 && starved()) {
        selected = selected.slice(0, -1);
        limits = allocateBudget(
            selected.map(entry => entry.size),
            KINDS.repo.maxChars
        );
    }

    const contents = await mapWithConcurrency(selected, 8, entry => fetchRaw({ owner, repo, ref: branch, filePath: entry.path }));
    const files = selected
        .map((entry, index) => ({ path: entry.path, text: contents[index], charLimit: limits[index] }))
        .filter(file => typeof file.text === 'string' && !file.text.includes('\u0000'))
        .map(file => ({ ...file, text: truncateWithOutline(file.text, file.charLimit) }));

    const header = [
        `# Repository ${owner}/${repo}${subpath ? `/${subpath}` : ''} (branch: ${branch})`,
        info.description ? `Description: ${info.description}` : '',
        info.language ? `Main language: ${info.language}` : '',
        info.topics?.length ? `Topics: ${info.topics.join(', ')}` : '',
    ]
        .filter(Boolean)
        .join('\n');

    const fileBlocks = files.map(file => {
        const ext = path.posix.extname(file.path).slice(1);
        return `### ${file.path}\n\`\`\`${ext}\n${file.text.trimEnd()}\n\`\`\``;
    });

    const skipped = candidates.length - files.length;
    const content = `${header}\n\n## File tree\n${treeListing}\n\n## Files${skipped > 0 ? ` (${files.length} most relevant of ${candidates.length})` : ''}\n\n${fileBlocks.join('\n\n')}`;

    return {
        title: `${owner}/${repo}${subpath ? `/${subpath}` : ''}`,
        content,
        meta: { branch, files: files.length, totalFiles: blobs.length, truncated: Boolean(tree.truncated) || skipped > 0 },
    };
}

async function fetchGitHubFile({ owner, repo, ref, filePath }) {
    const text = await fetchRaw({ owner, repo, ref, filePath });
    const name = path.posix.basename(filePath);
    if (/\.(pdf|docx)$/i.test(name)) {
        throw new Error('Open the file on GitHub, download it, and upload it here instead');
    }
    return { title: `${owner}/${repo}: ${filePath}`, content: `# ${filePath}\n\n${text}` };
}

// ============ FILES ============

async function extractFileText(name, buffer) {
    const ext = path.extname(name).toLowerCase();

    if (ext === '.pdf') {
        // Require the library file directly: pdf-parse's index runs a self-test when loaded as the main module.
        const pdfParse = require('pdf-parse/lib/pdf-parse.js');
        const result = await pdfParse(buffer);
        if (!result.text.trim()) throw new Error('This PDF has no selectable text (scanned image?). Paste the text instead.');
        return result.text;
    }

    if (ext === '.docx') {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
    }

    if (['.txt', '.md', '.markdown', '.json', '.csv', '.rtf', '.tex', '.html', '.htm'].includes(ext) || !ext) {
        const text = buffer.toString('utf8');
        return /\.html?$/.test(ext) ? text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ') : text;
    }

    throw new Error(`Unsupported file type ${ext}. Use PDF, DOCX, TXT or MD.`);
}

// ============ IPC ============

function setupKnowledgeIpcHandlers(sendToRenderer) {
    const { ipcMain } = require('electron');
    notify = summary => sendToRenderer('knowledge-updated', summary);

    const wrap =
        fn =>
        async (event, ...args) => {
            try {
                return { success: true, data: await fn(...args) };
            } catch (error) {
                return { success: false, error: error.message };
            }
        };

    ipcMain.handle(
        'knowledge:get',
        wrap(() => getSummary())
    );
    ipcMain.handle(
        'knowledge:add-url',
        wrap((kind, url) => addUrl(kind, url))
    );
    ipcMain.handle(
        'knowledge:add-file',
        wrap((kind, name, data) => addFile(kind, name, data))
    );
    ipcMain.handle(
        'knowledge:add-text',
        wrap((kind, text, title) => addText(kind, text, title))
    );
    ipcMain.handle(
        'knowledge:refresh',
        wrap(id => refresh(id))
    );
    ipcMain.handle(
        'knowledge:remove',
        wrap(id => remove(id))
    );
    ipcMain.handle(
        'knowledge:get-content',
        wrap(id => getContent(id))
    );
    ipcMain.handle(
        'knowledge:set-repo-instructions',
        wrap(text => setRepoInstructions(text))
    );
    ipcMain.handle(
        'knowledge:set-github-token',
        wrap(token => setGithubToken(token))
    );
}

/** Drop the in-memory cache (used after "clear all data"). */
function resetKnowledgeCache() {
    state = null;
}

module.exports = {
    KINDS,
    addUrl,
    addFile,
    addText,
    refresh,
    remove,
    getSummary,
    getContent,
    setRepoInstructions,
    buildKnowledgeSection,
    extractFileText,
    parseGitHubUrl,
    fetchGitHubRepo,
    setupKnowledgeIpcHandlers,
    resetKnowledgeCache,
};
