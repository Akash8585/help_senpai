const REPO = 'Akash8585/help_senpai';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

/* ───────── Card spotlight ───────── */

document.querySelectorAll('.card').forEach(card => {
    card.addEventListener('pointermove', e => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
        card.style.setProperty('--my', `${e.clientY - rect.top}px`);
    });
});

/* ───────── Hero tilt ───────── */

const tilt = document.querySelector('[data-tilt]');
if (tilt && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    const win = tilt.querySelector('.window');
    tilt.addEventListener('pointermove', e => {
        const rect = tilt.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        win.style.transform = `rotateY(${x * 12 - 4}deg) rotateX(${-y * 8 + 2}deg)`;
    });
    tilt.addEventListener('pointerleave', () => (win.style.transform = ''));
}

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
    for (const line of source.split('\n')) {
        if (line.startsWith('```')) {
            if (code) {
                out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
                code = null;
            } else {
                if (list) out.push(`<ul>${list.join('')}</ul>`), (list = null);
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
        if (list) out.push(`<ul>${list.join('')}</ul>`), (list = null);
        if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    if (code) out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
    return out.join('');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function playDemo(index) {
    const run = ++demoRun;
    const demo = DEMOS[index];
    tabs.forEach((tab, i) => tab.setAttribute('aria-selected', String(i === index)));

    if (reduceMotion) {
        questionEl.textContent = demo.question;
        answerEl.innerHTML = renderMarkdown(demo.answer);
        return;
    }

    questionEl.textContent = '';
    answerEl.innerHTML = '<p style="color:var(--faint)">Listening…</p>';
    for (const ch of demo.question) {
        if (run !== demoRun) return;
        questionEl.textContent += ch;
        await sleep(ch === ' ' ? 26 : 34);
    }
    await sleep(500);
    answerEl.innerHTML = '<p style="color:var(--faint)">Thinking…</p>';
    await sleep(450);

    // Stream the answer a few characters at a time, like the app does.
    const words = demo.answer.split(/(\s+)/);
    let shown = '';
    for (const word of words) {
        if (run !== demoRun) return;
        shown += word;
        answerEl.innerHTML = renderMarkdown(shown);
        await sleep(word.includes('\n') ? 40 : 28);
    }
    await sleep(4200);
    if (run === demoRun && !userPicked) playDemo((index + 1) % DEMOS.length);
}

let userPicked = false;
tabs.forEach((tab, i) =>
    tab.addEventListener('click', () => {
        userPicked = true;
        playDemo(i);
    })
);

// Start the demo when it scrolls into view.
const demoObserver = new IntersectionObserver(
    entries => {
        if (entries.some(entry => entry.isIntersecting)) {
            demoObserver.disconnect();
            playDemo(0);
        }
    },
    { threshold: 0.3 }
);
if (questionEl) demoObserver.observe(document.querySelector('.demo'));

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
            document.querySelectorAll('a[data-download]').forEach(a => {
                if (a.getAttribute('href') !== '#download') a.href = asset.browser_download_url;
            });
        } else if (!release) {
            // No release published yet: send people to the releases page instead of a dead link.
            document.querySelectorAll('a[data-download]').forEach(a => {
                if (a.getAttribute('href') !== '#download') a.href = `https://github.com/${REPO}/releases`;
            });
        }
    } catch {
        // Offline or rate-limited: the static links still work.
    }
}
loadRepoInfo();

/* ───────── Phones can't run the desktop app ───────── */

if (window.matchMedia('(max-width: 720px)').matches && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    document.querySelectorAll('.hero .meta').forEach(el => {
        if (!el.classList.contains('subtle')) el.textContent = 'Desktop app for Windows. Open this page on your PC to download.';
    });
}
