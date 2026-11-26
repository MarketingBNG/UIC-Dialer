// Runs in the dashboard page (sandboxed). Exposes only two Phone Link helpers; main.js answers them only for the
// app's own origin (rules.sameOrigin), so a page loaded from anywhere else gets nothing.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("uicDesktop", {
  /** { installed: boolean } — whether Microsoft Phone Link is installed on this PC. */
  phoneLinkStatus: () => ipcRenderer.invoke("phone-link:status"),
  /** Opens Phone Link (to pair a phone or check it is connected). */
  openPhoneLink: () => ipcRenderer.invoke("phone-link:open"),
});
