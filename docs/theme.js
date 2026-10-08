// Theme toggle shared by every page. The <head> script sets data-theme before first paint.
(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
        document
            .startViewTransition(() => applyTheme(next))
            .ready.then(() => {
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
})();
