# Self-Hosted Vault Sync

Fast, reliable Obsidian vault sync backed by your own sync server — a lightweight
self-hosted alternative to Obsidian Sync / obsidian-livesync, with no vendor
lock-in and no vault size limits beyond your own storage.

Pairs with the companion sync server: https://github.com/PeoneEr/self-hosted-vault-sync-server

## Features

- **Push on change** — file edits are pushed after a short debounce (2s)
- **Pull on startup + poll** — vault is refreshed on load and every N seconds
- **Real-time push on desktop** — Server-Sent Events notify connected clients
  the moment another device pushes a change (falls back to polling on mobile,
  driven by app visibility changes)
- **Delta sync** — only changed files are transferred, not the whole vault
- **Conflict-safe writes** — a stale write is saved as a `.conflict.<timestamp>`
  copy instead of silently overwriting newer content
- **Exclude patterns** — glob-based exclusion list (workspace files excluded
  by default)

## Setup

1. Deploy the [sync server](https://github.com/PeoneEr/self-hosted-vault-sync-server)
   somewhere reachable from your devices. Its startup log prints a one-time
   **bootstrap token** — copy it.
2. Install this plugin on your first device and enable it.
3. Open **Settings → Self-Hosted Vault Sync** and set:
   - **Server URL** — e.g. `https://sync.example.com`
   - **Auth token** — paste the bootstrap token here (only needed once, for
     this first device)
   - **Sync interval** — how often to poll for remote changes (seconds)
   - **Exclude patterns** — one glob per line for files to keep local-only
4. Click **Start initial sync**.
5. To add another device (e.g. your phone): on this configured device,
   scroll to **Devices → Pair new device**, give it a label, click
   **Generate**. Scan the QR code with the new device's camera — it opens
   Obsidian and finishes setup automatically, no typing required. (A
   "Copy link" fallback is shown next to the QR if scanning isn't
   convenient.)
6. Manage paired devices any time from the **Devices** list — each entry
   shows when it was last seen and has its own **Revoke** button.

## How conflicts are handled

Every upload carries a base hash of the file it was derived from. If the
server's current version no longer matches that base hash, the incoming
write is saved alongside the original as `<file>.conflict.<timestamp>.<ext>`
instead of overwriting it — you resolve the conflict manually.

## Requirements

- A running instance of the companion sync server
- `isDesktopOnly: false` — works on desktop and mobile, though real-time
  push (SSE) is desktop-only; mobile relies on polling plus a sync-on-focus
  trigger

## License

MIT — see [LICENSE](LICENSE).
