## Future Ideas
- **Sync System**
  - Use Telegraph as a backend via a shared “mega note”
  - Devices sync if:
    - Same note name
    - Same Telegraph token
  - Concept: multiple devices update one Telegraph note → acts as sync storage

- **Version Control**
  - Similar to Git / Photoshop history
  - Track note changes over time

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

## Concerns
- **Privacy**
  - Anyone with the link can access synced notes


