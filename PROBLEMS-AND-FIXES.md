# UIC Dialer: Problems and Fixes

A short record of issues we hit and how each was solved.

---

## Phone app (Android)

| Problem | Cause | Fix |
|---|---|---|
| App kept freezing and closing ("not responding") | Search and lists did slow work for every contact on the screen thread. Phones with thousands of contacts froze. | Heavy work moved to the background, and the slow step now runs once. (v0.3.81) |
| Old recordings stopped syncing for hours | Android stops background work every ~10 min, and the app waited longer after each stop (5 → 10 → 20 → 40 min…). | It now restarts within 1 minute, and **Sync now** restarts it immediately. (v0.3.81) |
| Old recordings didn't upload at all | They only uploaded while charging **and** on Wi-Fi. | They now upload on any network, unless the battery is low. (v0.3.79) |
| Missed and unrecorded calls didn't appear anywhere | Only calls with a recording were sent to the server. | The phone now sends its whole call log. Calls without a recording show as "No recording" or "Missed". (v0.3.80) |
| No normal dialer features | The app had no recents or phone contacts. | Added the Recents tab, phone contacts, favourites, keypad suggestions and Save contact. (v0.3.80) |
| A call was recorded but didn't show in the app | The recording uploaded under a different account from the one signed in. Agents only see their own calls. | Sign each phone in with the rep's own account. |
| Calls to saved contacts were skipped | "Business calls only" skips numbers saved in the phone's contacts. | Turn it off in Admin → Settings (it is off now). |
| Google sign-in failed | The Android OAuth client was missing or wrong in Google Cloud. | Created a new Android OAuth client with the app's package name and SHA-1. |
| Install blocked on Samsung phones | Samsung Auto Blocker and Play Protect block apps installed from outside the Play Store. | Turn off Auto Blocker and tap "Install anyway". Long term: publish through Google Play. |
| "Install unknown apps" asked every time | That permission is per app (Chrome, My Files, UIC Dialer), or Auto Blocker turned itself back on. | Always update from the in-app **Update** banner. |
| Users kept getting logged out | Sessions expired too early. | Sessions now renew while in use (30 days, up to 90). |

## Desktop app (Windows)

| Problem | Cause | Fix |
|---|---|---|
| White screen on launch | The local server didn't know the newly built web files. | Restart the server after building. |
| Window never appeared when offline | The app waited for the server before showing the window. | It now shows an offline page with Retry. |
| No logo in taskbar / showed "Electron" | Icon and app name weren't set. | Added the icon and the "UIC Dialer" name everywhere. |
| No auto-update | There was nothing to check for updates. | Added auto-update from GitHub Releases, published by CI. |
| Desktop releases never published | The CI change check used a wrong path, so it always said "unchanged". | Fixed the path in CI. |

## Server and dashboard

| Problem | Cause | Fix |
|---|---|---|
| Admin couldn't see computers signed in | Only phones were tracked. | The Health page now lists computers (Windows app and browsers), and admins can sign one out. |
| Reloading the Health page showed `{"ok":true}` | The server's health check and the dashboard page shared the `/health` address. | Browsers now get the page; tools still get the health check. |
| Phone and desktop didn't update live | No real-time channel. | Added live updates, so changes show everywhere within seconds. |

---

## Checklist after a release

1. Push to `main`. CI builds and publishes the phone and desktop updates.
2. Redeploy `uic-api` in Coolify. Database changes apply automatically.
3. Phones: tap the **Update** banner in the app.
