# AppsFlyer Link Opener v1.6.1

Chrome Manifest V3 extension for bulk-opening AppsFlyer integrated-partner URLs.

## Current behavior

- Built-in presets: Angel One and Jar.
- Starts with **Select an app** rather than auto-selecting an app.
- Custom App ID or existing AppsFlyer URL input.
- PID/URL bulk input with newline/comma/semicolon/tab separators.
- AppsFlyer URL extraction from arbitrary pasted text.
- Duplicate URL removal, reverse ordering, random ordering, optional Google-search handling.
- **New Tab Group is the default**. Group title is derived from the selected app and remains editable.
- Local app presets are remembered.
- Local workspace remembers the latest app selection, App ID, PID/URL input, extracted URLs, generated links, group name, and UI options.
- Recent run history is kept locally for **30 minutes** (completed/failed runs), with per-PID URL, status, retry counts, and Copy URL buttons. Finished runs can be removed individually or cleared together.
- Batch opening is configurable from Settings. Default is **7 tabs per batch** with **10 seconds between batches**.
- Batch delay is scheduled with Chrome alarms so the service worker can sleep/restart without losing the next batch.
- Per-tab AppsFlyer error/navigation retries: **up to 5**.
- Loading-stuck retries: **up to 2**, only when the tab is still genuinely loading at the 30-second watchdog.
- After retry limits are exhausted, the AppsFlyer page receives the manual fallback overlay with the correct URL to copy and enter manually.

## Install

1. Extract the ZIP.
2. Open `chrome://extensions/`.
3. Enable Developer mode.
4. Choose **Load unpacked**.
5. Select the extracted `appsflyer-link-opener` folder.


## v1.6.1 audit fixes
- Active runs are never evicted by the finished-history count cap.
- Complete AppsFlyer partner URLs work without a selected App ID.
- Preview uses the same ordering as Open and is cleared when inputs change.
- Custom group names survive app selection changes.
- Preset selection is stored by stable App ID rather than array position.
- Empty preset lists remain empty; built-ins only appear on first run.
- Presets can be edited and duplicate App IDs/names are blocked.
- Inconclusive page checks no longer become false Success states.
- Open is guarded against rapid double-clicks.
