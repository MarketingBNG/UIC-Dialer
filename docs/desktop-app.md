# UIC Dialer for Windows

Reps dial from their computer and talk through a headset. The call still goes out on their own Android phone's SIM, so the phone's recorder, our upload, transcripts and the Zoho CRM sync all work as before.

## How it works

1. The rep clicks **Call** in UIC Dialer: on the Dialer page, a contact or a call.
2. The app hands the number to Windows, and **Phone Link** tells the paired phone to dial.
3. The phone places a normal SIM call and records it with its built-in recorder.
4. The audio goes between the phone and the PC over **Bluetooth**, so the rep talks on the PC headset.
5. When the rep comes back to UIC Dialer, it asks for the outcome. The outcome is linked to the recording once the phone uploads it.

Our app can't stream call audio itself: Android doesn't allow ordinary apps to do that. Phone Link works because the PC acts as a Bluetooth headset.

## What each rep needs

- Windows 10 or 11 PC **with Bluetooth**, and a headset or mic and speakers.
- Android phone with the UIC Dialer phone app set up as usual (auto-record on, app signed in).
- Phone within about 10 m of the PC during calls.

## Setup (once per rep)

1. **Phone Link:** on the PC, open Phone Link (it comes with Windows), choose Android and scan the QR code with the **Link to Windows** app on the phone. Sign in with the same Microsoft account on both.
2. **Calls in Phone Link:** in Phone Link, open Calls and follow the Bluetooth pairing prompts. Make one test call from Phone Link itself.
3. **Phone links:** Windows Settings → Apps → Default apps → search for `TEL` → choose **Phone Link**. Teams or Skype often take this over; if a Call click opens them, change it back here.
4. **Install UIC Dialer:** run `UIC-Dialer-Setup-<version>.exe` (from the CI run's artifacts). The installer is not code-signed yet, so Windows SmartScreen shows "Windows protected your PC": click **More info → Run anyway**.
5. **Sign in:** click Sign in with Google. It opens your browser; after you sign in, allow it to open UIC Dialer.

## Before rolling out to a rep: recording check

Some phones' built-in recorders stop recording when the call audio goes to Bluetooth. For each phone model:

1. Make a call from UIC Dialer and talk for about 30 seconds.
2. Check the phone's recordings folder, then the dashboard, for that call's recording.

If it's missing, that phone can still dial from the desktop, but the rep must talk on the phone itself (switch the audio to the phone during the call) so it's recorded.

## Notes

- UIC Dialer shows the live dashboard, so dashboard updates arrive without reinstalling. Reinstall only for a new desktop version.
- Closing the window keeps it running in the tray (so the outcome prompt isn't lost). Quit it from the tray icon.
- The dashboard's Dialer page also works in a normal browser on Windows if Phone Link handles `tel:` links, but sign-in and Call clicks are smoother in the app.
- Code-signing the installer (to remove the SmartScreen warning) needs a paid code-signing certificate.
