# UIC Dialer

Internal calling and call-recording system for USA India CFO. Reps call from their own Android phones; recordings made by the phone's built-in recorder upload to our server, get transcribed and summarised, and appear in the dashboard and Zoho CRM.

## Folders

| Folder | What it is | Built and run by |
| --- | --- | --- |
| [android/](android/) | Android app (Kotlin): dialer, call outcomes, recording upload, full dashboard features | CI publishes the signed APK to the server; phones update in-app |
| [desktop/](desktop/) | Windows app (Electron): the dashboard plus click-to-call through Phone Link | CI builds the installer (`UIC-Dialer-Setup-*.exe`) as a run artifact |
| [server/](server/) | API (Fastify + Prisma + Postgres) and the web dashboard ([server/dashboard/](server/dashboard/), React) | Coolify resource `uic-api` |
| [worker/](worker/) | Python worker: transcription, translation, summaries, audio compression | Coolify resource `uic-worker` |
| [docs/](docs/) | Setup guides, plans and the troubleshooting log | — |

Don't rename `server/` or `worker/`: Coolify and CI build from those paths.

## Docs

- [docs/coolify-setup.md](docs/coolify-setup.md): deploying the server, worker and database
- [docs/google-oauth-setup.md](docs/google-oauth-setup.md): Google sign-in
- [docs/rollout.md](docs/rollout.md): putting the Android app on staff phones
- [docs/desktop-app.md](docs/desktop-app.md): installing UIC Dialer for Windows and pairing Phone Link
- [docs/dialer-plan.md](docs/dialer-plan.md): dialer and activity tracker
- [docs/zoho-crm-setup.md](docs/zoho-crm-setup.md): Zoho CRM sync
- [docs/privacy.md](docs/privacy.md): what is recorded and kept
- [docs/troubleshooting.md](docs/troubleshooting.md): problems we hit and how we fixed them

## Local development

- Server: `cd server && npm ci && npm run dev:db` (local Postgres), then `npm run dev`; dashboard: `npm run dev:dashboard`.
- Server tests: `cd server && npm test`.
- Worker: `cd worker && uv run pytest -q`.
- Android: open `android/` in Android Studio, or `./gradlew :app:assembleDebug`.
- Desktop: `cd desktop && npm ci && npm start` (set `UIC_URL=http://localhost:8000` to use a local server); `npm run dist` builds the installer.
