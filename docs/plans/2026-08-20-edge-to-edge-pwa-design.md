# Edge-to-Edge PWA Design

## Goal

Make the installed Pi Remote Web home-screen app use native standalone presentation and extend its chrome beneath the iOS status bar without placing controls under the device cutout.

## Design

Add a standards-based web app manifest with standalone display, app identity, scope/start URL, theme/background colors, and 192px/512px install icons. Add a 180px Apple touch icon because iOS does not use all manifest icon metadata consistently.

The document adds `viewport-fit=cover`, Apple standalone/status-bar metadata, and light/dark `theme-color` hints. The app shell fills the full viewport and applies `env(safe-area-inset-*)` padding so background reaches every edge while controls remain tappable and visible.

No service worker or offline cache is added. The existing cleanup for the previous app's service worker remains in place.

## Verification

- Validate manifest fields and icon dimensions.
- Build and serve the production UI.
- Verify standalone metadata, full-viewport layout, and safe-area CSS at a mobile viewport.
- Run `npm test`, `npm run check`, and `npm run build`.
