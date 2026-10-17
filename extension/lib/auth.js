// Sign-in for the Disco extension.
//
// Google sign-in happens in a Chrome sign-in window (chrome.identity.launchWebAuthFlow).
// Google hands back an ID token, which Supabase exchanges for a Disco session
// (the same account as signing in on the web). The session is kept in chrome.storage.local
// and refreshed quietly before it expires, so the user signs in once.
//
// A separate, optional Google token with Sheets access is used only during the
// side-by-side comparison, to copy each save into the user's existing Google Sheet.

import { SUPABASE_URL, SUPABASE_KEY, GOOGLE_CLIENT_ID } from './config.js';

const SESSION_KEY = 'disco.session';
const SHEETS_TOKEN_KEY = 'disco.googleSheetsToken';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomString = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

function webAuthFlow(url, interactive) {
  return new Promise((resolve, reject) => {
    const opts = { url, interactive };
    if (!interactive) Object.assign(opts, { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 8000 });
    chrome.identity.launchWebAuthFlow(opts, (redirect) => {
      if (chrome.runtime.lastError || !redirect) {
        reject(new Error(chrome.runtime.lastError?.message || 'Sign-in was cancelled'));
      } else {
        resolve(redirect);
      }
    });
  });
}

function fragmentParams(redirect) {
  const u = new URL(redirect);
  return new URLSearchParams(u.hash ? u.hash.slice(1) : u.search.slice(1));
}

async function supabaseAuth(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.msg || json.error_description || json.message || `Disco sign-in failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function storeSession(s) {
  const session = {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
    user: { id: s.user?.id, email: s.user?.email, name: s.user?.user_metadata?.full_name || s.user?.user_metadata?.name || '' },
  };
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

export async function getSession() {
  return (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY] || null;
}

export async function signIn() {
  const rawNonce = randomString();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'id_token token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: 'openid email profile',
    nonce: await sha256(rawNonce),
    prompt: 'select_account',
  });
  const redirect = await webAuthFlow(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, true);
  const f = fragmentParams(redirect);
  if (f.get('error')) throw new Error(`Google sign-in: ${f.get('error_description') || f.get('error')}`);
  if (!f.get('id_token')) throw new Error('Google did not return a sign-in token');
  const s = await supabaseAuth('token?grant_type=id_token', {
    provider: 'google',
    id_token: f.get('id_token'),
    access_token: f.get('access_token'),
    nonce: rawNonce,
  });
  return storeSession(s);
}

let refreshing = null;

// A valid Disco access token, refreshing it when it is about to expire. Null when signed out.
export async function getAccessToken() {
  const s = await getSession();
  if (!s) return null;
  if (s.expires_at * 1000 - 60_000 > Date.now()) return s.access_token;
  if (!refreshing) {
    refreshing = supabaseAuth('token?grant_type=refresh_token', { refresh_token: s.refresh_token })
      .then(storeSession)
      .catch(async (e) => {
        // A refresh token that is rejected means the session is over; sign out cleanly.
        if (e.status === 400 || e.status === 401) await chrome.storage.local.remove(SESSION_KEY);
        throw e;
      })
      .finally(() => { refreshing = null; });
  }
  return (await refreshing).access_token;
}

export async function signOut() {
  const s = await getSession();
  await chrome.storage.local.remove([SESSION_KEY, SHEETS_TOKEN_KEY]);
  if (s?.access_token) {
    fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${s.access_token}` },
    }).catch(() => {});
  }
}

// Google token with permission to edit the user's sheets (comparison period only).
// interactive=false tries silently and fails if Google needs the user to click something.
export async function getSheetsToken({ interactive = false } = {}) {
  const t = (await chrome.storage.local.get(SHEETS_TOKEN_KEY))[SHEETS_TOKEN_KEY];
  if (t && t.expires_at - 60_000 > Date.now()) return t.access_token;
  const s = await getSession();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SHEETS_SCOPE,
    include_granted_scopes: 'true',
  });
  if (s?.user?.email) params.set('login_hint', s.user.email);
  if (!interactive) params.set('prompt', 'none');
  const redirect = await webAuthFlow(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive);
  const f = fragmentParams(redirect);
  if (f.get('error') || !f.get('access_token')) {
    throw new Error(`Google Sheets access: ${f.get('error_description') || f.get('error') || 'no token'}`);
  }
  const token = { access_token: f.get('access_token'), expires_at: Date.now() + Number(f.get('expires_in') || 3600) * 1000 };
  await chrome.storage.local.set({ [SHEETS_TOKEN_KEY]: token });
  return token.access_token;
}

export async function forgetSheetsToken() {
  await chrome.storage.local.remove(SHEETS_TOKEN_KEY);
}
