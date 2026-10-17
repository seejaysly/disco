// Saving, with an offline safety net: if Disco can't be reached, the capture (and its image)
// waits in chrome.storage.local and is sent later — when the panel next opens, after the
// next save, or every few minutes from the background. client_id makes resending safe.

import { capture, uploadImage } from './api.js';

const QUEUE_KEY = 'disco.captureQueue';

async function readQueue() {
  return (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
}
async function writeQueue(q) {
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
}

async function send(body, imageData) {
  if (imageData) {
    const path = await uploadImage(imageData, body.client_id);
    body = { ...body, image: { ...(body.image || {}), storage_path: path } };
  }
  return capture(body);
}

// Returns { queued: false, result } when saved now, { queued: true } when kept for later.
// Throws for problems a retry won't fix (signed out, rejected by Disco).
export async function saveOrQueue(body, imageData = null) {
  try {
    const result = await send(body, imageData);
    flushCaptureQueue().catch(() => {});
    return { queued: false, result };
  } catch (e) {
    if (!e.offline) throw e;
    const q = await readQueue();
    if (!q.some((x) => x.body.client_id === body.client_id)) q.push({ body, imageData, tries: 0 });
    await writeQueue(q);
    return { queued: true };
  }
}

let flushing = null;

export function flushCaptureQueue() {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  let q = await readQueue();
  let sent = 0;
  for (const item of [...q]) {
    try {
      await send(item.body, item.imageData);
      sent++;
      q = q.filter((x) => x.body.client_id !== item.body.client_id);
      await writeQueue(q);
    } catch (e) {
      if (e.offline || e.signedOut) break; // try again later
      item.tries = (item.tries || 0) + 1;
      item.lastError = e.message;
      await writeQueue(q);
    }
  }
  return { sent, waiting: q.length };
}

export async function captureQueueInfo() {
  const q = await readQueue();
  return { waiting: q.length, problems: q.filter((x) => x.tries > 0).map((x) => x.lastError) };
}
