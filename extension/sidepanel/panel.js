// The Disco side panel: shows the highlighted passage, lets the user edit it, add a note,
// adjust tags and confirm the source, then saves through the capture endpoint.

import { getSession, signIn, signOut } from '../lib/auth.js';
import { rpc, capture } from '../lib/api.js';
import {
  getSheetSettings, connectSheet, disconnectSheet, copyToSheet, flushSheetQueue, sheetRow, sheetQueueLength,
} from '../lib/sheet.js';

const PENDING_KEY = 'disco.pending';
const $ = (id) => document.getElementById(id);

let cap = null;            // the capture being edited
let lastResults = [];      // last autocomplete results
let menuIndex = -1;
let saving = false;

// ---------- views ----------

function show(view) {
  for (const v of ['signin', 'empty', 'capture', 'settings']) $(`view-${v}`).hidden = v !== view;
}

async function start() {
  const session = await getSession();
  if (!session) { show('signin'); return; }
  $('who').textContent = session.user?.email || 'Signed in';
  flushSheetQueue().catch(() => {});
  const pending = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
  if (pending && pending.text) openCapture(pending);
  else show('empty');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[PENDING_KEY]?.newValue) {
    const p = changes[PENDING_KEY].newValue;
    getSession().then((s) => {
      if (!s) { show('signin'); return; }
      if (p.text) openCapture(p); else if (!cap) show('empty');
    });
  }
});

// ---------- sign in ----------

$('btn-signin').addEventListener('click', async () => {
  const btn = $('btn-signin');
  btn.disabled = true;
  $('signin-error').hidden = true;
  try {
    await signIn();
    await start();
  } catch (e) {
    $('signin-error').textContent = e.message;
    $('signin-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------- capture ----------

function openCapture(p) {
  if (cap && cap.id === p.id) { show('capture'); return; }
  cap = {
    id: p.id, at: p.at,
    text: p.text, edited: null, showingOriginal: false,
    prefix: p.prefix || '', suffix: p.suffix || '',
    url: p.url || '', title: p.title || '', site_name: p.site_name || '', author: p.author || '', published_at: p.published_at || '',
    tags: [],
  };
  saving = false;
  $('note').value = '';
  $('note-block').hidden = true;
  $('btn-add-note').hidden = false;
  $('tag-input').value = '';
  closeMenu();
  $('did-you-mean').hidden = true;
  $('save-error').hidden = true;
  $('passage-edit').hidden = true;
  $('passage-view').hidden = false;
  $('source-edit').hidden = true;
  $('source-view').hidden = false;
  const btn = $('btn-save');
  btn.disabled = false;
  btn.classList.remove('done');
  btn.textContent = 'Save Disco';
  renderPassage();
  renderSource();
  renderTags();
  show('capture');
  loadSuggestions(cap.id);
}

function renderPassage() {
  const edited = cap.edited != null;
  $('edited-row').hidden = !edited;
  $('btn-toggle-original').textContent = cap.showingOriginal ? 'Original · show your edit' : 'Edited · show original';
  $('passage').textContent = edited && !cap.showingOriginal ? cap.edited : cap.text;
}

$('passage').addEventListener('click', () => {
  $('passage-input').value = cap.edited ?? cap.text;
  $('passage-view').hidden = true;
  $('passage-edit').hidden = false;
  cap.showingOriginal = false;
  $('passage-input').focus();
});
$('btn-cancel-edit').addEventListener('click', () => {
  $('passage-edit').hidden = true;
  $('passage-view').hidden = false;
  renderPassage();
});
$('btn-done-edit').addEventListener('click', () => {
  const v = $('passage-input').value.trim();
  cap.edited = !v || v === cap.text ? null : v;
  $('passage-edit').hidden = true;
  $('passage-view').hidden = false;
  renderPassage();
});
$('btn-toggle-original').addEventListener('click', () => {
  cap.showingOriginal = !cap.showingOriginal;
  renderPassage();
});

// note
$('btn-add-note').addEventListener('click', () => {
  $('note-block').hidden = false;
  $('btn-add-note').hidden = true;
  $('note').focus();
});
$('btn-remove-note').addEventListener('click', () => {
  $('note').value = '';
  $('note-block').hidden = true;
  $('btn-add-note').hidden = false;
});

// ---------- source ----------

function prettyDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || '';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderSource() {
  let domain = '';
  try { domain = new URL(cap.url).hostname.replace(/^www\./, ''); } catch {}
  $('src-site').textContent = cap.site_name || domain || 'Unknown source';
  $('src-title').textContent = cap.title || '(no title)';
  const meta = $('src-meta');
  meta.textContent = '';
  if (cap.published_at) meta.append(prettyDate(cap.published_at), ' · ');
  if (cap.author) meta.append(cap.author);
  else {
    const s = document.createElement('span');
    s.className = 'missing';
    s.textContent = 'author not found on page';
    meta.append(s);
  }
  $('src-domain').textContent = domain;
}

$('btn-edit-source').addEventListener('click', () => {
  $('ed-site').value = cap.site_name;
  $('ed-title').value = cap.title;
  $('ed-author').value = cap.author;
  $('ed-date').value = /^\d{4}-\d{2}-\d{2}$/.test(cap.published_at) ? cap.published_at : '';
  $('source-view').hidden = true;
  $('source-edit').hidden = false;
  $('ed-site').focus();
});
$('btn-done-source').addEventListener('click', () => {
  cap.site_name = $('ed-site').value.trim();
  cap.title = $('ed-title').value.trim();
  cap.author = $('ed-author').value.trim();
  cap.published_at = $('ed-date').value;
  $('source-edit').hidden = true;
  $('source-view').hidden = false;
  renderSource();
});

// ---------- tags ----------

const hasTag = (label) => cap.tags.some((t) => t.label.toLowerCase() === label.toLowerCase());

function addTag(label, isNew) {
  label = label.trim();
  if (!label || hasTag(label)) return;
  cap.tags.push({ label, isNew });
  renderTags();
}

function renderTags() {
  const box = $('tags');
  box.textContent = '';
  cap.tags.forEach((t, i) => {
    const chip = document.createElement('div');
    chip.className = 'tag' + (t.isNew ? ' new' : '');
    const text = document.createElement('div');
    text.className = 'tag-text';
    const l = document.createElement('span');
    l.className = 'tag-label';
    l.textContent = t.label;
    const w = document.createElement('span');
    w.className = 'tag-why';
    w.textContent = t.isNew ? 'new tag' : 'disco tag';
    text.append(l, w);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'tag-x';
    x.setAttribute('aria-label', `Remove ${t.label}`);
    x.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
    x.addEventListener('click', () => { cap.tags.splice(i, 1); renderTags(); });
    chip.append(text, x);
    box.append(chip);
  });
}

async function loadSuggestions(forId) {
  $('tags-status').textContent = 'Finding tags…';
  try {
    const rows = await rpc('suggest_tags_for_capture', {
      p_passage: cap.text, p_url: cap.url || null, p_author: cap.author || null, max_results: 8,
    });
    if (!cap || cap.id !== forId) return;
    for (const r of rows || []) addTag(r.label, false);
    $('tags-status').textContent = cap.tags.length ? '' : 'No suggestions yet. Add a tag below if you like.';
  } catch (e) {
    if (!cap || cap.id !== forId) return;
    if (e.signedOut) { show('signin'); return; }
    $('tags-status').textContent = "Couldn't load suggestions. You can still add tags.";
  }
}

let searchTimer = null;
let searchSeq = 0;

async function searchTags(q) {
  const seq = ++searchSeq;
  try {
    const rows = await rpc('suggest_tags_with_hints', { q, max_results: 7 });
    if (seq !== searchSeq) return null;
    lastResults = rows || [];
    return lastResults;
  } catch {
    return [];
  }
}

function closeMenu() {
  $('tag-menu').hidden = true;
  $('tag-input').setAttribute('aria-expanded', 'false');
  menuIndex = -1;
}

function renderMenu(q) {
  const menu = $('tag-menu');
  menu.textContent = '';
  const items = lastResults.filter((r) => !hasTag(r.label));
  const exact = lastResults.some((r) => r.label.toLowerCase() === q.toLowerCase() || r.similarity >= 0.999);
  const options = items.map((r) => ({ label: r.label, hint: r.hint, isNew: false }));
  if (!exact && q) options.push({ label: q, hint: '', isNew: true });
  if (!options.length) { closeMenu(); return; }
  options.forEach((o, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `opt-${i}`;
    li.setAttribute('aria-selected', String(i === menuIndex));
    const a = document.createElement('span');
    if (o.isNew) { a.className = 'opt-new'; a.textContent = `Add “${o.label}” as a new tag`; } else a.textContent = o.label;
    li.append(a);
    if (o.hint) {
      const h = document.createElement('span');
      h.className = 'opt-hint';
      h.textContent = o.hint;
      li.append(h);
    }
    li.addEventListener('mousedown', (ev) => { ev.preventDefault(); chooseOption(o); });
    menu.append(li);
  });
  menu._options = options;
  menu.hidden = false;
  $('tag-input').setAttribute('aria-expanded', 'true');
}

function chooseOption(o) {
  addTag(o.label, o.isNew);
  $('tag-input').value = '';
  $('did-you-mean').hidden = true;
  closeMenu();
  $('tag-input').focus();
}

$('tag-input').addEventListener('input', () => {
  const q = $('tag-input').value.trim();
  $('did-you-mean').hidden = true;
  clearTimeout(searchTimer);
  if (!q) { closeMenu(); return; }
  searchTimer = setTimeout(async () => {
    const rows = await searchTags(q);
    if (rows && $('tag-input').value.trim() === q) { menuIndex = -1; renderMenu(q); }
  }, 150);
});

$('tag-input').addEventListener('keydown', (ev) => {
  const menu = $('tag-menu');
  const opts = menu._options || [];
  if (ev.key === 'ArrowDown' && !menu.hidden) {
    ev.preventDefault();
    menuIndex = Math.min(opts.length - 1, menuIndex + 1);
    renderMenu($('tag-input').value.trim());
  } else if (ev.key === 'ArrowUp' && !menu.hidden) {
    ev.preventDefault();
    menuIndex = Math.max(-1, menuIndex - 1);
    renderMenu($('tag-input').value.trim());
  } else if (ev.key === 'Enter' && !(ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    if (!menu.hidden && menuIndex >= 0 && opts[menuIndex]) chooseOption(opts[menuIndex]);
    else addTyped();
  } else if (ev.key === 'Escape') {
    closeMenu();
  }
});
$('tag-input').addEventListener('blur', () => setTimeout(closeMenu, 120));
$('btn-add-tag').addEventListener('click', () => addTyped());

// Typed text: an existing tag (by name or alias) is used as is; something close gets a
// "Did you mean…?" check; anything else becomes a new tag.
async function addTyped() {
  const q = $('tag-input').value.trim();
  if (!q) return;
  closeMenu();
  const rows = (await searchTags(q)) || lastResults;
  const exact = rows.find((r) => r.label.toLowerCase() === q.toLowerCase() || r.similarity >= 0.999);
  if (exact) { chooseOption({ label: exact.label, isNew: false }); return; }
  const close = rows.find((r) => r.similarity >= 0.55 && !hasTag(r.label));
  if (close) { askDidYouMean(q, close); return; }
  chooseOption({ label: q, isNew: true });
}

function askDidYouMean(typed, match) {
  const box = $('did-you-mean');
  box.textContent = '';
  const p = document.createElement('div');
  p.append('Did you mean ');
  const b = document.createElement('b');
  b.textContent = match.label;
  p.append(b, match.hint ? ` (${match.hint})?` : '?');
  const row = document.createElement('div');
  row.className = 'row gap';
  const use = document.createElement('button');
  use.type = 'button';
  use.className = 'btn-dark';
  use.textContent = `Use ${match.label}`;
  use.addEventListener('click', () => chooseOption({ label: match.label, isNew: false }));
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'btn-quiet';
  keep.textContent = `Keep “${typed}”`;
  keep.addEventListener('click', () => chooseOption({ label: typed, isNew: true }));
  row.append(use, keep);
  box.append(p, row);
  box.hidden = false;
}

// ---------- save ----------

async function save() {
  if (!cap || saving) return;
  if ($('passage-edit').hidden === false) $('btn-done-edit').click();
  if ($('source-edit').hidden === false) $('btn-done-source').click();
  // A tag typed but not yet added still counts.
  if ($('tag-input').value.trim()) await addTyped();
  if (!$('did-you-mean').hidden) return; // let the user answer first

  saving = true;
  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  $('save-error').hidden = true;

  const body = {
    quote: cap.edited ?? cap.text,
    text_captured: cap.text,
    prefix: cap.prefix || undefined,
    suffix: cap.suffix || undefined,
    note: $('note').value.trim() || undefined,
    url: cap.url || undefined,
    title: cap.title || undefined,
    site_name: cap.site_name || undefined,
    author: cap.author || undefined,
    published_at: cap.published_at || undefined,
    tags: cap.tags.map((t) => t.label),
    capture_method: 'extension',
    client_id: cap.id,
    captured_at: new Date(cap.at || Date.now()).toISOString(),
  };

  try {
    await capture(body);
  } catch (e) {
    saving = false;
    btn.disabled = false;
    btn.textContent = 'Save Disco';
    if (e.signedOut) { show('signin'); return; }
    $('save-error').textContent = e.message;
    $('save-error').hidden = false;
    return;
  }

  btn.textContent = 'Saved';
  btn.classList.add('done');
  const savedId = cap.id;
  await chrome.storage.session.remove(PENDING_KEY);

  let closeAfter = 900;
  const sheet = await copyToSheet(sheetRow(body)).catch((e) => ({ error: e.message, waiting: 1 }));
  if (sheet.waiting) {
    $('save-error').textContent = "Saved to Disco. Couldn't copy it to your Google Sheet yet; Disco will try again next time (or from Settings).";
    $('save-error').hidden = false;
    closeAfter = 3500;
  }
  setTimeout(() => {
    if (cap && cap.id === savedId) {
      cap = null;
      window.close();
    }
  }, closeAfter);
}

$('btn-save').addEventListener('click', save);
document.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && !$('view-capture').hidden) { ev.preventDefault(); save(); }
});

// ---------- settings ----------

let returnTo = 'empty';

async function openSettings() {
  returnTo = !$('view-capture').hidden ? 'capture' : 'empty';
  const s = await getSession();
  $('settings-who').textContent = s ? `Signed in as ${s.user?.email || 'you'}` : 'Signed out';
  await renderSheetSettings();
  show('settings');
}

async function renderSheetSettings() {
  const st = await getSheetSettings();
  $('sheet-error').hidden = true;
  $('sheet-connected').hidden = !st;
  $('sheet-setup').hidden = !!st;
  if (st) {
    $('sheet-title').textContent = st.title;
    $('sheet-tab').textContent = st.tab;
    const n = await sheetQueueLength();
    $('sheet-queue').textContent = n ? `${n} save${n === 1 ? '' : 's'} waiting to be copied.` : 'Every save so far has been copied.';
    $('btn-sheet-retry').hidden = !n;
  }
}

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-empty').addEventListener('click', openSettings);
$('btn-settings-done').addEventListener('click', () => show(returnTo === 'capture' && cap ? 'capture' : 'empty'));
$('btn-signout').addEventListener('click', async () => { await signOut(); cap = null; show('signin'); });
$('btn-sheet-connect').addEventListener('click', async () => {
  const btn = $('btn-sheet-connect');
  btn.disabled = true;
  $('sheet-error').hidden = true;
  try {
    await connectSheet($('sheet-link').value.trim(), $('sheet-tab-input').value.trim() || 'Notes');
    await renderSheetSettings();
  } catch (e) {
    $('sheet-error').textContent = e.message;
    $('sheet-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});
$('btn-sheet-disconnect').addEventListener('click', async () => { await disconnectSheet(); await renderSheetSettings(); });
$('btn-sheet-retry').addEventListener('click', async () => {
  const r = await flushSheetQueue({ interactive: true });
  await renderSheetSettings();
  if (r.error) { $('sheet-error').textContent = r.error; $('sheet-error').hidden = false; }
});

start();
