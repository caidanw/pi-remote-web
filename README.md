# Pi Remote Web

Remote web interface for local Pi sessions. Based on
[`ankitchouhan1020/pi-gui-extension`](https://github.com/ankitchouhan1020/pi-gui-extension).

> Work in progress: keep the server on localhost until browser authentication ships.

<img width="2940" height="1846" alt="Pi Remote Web" src="https://github.com/user-attachments/assets/e1da0c5c-fe19-445e-9f07-24625eeef5f9" />


## Install

```bash
pi install ~/Projects/pi-remote-web
```

Requires Node.js ≥ 20 and a working pi install (models / auth already set up).

Git and path installs work from the repository because package-root `dist/` is
committed. After changing `web/`, run `npm install --prefix web && npm run build`
before testing the local package with `pi install <path>`.

The renamed package is not published to npm yet.

## Usage

In any pi session:

```text
/remote-web                          # live-attach current session + open browser
/remote-web <sessionId>              # open that session (live if in-process, else from disk)
/remote-web open <sessionId>         # same
/remote-web open <sessionId> 4000    # custom port
/remote-web stop                     # shut down
```

`/remote-web` ensures the host runs in this process (takes over the port if needed), then opens the browser on the session. Pass a **session id** (or path) to target a specific chat; omit it to use the current TUI session.

How this relates to pi (disk vs live, ownership): [ownership documentation](./docs/src/content/docs/concepts/ownership.md).

Localhost only (`127.0.0.1`). No auth — treat it like the TUI on your machine.

## Features

- **Multi-session** — open, resume, and switch chats; concurrent turns
- **Streaming** — assistant text, tools, and thinking over SSE
- **Steer & abort** — send while the agent works; stop a turn
- **Models & thinking** — picker and levels from the status bar / palette
- **Command palette** (⌘K) — `/new`, `/resume`, `/session`, models, skills, export, …
- **Skill workspace** — browse loaded skills, view or edit Markdown, and create/import project or user skills directly into pi
- **Git Changes** — working-tree status and diffs for the session cwd
- **Images & bash** — paste/drop images; `!command` in the composer
- **Theme** — light / dark

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_REMOTE_WEB_PORT` | `3847` | HTTP port |
| `PI_REMOTE_WEB_PUBLIC_URL` | — | HTTPS Tailscale Serve URL accepted for pairing and Host/Origin checks |
| `PI_REMOTE_WEB_SESSION_IDLE_MS` | `86400000` (1 day) | Close hub session when no SSE clients (`0` disables) |

Pair a browser after configuring the public HTTPS URL:

```bash
PI_REMOTE_WEB_PUBLIC_URL=https://your-mac.your-tailnet.ts.net pi-remote-web pair
pi-remote-web revoke-all  # invalidate every paired browser
```

The pairing credential is carried only in the generated URL fragment. Models, provider auth, skills, and extensions still come from pi.

## macOS service

```bash
pi-remote-web install      # install and start the per-user LaunchAgent
pi-remote-web status       # health, URLs, socket, and live-session counts
pi-remote-web doctor       # permissions, locks, binaries, launchd, and Tailscale
pi-remote-web logs         # recent bounded daemon logs
pi-remote-web pair         # print a five-minute single-use pairing URL
pi-remote-web revoke-all   # invalidate every paired browser
pi-remote-web restart
pi-remote-web uninstall
```

The LaunchAgent runs `caffeinate -s` and remains loopback-only. Set
`PI_REMOTE_WEB_PUBLIC_URL` to the separate Tailscale Serve HTTPS URL before
installing or pairing. These commands never configure Tailscale or modify HAPI.

## License

[MIT](./LICENSE)

## Documentation

Project home: [github.com/caidanw/pi-remote-web](https://github.com/caidanw/pi-remote-web).

For coding agents: read [`llms.txt`](./llms.txt) before changing code. It contains the repo map, safe change boundaries, customization contract, anti-patterns, and test commands.

```bash
npm install --prefix docs
npm run dev:docs       # local docs server
npm run build:docs     # TanStack Start build in docs/dist/
```
