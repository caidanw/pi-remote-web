# Pi Remote Web Design

**Status:** Final design
**Date:** 2026-08-18
**Working name:** Pi Remote Web

## Context

Pi sessions run on a MacBook, while an iPhone browser acts as another control surface. Session files, credentials, tools, and execution stay on the Mac. The system must attach to multiple live terminal Pi processes, open saved sessions, and create browser-owned sessions without allowing two processes to write the same session file.

Before implementation, fork `ankitchouhan1020/pi-gui-extension` into the `caidanw` GitHub account as `pi-remote-web` and preserve the original repository as the `upstream` remote. The implementation will reuse its mobile web UI and existing Pi session rendering while replacing the package's single-process live attachment with a persistent daemon and a global Pi adapter extension.

## Goals

- Keep interactive Pi sessions usable in both the terminal and browser.
- Discover every interactive Pi process automatically.
- Support Pi processes started before or after the daemon.
- Show multiple live sessions in one browser.
- Create and resume Pi sessions from the browser.
- Start sessions in existing Git worktrees and create new worktrees.
- Keep durable data on the Mac.
- Survive browser disconnects, daemon restarts, and Mac login restarts.
- Expose the service only through the private tailnet.
- Prevent concurrent writers to a Pi session JSONL file.

## Non-goals

- Support Claude Code, opencode, or other coding agents.
- Provide a public relay or Tailscale Funnel.
- Support multiple users, accounts, or per-device revocation.
- Attach to Pi processes that do not load the adapter extension.
- Preserve an in-flight model request across daemon or Mac restarts.
- Build a native mobile app.
- Support multiple Macs in the first version.

## Architecture

```text
                                     MacBook
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Interactive Pi A ─┐                                                 │
│  Interactive Pi B ─┼─ global adapter ── Unix socket ─┐              │
│  Interactive Pi N ─┘                                 │              │
│                                                       ▼              │
│                                            Persistent daemon         │
│                                            ├─ session catalogue      │
│                                            ├─ ownership locks        │
│                                            ├─ REST + SSE server      │
│                                            ├─ pairing/auth           │
│                                            └─ Pi RPC workers         │
│                                                       │              │
│                                    127.0.0.1:<port> ──┘              │
│                                                       │              │
│                                  Tailscale Serve HTTPS               │
└───────────────────────────────────────────────────────┼──────────────┘
                                                        │ private tailnet
                                                        ▼
                                                  iPhone browser
```

### Global Pi adapter extension

Install one trusted extension in Pi's global package scope. It activates only for interactive TUI sessions.

On `session_start`, the adapter:

1. Acquires the session ownership lock.
2. Returns control to Pi without waiting indefinitely for the daemon.
3. Connects to the daemon's Unix socket.
4. Registers the process and current session.
5. Sends an authoritative snapshot and subsequent ordered events.
6. Accepts browser commands and applies them through Pi's public extension API.

On `session_shutdown`, it unregisters the session, closes its connection, and releases its lock when it still owns that lock.

The adapter never opens the live session file through another `SessionManager`. The terminal Pi runtime remains the only writer.

### Persistent daemon

Run one user LaunchAgent. The daemon owns:

- the browser application and API;
- the Unix socket broker;
- the live and saved session catalogue;
- session ownership arbitration;
- pairing and browser authentication;
- browser-created Pi RPC workers.

The daemon listens only on IPv4 loopback. It does not bind to a LAN or tailnet address.

### Browser-owned Pi workers

Create or resume non-live sessions by spawning one `pi --mode rpc` worker per open browser-owned session. Process isolation avoids extension-global state collisions and reuses Pi's supported RPC protocol.

Workers:

- use the selected project as their working directory;
- use the Mac's existing Pi settings, credentials, packages, and session directory;
- disable the terminal adapter to avoid self-registration;
- remain alive while work is active or a browser session remains open;
- release ownership before a terminal resumes their session;
- exit when the daemon exits because their RPC pipes close.

## Session identity and ownership

### Identity

Use the canonical absolute session-file path as the ownership key. Use Pi's session ID for display and lookup. Give each interactive Pi process a runtime ID that survives `/new`, `/resume`, extension reloads, and daemon reconnects within that process.

### Ownership states

A session is one of:

- **terminal-owned:** an interactive Pi process owns the file;
- **browser-owned:** a daemon-managed RPC worker owns the file;
- **disconnected:** its terminal owner lost the daemon connection during the reconnect grace period;
- **offline:** no runtime owns the file;
- **releasing:** the current owner is shutting down before ownership transfer.

### Locking

Store lock directories under `~/.pi/remote/locks/`, keyed by a SHA-256 hash of the canonical session path. Atomic directory creation acquires a lock without a new native dependency.

Each lock records:

- canonical session path;
- owner kind;
- runtime ID;
- PID and boot marker;
- random ownership nonce;
- acquisition time.

Remove a lock only when the ownership nonce matches. Clear a stale lock when it belongs to a prior boot or its PID is no longer alive. Provide `pi-remote doctor` for inspection and manual stale-lock cleanup.

### Ownership rules

1. Never open a session in a worker while a terminal lock exists.
2. Opening a live terminal session in the browser attaches to its adapter.
3. Opening an offline saved session from the browser acquires its lock before spawning a worker.
4. Starting a terminal on an idle browser-owned session releases the worker, then transfers ownership.
5. Starting a terminal on a busy browser-owned session is rejected. The terminal explains that the browser must use **Release to terminal** first, then exits before accepting prompts.
6. A daemon restart waits for the adapter discovery window before opening saved sessions.
7. A connection loss does not transfer ownership. The lock and reconnect grace period prevent a second writer.

## Synchronization protocol

### Adapter transport

Use newline-delimited JSON over a Unix domain socket. The socket directory is `0700`; the socket is `0600`.

Every frame includes a protocol version, message type, runtime ID, and request or event ID where applicable.

Core messages:

- `register`
- `registered`
- `snapshot`
- `event`
- `command`
- `command_result`
- `session_replaced`
- `heartbeat`
- `resync_required`
- `unregister`

### Reconnection

If the daemon is unavailable, the adapter retries with jittered exponential backoff capped at ten seconds. It does not block terminal startup or agent work.

The adapter maintains:

- a monotonic event sequence;
- a bounded outbound queue;
- the current streaming-message projection;
- the latest session metadata.

After reconnecting, it sends an authoritative snapshot before live events. If its outbound queue overflows, it drops intermediate display events, marks the connection for resynchronization, and never blocks Pi's event loop. Durable transcript state and the current projection repair the browser view.

### Browser transport

Retain `pi-remote-web`'s REST commands and server-sent event stream. SSE supports reconnect cursors and authoritative snapshot replacement. State-changing requests require browser authentication and pass Host, Origin, and CSRF checks.

### Command routing

Route commands to the current owner:

- prompt;
- steer;
- follow-up;
- abort;
- set model;
- set thinking level;
- rename session;
- compact;
- release ownership.

For terminal-owned sessions, the adapter applies commands through Pi's extension API. Browser prompts enter the same in-memory runtime and appear in the terminal. Terminal prompts and state changes arrive in the browser through Pi events.

For browser-owned sessions, the daemon maps commands to Pi's RPC protocol.

Serialize commands per session. Return an acknowledgement for every command. Use Pi's native steering and follow-up semantics while a turn is active.

## Browser behavior

### Session list

Group sessions into:

- Live terminals
- Browser sessions
- Saved sessions

Show owner, project, model, thinking level, running state, connection state, and last activity.

### Live terminal tabs

A tab opened from a live terminal follows that terminal process. If the terminal runs `/new` or `/resume`, update the tab to the replacement session and show:

> Terminal switched sessions · Open previous session

A tab opened directly from saved history remains pinned to that session.

### New and saved sessions

Allow the browser to:

- choose a directory under configured workspace roots;
- create a persistent Pi session;
- resume an offline saved session;
- release an idle browser-owned session for terminal use;
- abort work before release when explicitly requested.

Default the workspace root to `~/Projects`. Require explicit browser confirmation before trusting project-local Pi resources for an untrusted directory.

### Git worktrees

Discover existing worktrees with:

```text
git worktree list --porcelain
```

Show each worktree as a session location. Add a **New worktree** action that accepts:

- repository;
- new or existing branch;
- base revision, defaulting to the repository's current `HEAD`;
- destination path.

Suggest the destination by reusing the parent directory of the repository's existing linked worktrees. If no convention exists, suggest a sibling directory beside the main checkout. Always let the user override the destination before creation.

Validate branch names with `git check-ref-format --branch`. Invoke Git with argument arrays and `LANG=C`; never interpolate branch names, revisions, or paths into a shell command. Reject an occupied destination and any destination outside configured workspace roots unless the user first adds that root explicitly.

After `git worktree add` succeeds, create a browser-owned Pi session in the new worktree. Do not add worktree removal, branch deletion, pruning, or repository-specific hook execution in the first version.

### Terminal continuity

Connecting the adapter never replaces or disables Pi's TUI. The terminal remains fully interactive. Losing the browser or daemon connection does not interrupt terminal work.

## Authentication and network security

### Network boundary

- Bind the daemon to `127.0.0.1` only.
- Publish it through Tailscale Serve over HTTPS.
- Never use Tailscale Funnel.
- Restrict the tailnet ACL to the iPhone and Mac when practical.
- Validate the configured public Host and Origin for HTTP, SSE, and WebSocket upgrade attempts.

### QR pairing

`pi-remote pair` requests a random, five-minute, single-use pairing token from the daemon and displays a QR code.

Encode the token in the URL fragment:

```text
https://<mac>.<tailnet>.ts.net/#pair=<token>
```

The fragment is not sent in HTTP requests. Browser JavaScript exchanges it once, then removes it with `history.replaceState`. The daemon consumes the token and sets a signed, long-lived cookie with:

- `HttpOnly`;
- `Secure`;
- `SameSite=Strict`;
- a bounded expiry.

Do not add accounts, passwords, refresh tokens, or a device registry. `pi-remote revoke-all` rotates the cookie-signing secret and invalidates every browser.

### Local boundary

Keep daemon configuration and signing secrets in a user-only directory. Unix-socket permissions authenticate local adapters. The daemon never returns provider credentials or Pi authentication files to the browser.

## Launch and power behavior

Install a user LaunchAgent with `RunAtLoad` and `KeepAlive`. Run the daemon as:

```text
caffeinate -s pi-remote-daemon
```

The assertion prevents automatic system sleep while on AC and while the daemon runs. It allows display sleep and does not override lid-close sleep. Supported clamshell mode still requires AC and a detected external display; a compatible dummy HDMI plug can provide that display signal.

The LaunchAgent runs only while the user is logged in. Tailscale must have **Start on login** and **Run unattended** enabled. The daemon cannot wake a Mac that has already slept.

During rollout, expose the new service on a separate Tailscale HTTPS port. Replace HAPI's default Serve route only after acceptance testing passes.

## Failure behavior

| Failure | Behavior |
|---|---|
| Daemon starts after Pi | Adapter reconnects and registers within the capped retry interval. |
| Daemon restarts | Terminal sessions continue; adapters reconnect and browser state reloads. |
| Browser disconnects | Owners and active turns continue; browser reconnects through SSE. |
| Tailscale disconnects | Local terminal and daemon work continue. |
| Adapter queue overflows | Drop display deltas, request resync, never block Pi. |
| RPC worker exits | Keep the JSONL, mark the session stopped, offer resume. |
| Daemon exits during RPC work | Worker exits on pipe closure; completed JSONL entries remain resumable. |
| Duplicate owner | Reject the second owner before it accepts a prompt. |
| Busy browser session resumed in terminal | Reject terminal takeover and direct the user to Release to terminal. |
| Authentication expires | Return to pairing screen without affecting active sessions. |
| Protocol versions differ | Reject registration with an actionable upgrade message. |

## Observability

Provide:

- `pi-remote status` for daemon, socket, Tailscale URL, and live-session counts;
- `pi-remote doctor` for binary paths, permissions, locks, LaunchAgent state, and stale owners;
- `pi-remote pair` for QR pairing;
- `pi-remote revoke-all` for browser revocation;
- bounded rotating daemon logs;
- a loopback health endpoint that exposes no sensitive data.

The Pi footer may show a compact remote state: connected, reconnecting, conflict, or disabled.

## Testing

### Automated checks

Use the repository's existing test stack plus Node's built-in test runner where new server tests are needed.

Cover:

- lock acquisition, ownership nonce checks, and stale-lock recovery;
- pairing expiry, single use, cookie validation, and revoke-all;
- Host, Origin, CSRF, and unauthenticated request rejection;
- adapter startup before daemon startup;
- reconnect snapshots and event-sequence gaps;
- bounded backpressure and `resync_required` behavior;
- two simultaneous terminal registrations;
- per-session command serialization;
- terminal-to-browser and browser-to-terminal event projection;
- idle worker release and busy worker takeover rejection;
- existing-worktree discovery and destination suggestion;
- branch/path validation and safe `git worktree add` argument construction;
- runtime-following tabs and pinned saved-session tabs;
- protocol-version rejection.

### Manual acceptance

Do not call the setup complete until all checks pass:

1. Start two terminal Pi sessions before the daemon; start the daemon and observe both.
2. Send a browser prompt to each terminal session and confirm it appears in each TUI.
3. Send terminal prompts and confirm streaming output appears on the phone.
4. Switch a terminal with `/new` and `/resume`; confirm its browser tab follows.
5. Create and resume browser-owned sessions from the phone.
6. Start a session in an existing worktree, then create a worktree with both the suggested and an overridden path.
7. Release an idle browser session and resume it in the terminal.
8. Confirm a busy browser session blocks terminal takeover without data loss.
9. Restart the daemon during terminal work; confirm terminal work continues and reconnects.
10. Use a pairing QR once, confirm reuse and expiry fail, then test revoke-all.
11. Reboot the Mac and verify launchd, Tailscale, Serve, pairing, and session discovery.
12. Close the lid in the intended clamshell setup, wait beyond the sleep timer, and connect from the phone.

## Delivery slices

1. **Broker foundation:** daemon, adapter registration, reconnect, session catalogue, and terminal read-only mirroring.
2. **Live control:** prompt, queue, abort, model, thinking level, and terminal session following.
3. **Browser ownership:** create/resume RPC workers, locks, release, and conflict handling.
4. **Remote security:** Tailscale configuration, QR pairing, cookies, Origin checks, and revocation.
5. **Operations:** LaunchAgent, `caffeinate`, status, doctor, logs, and reboot verification.
6. **Migration:** run beside HAPI, complete acceptance checks, then remove HAPI and replace its Serve route.

Each slice must leave terminal Pi usable if the daemon is absent.

## Tradeoffs

- Starting from `pi-gui-extension` avoids rebuilding a mobile session UI but creates a maintained fork.
- Cooperative adapters cannot attach to Pi processes that omit the extension.
- RPC workers provide isolation but cannot preserve in-flight requests after daemon failure.
- Atomic lock directories avoid a native locking dependency but require stale-PID recovery.
- One signing secret keeps single-user authentication small; revocation affects every browser.
- Tailscale avoids public exposure but remains a required machine and phone dependency.

## Success criteria

The design succeeds when one paired iPhone browser can control at least two simultaneous terminal Pi sessions, create and resume browser-owned sessions, survive daemon restart without interrupting terminal work, and never produce two active writers for one session file during the acceptance tests.
