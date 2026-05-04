# Chrome Automation: Fixes, Robustification & Full Optimization (Single-shot)

**Purpose**

This single-shot, machine-actionable document contains everything a coding agent needs to _fully fix and optimize_ your TypeScript `youtub_uploader` (xgodo agent + Chrome on Android) project for Phase 1 (download). Apply the patches and steps below to eliminate the omnibox loop, make URL submission idempotent, and add robust fallbacks (Intent, key events, shell input) and stronger navigation detection. The document includes ready-to-drop-in code, a demo job, a test harness, dependency notes, and debugging guidance.

---

## Problem summary (from your logs)
- The automation types the full `video_url` into Chrome's omnibox and `nodeAction` logs "Enter succeeded," yet Chrome doesn't navigate to the video page. The handler times out, clears a submitted flag, and restarts — causing a loop.
- Root causes: Enter action may not produce an IME "Enter" event, Chrome may treat the input as a search or new-tab action, or an IME/keyboard is interfering. The handler relies on brittle sleeps and a narrow navigation check.

---

## Goals of this patch
1. Bypass the fragile omnibox workflow where possible using an Intent (`am start`) to open the URL directly.  
2. If Intent is unavailable, write the URL to the omnibox and submit it using several fallbacks in priority order: KEYEVENT (66) -> nodeAction -> on-screen Go -> shell input keyevent -> keyboard click.  
3. Make submission idempotent (mark a job-level flag) so the stage won't re-type while navigation is pending.  
4. Replace fixed `sleep`s with polling for multiple navigation signals (webview nodes, video controls, URL change).  
5. Add heavy logging to identify which fallback worked and why previous attempts failed.

---

## Files to add / modify (one-shot list)
- `src/data.ts` — small job-scope data store (if you already have `getData/addData/clearData`, ensure it matches the snippet).
- `src/utils/ui.ts` — helper utilities: `getAllNodes`, `sleep`.
- `src/stages/ChromeDownloadStage.ts` — replace the `ActiveUrlBar` handler with the robust implementation (full code below).
- `scripts/demo-job.json` — demo job payload for testing.
- `scripts/run-demo.sh` — helper to run a single demo job.
- `package.json` — optional: add dependencies if you choose Puppeteer/axios for server-side alternative.

---

## Ready-to-drop-in code patches

> Note: adapt import paths if your project layout differs. The patches assume TypeScript; small adjustments for JS are trivial.

### 1) `src/data.ts`

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

**Notes:** This is an in-memory store suitable for a single-run agent. If jobs can run concurrently or across processes, use a job-keyed persistence (file, DB). Use `phase1_url_submitted` as the flag key.

---

### 2) `src/utils/ui.ts`

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

If your repo already includes similar helpers, keep those and skip adding this file.

---

### 3) `src/stages/ChromeDownloadStage.ts` — Full, robust `ActiveUrlBar` handler

Replace your existing `ActiveUrlBar.handleScreen` (or the whole handler) with the following implementation. It attempts an Intent launch first, writes/validates text, and uses fallbacks for Enter (key event, nodeAction, on-screen button, shell input, keyboard click). It polls for navigation and sets/clears the `phase1_url_submitted` flag sensibly.

```ts
// src/stages/ChromeDownloadStage.ts (snippet)
import { getAllNodes, sleep } from "../utils/ui";
import { getData, addData, clearData } from "../data";

const APP_PACKAGE_NAME = "com.android.chrome";
const DEFAULT_POLL_MS = 30_000;
const POLL_INTERVAL = 1_000;

export const ActiveUrlBar = {
  detectScreen: async (screenContent: any) => {
    return !!screenContent.find((node: any) =>
      node.packageName === APP_PACKAGE_NAME &&
      (node.viewId === "com.android.chrome:id/url_bar" || (node.resourceId && node.resourceId.endsWith("url_bar")))
    );
  },

  handleScreen: async (screenContent: any, agent: any) => {
    const jobVariables = agent.arguments?.jobVariables || {};
    const videoUrl = jobVariables.video_url || jobVariables.videoUrl;
    if (!videoUrl) {
      console.error("Missing job variable: video_url");
      return false;
    }

    const current = getData();
    if (current.phase1_url_submitted === videoUrl) {
      console.log("URL already submitted for this job — skipping re-type.");
      await sleep(1500);
      return true;
    }

    // 0) Preferred: Try Intent launch (am start) to open the URL directly
    try {
      console.log("Attempting Intent launch (am start) to open URL directly...");
      if (agent.utils && agent.utils.shell) {
        const intentCmd = `am start -a android.intent.action.VIEW -d "${videoUrl}" com.android.chrome`;
        const shellRes = await agent.utils.shell(intentCmd);
        console.log("Intent shell result:", shellRes?.stdout || shellRes);
        await sleep(700);
        if (await _pollForNavigation(agent, videoUrl, DEFAULT_POLL_MS)) {
          addData({ phase1_url_submitted: videoUrl });
          return true;
        }
      }
    } catch (e) {
      console.warn("Intent launch attempt failed:", e);
    }

    // 1) Find URL bar node
    const urlBarNode = screenContent.find((node: any) =>
      node.packageName === APP_PACKAGE_NAME &&
      (node.viewId === "com.android.chrome:id/url_bar" || (node.resourceId && node.resourceId.endsWith("url_bar")))
    );
    if (!urlBarNode) {
      console.warn("URL bar node not found in the current screenContent.");
      return false;
    }

    // Debugging metadata
    console.log("urlBarNode.text:", urlBarNode.text?.slice?.(0,200));
    console.log("urlBarNode.actions:", urlBarNode.actions);
    console.log("urlBarNode.actionLabels:", urlBarNode.actionLabels);
    console.log("urlBarNode.className:", urlBarNode.className);

    // Click the url bar and write text
    try { urlBarNode.randomClick?.(); } catch (e) { try { await agent.actions.nodeAction(urlBarNode, agent.constants.ACTION_CLICK); } catch {} }
    await sleep(500);

    await agent.actions.writeText(videoUrl);
    await sleep(700);

    // read back and verify
    let all = (await agent.actions.allScreensContent()).flatMap((s: any) => getAllNodes(s));
    const urlNodeAfter = all.find((n: any) => n.viewId === "com.android.chrome:id/url_bar" || (n.resourceId && n.resourceId.endsWith("url_bar")));
    const typedText = urlNodeAfter?.text || urlNodeAfter?.contentDescription || "";
    console.log("Typed text preview:", typedText?.slice?.(0,200));

    if (!typedText || !typedText.includes(videoUrl.slice(0, 20))) {
      console.warn("Typed text mismatch; retrying write once...");
      await agent.actions.writeText(videoUrl);
      await sleep(600);
    }

    // 2) Try Enter fallbacks
    let enterTriggered = false;

    // 2A: agent keyEvent (KEYCODE_ENTER == 66)
    try {
      if (agent.actions && typeof agent.actions.keyEvent === "function") {
        console.log("Attempting agent.actions.keyEvent(66) (KEYCODE_ENTER)");
        await agent.actions.keyEvent(66);
        enterTriggered = true;
      } else if (agent.actions && typeof agent.actions.sendKeyEvent === "function") {
        console.log("Attempting agent.actions.sendKeyEvent('KEYCODE_ENTER')");
        await agent.actions.sendKeyEvent("KEYCODE_ENTER");
        enterTriggered = true;
      }
    } catch (e) {
      console.warn("agent keyEvent attempts failed:", e);
    }

    // 2B: nodeAction on url bar
    if (!enterTriggered) {
      try {
        if (urlBarNode.actions && urlBarNode.actions.length) {
          console.log("Attempting nodeAction on url bar with actionId:", urlBarNode.actions[0]);
          await agent.actions.nodeAction(urlBarNode, urlBarNode.actions[0]);
          enterTriggered = true;
          console.log("nodeAction Enter succeeded.");
        }
      } catch (e) {
        console.warn("nodeAction on url bar failed:", e);
      }
    }

    // 2C: on-screen Go/Search/Done
    if (!enterTriggered) {
      try {
        all = (await agent.actions.allScreensContent()).flatMap((s: any) => getAllNodes(s));
        const goBtn = all.find((n: any) => n.text && ["go","search","enter","done"].includes(n.text.toString().toLowerCase()));
        if (goBtn) {
          console.log("Clicking found on-screen button:", goBtn.text || goBtn.viewId);
          await agent.actions.nodeAction(goBtn, agent.constants.ACTION_CLICK);
          enterTriggered = true;
        }
      } catch (e) {
        console.warn("Clicking on-screen go button failed:", e);
      }
    }

    // 2D: shell input keyevent
    if (!enterTriggered) {
      try {
        if (agent.utils && agent.utils.shell) {
          console.log("Fallback: shell input keyevent 66");
          await agent.utils.shell("input keyevent 66");
          enterTriggered = true;
        }
      } catch (e) {
        console.warn("Shell input keyevent failed:", e);
      }
    }

    // 2E: keyboard-area click fallback
    if (!enterTriggered) {
      try {
        console.log("Final fallback: clicking approximate keyboard enter area.");
        await agent.utils.randomClick(900, 1700, 1079, 1999);
        enterTriggered = true;
      } catch (e) {
        console.warn("Keyboard-area click failed:", e);
      }
    }

    if (!enterTriggered) {
      console.error("All enter attempts failed; aborting this attempt.");
      return false;
    }

    // Mark submitted to avoid immediate re-typing
    addData({ phase1_url_submitted: videoUrl });

    // Poll for navigation or presence of webview / video controls
    const navOk = await _pollForNavigation(agent, videoUrl, DEFAULT_POLL_MS);
    if (!navOk) {
      console.warn("Navigation not detected within timeout — clearing submitted flag for retry.");
      clearData("phase1_url_submitted");
      return false;
    }

    console.log("Navigation detected; handing control over to next stage.");
    return true;
  }
};

async function _pollForNavigation(agent: any, videoUrl: string, timeoutMs: number) {
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    await sleep(POLL_INTERVAL);
    elapsed += POLL_INTERVAL;
    try {
      const screens = await agent.actions.allScreensContent();
      const flat = screens.flatMap((s: any) => getAllNodes(s));

      // Detect webview node
      const webview = flat.find((n: any) => (n.className && n.className.toLowerCase().includes("webview")) || n.packageName === APP_PACKAGE_NAME && n.className && n.className.toLowerCase().includes("webview"));
      if (webview) { console.log("Detected webview node — likely navigated."); return true; }

      // Detect video/media controls
      const mediaControl = flat.find((n: any) => (n.description && n.description.toLowerCase().includes("media")) || (n.text && n.text.toString().toLowerCase().includes("play")) || (n.resourceId && /media|video|play/.test(n.resourceId)));
      if (mediaControl) { console.log("Detected media control node:", mediaControl.text || mediaControl.description || mediaControl.resourceId); return true; }

      // Detect URL bar change
      const urlNodeNow = flat.find((n: any) => n.viewId === "com.android.chrome:id/url_bar" || (n.resourceId && n.resourceId.endsWith("url_bar")));
      if (urlNodeNow && urlNodeNow.text && typeof urlNodeNow.text === "string") {
        const t = urlNodeNow.text.toString().toLowerCase();
        if (t.includes("http") && t !== videoUrl && !t.includes("about:blank") && !t.includes("new tab")) {
          console.log("URL bar now contains:", t.slice(0,100));
          return true;
        }
        if (t.includes(videoUrl.slice(0,20))) {
          console.log("URL bar still contains the requested URL (navigation may be loading).");
        }
      }

    } catch (e) {
      console.warn("Polling error:", e);
    }
  }
  return false;
}
```

**Tuning:** Adjust the keyboard click coordinates (`randomClick`), timeouts, and the `APP_PACKAGE_NAME` if your Chrome build uses a different package.

---

## Demo job & test harness

### `scripts/demo-job.json`

```json
{
  "jobId": "demo-1",
  "jobVariables": {
    "video_url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    "video_title": "My Cool Short",
    "video_description": "Check this out!",
    "video_hashtags": "shorts,funny,viral"
  }
}
```

### `scripts/run-demo.sh`

```sh
#!/bin/bash
set -e
JOBFILE=scripts/demo-job.json
# Adjust the runner command to match your project
node dist/main.js --job $JOBFILE
```

Make executable: `chmod +x scripts/run-demo.sh` and run `./scripts/run-demo.sh`.

---

## Optional: server-side alternatives (recommended long-term)

1. **Direct HTTP download** (if `video_url` points to a raw file): use `node-fetch` or `axios` to download the file directly on the server — reliable and fast.

2. **Headless browser (Puppeteer/Playwright)**: Use a server-side headless browser to navigate pages and extract video `src` or network requests, then download. This avoids device UI automation altogether.

If you want, I can add a `scripts/pup-download.ts` example next.

---

## package.json dependencies (suggested)

If you use direct download & shell helpers, add (example):

```json
"dependencies": {
  "node-fetch": "^2.6.7"
},
"devDependencies": {
  "puppeteer": "^21.0.0",
  "ts-node": "^10.9.1",
  "typescript": "^5.0.0"
}
```

Only add Puppeteer if you plan the server-side route.

---

## Testing & verification steps (one-shot)
1. Apply the patches above (or have the coding agent apply them).  
2. Build and start the agent in a test environment with the device connected.  
3. Run `scripts/run-demo.sh`.  
4. Inspect logs for these lines — they should appear in order:  
   - `Attempting Intent launch (am start) to open URL directly...` (if shell available)  
   - `Clicking URL bar and writing the URL...`  
   - `Typed text preview:`  
   - `Attempting agent.actions.keyEvent(66)` OR `nodeAction Enter succeeded.` OR `Fallback: shell input keyevent 66`  
   - `Detected webview node — likely navigated.` OR `Detected media control node:` OR `URL bar now contains:`  
5. If navigation fails, check logs to see which fallback ran and paste the snapshot of `allScreensContent` for analysis.

---

## Debugging checklist & recommended quick dumps
If errors persist, capture and share these snapshots (paste into logs or debugging console):

1. `urlBarNode` object after clicking the URL bar (show `actions`, `actionLabels`, `text`, `className`, `resourceId`).  
2. `allScreensContent()` flattened after Enter attempt (one snapshot).  
3. Output of `agent.utils.shell('am start -a android.intent.action.VIEW -d "<URL>" com.android.chrome')` run once manually.  
4. Device screen resolution and whether an IME keyboard appears (if IME present, prefer KEYEVENT or shell input keyevent). 

These dumps will reveal whether the Enter succeeds but Chrome's UI flow differs.

---

## Rollback & git workflow (safe apply)

```sh
git checkout -b fix/chrome-url-robust
# apply changes
git add -A && git commit -m "fix: robust Chrome URL submission (Intent, keyEvent, fallbacks)"
# test
# if regressions, revert
git checkout main && git reset --hard HEAD~1
```

---

## Coding-agent friendly automation steps (single-shot)
Give these steps to your coding agent and it can apply changes without additional human input.

1. Locate file with `ActiveUrlBar` handler. Replace `handleScreen` with the `ActiveUrlBar` implementation from this doc. If that file does not exist, create `src/stages/ChromeDownloadStage.ts` and export `ActiveUrlBar`.  
2. Ensure `src/data.ts` and `src/utils/ui.ts` exist with the contents here (or adapt).  
3. Add `scripts/demo-job.json` and `scripts/run-demo.sh`.  
4. Run `npm run build` (or appropriate TypeScript compile) and fix any import path mismatches.  
5. Execute `./scripts/run-demo.sh`.  
6. If runtime `agent.*` names differ, map:  
   - `agent.utils.shell` → any available shell/exec helper  
   - `agent.actions.keyEvent` / `sendKeyEvent` → map to your agent's input API  
   - `agent.utils.randomClick` → use platform click with coordinates

---

## Why this patch fixes the loop (brief rationale)
- `am start` avoids omnibox & IME entirely — fastest, most reliable path.  
- KEYEVENT and shell `input keyevent` interact with system input rather than accessibility action ids that can vary across devices.  
- Multiple navigation signals are checked so you don't get false negatives.  
- Idempotent flag prevents re-typing while navigation is still in progress.

---

## Next steps I can run for you (pick one)
- Generate a git patch/diff (unified) for all above changes.  
- Produce a Puppeteer server-side download example file.  
- Produce a minimal debug injection snippet that prints `urlBarNode` & `allScreensContent()` for deeper analysis.

---

*End of file.*

