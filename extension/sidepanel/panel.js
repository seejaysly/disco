// The Disco side panel. It shows what's being saved (a passage, a single word, an image or a
// video moment), lets the user edit it, add a note, adjust tags and confirm the source, then
// saves through the capture endpoint (or keeps it for later when offline).

import { getSession, signIn, signOut } from '../lib/auth.js';
import { rpc } from '../lib/api.js';
import { saveOrQueue, flushCaptureQueue, captureQueueInfo } from '../lib/queue.js';
import { getPageMemory, rememberPageTags } from '../lib/pagememory.js';
import {
  getSheetSettings, connectSheet, disconnectSheet, copyToSheet, flushSheetQueue, sheetRow, sheetQueueLength,
} from '../lib/sheet.js';

const PENDING_KEY = 'disco.pending';
const $ = (id) => document.getElementById(id);

let cap = null;            // the disco being prepared
let lastResults = [];      // last autocomplete results
let menuIndex = -1;
let saving = false;

const hms = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

// ---------- views ----------

function show(view) {
  for (const v of ['signin', 'empty', 'wait', 'capture', 'settings']) $(`view-${v}`).hidden = v !== view;
}

async function showEmpty() {
  show('empty');
  const q = await captureQueueInfo();
  $('empty-queue').hidden = !q.waiting;
  $('empty-queue').textContent = q.waiting ? `${q.waiting} save${q.waiting === 1 ? '' : 's'} waiting to send. Disco keeps trying.` : '';
}

async function start() {
  const session = await getSession();
  if (!session) { show('signin'); return; }
  $('who').textContent = session.user?.email || 'Signed in';
  flushCaptureQueue().catch(() => {});
  flushSheetQueue().catch(() => {});
  const pending = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
  handlePending(pending);
}

function handlePending(p) {
  if (!p || p.kind === 'none') { if (!cap || saving) showEmpty(); return; }
  if (cap && cap.id === p.id && cap.kind === 'video') {
    // The still of the video arrives a moment after the moment itself.
    cap.frameLoading = !!p.frameLoading;
    if (p.frameData) { cap.frameData = p.frameData; cap.frameWidth = p.frameWidth; cap.frameHeight = p.frameHeight; }
    renderMain();
    return;
  }
  if (p.kind === 'area-wait') {
    $('wait-text').textContent = 'Drag a box around the part of the page you want to save. Press Esc to cancel.';
    show('wait');
    return;
  }
  if (p.kind === 'image' && p.loading) {
    $('wait-text').textContent = 'Getting the image…';
    show('wait');
    return;
  }
  openCapture(p);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[PENDING_KEY]) return;
  const p = changes[PENDING_KEY].newValue;
  if (!p) return;
  getSession().then((s) => {
    if (!s) { show('signin'); return; }
    handlePending(p);
  });
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

// ---------- open a capture ----------

function openCapture(p) {
  if (cap && cap.id === p.id) { show('capture'); return; }
  const kind = p.kind === 'vocab' ? 'vocab' : p.kind || 'text';
  const lines = p.lines || [];
  cap = {
    id: p.id, at: p.at, kind,
    text: kind === 'video' ? lines.map((l) => l.text).join('\n') : (p.text || p.word || ''),
    edited: null, showingOriginal: false,
    word: p.word || '', sentence: p.sentence || '',
    prefix: p.prefix || '', suffix: p.suffix || '',
    url: p.url || '', title: p.title || '', site_name: p.site_name || '', author: p.author || '', published_at: p.published_at || '',
    // image
    imageData: p.imageData || null, imageUrl: p.imageUrl || null, alt: p.alt || '', caption: p.caption || '',
    width: p.width, height: p.height, area: !!p.area, imageError: p.error || '',
    // video
    lines, start: p.start ?? (lines[0]?.t ?? 0), end: p.end ?? null, channel_id: p.channel_id || '', duration: p.duration || 0, tabId: p.tabId || null,
    frameLoading: !!p.frameLoading, frameData: p.frameData || null, frameWidth: p.frameWidth, frameHeight: p.frameHeight,
    tags: [], offered: new Set(), excluded: new Set(),
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
  $('source-edit').hidden = true;
  $('source-view').hidden = false;
  const btn = $('btn-save');
  btn.classList.remove('done');
  btn.textContent = 'Save Disco';
  btn.disabled = kind === 'image' && !cap.imageData;
  $('note').placeholder = {
    image: 'What this image shows you',
    video: 'Why this moment matters',
  }[kind] || 'Your thought on this. It shows under the passage in your knowledge guide.';
  renderMain();
  renderSource();
  renderTags();
  show('capture');
  loadSuggestions(cap.id);
}

function renderMain() {
  const k = cap.kind;
  const editing = !$('passage-edit').hidden;
  $('mode-text').hidden = k !== 'text' || editing;
  $('mode-vocab').hidden = k !== 'vocab';
  $('mode-image').hidden = k !== 'image';
  $('mode-video').hidden = k !== 'video' || editing;
  $('source-block').hidden = k === 'video';
  const edited = cap.edited != null && (k === 'text' || k === 'video');
  $('edited-row').hidden = !edited || editing;
  $('btn-toggle-original').textContent = cap.showingOriginal ? 'Original · show your edit' : 'Edited · show original';
  const shown = edited && !cap.showingOriginal ? cap.edited : cap.text;

  if (k === 'text') $('passage').textContent = shown;

  if (k === 'vocab') {
    $('vocab-word').textContent = cap.word;
    const box = $('vocab-sentence');
    box.textContent = '';
    const s = cap.sentence;
    const i = s ? s.toLowerCase().indexOf(cap.word.toLowerCase()) : -1;
    if (i >= 0) {
      const mark = document.createElement('mark');
      mark.textContent = s.slice(i, i + cap.word.length);
      box.append(s.slice(0, i), mark, s.slice(i + cap.word.length));
    } else {
      box.textContent = s || '';
    }
  }

  if (k === 'image') {
    const img = $('image-preview');
    if (cap.imageData) { img.src = cap.imageData; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
    img.alt = cap.alt || 'The image you saved';
    $('image-caption').textContent = cap.caption || cap.alt || (cap.area ? 'A part of the page you captured.' : '');
    $('image-error').textContent = cap.imageError;
    $('image-error').hidden = !cap.imageError;
  }

  if (k === 'video') {
    const multi = cap.lines.length > 1;
    $('video-head-label').textContent = cap.lines.length ? (multi ? 'Highlighted from the transcript' : 'Captions at this moment') : 'Video moment';
    $('video-range').textContent = cap.end != null && cap.end !== cap.start ? `${hms(cap.start)} – ${hms(cap.end)}` : hms(cap.start);
    const box = $('video-lines');
    box.textContent = '';
    if (edited && !cap.showingOriginal) {
      const d = document.createElement('span');
      d.className = 'plain';
      d.textContent = cap.edited;
      box.append(d);
    } else if (cap.lines.length) {
      for (const l of cap.lines) {
        const t = document.createElement('span'); t.className = 'ts'; t.textContent = hms(l.t);
        const x = document.createElement('span'); x.className = 'ln'; x.textContent = l.text;
        box.append(t, x);
      }
    } else {
      const n = document.createElement('span');
      n.className = 'none';
      n.textContent = 'No captions at this moment. Click to type what was said, or add a note.';
      box.append(n);
    }
    $('video-still-wrap').hidden = !cap.frameData && !cap.frameLoading;
    $('video-still').hidden = !cap.frameData;
    if (cap.frameData) $('video-still').src = cap.frameData;
    $('video-still-wait').hidden = !!cap.frameData;
    $('video-channel').textContent = cap.site_name || 'Video';
    $('video-title').textContent = cap.title || '';
    $('video-meta').textContent = [cap.published_at ? prettyDate(cap.published_at) : '', cap.duration ? `${Math.round(cap.duration / 60)} min` : '']
      .filter(Boolean).join(' · ');
  }
}

// ---------- editing text / transcript ----------

function startEdit() {
  $('passage-input').value = cap.edited ?? cap.text;
  $('passage-edit').hidden = false;
  cap.showingOriginal = false;
  renderMain();
  $('passage-input').focus();
}
$('passage').addEventListener('click', startEdit);
$('video-text').addEventListener('click', startEdit);
$('btn-cancel-edit').addEventListener('click', () => { $('passage-edit').hidden = true; renderMain(); });
$('btn-done-edit').addEventListener('click', () => {
  const v = $('passage-input').value.trim();
  if (cap.kind === 'video' && !cap.text) { cap.text = v; cap.edited = null; }
  else cap.edited = !v || v === cap.text ? null : v;
  $('passage-edit').hidden = true;
  renderMain();
  if (cap.tags.length === 0 && v) loadSuggestions(cap.id);
});
$('btn-toggle-original').addEventListener('click', () => { cap.showingOriginal = !cap.showingOriginal; renderMain(); });

$('btn-not-vocab').addEventListener('click', () => {
  cap.kind = 'text';
  cap.text = cap.word;
  renderMain();
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
    s.textContent = 'author not found';
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

function suggestionText() {
  if (cap.kind === 'image') return [cap.caption, cap.alt, cap.title].filter(Boolean).join('. ');
  if (cap.kind === 'vocab') return '';
  return cap.edited ?? cap.text;
}

async function loadSuggestions(forId) {
  // Tags you chose earlier on this page come first; tags you removed on this page stay away.
  const mem = await getPageMemory(cap.url);
  if (!cap || cap.id !== forId) return;
  cap.excluded = new Set(mem.exclude.map((t) => t.toLowerCase()));
  for (const t of mem.keep) { addTag(t, false); cap.offered.add(t.toLowerCase()); }

  const passage = suggestionText();
  if (!passage) { $('tags-status').textContent = cap.kind === 'vocab' || cap.tags.length ? '' : 'Add a tag below if you like.'; return; }
  $('tags-status').textContent = 'Finding tags…';
  try {
    const rows = await rpc('suggest_tags_for_capture', {
      p_passage: passage, p_url: cap.url || null, p_author: cap.author || null, max_results: 16,
    });
    if (!cap || cap.id !== forId) return;
    let added = 0;
    for (const r of rows || []) {
      if (added >= 8) break;
      const lc = r.label.toLowerCase();
      if (cap.excluded.has(lc) || hasTag(r.label)) continue;
      addTag(r.label, false);
      cap.offered.add(lc);
      added++;
    }
    $('tags-status').textContent = cap.tags.length ? '' : 'No suggestions yet. Add a tag below if you like.';
  } catch (e) {
    if (!cap || cap.id !== forId) return;
    if (e.signedOut) { show('signin'); return; }
    $('tags-status').textContent = e.offline ? "You're offline. You can still add tags." : "Couldn't load suggestions. You can still add tags.";
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

function buildBody() {
  const note = $('note').value.trim() || undefined;
  const common = {
    note,
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
  if (cap.kind === 'vocab') {
    return { ...common, kind: 'vocabulary', quote: cap.word, text_captured: cap.word,
      prefix: cap.prefix || undefined, suffix: cap.suffix || undefined,
      details: cap.sentence ? { example: cap.sentence } : undefined };
  }
  if (cap.kind === 'image') {
    return { ...common, kind: 'image', quote: cap.caption || undefined,
      image: { original_url: cap.imageUrl || undefined, alt_text: cap.alt || undefined, caption: cap.caption || undefined,
        width: cap.width, height: cap.height } };
  }
  if (cap.kind === 'video') {
    const text = cap.text || undefined;
    return { ...common, kind: 'video', author: undefined,
      quote: cap.edited ?? text, text_captured: text,
      channel_id: cap.channel_id || undefined,
      video: { start_seconds: cap.start, end_seconds: cap.end ?? undefined, caption_text: text },
      image: cap.frameData ? { width: cap.frameWidth, height: cap.frameHeight, caption: `Still at ${hms(cap.start)}` } : undefined,
      details: cap.duration ? { duration_seconds: cap.duration } : undefined };
  }
  return { ...common, kind: 'highlight', quote: cap.edited ?? cap.text, text_captured: cap.text,
    prefix: cap.prefix || undefined, suffix: cap.suffix || undefined };
}

async function save() {
  if (!cap || saving) return;
  if (!$('passage-edit').hidden) $('btn-done-edit').click();
  if (!$('source-edit').hidden) $('btn-done-source').click();
  // A tag typed but not yet added still counts.
  if ($('tag-input').value.trim()) await addTyped();
  if (!$('did-you-mean').hidden) return; // let the user answer first
  if (cap.kind === 'image' && !cap.imageData) return;
  // Give the video still a moment to arrive if it's on its way.
  for (let i = 0; i < 30 && cap.kind === 'video' && cap.frameLoading; i++) await new Promise((r) => setTimeout(r, 100));

  saving = true;
  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  $('save-error').hidden = true;

  const body = buildBody();
  let outcome;
  try {
    outcome = await saveOrQueue(body, cap.kind === 'image' ? cap.imageData : cap.kind === 'video' ? cap.frameData : null);
  } catch (e) {
    saving = false;
    btn.disabled = false;
    btn.textContent = 'Save Disco';
    if (e.signedOut) { show('signin'); return; }
    $('save-error').textContent = e.message;
    $('save-error').hidden = false;
    return;
  }

  btn.textContent = outcome.queued ? 'Saved for later' : 'Saved';
  btn.classList.add('done');
  const savedId = cap.id;
  await chrome.storage.session.remove(PENDING_KEY);
  {
    const finalLc = new Set(body.tags.map((t) => t.toLowerCase()));
    const typed = body.tags.filter((t) => !cap.offered.has(t.toLowerCase()));
    const removed = [...cap.offered].filter((t) => !finalLc.has(t));
    await rememberPageTags(cap.url, typed, removed).catch(() => {});
  }

  const notes = [];
  let closeAfter = 900;
  if (outcome.queued) {
    notes.push("You're offline, so this is kept on your computer and will be sent to Disco when you're back online.");
    closeAfter = 3500;
  }
  const sheet = await copyToSheet(sheetRow(body)).catch((e) => ({ error: e.message, waiting: 1 }));
  if (sheet.waiting && !outcome.queued) {
    notes.push("Couldn't copy it to your Google Sheet yet; Disco will try again (or use Settings).");
    closeAfter = 3500;
  }
  if (notes.length) {
    $('save-error').textContent = notes.join(' ');
    $('save-error').hidden = false;
  }
  // After a transcript save, ask the background to put the transcript back where you were.
  const backTo = cap.kind === 'video' && cap.tabId && cap.lines.length
    ? { type: 'disco-return-to', tabId: cap.tabId, seconds: cap.end ?? cap.start } : null;
  setTimeout(async () => {
    if (cap && cap.id === savedId) {
      cap = null;
      if (backTo) await chrome.runtime.sendMessage(backTo).catch(() => {});
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
  await renderQueue();
  await renderSheetSettings();
  show('settings');
}

async function renderQueue() {
  const q = await captureQueueInfo();
  $('queue-block').hidden = !q.waiting;
  $('queue-text').textContent = q.waiting
    ? `${q.waiting} save${q.waiting === 1 ? '' : 's'} made offline ${q.waiting === 1 ? 'is' : 'are'} waiting to go to Disco.` + (q.problems.length ? ` Last problem: ${q.problems[q.problems.length - 1]}` : '')
    : '';
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
$('btn-settings-done').addEventListener('click', () => { if (returnTo === 'capture' && cap) show('capture'); else showEmpty(); });
$('btn-signout').addEventListener('click', async () => { await signOut(); cap = null; show('signin'); });
$('btn-queue-retry').addEventListener('click', async () => { await flushCaptureQueue(); await renderQueue(); });
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
