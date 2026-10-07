// Notes: short chunks (STAR stories, talking points, formulas, questions to ask) the user writes on the
// Notes page and reads from the side panel during a session. Chunks marked "share with AI" are also
// added to the system prompt.

const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../storage');

const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 50000;
const MAX_NOTES = 500;

let state = null;
let notify = () => {};

function getNotesPath() {
    return path.join(getConfigDir(), 'notes.json');
}

function loadState() {
    if (state) return state;
    try {
        state = JSON.parse(fs.readFileSync(getNotesPath(), 'utf8'));
    } catch {
        state = null;
    }
    if (!state || !Array.isArray(state.notes)) state = { notes: [] };
    return state;
}

function saveState() {
    try {
        fs.mkdirSync(path.dirname(getNotesPath()), { recursive: true });
        fs.writeFileSync(getNotesPath(), JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.error('[Notes] Save failed:', error.message);
    }
    notify(listNotes());
}

function listNotes() {
    return loadState().notes.map(note => ({ ...note }));
}

function cleanNote(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid note');
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, MAX_TITLE_CHARS) : '';
    const body = typeof input.body === 'string' ? input.body.replace(/\r\n/g, '\n').trimEnd().slice(0, MAX_BODY_CHARS) : '';
    if (!title && !body.trim()) throw new Error('Note is empty');
    return { title, body, shareWithAI: input.shareWithAI === true };
}

function newId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Create (no id) or update (with id) a note. New notes go to the top. */
function saveNote(input) {
    const s = loadState();
    const fields = cleanNote(input);
    const now = Date.now();

    if (input.id) {
        const existing = s.notes.find(note => note.id === input.id);
        if (!existing) throw new Error('Note not found');
        Object.assign(existing, fields, { updatedAt: now });
        saveState();
        return { ...existing };
    }

    if (s.notes.length >= MAX_NOTES) throw new Error(`You can keep up to ${MAX_NOTES} notes`);
    const note = { id: newId(), ...fields, createdAt: now, updatedAt: now };
    s.notes.unshift(note);
    saveState();
    return { ...note };
}

/** Add several chunks at once (from "paste and split"), keeping their order. */
function addNotes(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('Nothing to add');
    const s = loadState();
    if (s.notes.length + inputs.length > MAX_NOTES) throw new Error(`You can keep up to ${MAX_NOTES} notes`);
    const now = Date.now();
    const created = inputs.map((input, index) => ({ id: newId(), ...cleanNote(input), createdAt: now + index, updatedAt: now + index }));
    s.notes.unshift(...created);
    saveState();
    return created.length;
}

function deleteNote(id) {
    const s = loadState();
    s.notes = s.notes.filter(note => note.id !== id);
    saveState();
}

/** Notes the user chose to share with the AI, formatted for the system prompt. */
function getSharedNotesText() {
    return loadState()
        .notes.filter(note => note.shareWithAI)
        .map(note => `## ${note.title || 'Note'}\n${note.body}`)
        .join('\n\n');
}

function resetNotesCache() {
    state = null;
}

function setupNotesIpcHandlers(sendToRenderer) {
    const { ipcMain } = require('electron');
    notify = notes => sendToRenderer('notes-updated', notes);

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
        'notes:list',
        wrap(() => listNotes())
    );
    ipcMain.handle(
        'notes:save',
        wrap(note => saveNote(note))
    );
    ipcMain.handle(
        'notes:add-many',
        wrap(notes => addNotes(notes))
    );
    ipcMain.handle(
        'notes:delete',
        wrap(id => deleteNote(id))
    );
}

module.exports = {
    listNotes,
    saveNote,
    addNotes,
    deleteNote,
    getSharedNotesText,
    resetNotesCache,
    setupNotesIpcHandlers,
};
