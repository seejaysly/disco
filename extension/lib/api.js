// Calls to Disco's back end, always as the signed-in user (row-level security applies).

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { getAccessToken } from './auth.js';

export class SignedOutError extends Error {
  constructor() { super('Sign in to save to Disco'); this.signedOut = true; }
}

async function call(url, body) {
  const token = await getAccessToken();
  if (!token) throw new SignedOutError();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    const e = new Error("Can't reach Disco. Check your connection and try again.");
    e.offline = true;
    throw e;
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401) throw new SignedOutError();
  if (!res.ok) throw new Error(json?.error || json?.message || `Disco had a problem (${res.status})`);
  return json;
}

// Database function, e.g. rpc('suggest_tags_with_hints', { q: 'quan' })
export const rpc = (name, args) => call(`${SUPABASE_URL}/rest/v1/rpc/${name}`, args);

// The one capture endpoint used by every capture tool. See supabase/functions/capture/index.ts.
export const capture = (body) => call(`${SUPABASE_URL}/functions/v1/capture`, body);
