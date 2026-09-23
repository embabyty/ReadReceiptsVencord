# ReadReceiptsVencord

Instagram-style read receipts for Discord DMs **and servers**, as a Vencord userplugin.

## What it does

- **DMs:** small right-aligned **Seen** label (+ recipient avatar) under your last message in a 1:1 DM, like Instagram. Shows **Sent** until then (toggleable).
- **Servers:** **Seen by N** label with a stacked avatar row under your last message in a guild channel, counting members active after your message was sent.
- Optional experimental group-DM support.
- Everything is toggleable: DMs, group DMs, and servers each have their own setting.

## Important limitation (please read)

Discord has **no API that exposes another user's read state** to you. So this plugin cannot know with 100% certainty that someone opened your DM or read your server message.

Instead, `Seen` is an **estimate** based on activity observed by your client after your message was sent:

- someone replies in that channel (`MESSAGE_CREATE`)
- someone edits a message there (`MESSAGE_UPDATE`)
- someone starts typing there (`TYPING_START`)
- someone reacts to a message there (`MESSAGE_REACTION_ADD`)

In DMs, any of those from the recipient marks your message Seen. In servers, each active member is counted in **Seen by N** (bots excluded). This is local-only: nothing is sent anywhere, no messages are modified, and nobody else sees anything different.

## Install (Vencord from source required)

Custom plugins require a [Vencord source build](https://docs.vencord.dev/installing/) — the installer build cannot load them.

```powershell
# inside your Vencord checkout
New-Item -ItemType Directory -Path "src/userplugins" -Force
Copy-Item -Recurse "<this-repo>/readReceipts" "src/userplugins/readReceipts"
pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

Then restart Discord and enable **ReadReceipts** under Settings → Vencord → Plugins.

Repo layout:

```text
readReceipts/
  index.tsx    # plugin entry (definePlugin, flux handlers, accessory UI)
  styles.css   # Seen/Sent styling
```

## Settings

| Setting | Default | Notes |
|---|---|---|
| Enable DMs | on | 1:1 DMs |
| Enable Group DMs | off | experimental |
| Enable Servers | on | Seen-by count + avatars in guild channels |
| Only show on last message | on | Instagram behaviour |
| Show Sent | on | label before Seen |
| Seen / Sent text | Seen / Sent | DMs, customizable |
| Server Seen text | Seen by | prefix before viewer count |
| Max server avatars | 5 | 3 / 5 / 8 |
| Show avatar | on | avatars next to Seen |
| Show timestamp | off | time it was seen (DMs only) |

## Files

- `readReceipts/index.tsx` — event tracking (`MESSAGE_CREATE`, `TYPING_START`, `MESSAGE_REACTION_ADD`, `MESSAGE_UPDATE`) + `renderMessageAccessory` UI.
- `readReceipts/styles.css` — styling for the receipt row.

## Roadmap

- [x] DM receipts (heuristic)
- [x] Server receipts (Seen by N + avatars, heuristic)
- [ ] Per-channel seen history / persistence
