# Chrome Automation: Fixes, Robustification & Optimization

**Purpose:**
This single-shot, machine-actionable document lists all changes, new helpers, tests, and suggested workflow changes to make your TypeScript `youtub_uploader` project (xgodo agent + Chrome on Android automation) robust and fast. Feed this file to a coding agent (or apply manually) and it should be able to implement the fixes, add tests, and produce a working, more reliable Phase 1 (download) flow.

---

## Summary of the problem (diagnosis)
- The script successfully launches Chrome, clicks the URL bar, writes the `jobVariables.video_url`, but fails to reliably submit (Enter). Instead it re-launches Chrome and re-types the URL in a loop.
- Root causes: timing/race conditions (writeText vs. Enter), unreliable nodeAction ids across devices/Chrome builds, no idempotency guard (so the stage re-runs), and brittle reliance on fixed sleeps instead of polling for conditions.

## High-level design goals for the fix
1. Make the URL-submit step idempotent (one-shot per job URL) to avoid typing loops.
2. Verify (read back) that the text was written before pressing Enter.
3. Submit Enter with fallbacks: nodeAction -> on-screen Go/Search -> keyboard-area click -> Intent launch (if available).
4. Poll for navigation / video-player controls instead of using fixed `sleep()` only.
5. Add clear logs and error handling so the coding agent and you can see which fallback ran.
6. Provide an optional, more reliable server-side alternative (Puppeteer / yt-dlp) to avoid fragile device UI automation.

---

## Files to modify (overview)
- `src/stages/ChromeDownloadStage.ts` (or location of your ActiveUrlBar screen handler)
- `src/data.ts` (add/get helper for `phase1_url_submitted`) — if missing, add `getData/addData/clearData` helpers.
- `src/utils/ui.ts` (add `getAllNodes()` and `sleep()` helpers if not present)
- `package.json` (add dev dependencies for testing / optional Puppeteer)
- Add a test harness `scripts/demo-job.json` and `scripts/run-demo.sh` for manual verification.

---

## Exact code patches
Below are ready-to-drop-in code patches. When applying, adapt import paths to match your repo structure.

### 1) `src/data.ts` — store job-level flags
If you already have `getData/addData`, skip replacing the file. Otherwise add or augment with the following simple in-memory store (persisting to disk is optional):

```ts
// src/data.ts
let _store: Record<string, any> = {};

export function getData() {
  return _store;
}

export function addData(obj: Record<string, any>) {
  _store = { ..._store, ...obj };
}

export function clearData(key?: string) {
  if (!key) { _store = {}; return; }
  delete _store[key];
}
```

Notes:
- This simple store is per-run and sufficient for guarding retries. If your agent runs multiple jobs in parallel or across process restarts, replace with a job-scoped persistence (e.g., file-based or database) keyed by job id.


### 2) `src/utils/ui.ts` — helpers: flatten nodes and sleep

```ts
// src/utils/ui.ts
export function getAllNodes(screen: any): any[] {
  if (!screen) return [];
  if (Array.isArray(screen.nodes)) return screen.nodes;
  if (Array.isArray(screen)) return screen.flatMap(getAllNodes);
  return [];
}

export function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
```

If your repo already exposes `getAllNodes` or `sleep`, use those instead.


### 3) `src/stages/ChromeDownloadStage.ts` — robust ActiveUrlBar handler (full replacement)

Replace your existing `ActiveUrlBar.handleScreen` implementation with the code below. It is defensive, logs extensively, verifies typed text, uses fallbacks for Enter, marks the URL-submitted flag, and polls for navigation evidence.

> **Adaptation note:** This patch assumes you have access to `agent.actions.writeText`, `agent.actions.nodeAction`, `agent.actions.allScreensContent`, `agent.constants.ACTION_CLICK`, `agent.utils.randomClick`, `agent.arguments.jobVariables`, and the helper functions `getAllNodes`, `sleep`, `getData`, and `addData`.

```ts
// src/stages/ChromeDownloadStage.ts  (snippet)
import { getAllNodes, sleep } from "../utils/ui";
import { getData, addData } from "../data";

const APP_PACKAGE_NAME = "com.android.chrome"; // adjust if different

export const ActiveUrlBar = {
  detectScreen: async (screenContent: any) => {
    return !!screenContent.find((node: any) =>
      node.packageName === APP_PACKAGE_NAME && (node.viewId === "com.android.chrome:id/url_bar" || (node.resourceId && node.resourceId.endsWith("url_bar")))
    );
  },

  handleScreen: async (screenContent: any, agent: any) => {
    const urlBarNode = screenContent.find((node: any) =>
      node.packageName === APP_PACKAGE_NAME && (node.viewId === "com.android.chrome:id/url_bar" || (node.resourceId && node.resourceId.endsWith("url_bar")))
    );

    if (!urlBarNode) return false;

    const jobVariables = agent.arguments?.jobVariables || {};
    const videoUrl = jobVariables.video_url || jobVariables.videoUrl;
    if (!videoUrl) {
      console.error("Missing job variable: video_url");
      return false;
    }

    const current = getData();
    if (current.phase1_url_submitted && current.phase1_url_submitted === videoUrl) {
      console.log("URL already submitted for this job — skipping re-type.");
      await sleep(1500);
      return true;
    }

    console.log("Clicking URL bar and writing the URL...");
    try {
      urlBarNode.randomClick?.();
    } catch (e) {
      try { await agent.actions.nodeAction(urlBarNode, agent.constants.ACTION_CLICK); } catch (e2) { /* ignore */ }
    }

    await sleep(600);

    // write text and verify
    await agent.actions.writeText(videoUrl);
    await sleep(700);

    let all = (await agent.actions.allScreensContent()).flatMap((s: any) => getAllNodes(s));
    const urlNodeAfter = all.find((n: any) => n.viewId === "com.android.chrome:id/url_bar" || (n.resourceId && n.resourceId.endsWith("url_bar")));
    const typedText = urlNodeAfter?.text || urlNodeAfter?.contentDescription || "";
    console.log("Typed text preview:", typedText?.slice(0, 140));

    if (!typedText || !typedText.includes(videoUrl.slice(0, 20))) {
      console.warn("Typed text mismatch, retrying write once...");
      await agent.actions.writeText(videoUrl);
      await sleep(700);
    }

    // Try to submit Enter using multiple fallbacks
    let enterTriggered = false;

    // Fallback 1: nodeAction on url bar (preferred)
    try {
      if (urlBarNode.actions && urlBarNode.actions.length) {
        // try to pick an action id that likely invokes "Go" or "Search"
        const maybeActionId = urlBarNode.actions[0];
        console.log("Attempting nodeAction on url bar actionId:", maybeActionId);
        await agent.actions.nodeAction(urlBarNode, maybeActionId);
        enterTriggered = true;
      }
    } catch (e) {
      console.warn("nodeAction on url bar failed:", e);
    }

    // Fallback 2: click an on-screen 'Go'/'Search'/'Enter' button
    if (!enterTriggered) {
      all = (await agent.actions.allScreensContent()).flatMap((s: any) => getAllNodes(s));
      const goBtn = all.find((n: any) => n.text && ["go","search","enter","done"].includes(n.text.toString().toLowerCase()));
      if (goBtn) {
        try {
          await agent.actions.nodeAction(goBtn, agent.constants.ACTION_CLICK);
          enterTriggered = true;
          console.log("Clicked on-screen button to submit URL.");
        } catch (e) {
          console.warn("Click of on-screen button failed:", e);
        }
      }
    }

    // Fallback 3: click keyboard enter area (device-specific coordinates)
    if (!enterTriggered) {
      try {
        console.log("Fallback: clicking approximate keyboard enter area (bottom-right)");
        // adjust coordinates if your device resolution differs
        await agent.utils.randomClick(900, 1700, 1079, 1999);
        enterTriggered = true;
      } catch (e) {
        console.warn("Keyboard-area click fallback failed:", e);
      }
    }

    if (!enterTriggered) {
      console.error("Could not trigger Enter by any method.");
      return false;
    }

    // Mark the URL as submitted for this job to avoid re-typing
    addData({ phase1_url_submitted: videoUrl });

    // Poll for navigation or the video controls (up to N ms)
    const maxPollMs = 20_000;
    const pollInterval = 1000;
    let elapsed = 0;
    let navDetected = false;

    while (elapsed < maxPollMs) {
      await sleep(pollInterval);
      elapsed += pollInterval;

      const screens = await agent.actions.allScreensContent();
      const flat = screens.flatMap((s: any) => getAllNodes(s));

      // Detect playing-video controls by description (adjust if needed)
      const mediaControl = flat.find((n: any) => n.packageName === APP_PACKAGE_NAME && (n.description === "show more media controls" || (n.text && n.text.toLowerCase().includes("play"))));
      if (mediaControl) {
        console.log("Detected media controls — navigation successful.");
        navDetected = true;
        break;
      }

      const urlNodeNow = flat.find((n: any) => n.viewId === "com.android.chrome:id/url_bar" || (n.resourceId && n.resourceId.endsWith("url_bar")));
      if (urlNodeNow && urlNodeNow.text && typeof urlNodeNow.text === "string") {
        if (!urlNodeNow.text.includes("about:blank") && !urlNodeNow.text.includes("new tab") && urlNodeNow.text !== typedText) {
          console.log("URL changed after submit:", urlNodeNow.text.slice(0, 140));
          navDetected = true;
          break;
        }
      }
    }

    if (!navDetected) {
      console.warn("Navigation not detected within timeout. Consider removing the submitted flag to allow a retry.");
      // If you want to allow retries uncomment below to clear the submitted flag
      // clearData('phase1_url_submitted');
      return false;
    }

    console.log("Phase 1: navigation detected; handing control to PlayingVideo stage.");
    return true;
  }
};
```

**Important adjustments to check after dropping this code**:
- Ensure the `agent.*` APIs exist with the names used. If your code uses different names for constants or utilities, adapt them.
- `agent.utils.randomClick` coordinates may require tuning for your device/resolution.


---

## Optional: Launch via Intent (best if available)
If your agent/platform supports launching Chrome with a URL intent (bypassing typing altogether), prefer that. Example pseudo-code: `agent.actions.launchApp({ packageName: 'com.android.chrome', url: videoUrl })` or via Android `am start -a android.intent.action.VIEW -d "${videoUrl}"`. If possible, add this as the **first** attempt before typing.

---

## Alternative architecture (recommended long-term)
Avoid on-device UI automation entirely if you can. Two robust server-side alternatives:

### A) Direct HTTP download (best if URL points to media file)
- Use `node-fetch` or `axios` to download `host:port/file.format` directly to disk.
- If auth required, include headers/cookies provided by xgodo job variables.

```ts
// example: server-side download
import fs from 'fs';
import fetch from 'node-fetch';

export async function downloadFile(url: string, outPath: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  const fileStream = fs.createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
  });
}
```

### B) Headless browser (Puppeteer/Playwright) to extract media
- Use Puppeteer to navigate to the page, wait for the video element, extract `src` or fetch the network request for the media segment, then download.
- Much faster and more deterministic than on-device UI automation.

Example: `npm i puppeteer` + sample code in `scripts/pup-download.ts` (not included here, ask me if you want the full sample).

Pros: faster, testable, scriptable; cons: may not run on-device and might require server resources.

---

## Demo job & test harness (single-shot)
Create `scripts/demo-job.json` to simulate a job for local testing. This file is used by `scripts/run-demo.sh` to call your agent runner.

```json
// scripts/demo-job.json
{
  "jobId": "demo-1",
  "jobVariables": {
    "video_url": "https://example.com/path/to/video.mp4"
  }
}
```

`run-demo.sh` (make executable):

```sh
#!/bin/bash
JOBFILE=scripts/demo-job.json
node dist/agent-runner.js --job $JOBFILE
```

Adjust the runner command to match how your agent receives job payloads.

---

## Dependencies & `package.json` changes
If you add Puppeteer or testing libs, install:

```sh
npm i node-fetch@2 fs-extra
npm i -D puppeteer typescript ts-node
```

(Only add Puppeteer if you choose the server-side strategy.)

---

## Tests & verification steps
1. Build and run your agent in a test environment where you can watch logs.
2. Use `scripts/demo-job.json` to run a single job and observe logs.
3. Confirm logs show:
   - "Clicking URL bar and writing the URL..."
   - "Typed text preview:" with the typed URL fragment
   - Which fallback was used to submit the URL
   - "Detected media controls" or "URL changed after submit"
4. If the script still loops, inspect logs to see if `phase1_url_submitted` was set; if not, find the branch that prevented setting it.

---

## Rollback plan
If the new handler causes regressions, revert the commit and restore the previous handler. Suggested git workflow:

```sh
git checkout -b fix/chrome-url-robust
# apply changes
git add -A && git commit -m "fix: robust Chrome URL submission with fallbacks and idempotency"
# test
# if regressions -> revert
git checkout main && git reset --hard HEAD~1
```

---

## Coding-agent friendly patch instructions (single-shot automated steps)
This section is written so a code-mod/coding agent can follow it step-by-step without external inputs.

1. Search repository for the file that contains `ActiveUrlBar` or the handler that clicks the URL/search box. Usually located in `src/stages/ChromeDownloadStage.ts` or `src/stages/*`.
2. Replace the `handleScreen` implementation in that handler with the `ActiveUrlBar` implementation from this document.
3. Ensure `src/data.ts` contains `getData/addData/clearData`; if missing, add the file with the content supplied.
4. Ensure `src/utils/ui.ts` contains `getAllNodes` and `sleep`; add if missing.
5. Run TypeScript compile (or `npm run build`) and fix any import path issues.
6. Add a short test job at `scripts/demo-job.json` with a stable URL and run the runner.
7. If agent logs show mismatches in `agent.*` method names, map them accordingly and re-run tests.
8. Commit changes with message: `fix: robust Chrome URL submission with fallbacks and idempotency`.

---

## Debugging tips & device-specific notes
- Keyboard coordinates used by `randomClick` are device-resolution dependent. If you see keyboard clicks having no effect, capture a screenshot, test coordinates manually, and update the numbers.
- If `agent.actions.nodeAction(..., actionId)` expects Android `actionId` constants (e.g., `16908372`), prefer using `agent.constants.ACTION_CLICK` unless you deliberately use KeyEvent codes.
- Add verbose logging to see the content of `urlBarNode.actions` and `urlBarNode.actionLabels` to understand the runtime behavior on your device.

---

## What I cannot change remotely
- I cannot know your exact device resolution and the exact `agent` API signatures; you may need to adapt a few names/IDs.
- If the Chrome app package name or view ids differ on your build, update the `APP_PACKAGE_NAME` and `url_bar` resource id checks accordingly.

---

## Next steps I can do for you (pick any)
- Produce a precise patch/diff (git-style) that the coding agent can apply automatically.
- Generate a Puppeteer-based server-side downloader example in TypeScript.
- Produce a short unit/integration test script that can run inside your CI to validate the flow.

---

## Signed-off-by
This document was generated to be directly actionable by a code-fixing agent. Follow the `Coding-agent friendly patch instructions` section for an automated apply.

---

*End of file.*

