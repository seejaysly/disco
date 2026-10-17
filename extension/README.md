# Disco extension (v2)

Chrome extension (Manifest V3) for saving discos to Supabase. Build plan Phase 3.

## How it works

- **Highlight → right-click → Save to Disco** opens the side panel with the passage
  (also **Alt+Shift+D**; the toolbar icon just opens the panel).
- The panel shows the passage (click to edit; the original is kept and sent as `text_captured`),
  an optional note, suggested tags (`suggest_tags_for_capture`), an add-tag box with autocomplete
  (`suggest_tags_with_hints`, with a "Did you mean…?" check), and the source details (pencil to fix).
- **Save Disco** posts to the `capture` edge function with a `client_id`, so retries never duplicate.
- **Comparison period only:** each save is also appended to the user's Google Sheet ("Notes" tab,
  same 9 columns as the original extension) so Coda keeps receiving discos. Connect the sheet once
  under Settings. Rows that can't be copied wait in a queue and are retried. Remove at cutover (Phase 7).

## Sign-in

Google sign-in through `chrome.identity.launchWebAuthFlow`, exchanged for a Supabase session with
the ID-token grant. The extension ID is fixed by the `key` in `manifest.json`:

- Extension ID: `ncnmnpcfeijaoohclhoneigipokhnpeo`
- Redirect URL (must be listed on the Google OAuth client in the "Disco" Google Cloud project):
  `https://ncnmnpcfeijaoohclhoneigipokhnpeo.chromiumapp.org/`
- The Google Sheets API must be enabled in that Google Cloud project for the comparison copy.

## Install (unpacked)

1. Put this `extension` folder somewhere of its own (not the folder the original extension loads from).
2. `chrome://extensions` → turn on Developer mode → **Load unpacked** → choose the folder.
3. Pin "Disco (new)" from the puzzle-piece menu, open it, and sign in.
4. Settings → paste the Google Sheet link → Connect sheet.

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | Permissions, side panel, right-click menu, shortcut, fixed extension key |
| `background.js` | Right-click menu and shortcut; reads the selection, a little context and page details |
| `sidepanel/` | The capture panel (HTML, CSS, JS) |
| `lib/auth.js` | Google → Supabase sign-in, session refresh, Sheets token |
| `lib/api.js` | Calls to the capture endpoint and database functions |
| `lib/sheet.js` | Comparison-period copy to the Google Sheet |
| `lib/config.js` | Public settings (Supabase URL, publishable key, Google client ID) |
