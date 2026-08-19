# Pi Remote Web Implementation Plan

## Success criteria

- Discover two interactive Pi processes through one persistent daemon.
- Keep terminal interaction working when the daemon is absent or restarts.
- Mirror terminal events and route browser commands through the owning Pi runtime.
- Prevent two runtimes from owning one session file.
- Create and resume daemon-owned Pi sessions.
- Pair one browser through Tailscale with a single-use QR token.

## 1. Broker foundation

Add a versioned newline-delimited JSON protocol, Unix-socket daemon, and auto-registering TUI adapter.

Verify:

- Start the adapter before the daemon; it registers within the 10-second cap after the daemon starts.
- Register two adapters and list both through the daemon.
- Restart the daemon without interrupting either terminal process.
- Overflowing an adapter queue requests resynchronization instead of blocking Pi.

## 2. Session ownership

Add atomic lock directories keyed by canonical session path. Track owner nonce, runtime ID, PID, and owner kind.

Verify:

- Reject a second owner while the first PID lives.
- Remove only a lock with the matching nonce.
- Recover a lock whose PID is dead.
- Keep a disconnected terminal owner reserved through its reconnect grace period.

## 3. Live browser control

Route remote sessions through the existing HTTP/SSE contract. Reuse the current browser transcript and controls.

Verify:

- Browser prompts appear in the terminal-owned session.
- Terminal prompts and streaming output appear in the browser.
- Abort, steer, follow-up, model, thinking, and rename commands affect the owning runtime.
- A live browser tab follows `/new` and `/resume`; a saved-session tab stays pinned.

## 4. Browser-owned sessions

Spawn isolated `pi --mode rpc` workers for new and offline sessions. Add release-to-terminal behavior.

Verify:

- Create and resume persistent sessions from the browser.
- Attach to a terminal owner instead of opening its JSONL.
- Release an idle worker before terminal takeover.
- Reject takeover while a worker is busy.
- Worker pipe closure on daemon exit leaves a resumable JSONL.

## 5. Worktrees

List existing worktrees and create new ones with native Git commands.

Verify:

- Parse `git worktree list --porcelain`.
- Suggest the existing worktree parent or a sibling fallback.
- Allow a destination override inside configured workspace roots.
- Validate branch names and reject occupied destinations.
- Start a Pi session in the created worktree.

## 6. Browser authentication

Add one-time QR pairing, signed cookies, Origin checks, and revoke-all.

Verify:

- Pairing tokens expire after five minutes and work once.
- Tokens remain in URL fragments and are removed after exchange.
- Cookies are `HttpOnly`, `Secure`, and `SameSite=Strict`.
- Unauthenticated, cross-Origin, and stale-cookie requests fail.
- Rotating the signing secret invalidates every browser.

## 7. macOS operations

Add the service CLI, LaunchAgent installer, diagnostics, logs, and Tailscale setup guidance.

Verify:

- `launchd` restarts `caffeinate -s pi-remote-daemon` after failure and login.
- `status` reports daemon, socket, URL, and live-session counts.
- `doctor` reports stale locks, permissions, and binary-path problems.
- A reboot restores the daemon and remote browser access.

## 8. Migration

Run Pi Remote Web beside HAPI on a separate Tailscale HTTPS port. Complete the manual acceptance checklist in the design document. Replace HAPI's default Serve route only after every check passes.
