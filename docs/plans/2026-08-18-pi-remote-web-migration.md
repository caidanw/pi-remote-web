# Pi Remote Web Migration Runbook

Run Pi Remote Web beside HAPI until every check below passes. Do not change
HAPI's existing `https://caidans-macbook-pro-2023.skate-danio.ts.net` →
`http://127.0.0.1:3006` route until migration is approved.

## 1. Install beside HAPI

```bash
cd ~/Projects/pi-remote-web
npm install && npm install --prefix web && npm run build
npm link                 # exposes the pi-remote-web command
tailscale serve --bg --https=8443 http://127.0.0.1:3847
pi-remote-web install    # public URL is detected from the serve route
pi-remote-web status
pi-remote-web doctor
```

## 2. Publish a separate Tailscale HTTPS port

Run manually; the daemon never mutates Tailscale.

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3847
tailscale serve status
```

Rollback:

```bash
tailscale serve --https=8443 off
```

Keep Funnel disabled. Confirm `tailscale serve status` still lists HAPI on 443.

## 3. Pair one browser

```bash
pi-remote-web pair    # QR code + single-use, five-minute fragment URL
```

Open the URL on the iPhone. Confirm the URL fragment never reaches the server,
reuse fails, and `pi-remote-web revoke-all` invalidates the browser.

## 4. Manual acceptance checklist

1. Start two terminal Pi sessions before the daemon, then start the daemon and see both.
2. Prompt each terminal session from the browser and see it in each TUI.
3. Prompt from each TUI and see streaming output on the phone.
4. Run `/new` and `/resume` in a terminal; the live browser tab follows, a pinned history tab does not.
5. Create and resume a browser-owned session from the phone.
6. Launch a session in an existing worktree, then create worktrees with the suggested and an overridden path.
7. Release an idle browser session, then resume it in a terminal.
8. Confirm a busy browser session rejects terminal takeover without losing work.
9. Restart the daemon during terminal work; terminal work continues and the browser reconnects.
10. Verify pairing reuse/expiry failure and revoke-all.
11. Reboot the Mac; verify launchd, Tailscale, pairing, and session discovery.
12. Close the lid in the intended clamshell setup, wait past the sleep timer, and connect from the phone.

## 5. Cut over and retire HAPI

Only after every check passes:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3847
tailscale serve --https=8443 off
tailscale serve status
```

Then stop HAPI's service and remove its process. Keep its data until one week of
successful daily use.

## Rollback

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3006
pi-remote-web stop
```
