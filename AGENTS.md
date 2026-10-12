# Pi Remote Web — agent instructions

Browser and phone UI for Pi sessions running on this Mac: a thin Svelte client
plus a Node `http`/SSE server over `@earendil-works/pi-coding-agent`. Pi owns
sessions, models, auth, tools, skills, extensions, and session JSONL files; this
repo only displays and drives them. The npm package ships the extension runtime,
the server, and the prebuilt UI in `dist/`.

## Trust model

- The server binds `127.0.0.1` only. Remote access is Tailscale Serve (HTTPS) in
  front of it; keep the bind loopback and leave Tailscale configuration to the user.
- Every API call needs a paired-browser cookie (`server/auth.js`): a single-use
  QR pairing token becomes a 400-day session that `/api/auth/status` renews on
  each app open. Mutations also need the CSRF header; Host and Origin are checked.
  `pi-remote-web revoke-all` rotates the signing secret.
- `PI_REMOTE_WEB_INSECURE_NO_AUTH=1` turns auth off. It is set only by the
  `dev:*` scripts and must stay opt-in.

## Runtime shape

- **Daemon** (`pi-remote-web daemon`; macOS LaunchAgent via `server/service.js`):
  REST + SSE in `server/http.js`.
- **Terminal sessions** join the daemon over a Unix socket
  (`server/remote-broker.js`) through the `extensions/remote.ts` adapter that
  `pi install` loads. A terminal that predates the adapter connects with `/reload`.
- **Browser sessions** run as `pi --mode rpc` children (`server/rpc-workers.js`)
  using the user's installed `pi`, so they match its version and extensions.
- **Ownership**: one owner per session file via locks (`remote/session-lock.js`).
  A session owned elsewhere opens as a read-only copy read from disk
  (`server/transcript.js`).
- **Notifications**: on `agent_settled` the broker and workers report the turn to
  `server/push.js`, which sends Web Push (RFC 8291 encryption, VAPID keys in the
  auth dir) to subscribed browsers; `web/public/sw.js` only displays them.
- **In-process mode**: `/remote-web` inside Pi (`extensions/web.ts`) runs the hub
  (`server/hub.js`) in that Pi process.

## Layout

```text
extensions/        web.ts (/remote-web), remote.ts (daemon adapter)
remote/            Unix-socket protocol, reconnecting client, session locks
server/            cli, http, hub, auth, service, rpc-workers, remote-broker, transcript
web/src/App.svelte routing and session shell
web/src/lib/       api.ts, chat-stream.ts, components/, plugins/, kit/ (vendored UI kit)
dist/              built UI (committed; rebuild with `npm run build` after web/ changes)
docs/              landing site (Vite + React), serves docs/public/llms.txt
```

Scripts live in `package.json`; `npm test`, `npm run check`, and `npm run build`
cover a change. New server test files must be added to the `test` script, and new
server modules to `files`.

## Change zones

Prefer the highest zone that works.

- **Green** (intended customization): `web/src/lib/plugins/` message renderers;
  theme tokens in `web/src/app.css`; presentation-only chrome in
  `web/src/lib/components/`; client wrappers for existing routes in `api.ts`; docs.
- **Yellow** (clear need, small diff): a new backend capability, wired
  hub → `http.js` → `api.ts` → UI; one command in `CommandPalette.svelte`;
  `ChatPanel.svelte` and composer streaming UX; `App.svelte` and
  `SessionList.svelte` routing; a fork of one vendored kit component.
- **Red** (bugfix only, with tests): `server/hub.js` lifecycle, locks, prompt
  queues; `server/sse-protocol.js` and the SSE branch of `http.js`;
  `web/src/lib/chat-stream.ts` seq gate, snapshot, and merge; the trust model above.

## Conventions

- Plain `node:http` and SSE for transport.
- Custom message rendering goes in a narrowly matched plugin registered in
  `web/src/lib/plugins/registry.ts`, leaving `MessageBubble.svelte` generic.
- Read models, auth, and settings from Pi rather than duplicating its config.
- User config (`~/.pi/agent/pi-remote-web/config.json`, then
  `.pi/pi-remote-web/config.json` once Pi trusts the project) is data only;
  keys and validation live in `server/customization.js`.
- The chat column is full-width.
