// Auto-update for the Windows (Squirrel) build.
// Updates come from GitHub Releases through update.electronjs.org, the Electron project's free update
// service for open-source apps. Each release must include the Squirrel files (RELEASES + *-full.nupkg)
// alongside the setup .exe. Set HELP_SENPAI_UPDATE_FEED to a folder or URL to test against a local build.

const { app, autoUpdater, ipcMain } = require('electron');

const REPO = 'Akash8585/help_senpai';
const FIRST_CHECK_DELAY = 10 * 1000;
// Squirrel holds a lock right after installation; wait longer on the first launch.
const FIRST_RUN_DELAY = 60 * 1000;
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;

let state = { status: 'idle', currentVersion: app.getVersion(), error: null, checkedAt: null };
let notify = () => {};

function isSupported() {
    return process.platform === 'win32' && app.isPackaged;
}

function feedUrl() {
    return process.env.HELP_SENPAI_UPDATE_FEED || `https://update.electronjs.org/${REPO}/${process.platform}-${process.arch}/${app.getVersion()}`;
}

function setState(patch) {
    state = { ...state, ...patch };
    notify(state);
}

function checkForUpdates() {
    if (!isSupported()) return state;
    if (['checking', 'downloading', 'ready'].includes(state.status)) return state;
    try {
        autoUpdater.checkForUpdates();
    } catch (error) {
        setState({ status: 'error', error: error.message });
    }
    return state;
}

function setupUpdater(sendToRenderer) {
    notify = next => sendToRenderer('update-state', next);

    ipcMain.handle('update:get', () => state);
    ipcMain.handle('update:check', () => checkForUpdates());
    ipcMain.handle('update:install', () => {
        if (state.status !== 'ready') return false;
        autoUpdater.quitAndInstall();
        return true;
    });

    if (!isSupported()) {
        state = { ...state, status: 'unsupported' };
        return;
    }

    autoUpdater.setFeedURL({ url: feedUrl() });
    autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
    autoUpdater.on('update-available', () => setState({ status: 'downloading' }));
    autoUpdater.on('update-not-available', () => setState({ status: 'up-to-date', checkedAt: Date.now() }));
    autoUpdater.on('update-downloaded', (event, releaseNotes, releaseName) =>
        setState({ status: 'ready', newVersion: releaseName || null, checkedAt: Date.now() })
    );
    autoUpdater.on('error', error => {
        console.error('[Updater]', error.message);
        setState({ status: 'error', error: error.message, checkedAt: Date.now() });
    });

    const firstRun = process.argv.includes('--squirrel-firstrun');
    setTimeout(checkForUpdates, firstRun ? FIRST_RUN_DELAY : FIRST_CHECK_DELAY);
    setInterval(checkForUpdates, CHECK_INTERVAL);
}

module.exports = { setupUpdater, checkForUpdates };
