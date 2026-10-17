// Disco extension background worker.
// Main way in: highlight text → right-click → "Save to Disco". The keyboard shortcut
// (Alt+Shift+D) does the same; the toolbar icon just opens the panel.

const MENU_ID = 'disco-save-text';
const PENDING_KEY = 'disco.pending';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Save to Disco', contexts: ['selection'] });
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  // Open the panel first, while Chrome still counts this as the user's click.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  grabSelection(tab, info.selectionText);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'save-selection' || !tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  grabSelection(tab, '');
});

async function grabSelection(tab, fallbackText) {
  let data = null;
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readSelection });
    data = result?.result || null;
  } catch {
    // Pages the extension can't read (Chrome pages, the PDF viewer, some embedded frames):
    // fall back to the text Chrome gave the menu.
  }
  if (!data || !data.text) {
    data = { text: (fallbackText || '').trim(), prefix: '', suffix: '', url: tab.url || '', title: tab.title || '', site_name: '', author: '', published_at: '' };
  }
  data.id = crypto.randomUUID();
  data.at = Date.now();
  await chrome.storage.session.set({ [PENDING_KEY]: data });
}

// Runs inside the page. Must be self-contained.
function readSelection() {
  const sel = window.getSelection();
  const text = (sel ? sel.toString() : '').replace(/ /g, ' ').trim();
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  let prefix = '';
  let suffix = '';
  if (sel && sel.rangeCount && document.body) {
    const r = sel.getRangeAt(0);
    try {
      const before = document.createRange();
      before.setStart(document.body, 0);
      before.setEnd(r.startContainer, r.startOffset);
      prefix = squash(before.toString().slice(-400)).split(' ').slice(-15).join(' ');
    } catch {}
    try {
      const after = document.createRange();
      after.setStart(r.endContainer, r.endOffset);
      after.setEnd(document.body, document.body.childNodes.length);
      suffix = squash(after.toString().slice(0, 400)).split(' ').slice(0, 15).join(' ');
    } catch {}
  }

  const meta = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return '';
    return squash(el.getAttribute('content') || el.getAttribute('datetime') || el.textContent || '');
  };

  // Structured data many news sites include (schema.org Article).
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
        if (/Article|BlogPosting|Report|NewsArticle|WebPage/.test(type) && !ld.headline) {
          const authors = [].concat(o.author || []).map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean);
          ld = {
            headline: o.headline || o.name,
            author: authors.join(', '),
            datePublished: o.datePublished || o.dateCreated,
            publisher: typeof o.publisher === 'string' ? o.publisher : o.publisher?.name,
          };
        }
      }
    } catch {}
  }

  const host = location.hostname.replace(/^www\./, '');
  let site = meta('meta[property="og:site_name"]') || squash(ld.publisher) || meta('meta[name="application-name"]') || '';
  let title = meta('meta[property="og:title"]') || squash(ld.headline) || squash(document.title);

  // "Article title | Outlet" → title "Article title", outlet "Outlet"
  const m = title.match(/^(.{12,}?)\s+[|\-–—:]\s+([^|\-–—]{2,60})$/);
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

  return { text, prefix, suffix, url: location.href, title, site_name: site, author, published_at: published };
}
