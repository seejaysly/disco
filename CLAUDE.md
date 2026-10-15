# Disco — instructions for Claude Code

Disco captures what a reader highlights on the web ("discos"), organizes it by topic, and builds a daily
reading feed that pushes into parts of a topic the reader hasn't covered yet. It's built for many users,
but CJ (the owner, seejaysly) is the only user until the v2 feed has beaten the current Coda feed in a
side-by-side comparison.

## Source of truth

- **Build plan (phases, checklist, decisions):** https://claude.ai/code/artifact/5dd4461b-3d2a-4ebb-b86f-31a107b711c7
- **Data model:** https://claude.ai/code/artifact/e5f51b12-09e8-4938-ae6e-d5aca6ece7cc
- **Feed algorithm and inputs:** https://claude.ai/code/artifact/092f4dfb-b282-4999-b2bc-3bca728b2123

Read the build plan before starting a phase, and tick items off there when they're done.

## Repository layout

| Folder | What it is |
| --- | --- |
| `legacy/extension-v1/` | The current Disco capture extension (saves to Google Sheets → Coda). Kept for reference; the untouched original is on branch `v1-final`. |
| `extension/` | The v2 Chrome extension (Manifest V3), saving to Supabase. Phase 3. |
| `web/` | The reader web app, hosted on Netlify. Phase 5. |
| `supabase/migrations/` | Every database change, in order. Never edit an applied migration; add a new one. |
| `supabase/functions/` | Edge functions. `capture/` is the one capture endpoint for every capture tool. |
| `supabase/seed/` | Re-runnable data loads (the DIG taxonomy). |
| `scripts/` | One-off tools, including the Coda → Supabase copy script (Phase 2). |
| `docs/` | Notes that belong with the code. |

## Rules that must not be broken

1. **Don't break v1 during the comparison.** CJ's installed extension is loaded unpacked from a separate
   folder on his computer. Its Google sign-in depends on the extension ID, which comes from that folder's
   path. Never ask him to move, pull into, or reload that folder. The Coda feed, its Google Sheet, the Apps
   Script and the 6 AM scheduled run stay untouched until cutover (Phase 7).
2. **CJ is user #1, not a special case.** Every personal row carries `user_id` and is protected by row-level
   security. Never hard-code his ID or bypass RLS in app code. Adding a tester must never need a code change.
3. **Shared catalog, personal layer.** `topics`, `topic_aliases`, `sources`, `articles`, `article_topics` are
   shared and written only by server code. Everything else belongs to one user.
4. **All captures go through `capture_disco`** (via the `capture` edge function). Don't write capture logic
   anywhere else.
5. **Store the highlight, not the article.** Only the passage, a little context and the link. Images are the
   one stored copy (private bucket `disco-media`, one folder per user). Videos are never stored.
6. **Discos are private by default.** Visibility widens only through the four sharing paths: shared with a
   person, saved by them, in a shared guide, or a public share link (passage and source only, never images).

## Supabase

- Project: **Disco feed**, ref `rlvwfzhvbyuwtbnrqkou`, region us-west-2, Pro plan (daily backups).
- URL: `https://rlvwfzhvbyuwtbnrqkou.supabase.co`
- Publishable key (safe in client code): `sb_publishable_7yDGFlDmZSnbcFI_sIrHsg_xntqgs7u`
- Never commit the service-role key or any secret. Use Supabase function secrets or local `.env` (gitignored).
- Sign-in: Google (Google Cloud project "Disco", in Testing mode with CJ as test user) and email links.
  The Chrome extension's redirect URL must be added to that Google client when the extension exists.
- After any schema change, run the Supabase security and performance advisors.
- Test row-level security with two throwaway users inside a transaction that rolls back, so the
  database is left clean.

## Capture endpoint

`POST /functions/v1/capture` with the user's token. See the header comment in
`supabase/functions/capture/index.ts` for the body. It cleans links, finds or creates the source,
infers the kind (one word → vocabulary), resolves tags case-insensitively and through aliases, and
uses `client_id` so retries never duplicate. Tag suggestions: `rpc('suggest_tags', { q })`.

Run the link-cleaning tests with:
`node --experimental-strip-types supabase/functions/capture/clean.test.ts`

## Deferred (planned, not built)

- Vocabulary enrichment (definition, pronunciation, part of speech, etymology) as a background service.
- Embeddings for related discos, novelty and "suggest tags from similar discos" (columns already exist).
- Guided highlights, the wider social layer, a native iPhone app, study-guide notes.

## Working style CJ prefers

- Plain language in replies; no jargon without a short explanation.
- When giving code to paste, give the complete file, not a partial edit.
- When publishing or updating a page, include its full URL in the reply.
