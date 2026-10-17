// Calls to Disco's back end, always as the signed-in user (row-level security applies).

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { getAccessToken, getSession } from './auth.js';

export class SignedOutError extends Error {
  constructor() { super('Sign in to save to Disco'); this.signedOut = true; }
}

function offlineError() {
  const e = new Error("Can't reach Disco. Check your connection and try again.");
  e.offline = true;
  return e;
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
    throw offlineError();
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401) throw new SignedOutError();
  if (!res.ok) {
    const e = new Error(json?.error || json?.message || `Disco had a problem (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return json;
}

// Database function, e.g. rpc('suggest_tags_with_hints', { q: 'quan' })
export const rpc = (name, args) => call(`${SUPABASE_URL}/rest/v1/rpc/${name}`, args);

// The one capture endpoint used by every capture tool. See supabase/functions/capture/index.ts.
export const capture = (body) => call(`${SUPABASE_URL}/functions/v1/capture`, body);

// Upload an image (data: URL) to the user's own folder in the private disco-media bucket.
// The file is named after the capture's client_id, so a retry overwrites rather than duplicates.
export async function uploadImage(dataUrl, clientId) {
  const token = await getAccessToken();
  const session = await getSession();
  if (!token || !session?.user?.id) throw new SignedOutError();
  const blob = await (await fetch(dataUrl)).blob();
  const path = `${session.user.id}/${clientId}.jpg`;
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/storage/v1/object/disco-media/${path}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
      body: blob,
    });
  } catch {
    throw offlineError();
  }
  if (res.status === 401) throw new SignedOutError();
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.message || j.error || `Couldn't upload the image (${res.status})`);
  }
  return path;
}
