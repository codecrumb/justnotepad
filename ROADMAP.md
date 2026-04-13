## Sync & Version History (GitHub Gist)

Replace the Telegraph idea. Use a private GitHub Gist as a sync backend — no server needed, free, and revision history is built in (kills two roadmap items at once).

**How it works:**
- User pastes a GitHub PAT (scoped to `gist` only) in settings
- App creates one private gist named `justnotepad-sync` on first run
- Same PAT on another device → app finds the existing gist → synced
- Each note = one `.md` file inside the gist
- Gist revisions = free version history (meaningful snapshots, not keystroke-by-keystroke)

**Sync strategy:**
- Push: debounced 15s after last keystroke + flush on tab close/switch
- Pull: on tab focus + every 60s in background
- Conflict: if remote was updated since last sync → surface both versions, let user pick
- Manual sync button in sidebar that doubles as a status indicator (green / spinning / amber conflict / red offline)

**Version history (free from Gist revisions):**
- Every push creates a revision automatically — no extra work
- UI: history panel per note showing timestamps, preview on hover, restore button
- No separate "version control" feature needed — it's built into sync

**Why Gist over Telegraph:**
- Private (authenticated reads + writes, not just public links)
- Stable API, developer-friendly rate limits (5,000 req/hour — polling uses ~60-120/hour)
- Revision history built in

## Storage Evolution
- **OPFS (Origin Private File System)**
  - Better performance than IndexedDB for large/binary data; synchronous I/O in workers
  - **Hold off for now** — notes are small text, no user-visible benefit yet
  - Revisit when: (a) browser support is universal, or (b) attachments/images are added
  - Implementation plan when ready:
    - Abstract `NoteDB` behind a common interface
    - Add OPFS adapter with the same API
    - One-time migration: detect OPFS support → copy IndexedDB data → mark migrated
  - Current support (2025): Chrome 86+, Firefox 111+, Safari 15.2+ — good but not universal
