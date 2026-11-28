import { describe, expect, it } from "vitest";
import { DeviceConfig, updateRequired } from "../src/settings.js";

const latest = { versionCode: 50 };
const off = { minVersionCode: null, requireLatest: false };

describe("updateRequired", () => {
  it("never forces with no policy, no published app, or an unknown phone version", () => {
    expect(updateRequired(off, latest, 10)).toBe(false);
    expect(updateRequired({ minVersionCode: 40, requireLatest: false }, null, 10)).toBe(false);
    expect(updateRequired({ minVersionCode: 40, requireLatest: true }, latest, null)).toBe(false);
  });
  it("forces phones below the minimum, only when a newer build exists", () => {
    const p = { minVersionCode: 40, requireLatest: false };
    expect(updateRequired(p, latest, 39)).toBe(true);
    expect(updateRequired(p, latest, 40)).toBe(false);
    expect(updateRequired({ minVersionCode: 99, requireLatest: false }, latest, 50)).toBe(false); // nothing newer to install
  });
  it("'always require the latest' forces anything older than the published build", () => {
    const p = { minVersionCode: null, requireLatest: true };
    expect(updateRequired(p, latest, 49)).toBe(true);
    expect(updateRequired(p, latest, 50)).toBe(false);
  });
  it("older saved settings without the new fields still parse", () => {
    const old = { recorderFolders: [], liveNetwork: "any", backlogEnabled: true, backlogCutoffDays: 1, maxParallelUploads: 1, compressAudio: true, businessOnly: false };
    expect(DeviceConfig.parse(old)).toMatchObject({ minVersionCode: null, requireLatest: false });
  });
});
