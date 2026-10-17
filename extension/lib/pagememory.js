// Remembers, per article (or video), the tags the user chose while reading it:
//   keep    — tags the user added themselves; offered automatically on every later save from the page
//   exclude — tags the user removed; never suggested again on that page
// Kept on this computer for 30 days after the last save from the page.

const KEY = 'disco.pageTags';
const DAYS = 30;
const MAX_PAGES = 300;

export function pageKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '');
    if (host === 'youtube.com' && u.searchParams.get('v')) return `youtube:${u.searchParams.get('v')}`;
    if (host === 'youtu.be') return `youtube:${u.pathname.slice(1).split('/')[0]}`;
    return `${host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return null;
  }
}

async function readAll() {
  return (await chrome.storage.local.get(KEY))[KEY] || {};
}

export async function getPageMemory(url) {
  const k = pageKey(url);
  if (!k) return { keep: [], exclude: [] };
  const m = (await readAll())[k];
  if (!m || Date.now() - m.at > DAYS * 86400e3) return { keep: [], exclude: [] };
  return { keep: m.keep || [], exclude: m.exclude || [] };
}

// added: labels the user typed in this save; removed: labels offered automatically that the user took off.
export async function rememberPageTags(url, added, removed) {
  const k = pageKey(url);
  if (!k) return;
  const all = await readAll();
  const m = all[k] && Date.now() - all[k].at <= DAYS * 86400e3 ? all[k] : { keep: [], exclude: [] };
  const lc = (s) => s.toLowerCase();
  let keep = (m.keep || []).filter((t) => !removed.some((r) => lc(r) === lc(t)));
  let exclude = (m.exclude || []).filter((t) => !added.some((a) => lc(a) === lc(t)));
  for (const a of added) if (!keep.some((t) => lc(t) === lc(a))) keep.push(a);
  for (const r of removed) if (!exclude.some((t) => lc(t) === lc(r))) exclude.push(r);
  all[k] = { keep, exclude, at: Date.now() };
  // Forget the oldest pages beyond the limit.
  const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  for (const old of keys.slice(MAX_PAGES)) delete all[old];
  await chrome.storage.local.set({ [KEY]: all });
}
