const REPO = 'Akash8585/help_senpai';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ───────── Light / dark theme ───────── */

const themeToggle = document.querySelector('[data-theme-toggle]');
const themeMeta = document.querySelector('meta[name="theme-color"]');

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeMeta?.setAttribute('content', theme === 'dark' ? '#111116' : '#f6f5f1');
    themeToggle?.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
}
applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

themeToggle?.addEventListener('click', e => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try {
        localStorage.setItem('senpai-theme', next);
    } catch {}

    // Circular reveal from the button where supported; instant switch otherwise.
    if (!document.startViewTransition || reduceMotion) {
        applyTheme(next);
        return;
    }
    const rect = themeToggle.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(() => applyTheme(next)).ready.then(() => {
        document.documentElement.animate(
            { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
            { duration: 550, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' }
        );
    });
});

// Follow the system setting until the visitor picks a theme.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    let saved = null;
    try {
        saved = localStorage.getItem('senpai-theme');
    } catch {}
    if (!saved) applyTheme(e.matches ? 'dark' : 'light');
});

/* ───────── Reveal on scroll ───────── */

const revealObserver = new IntersectionObserver(
    entries => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                entry.target.classList.add('in');
                revealObserver.unobserve(entry.target);
            }
        }
    },
    { threshold: 0.12 }
);
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

/* ───────── Reading progress bar ───────── */

const progressBar = document.querySelector('[data-progress]');
function updateProgress() {
    const max = document.documentElement.scrollHeight - innerHeight;
    progressBar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
}
addEventListener('scroll', updateProgress, { passive: true });
updateProgress();

/* ───────── Rotating headline ───────── */

const ROTATING = ['DSA question', 'system design', 'coding round', 'tough follow-up', 'STAR story'];
const rotateEl = document.querySelector('[data-rotate]');

/**
 * Lock the highlighter to the width of the longest phrase so it never grows or shrinks while typing.
 * If even that is wider than the headline (small phones), shrink the phrase to fit on one line.
 */
function sizeRotator() {
    if (!rotateEl) return;
    const box = rotateEl.parentElement;
    const line = box.parentElement;
    rotateEl.style.minWidth = '';
    box.style.fontSize = '';
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px';
    rotateEl.appendChild(probe);
    let widest = 0;
    for (const phrase of ROTATING) {
        probe.textContent = phrase;
        widest = Math.max(widest, probe.getBoundingClientRect().width);
    }
    probe.remove();
    const chrome = box.getBoundingClientRect().width - rotateEl.getBoundingClientRect().width;
    const available = line.getBoundingClientRect().width - 12; // room for the offset shadow
    const scale = Math.min(1, available / (widest + chrome));
    if (scale < 1) box.style.fontSize = `${scale}em`;
    rotateEl.style.minWidth = `${Math.ceil(widest * scale)}px`;
}
sizeRotator();
document.fonts?.ready.then(sizeRotator);
let resizeTimer = null;
addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sizeRotator, 120);
});

async function rotateHeadline() {
    if (!rotateEl || reduceMotion) return;
    let index = 0;
    for (;;) {
        await sleep(2200);
        const current = ROTATING[index];
        for (let i = current.length; i >= 0; i--) {
            rotateEl.textContent = current.slice(0, i);
            await sleep(28);
        }
        index = (index + 1) % ROTATING.length;
        const next = ROTATING[index];
        for (let i = 1; i <= next.length; i++) {
            rotateEl.textContent = next.slice(0, i);
            await sleep(55);
        }
    }
}
rotateHeadline();

/* ───────── Draggable stickers ───────── */

document.querySelectorAll('[data-sticker]').forEach(sticker => {
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;

    sticker.addEventListener('pointerdown', e => {
        sticker.setPointerCapture(e.pointerId);
        sticker.classList.add('dragging');
        startX = e.clientX;
        startY = e.clientY;
        const [x = 0, y = 0] = (sticker.style.translate || '0px 0px').split(' ').map(parseFloat);
        baseX = x;
        baseY = y;
    });

    sticker.addEventListener('pointermove', e => {
        if (!sticker.classList.contains('dragging')) return;
        sticker.style.translate = `${baseX + e.clientX - startX}px ${baseY + e.clientY - startY}px`;
    });

    const drop = () => sticker.classList.remove('dragging');
    sticker.addEventListener('pointerup', drop);
    sticker.addEventListener('pointercancel', drop);
});

/* ───────── Count-up stats ───────── */

function countUp(el) {
    const target = Number(el.dataset.count);
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    if (reduceMotion || target === 0) {
        el.textContent = `${prefix}${target.toLocaleString()}${suffix}`;
        return;
    }
    const start = performance.now();
    const duration = 1200;
    const tick = now => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = `${prefix}${Math.round(target * eased).toLocaleString()}${suffix}`;
        if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

const statsObserver = new IntersectionObserver(
    entries => {
        if (entries.some(entry => entry.isIntersecting)) {
            statsObserver.disconnect();
            document.querySelectorAll('[data-count]').forEach(countUp);
        }
    },
    { threshold: 0.5 }
);
const statsEl = document.querySelector('.stats');
if (statsEl) statsObserver.observe(statsEl);

/* ───────── Live demo ───────── */

const DEMOS = [
    {
        question: 'Given a string, find the length of the longest substring without repeating characters.',
        answer: `**Approach:** sliding window + hash map of last-seen indexes.
- Grow \`right\`; if a char repeats inside the window, jump \`left\` past it
- **Time** O(n) · **Space** O(min(n, alphabet))
\`\`\`
def longest(s):
    seen, left, best = {}, 0, 0
    for right, ch in enumerate(s):
        if seen.get(ch, -1) >= left:
            left = seen[ch] + 1
        seen[ch] = right
        best = max(best, right - left + 1)
    return best
\`\`\``,
    },
    {
        question: 'How would you design a URL shortener like bit.ly?',
        answer: `**Scope:** 100M new links/month, read-heavy (100:1), p99 redirect < 50 ms.
- **API:** \`POST /links\` → short code, \`GET /{code}\` → 301 redirect
- **IDs:** base62 of a 64-bit counter from a ticket service, 7 chars ≈ 3.5T codes
- **Storage:** key-value store (code → URL), sharded by code; write-once data
- **Reads:** CDN + Redis cache in front, ~95% hit rate
- **Analytics:** fire click events to Kafka, aggregate offline
**Trade-off:** counters are predictable; add a random salt if guessable links matter.`,
    },
    {
        question: 'Tell me about a project you are proud of.',
        answer: `I built a **campus ride-share app** at a 36-hour hackathon with two friends.
- I owned the **matching API** in FastAPI with Redis for live driver locations
- We split work by feature and demoed a working app at hour 34
- **Result:** 1st place out of 40 teams, and 200 students signed up in the first week
What I'd improve: move matching to a geohash index so it scales past one city.`,
    },
];

const questionEl = document.querySelector('[data-demo-question]');
const answerEl = document.querySelector('[data-demo-answer]');
const tabs = [...document.querySelectorAll('[data-demo]')];
let demoRun = 0;
let demoIndex = 0;
let userPicked = false;

const escapeHtml = text => text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
const inline = text =>
    escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');

/** Tiny markdown renderer for partially streamed text: paragraphs, bullets, bold, inline code, code fences. */
function renderMarkdown(source) {
    const out = [];
    let list = null;
    let code = null;
    const flushList = () => {
        if (list) out.push(`<ul>${list.join('')}</ul>`);
        list = null;
    };
    for (const line of source.split('\n')) {
        if (line.startsWith('```')) {
            if (code) {
                out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
                code = null;
            } else {
                flushList();
                code = [];
            }
            continue;
        }
        if (code) {
            code.push(line);
            continue;
        }
        if (line.startsWith('- ')) {
            (list ??= []).push(`<li>${inline(line.slice(2))}</li>`);
            continue;
        }
        flushList();
        if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    flushList();
    if (code) out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
    return out.join('');
}

async function playDemo(index) {
    const run = ++demoRun;
    demoIndex = index;
    const demo = DEMOS[index];
    tabs.forEach((tab, i) => tab.setAttribute('aria-selected', String(i === index)));

    if (reduceMotion) {
        questionEl.textContent = demo.question;
        answerEl.innerHTML = renderMarkdown(demo.answer);
        return;
    }

    questionEl.textContent = '';
    answerEl.innerHTML = '<p class="dim">Listening…</p>';
    for (const ch of demo.question) {
        if (run !== demoRun) return;
        questionEl.textContent += ch;
        await sleep(ch === ' ' ? 24 : 32);
    }
    await sleep(450);
    answerEl.innerHTML = '<p class="dim">Thinking…</p>';
    await sleep(400);

    // Stream the answer a word at a time, like the app does.
    let shown = '';
    for (const word of demo.answer.split(/(\s+)/)) {
        if (run !== demoRun) return;
        shown += word;
        answerEl.innerHTML = renderMarkdown(shown);
        await sleep(word.includes('\n') ? 40 : 26);
    }
    await sleep(4200);
    if (run === demoRun && !userPicked) playDemo((index + 1) % DEMOS.length);
}

tabs.forEach((tab, i) =>
    tab.addEventListener('click', () => {
        userPicked = true;
        playDemo(i);
    })
);

const demoObserver = new IntersectionObserver(
    entries => {
        if (entries.some(entry => entry.isIntersecting)) {
            demoObserver.disconnect();
            playDemo(0);
        }
    },
    { threshold: 0.3 }
);
const demoEl = document.querySelector('.demo');
if (demoEl) demoObserver.observe(demoEl);

/* ───────── Keycaps light up as you type; Ctrl+Enter runs the demo ───────── */

function keyId(e) {
    if (e.key.startsWith('Arrow')) return 'Arrow';
    if (e.key === 'Control' || e.key === 'Meta') return 'Control';
    return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

function setPressed(id, pressed) {
    document.querySelectorAll(`kbd[data-key="${CSS.escape(id)}"]`).forEach(kbd => kbd.classList.toggle('pressed', pressed));
    // Light up a shortcut card when all its keys are held.
    document.querySelectorAll('.shortcut-grid > div').forEach(card => {
        const keys = [...card.querySelectorAll('kbd')];
        card.classList.toggle('lit', keys.length > 0 && keys.every(kbd => kbd.classList.contains('pressed')));
    });
}

addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea')) return;
    setPressed(keyId(e), true);
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        userPicked = true;
        demoObserver.disconnect(); // don't let the scroll-into-view auto-start restart the demo
        demoEl?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        playDemo((demoIndex + 1) % DEMOS.length);
        toast('Ctrl + Enter: asking Senpai the next question…');
    }
});
addEventListener('keyup', e => setPressed(keyId(e), false));
addEventListener('blur', () => document.querySelectorAll('kbd.pressed').forEach(kbd => setPressed(kbd.dataset.key, false)));

/* ───────── Toast ───────── */

const toastEl = document.querySelector('[data-toast]');
let toastTimer = null;
function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

/* ───────── Confetti on download ───────── */

const canvas = document.querySelector('[data-confetti]');
const ctx = canvas.getContext('2d');
const COLORS = ['#3d3cff', '#d4ff3a', '#ffb3e1', '#bfe3ff', '#ffd8a8', '#111114'];
let pieces = [];
let confettiFrame = null;

function burst(x, y) {
    if (reduceMotion) return;
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    for (let i = 0; i < 120; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 4 + Math.random() * 9;
        pieces.push({
            x,
            y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 6,
            size: 6 + Math.random() * 7,
            rot: Math.random() * Math.PI,
            spin: (Math.random() - 0.5) * 0.4,
            color: COLORS[i % COLORS.length],
            life: 0,
        });
    }
    if (!confettiFrame) confettiFrame = requestAnimationFrame(drawConfetti);
}

function drawConfetti() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    pieces = pieces.filter(p => p.life < 160 && p.y < innerHeight + 40);
    for (const p of pieces) {
        p.life++;
        p.vy += 0.32;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.strokeStyle = '#111114';
        ctx.lineWidth = 1.2;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.strokeRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
    }
    confettiFrame = pieces.length ? requestAnimationFrame(drawConfetti) : null;
    if (!pieces.length) ctx.clearRect(0, 0, innerWidth, innerHeight);
}

document.querySelectorAll('a[data-download]').forEach(link =>
    link.addEventListener('click', () => {
        const rect = link.getBoundingClientRect();
        burst(rect.left + rect.width / 2, rect.top + rect.height / 2);
        toast('🎉 Downloading Senpai… good luck in there!');
    })
);

/* ───────── Live release + stars from GitHub ───────── */

async function loadRepoInfo() {
    try {
        const [repo, release] = await Promise.all([
            fetch(`https://api.github.com/repos/${REPO}`).then(r => (r.ok ? r.json() : null)),
            fetch(`https://api.github.com/repos/${REPO}/releases/latest`).then(r => (r.ok ? r.json() : null)),
        ]);

        if (repo && repo.stargazers_count > 0) {
            document.querySelectorAll('[data-stars]').forEach(el => {
                el.textContent = repo.stargazers_count.toLocaleString();
                el.hidden = false;
            });
        }

        const asset = release?.assets?.find(a => /\.exe$/i.test(a.name));
        if (release && asset) {
            document.querySelectorAll('[data-version]').forEach(el => (el.textContent = release.tag_name));
            document.querySelectorAll('[data-size]').forEach(el => (el.textContent = `${Math.round(asset.size / 1024 / 1024)} MB`));
            document.querySelectorAll('a[data-download]').forEach(a => (a.href = asset.browser_download_url));
        } else if (!release) {
            // No release published yet: send people to the releases page instead of a dead link.
            document.querySelectorAll('a[data-download]').forEach(a => (a.href = `https://github.com/${REPO}/releases`));
        }
    } catch {
        // Offline or rate-limited: the static links still work.
    }
}
loadRepoInfo();

/* ───────── Phones can't run the desktop app ───────── */

if (window.matchMedia('(max-width: 720px)').matches && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    const meta = document.querySelector('.hero .meta');
    if (meta) meta.textContent = 'Desktop app for Windows. Open this page on your PC to download.';
}
