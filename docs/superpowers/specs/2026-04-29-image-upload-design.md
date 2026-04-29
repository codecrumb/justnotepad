# Image Upload via Imgur — Design Spec
**Date:** 2026-04-29  
**Status:** Approved

## Overview

Allow users to paste or drop images directly into the editor. Images are uploaded to Imgur via a Cloudflare Pages Function proxy, and the resulting URL is inserted as standard markdown `![image](url)`. Sync works for free — the URL is just text in the note.

---

## Architecture

```
Browser                     CF Pages Function           Imgur API
  |                               |                         |
  |-- POST /api/upload (file) --> |                         |
  |                               |-- POST /3/image ------> |
  |                               |<-- { id, ... } -------- |
  |<-- { url: "https://..." } --- |                         |
```

The Client-ID never appears in browser JS. It lives in the CF Pages environment as `IMGUR_CLIENT_ID`.

---

## Components

### 1. Pages Function — `functions/api/upload.js`

- **POST /api/upload**: Accepts `multipart/form-data` with a `file` field. Reads the file as an `ArrayBuffer`, POSTs raw bytes to `https://api.imgur.com/3/image` with `Authorization: Client-ID <env.IMGUR_CLIENT_ID>`. Returns `{ url: "https://i.imgur.com/<id>.png" }` JSON with `Access-Control-Allow-Origin: *`.
- **OPTIONS /api/upload**: Returns CORS preflight headers.
- Error cases: missing file → 400, Imgur failure → 502 with `{ error: "..." }`.
- No rate-limit pooling in v1 — single Client-ID. Add rotation if needed later.

### 2. Client-side — new `uploadImage(file)` function in `app.js`

**Flow:**
1. Generate a unique placeholder ID: `uploading-<8 random hex chars>`
2. Insert `![uploading…]()` at the current cursor via `inkEditor.insert()`
3. POST the file to `/api/upload` as `FormData`
4. On success: grab full editor content, find and replace the placeholder with `![image](https://i.imgur.com/...)`, call `inkEditor.update(newContent)`
5. On failure: remove the placeholder, show error toast

**Paste handler** (on `.cm-editor`):
- Check `e.clipboardData.items` for any item with `type.startsWith('image/')`
- If found: `e.preventDefault()`, get the `File`, call `uploadImage(file)`
- If not found (plain text paste): do nothing, let CodeMirror handle it normally

**Drop handler** (on `.cm-editor`):
- Check `e.dataTransfer.files` for files with `type.startsWith('image/')`
- If found: `e.preventDefault()`, call `uploadImage(file)` for each
- If not found: do nothing

**File size guard:** Reject files over 20MB client-side before uploading. Show error toast: "Image too large (max 20 MB)".

**Toast:** On successful upload, call the existing `GistSync.showToast('Image uploaded')`. On failure: "Image upload failed".

---

## Data Flow — Placeholder Swap

The placeholder uses a random suffix to stay unique if multiple images are uploading simultaneously:

```
Insert:  "![uploading-a3f9bc2e]()"
         ↓ upload completes
Replace: "![image](https://i.imgur.com/AbCdEfG.png)"
```

The swap uses `String.replace()` on the full content string, then `inkEditor.update()`. Since the note's change handler is guarded by `editor_updating = true`, this won't trigger an extra save cycle.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| File > 20MB | Client-side reject, error toast, no upload attempt |
| Network error | Remove placeholder, error toast |
| Imgur 429 rate limit | Remove placeholder, toast: "Upload failed — try again" |
| Imgur 500+ | Remove placeholder, toast: "Upload failed — try again" |
| Non-image paste/drop | Ignored — CodeMirror handles it normally |

---

## What's Not In Scope

- Image deletion (anonymous Imgur uploads can't be deleted without a deletehash; not storing these)
- Multiple Client-ID rotation (add later if rate limits become an issue)
- OPFS local storage (external URL is sufficient; sync works for free)
- Privacy notice beyond the toast (users pasting images understand they're uploading)
