// Disco extension background worker.
//
// Ways in:
//   • highlight text → right-click → "Save to Disco" (also highlighted YouTube transcript lines → video moment,
//     and a single highlighted word → vocabulary)
//   • right-click an image → "Save image to Disco"
//   • right-click a video → "Save video moment to Disco"
//   • right-click the page → "Capture an area for Disco" (drag a box; saved as an image)
//   • Alt+Shift+D: the highlighted text, or the moment a playing video is at
//   • the toolbar icon opens the panel
// The background reads the page, then hands the panel a "pending" capture in chrome.storage.session.

import { flushCaptureQueue } from './lib/queue.js';
import { flushSheetQueue } from './lib/sheet.js';

const PENDING_KEY = 'disco.pending';
const MAX_SIDE = 1600;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'disco-text', title: 'Save to Disco', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'disco-image', title: 'Save image to Disco', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'disco-video', title: 'Save video moment to Disco', contexts: ['video'] });
    chrome.contextMenus.create({ id: 'disco-area', title: 'Capture an area for Disco', contexts: ['page'] });
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('disco-flush', { periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('disco-flush', { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'disco-flush') flushAll();
});

async function flushAll() {
  await flushCaptureQueue().catch(() => {});
  await flushSheetQueue().catch(() => {});
}

const setPending = (data) =>
  chrome.storage.session.set({ [PENDING_KEY]: { id: crypto.randomUUID(), at: Date.now(), ...data } });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runInPage(tabId, args) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage, args: [args] });
  return result?.result || null;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  // Open the panel first, while Chrome still counts this as the user's click.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  if (info.menuItemId === 'disco-text') grabSelection(tab, info.selectionText);
  else if (info.menuItemId === 'disco-image') grabImage(tab, info.srcUrl);
  else if (info.menuItemId === 'disco-video') grabVideo(tab, info.srcUrl);
  else if (info.menuItemId === 'disco-area') startArea(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'save-selection' || !tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  grabSelection(tab, '', true);
});

// ---------- text, vocabulary, transcript lines ----------

async function grabSelection(tab, fallbackText, fromShortcut = false) {
  let data = null;
  try {
    data = await runInPage(tab.id, { mode: fromShortcut ? 'shortcut' : 'selection' });
  } catch {
    // Pages the extension can't read (Chrome pages, the PDF viewer): use the text Chrome gave the menu.
  }
  if (!data || data.kind === 'none') {
    const text = (fallbackText || '').trim();
    data = text
      ? { kind: /^[\p{L}][\p{L}'’-]{0,39}$/u.test(text) ? 'vocab' : 'text', text, word: text, sentence: '', url: tab.url || '', title: tab.title || '' }
      : { kind: 'none' };
  }
  await setPending(data);
}

// ---------- images ----------

async function grabImage(tab, srcUrl) {
  await setPending({ kind: 'image', loading: true, imageUrl: srcUrl, url: tab.url, title: tab.title });
  await wait(350); // let the page settle after the side panel opens
  let info = null;
  try { info = await runInPage(tab.id, { mode: 'image', src: srcUrl }); } catch {}
  const meta = info || { url: tab.url, title: tab.title };

  let img = null;
  try {
    // Best quality: the original file, when the site allows it to be downloaded.
    const res = await fetch(srcUrl);
    if (res.ok && /^image\//.test(res.headers.get('content-type') || '')) img = await toJpeg(await res.blob());
  } catch {}
  if (!img && info?.rect) {
    // Otherwise a snapshot of the image as it appears on screen.
    try { img = await snapshot(tab, info.rect, info.viewportWidth); } catch {}
  }
  await setPending({
    ...meta, kind: 'image', loading: false, imageUrl: srcUrl,
    imageData: img?.dataUrl || null, width: img?.width, height: img?.height,
    error: img ? '' : "Couldn't get a copy of this image. Try “Capture an area” instead.",
  });
}

// ---------- capture an area ----------

async function startArea(tab) {
  await setPending({ kind: 'area-wait', url: tab.url, title: tab.title });
  await wait(350);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: areaPicker });
  } catch {
    await setPending({ kind: 'image', loading: false, error: "Disco can't capture this page.", url: tab.url, title: tab.title });
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'disco-area' && sender.tab?.id) {
    finishArea(sender.tab, msg);
  } else if (msg?.type === 'disco-area-cancel') {
    setPending({ kind: 'none' });
  } else if (msg?.type === 'disco-flush') {
    flushAll();
  }
});

async function finishArea(tab, msg) {
  let img = null;
  try { img = await snapshot(tab, msg.rect, msg.viewportWidth); } catch {}
  let meta = null;
  try { meta = await runInPage(tab.id, { mode: 'meta' }); } catch {}
  await setPending({
    ...(meta || { url: tab.url, title: tab.title }),
    kind: 'image', loading: false, area: true, imageUrl: null,
    imageData: img?.dataUrl || null, width: img?.width, height: img?.height,
    error: img ? '' : "Couldn't capture that area. Please try again.",
  });
}

// ---------- video moments ----------

async function grabVideo(tab, srcUrl) {
  let data = null;
  try { data = await runInPage(tab.id, { mode: 'video', src: srcUrl }); } catch {}
  await setPending(data && data.kind === 'video' ? data : { kind: 'none' });
}

// ---------- image helpers ----------

async function snapshot(tab, rect, viewportWidth) {
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const blob = await (await fetch(shot)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = bmp.width / (viewportWidth || bmp.width);
  const crop = {
    x: Math.max(0, Math.round(rect.x * scale)),
    y: Math.max(0, Math.round(rect.y * scale)),
  };
  crop.w = Math.min(bmp.width - crop.x, Math.round(rect.w * scale));
  crop.h = Math.min(bmp.height - crop.y, Math.round(rect.h * scale));
  if (crop.w < 4 || crop.h < 4) throw new Error('area too small');
  return toJpeg(bmp, crop);
}

async function toJpeg(source, crop) {
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  const c0 = crop || { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const k = Math.min(1, MAX_SIDE / Math.max(c0.w, c0.h));
  const w = Math.max(1, Math.round(c0.w * k));
  const h = Math.max(1, Math.round(c0.h * k));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff'; // transparent images get a white background
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, c0.x, c0.y, c0.w, c0.h, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { dataUrl: `data:image/jpeg;base64,${btoa(bin)}`, width: w, height: h };
}

// ======================================================================================
// Functions below run inside the web page. Each must be self-contained.
// ======================================================================================

async function readPage(opts) {
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const meta = (selector, root = document) => {
    const el = root.querySelector(selector);
    if (!el) return '';
    return squash(el.getAttribute('content') || el.getAttribute('datetime') || el.textContent || '');
  };
  const hms = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const toSec = (ts) => ts.split(':').reduce((a, n) => a * 60 + Number(n), 0);
  const TS = /^(\d{1,2}:\d{2}(?::\d{2})?)$/;

  // ---- page details ----
  function pageMeta() {
    let ld = {};
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const stack = [JSON.parse(s.textContent)];
        while (stack.length) {
          const o = stack.pop();
          if (!o || typeof o !== 'object') continue;
          if (Array.isArray(o)) { stack.push(...o); continue; }
          if (o['@graph']) stack.push(o['@graph']);
          const type = [].concat(o['@type'] || []).join(' ');
          if (/Article|BlogPosting|Report|NewsArticle|WebPage|VideoObject/.test(type) && !ld.headline) {
            const authors = [].concat(o.author || []).map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean);
            ld = {
              headline: o.headline || o.name,
              author: authors.join(', '),
              datePublished: o.datePublished || o.uploadDate || o.dateCreated,
              publisher: typeof o.publisher === 'string' ? o.publisher : o.publisher?.name,
            };
          }
        }
      } catch {}
    }
    const host = location.hostname.replace(/^www\./, '');
    let site = meta('meta[property="og:site_name"]') || squash(ld.publisher) || meta('meta[name="application-name"]') || '';
    let title = meta('meta[property="og:title"]') || squash(ld.headline) || squash(document.title);
    const m = title.match(/^(.{4,}?)\s+[|\-–—:]\s+([^|\-–—]{2,60})$/);
    if (m) {
      const tail = m[2].trim();
      if (!site || tail.toLowerCase() === site.toLowerCase() || site === host) {
        title = m[1].trim();
        if (!site || site === host) site = tail;
      }
    }
    if (!site) site = host;
    let author = meta('meta[name="author"]') || squash(ld.author) || meta('meta[property="article:author"]')
      || meta('[itemprop="author"] [itemprop="name"]') || meta('[rel="author"]') || '';
    if (/^https?:/i.test(author)) author = '';
    author = author.replace(/^by\s+/i, '').slice(0, 200);
    let published = meta('meta[property="article:published_time"]') || squash(ld.datePublished)
      || meta('meta[name="date"]') || meta('meta[itemprop="datePublished"]') || meta('time[datetime]') || '';
    const d = published ? new Date(published) : null;
    published = d && !isNaN(d) ? d.toISOString().slice(0, 10) : '';
    return { url: location.href, title, site_name: site, author, published_at: published };
  }

  // ---- video details (YouTube first, then any page with a video) ----
  function videoMeta() {
    const base = pageMeta();
    const yt = /(^|\.)youtube\.com$/.test(location.hostname);
    if (yt) {
      const h1 = squash(document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata')?.textContent);
      const channel = squash(document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a')?.textContent)
        || meta('span[itemprop="author"] link[itemprop="name"]');
      if (h1) base.title = h1;
      else base.title = squash(document.title).replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube$/, '');
      base.site_name = channel || 'YouTube';
      base.channel_id = meta('meta[itemprop="channelId"]') || meta('meta[itemprop="identifier"]') || '';
      const up = meta('meta[itemprop="uploadDate"]') || meta('meta[itemprop="datePublished"]');
      const d = up ? new Date(up) : null;
      if (d && !isNaN(d)) base.published_at = d.toISOString().slice(0, 10);
      base.author = '';
    }
    const v = document.querySelector('video');
    const iso = meta('meta[itemprop="duration"]');
    const pm = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    base.duration = pm ? (+pm[1] || 0) * 3600 + (+pm[2] || 0) * 60 + (+pm[3] || 0) : Math.floor(v?.duration || 0) || 0;
    return base;
  }

  // ---- transcript lines inside a selection ----
  function transcriptLines(sel) {
    if (!sel || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const lines = [];
    // YouTube's transcript panel (older and newer markup)
    const segs = document.querySelectorAll('ytd-transcript-segment-renderer, transcript-segment-view-model');
    for (const seg of segs) {
      if (!range.intersectsNode(seg)) continue;
      const stamp = [...seg.querySelectorAll('*')].map((e) => squash(e.textContent)).find((t) => TS.test(t));
      const textEl = seg.querySelector('.segment-text, yt-formatted-string.segment-text, [class*="SegmentText"], span[role="text"]');
      let text = squash(textEl ? textEl.textContent : seg.textContent);
      if (stamp && text.startsWith(stamp)) text = squash(text.slice(stamp.length));
      if (stamp && text) lines.push({ t: toSec(stamp), text });
    }
    if (lines.length) return lines;
    // Any page: lines that start with a timestamp in the selected text
    let cur = null;
    for (const raw of sel.toString().split(/\n+/)) {
      const line = squash(raw);
      if (!line || /^\d+\s+(seconds?|minutes?|hours?)\b/i.test(line)) continue;
      const only = line.match(TS);
      const lead = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
      if (only) { cur = { t: toSec(only[1]), text: '' }; lines.push(cur); }
      else if (lead) { cur = { t: toSec(lead[1]), text: lead[2] }; lines.push(cur); }
      else if (cur) cur.text = squash(`${cur.text} ${line}`);
    }
    return lines.filter((l) => l.text);
  }

  function sentenceAround(range, word) {
    try {
      const before = document.createRange();
      before.setStart(document.body, 0);
      before.setEnd(range.startContainer, range.startOffset);
      const after = document.createRange();
      after.setStart(range.endContainer, range.endOffset);
      after.setEnd(document.body, document.body.childNodes.length);
      const b = before.toString().slice(-600).replace(/\s+/g, ' ');
      const a = after.toString().slice(0, 600).replace(/\s+/g, ' ');
      const start = Math.max(b.lastIndexOf('. '), b.lastIndexOf('? '), b.lastIndexOf('! '), b.lastIndexOf('\n'));
      const endM = a.match(/[.?!](\s|$)/);
      const s = squash(b.slice(start + 1) + word + (endM ? a.slice(0, endM.index + 1) : a.slice(0, 200)));
      return s.length > 400 ? '' : s;
    } catch { return ''; }
  }

  function contextAround(range) {
    let prefix = '', suffix = '';
    try {
      const before = document.createRange();
      before.setStart(document.body, 0);
      before.setEnd(range.startContainer, range.startOffset);
      prefix = squash(before.toString().slice(-400)).split(' ').slice(-15).join(' ');
    } catch {}
    try {
      const after = document.createRange();
      after.setStart(range.endContainer, range.endOffset);
      after.setEnd(document.body, document.body.childNodes.length);
      suffix = squash(after.toString().slice(0, 400)).split(' ').slice(0, 15).join(' ');
    } catch {}
    return { prefix, suffix };
  }

  function videoMoment(video) {
    const v = video || [...document.querySelectorAll('video')].find((x) => x.duration > 0) || null;
    if (!v) return null;
    const t = Math.floor(v.currentTime || 0);
    let caption = '';
    for (const track of v.textTracks || []) {
      if (track.mode === 'showing' && track.activeCues) caption += [...track.activeCues].map((c) => c.text).join(' ');
    }
    if (!caption) caption = squash([...document.querySelectorAll('.ytp-caption-segment')].map((e) => e.textContent).join(' '));
    return { kind: 'video', ...videoMeta(), lines: caption ? [{ t, text: squash(caption) }] : [], start: t, end: null };
  }

  if (opts.mode === 'meta') return pageMeta();

  if (opts.mode === 'image') {
    const img = [...document.images].find((i) => i.currentSrc === opts.src || i.src === opts.src);
    const info = { kind: 'image', ...pageMeta(), alt: '', caption: '' };
    if (img) {
      info.alt = squash(img.alt).slice(0, 500);
      const fig = img.closest('figure');
      info.caption = squash(fig?.querySelector('figcaption')?.textContent || img.title || '').slice(0, 1000);
      img.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rc = img.getBoundingClientRect();
      const x = Math.max(0, rc.left), y = Math.max(0, rc.top);
      info.rect = { x, y, w: Math.min(innerWidth, rc.right) - x, h: Math.min(innerHeight, rc.bottom) - y };
      info.viewportWidth = innerWidth;
    }
    return info;
  }

  if (opts.mode === 'video') {
    const v = [...document.querySelectorAll('video')].find((x) => x.currentSrc === opts.src || x.src === opts.src);
    return videoMoment(v) || { kind: 'none' };
  }

  // selection or shortcut
  const sel = window.getSelection();
  const text = (sel ? sel.toString() : '').replace(/ /g, ' ').trim();
  if (!text) {
    if (opts.mode === 'shortcut') return videoMoment(null) || { kind: 'none' };
    return { kind: 'none' };
  }
  const lines = transcriptLines(sel);
  if (lines.length) {
    return { kind: 'video', ...videoMeta(), lines, start: lines[0].t, end: lines.length > 1 ? lines[lines.length - 1].t : null };
  }
  const range = sel.getRangeAt(0);
  if (/^[\p{L}][\p{L}'’-]{0,39}$/u.test(text)) {
    return { kind: 'vocab', word: text, text, sentence: sentenceAround(range, text), ...contextAround(range), ...pageMeta() };
  }
  return { kind: 'text', text, ...contextAround(range), ...pageMeta() };
}

function areaPicker() {
  if (document.getElementById('__disco_area')) return;
  const layer = document.createElement('div');
  layer.id = '__disco_area';
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(22,27,34,.18)';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;border:2px solid #b8730f;background:rgba(251,241,223,.25);box-shadow:0 0 0 9999px rgba(22,27,34,.28);display:none;pointer-events:none';
  const tip = document.createElement('div');
  tip.textContent = 'Drag a box around what you want to save · Esc to cancel';
  tip.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#161b22;color:#fff;font:600 13px system-ui,sans-serif;padding:8px 14px;border-radius:999px;pointer-events:none';
  layer.append(box, tip);
  document.documentElement.append(layer);
  let sx = 0, sy = 0, dragging = false;
  const done = (msg) => {
    layer.remove();
    removeEventListener('keydown', onKey, true);
    requestAnimationFrame(() => requestAnimationFrame(() => chrome.runtime.sendMessage(msg)));
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done({ type: 'disco-area-cancel' }); } };
  addEventListener('keydown', onKey, true);
  layer.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = true; sx = e.clientX; sy = e.clientY; box.style.display = 'block'; });
  layer.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
    Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - sx)}px`, height: `${Math.abs(e.clientY - sy)}px` });
  });
  layer.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const rect = { x: Math.min(sx, e.clientX), y: Math.min(sy, e.clientY), w: Math.abs(e.clientX - sx), h: Math.abs(e.clientY - sy) };
    if (rect.w < 8 || rect.h < 8) { box.style.display = 'none'; return; }
    done({ type: 'disco-area', rect, viewportWidth: innerWidth });
  });
}
