# Disco extension (v2)

Chrome extension (Manifest V3) for saving discos to Supabase. Build plan Phase 3.

## How it works

- **Highlight → right-click → Save to Disco** opens the side panel with the passage
  (also **Alt+Shift+D**; the toolbar icon just opens the panel).
- **A single highlighted word** becomes a vocabulary disco, with its sentence sent as `details.example`;
  one click saves it as a regular passage instead.
- **Right-click an image → Save image to Disco.** The original file is downloaded when the site allows it,
  otherwise the image is snapshotted from the screen; either way it's resized to 1600px at most, saved as
  JPEG to `disco-media/<user id>/<client_id>.jpg`, then captured as an image disco.
- **Right-click the page → Capture an area for Disco**: drag a box; saved like an image.
- **Video moments:** highlight lines in a YouTube transcript (or any text with `m:ss` timestamps) and
  Save to Disco; or press Alt+Shift+D while a video plays to save the current moment (with the captions
  showing, if any). Right-clicking an ordinary HTML video also offers it. The capture endpoint adds the
  time to the link.
- **Offline:** if Disco can't be reached, the save (and its image) waits in `chrome.storage.local` and is
  sent later — next panel open, next save, or every 5 minutes from the background. `client_id` makes
  resending safe.
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
| `lib/queue.js` | Save now, or keep for later when offline |
| `lib/sheet.js` | Comparison-period copy to the Google Sheet |
| `lib/config.js` | Public settings (Supabase URL, publishable key, Google client ID) |
