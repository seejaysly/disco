// Comparison period only: copy each save into the user's existing Disco Google Sheet,
// so the current Coda feed keeps receiving everything. Removed at cutover (Phase 7).
//
// The Sheet's "Notes" tab has these columns, in this order (same as the original extension):
// Date captured | Text captured | Summary | Tags | Title | URL | Publication | Author | Date published

import { getSheetsToken, forgetSheetsToken } from './auth.js';

const SETTINGS_KEY = 'disco.sheetCopy';     // { sheetId, tab, title }
const QUEUE_KEY = 'disco.sheetQueue';       // rows waiting to be copied

export async function getSheetSettings() {
  return (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || null;
}

export function sheetIdFromLink(link) {
  const m = String(link || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/) || String(link || '').match(/^([a-zA-Z0-9_-]{30,})$/);
  return m ? m[1] : null;
}

async function sheetsFetch(url, init = {}, interactive = false) {
  let token = await getSheetsToken({ interactive });
  let res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    await forgetSheetsToken();
    token = await getSheetsToken({ interactive });
    res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Google Sheets error ${res.status}`);
  return json;
}

// Connect a sheet: asks Google for Sheets access (a click the first time) and checks the tab exists.
export async function connectSheet(link, tab = 'Notes') {
  const sheetId = sheetIdFromLink(link);
  if (!sheetId) throw new Error("That doesn't look like a Google Sheets link");
  const info = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=properties.title,sheets.properties.title`,
    {}, true);
  const tabs = (info.sheets || []).map((s) => s.properties.title);
  if (!tabs.includes(tab)) throw new Error(`The sheet has no "${tab}" tab (it has: ${tabs.join(', ')})`);
  const settings = { sheetId, tab, title: info.properties?.title || 'Google Sheet' };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

export async function disconnectSheet() {
  await chrome.storage.local.remove([SETTINGS_KEY, QUEUE_KEY]);
  await forgetSheetsToken();
}

const mdy = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

function publishedForSheet(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${+m[2]}/${+m[3]}/${m[1]}` : String(iso);
}

// The video's own address, without the moment, playlist or tracking bits. Coda makes one source
// per address, so every moment saved from a video must share the same one to land in one video guide.
// (The new Disco keeps the exact moment with each disco.)
function plainVideoUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com') id = u.pathname === '/watch' ? u.searchParams.get('v') : (u.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/) || [])[2];
    if (id) return `https://www.youtube.com/watch?v=${id}`;
    u.hash = '';
    return u.toString();
  } catch { return url; }
}

// One row in the same shape the original extension writes, for any kind of disco.
export function sheetRow(c) {
  const tags = [...(c.tags || [])];
  let text = c.text_captured || c.quote || '';
  let summary = c.quote || c.text_captured || '';
  let url = c.url || '';
  if (c.kind === 'vocabulary') {
    if (!tags.some((t) => t.toLowerCase() === 'vocabulary')) tags.push('vocabulary');
  } else if (c.kind === 'image') {
    // Alt text that is just a file name ("File:Something.jpg") reads badly in Coda; skip it.
    const alt = c.image?.alt_text || '';
    const usefulAlt = /^(file:)?.*\.(jpe?g|png|gif|webp|svg|tiff?)$/i.test(alt.trim()) ? '' : alt;
    const words = c.image?.caption || c.note || usefulAlt || c.title || '';
    text = `[Image] ${words} ${c.image?.original_url || ''}`.replace(/\s+/g, ' ').trim();
    summary = words || text;
  } else if (c.kind === 'video') {
    url = plainVideoUrl(url);
  }
  return [
    mdy(new Date(c.captured_at || Date.now())),
    text,
    summary,
    tags.join(', '),
    c.title || '',
    url,
    c.site_name || '',
    c.author || '',
    publishedForSheet(c.published_at),
  ];
}

async function appendRows(settings, rows) {
  const range = encodeURIComponent(`${settings.tab}!A:I`);
  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${settings.sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: rows }) });
}

// Queue a row, then try to copy everything waiting. Returns { copied, waiting }.
export async function copyToSheet(row) {
  const settings = await getSheetSettings();
  if (!settings) return { copied: 0, waiting: 0, off: true };
  const queue = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  if (row) queue.push(row);
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
  return flushSheetQueue();
}

export async function flushSheetQueue({ interactive = false } = {}) {
  const settings = await getSheetSettings();
  const queue = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  if (!settings || !queue.length) return { copied: 0, waiting: queue.length };
  try {
    if (interactive) await getSheetsToken({ interactive: true });
    await appendRows(settings, queue);
    await chrome.storage.local.set({ [QUEUE_KEY]: [] });
    return { copied: queue.length, waiting: 0 };
  } catch (e) {
    return { copied: 0, waiting: queue.length, error: e.message };
  }
}

export async function sheetQueueLength() {
  return ((await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || []).length;
}
