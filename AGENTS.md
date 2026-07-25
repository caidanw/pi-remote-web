# pi-gui — agent instructions

Localhost web UI for pi. Thin Svelte client + multi-session hub over `@earendil-works/pi-coding-agent`.

Repository guidance for contributors and coding agents. The published npm package contains only the extension runtime and prebuilt UI.

## Docs map

| Audience | Open |
|------|------|
| **Coding agents / any code change** | [llms.txt](./llms.txt) first |
| Humans / install / what it does | [docs landing page](./docs/src/routes/index.tsx) |
| Package overview | [README.md](./README.md) |

Do **not** crawl old docs for a small UI change; the operating contract lives in `llms.txt`.

## Layout

```text
extensions/gui.ts     # pi: /gui (in-process + live attach)
server/               # cli, http, hub, sse-protocol
web/src/lib/
  api.ts · chat-stream.ts · plugins/ · components/ · kit/
dist/                 # production UI (npm run build)
docs/                 # TanStack Start landing site
```

UI source is `web/`; `dist/` is build output (what the server ships).

## Run

```bash
npm install && npm install --prefix web
npm run dev:server   # :3847
npm run dev:web      # :5173 proxies /api
# package UI: npm run build
# build docs: npm run build:docs
# test extension: pi install <path> → /gui
```

Port: `PI_GUI_PORT` (default `3847`).

## Zones (summary)

- **Green:** `web/src/lib/plugins/`, theme, docs, presentation-only chrome
- **Yellow:** `components/*`, new `hub → http → api.ts` routes, kit fork of one component
- **Red:** `hub.js` lifecycle, `sse-protocol.js`, `chat-stream.ts` — bugfix only + tests

Details: [llms.txt](./llms.txt).

## Conventions

- Localhost only (`127.0.0.1`). No Express/socket.io.
- Full-width chat column.
- New backend capability: **hub → http → api.ts → UI**.
- Prefer message **plugins** over deep `MessageBubble` edits.
