/**
 * Download Stage - Downloads video from URL to device storage via Chrome browser
 *
 * Clean 2-path workflow:
 *   Path 1.1 (Home Screen): search_box → URL bar → type URL → Enter → video page → 3-dots media → download
 *   Path 1.2 (Other Screen): Chrome menu button → "New tab" → (home screen) → follow Path 1.1
 *
 * All selectors are derived from real device accessibility data:
 *   - data/chrome/chrome_launch.json          → Chrome home screen
 *   - data/chrome/chrome_launch_search.json   → search_box_text (EditText)
 *   - data/chrome/chrome_search.json          → url_bar in search mode
 *   - data/chrome/select_3_dot.json           → Chrome menu_button (top-right 3-dot)
 *   - data/chrome/new_tab_select.json         → "New tab" menu item
 *   - data/chrome/download_video.json         → Video player page
 *   - data/chrome/media_control.json          → "show more media controls" button
 *   - data/chrome/download_button.json        → "download media" MenuItem
 */

import { DEFAULT_MAX_STEPS_PER_STAGE, JOB_VARS, getJobVar, UPLOAD_CONFIG } from "./config";
import { Stage, type ScreenHandles, setStage } from "./Stage";
import { fail, addData, submitProgress } from "./data";

const CHROME_PACKAGE = "com.android.chrome";
const YOUTUBE_PACKAGE = "com.google.android.youtube";
const MAX_DOWNLOAD_ATTEMPTS = 3;

// ════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════

/** Dump screen nodes for debugging */
async function dumpScreenNodes(label: string, maxNodes: number = 20) {
    const screen = await agent.actions.screenContent();
    const allNodes = screen.allNodes();
    console.log(`[Download] === ${label} === (${allNodes.length} nodes)`);
    for (const node of allNodes.slice(0, maxNodes)) {
        const cls = (node.className || "?").replace("android.widget.", "").replace("android.view.", "");
        const vid = node.viewId ? node.viewId.replace(`${CHROME_PACKAGE}:id/`, "") : "";
        const txt = (node.text || "").substring(0, 50);
        const desc = (node.description || "").substring(0, 50);
        const click = node.clickable ? "✓" : " ";
        console.log(`  [${click}] ${cls} id=${vid} text="${txt}" desc="${desc}"`);
    }
    return { screen, allNodes };
}

/** Check if Chrome is actually in the foreground (not just the home screen widget) */
function isChromeInForeground(allNodes: any[]): boolean {
    return allNodes.some(
        (n: any) =>
            n.packageName === CHROME_PACKAGE && (
                (n.viewId && (
                    n.viewId.includes("url_bar") ||
                    n.viewId.includes("toolbar") ||
                    n.viewId.includes("search_box_text") ||
                    n.viewId.includes("tab_switcher") ||
                    n.viewId.includes("location_bar") ||
                    n.viewId.includes("omnibox")
                )) ||
                n.className === "android.webkit.WebView"
            )
    );
}

/**
 * Check if we're on Chrome's HOME/NEW-TAB screen.
 * Key indicator: search_box_text (viewId="com.android.chrome:id/search_box_text")
 * From chrome_launch.json / chrome_launch_search.json
 */
function isHomeScreen(allNodes: any[]): boolean {
    return allNodes.some(
        (n: any) =>
            n.viewId === `${CHROME_PACKAGE}:id/search_box_text` &&
            n.packageName === CHROME_PACKAGE
    );
}

/**
 * Check if we're on a video player page.
 * From download_video.json: WebView + media controls (play/mute/fullscreen/scrubber/3-dot)
 */
function isVideoPlayerPage(allNodes: any[]): boolean {
    const hasWebView = allNodes.some(
        (n: any) => n.className === "android.webkit.WebView" && n.packageName === CHROME_PACKAGE
    );
    const hasMediaControls = allNodes.some(
        (n: any) =>
            n.packageName === CHROME_PACKAGE && (
                (n.description === "play" && n.className === "android.widget.Button") ||
                (n.description === "mute" && n.className === "android.widget.Button") ||
                (n.description === "enter full screen" && n.className === "android.widget.Button") ||
                (n.text && n.text.includes("show more media controls")) ||
                (n.text === "video time scrubber")
            )
    );
    return hasWebView && hasMediaControls;
}

/** Dismiss Chrome crash dialogs ("Chrome keeps stopping" etc.) */
async function handleCrashDialogs(allNodes: any[]): Promise<boolean> {
    const crashTitle = allNodes.find(
        (n: any) =>
            n.text && (
                n.text.includes("keeps stopping") ||
                n.text.includes("has stopped") ||
                n.text.includes("isn't responding") ||
                n.text.includes("keeps crashing")
            )
    );
    if (!crashTitle) return false;

    console.log(`[Download] ⚠️ CRASH DIALOG: "${crashTitle.text}"`);
    for (const text of ["Close app", "Close", "OK", "Wait"]) {
        const button = allNodes.find(
            (n: any) => n.text && n.text.toLowerCase() === text.toLowerCase() && n.clickable
        );
        if (button) {
            console.log(`[Download] Tapping "${button.text}" to dismiss`);
            await button.randomClick();
            await sleep(2000);
            return true;
        }
    }
    return false;
}

/** Dismiss Chrome welcome/notification dialogs */
async function dismissChromeDialogs(allNodes: any[]): Promise<boolean> {
    const dialogTexts = [
        "No thanks", "No, thanks", "Continue", "Accept & continue",
        "OK", "Got it", "Skip", "Accept", "Dismiss",
    ];
    for (const buttonText of dialogTexts) {
        const button = allNodes.find(
            (n: any) =>
                n.clickable && n.packageName === CHROME_PACKAGE &&
                ((n.text && n.text.toLowerCase() === buttonText.toLowerCase()) ||
                    (n.description && n.description.toLowerCase() === buttonText.toLowerCase()))
        );
        if (button) {
            console.log(`[Download] Dismissed Chrome dialog: "${button.text || button.description}"`);
            await button.randomClick();
            await sleep(2000);
            return true;
        }
    }
    return false;
}

// ════════════════════════════════════════════════════
// CORE DOWNLOAD FLOW (Clean 2-path approach)
// ════════════════════════════════════════════════════

/**
 * PATH 1.1: Execute the download from the HOME SCREEN.
 * Home screen detected → tap search_box → type URL → Enter → video page → 3-dots → download
 * Returns true if download succeeded.
 */
async function downloadFromHomeScreen(allNodes: any[], videoUrl: string): Promise<boolean> {

    // ── STEP A: Click search_box_text to activate the URL bar ──
    // NOTE: SET_TEXT on search_box_text silently fails (text never changes).
    //       SET_TEXT on url_bar crashes Chrome.
    //       Solution: click search_box → use type() via IME to type the URL.
    console.log("{---------- 🔵 STEP A: Click search box to activate URL bar ----------}");

    const searchBox = allNodes.find(
        (n: any) =>
            n.viewId === `${CHROME_PACKAGE}:id/search_box_text` &&
            n.packageName === CHROME_PACKAGE
    );

    if (!searchBox) {
        console.error("[Download] ❌ search_box_text not found on home screen!");
        return false;
    }

    console.log(`[Download] Found search_box: text="${(searchBox.text || "").substring(0, 30)}"`);
    await searchBox.randomClick();
    await sleep(2000);

    // After clicking, Chrome transitions to url_bar (EditText) with omnibox suggestions
    const { allNodes: searchNodes } = await dumpScreenNodes("After search box click");
    if (await handleCrashDialogs(searchNodes)) {
        console.error("[Download] ❌ Chrome crashed after clicking search box!");
        return false;
    }

    const urlBar = searchNodes.find(
        (n: any) =>
            n.viewId === `${CHROME_PACKAGE}:id/url_bar` &&
            n.className === "android.widget.EditText" &&
            n.packageName === CHROME_PACKAGE
    );

    if (!urlBar) {
        console.error("[Download] ❌ url_bar not found after clicking search box!");
        return false;
    }
    console.log("[Download] ✅ URL bar active.");

    // ── STEP B: SET_TEXT on url_bar (the ONLY text input method available) ──
    // NOTE: type() does NOT exist on agent.actions. SET_TEXT is the only way.
    // SET_TEXT on search_box_text silently fails. SET_TEXT on url_bar may crash Chrome.
    // If Chrome crashes → return false → outer retry loop will re-launch Chrome.
    console.log("{---------- 🔵 STEP B: SET_TEXT on url_bar ----------}");
    console.log(`[Download] Setting URL: ${videoUrl}`);

    // Click url_bar to ensure focus
    await urlBar.randomClick();
    await sleep(1000);

    // Apply SET_TEXT on the focused url_bar
    try {
        await agent.actions.nodeAction(urlBar, agent.constants.ACTION_SET_TEXT, { text: videoUrl });
        console.log("[Download] ✅ SET_TEXT on url_bar succeeded");
    } catch (e) {
        console.error("[Download] ❌ SET_TEXT on url_bar threw error:", e);
        return false; // outer retry loop will re-launch Chrome
    }
    await sleep(2000);

    // Check if Chrome survived SET_TEXT
    const { allNodes: afterSetNodes } = await dumpScreenNodes("After SET_TEXT on url_bar");
    if (await handleCrashDialogs(afterSetNodes)) {
        console.error("[Download] ❌ Chrome crashed after SET_TEXT on url_bar!");
        return false; // outer retry loop will re-launch Chrome
    }

    if (!isChromeInForeground(afterSetNodes)) {
        console.error("[Download] ❌ Chrome disappeared after SET_TEXT (silent crash)!");
        return false;
    }

    // Verify the URL was actually set (check url_bar text)
    const verifyBar = afterSetNodes.find(
        (n: any) => n.viewId === `${CHROME_PACKAGE}:id/url_bar` && n.text
    );
    const barText = verifyBar ? (verifyBar.text || "") : "";
    console.log(`[Download] URL bar now shows: "${barText.substring(0, 80)}"`);

    // Check if SET_TEXT silently failed (text still shows hint)
    if (barText === "Search Google or type URL" || barText === "") {
        console.error("[Download] ❌ SET_TEXT silently failed — url_bar still shows hint text!");
        // Try one more time: re-scan, re-find url_bar, re-click, re-SET_TEXT
        const freshBar = afterSetNodes.find(
            (n: any) =>
                n.viewId === `${CHROME_PACKAGE}:id/url_bar` &&
                n.className === "android.widget.EditText" &&
                n.packageName === CHROME_PACKAGE
        );
        if (freshBar) {
            console.log("[Download] Retrying SET_TEXT...");
            await freshBar.randomClick();
            await sleep(1000);
            try {
                await agent.actions.nodeAction(freshBar, agent.constants.ACTION_SET_TEXT, { text: videoUrl });
                console.log("[Download] ✅ Retry SET_TEXT succeeded");
                await sleep(1500);
            } catch (e2) {
                console.error("[Download] ❌ Retry SET_TEXT failed:", e2);
                return false;
            }
            // Re-verify
            const { allNodes: retryNodes } = await dumpScreenNodes("After retry SET_TEXT");
            if (await handleCrashDialogs(retryNodes)) {
                console.error("[Download] ❌ Chrome crashed after retry SET_TEXT!");
                return false;
            }
            const retryBar = retryNodes.find(
                (n: any) => n.viewId === `${CHROME_PACKAGE}:id/url_bar` && n.text
            );
            const retryText = retryBar ? (retryBar.text || "") : "";
            console.log(`[Download] After retry, URL bar shows: "${retryText.substring(0, 80)}"`);
            if (retryText === "Search Google or type URL" || retryText === "") {
                console.error("[Download] ❌ SET_TEXT failed twice — cannot input URL!");
                return false;
            }
        } else {
            console.error("[Download] ❌ url_bar not found for retry!");
            return false;
        }
    }

    // Use the latest nodes for Step C
    const afterTypeNodes = afterSetNodes;

    // ── STEP C: Navigate to the URL ──
    console.log("{---------- 🔵 STEP C: Navigate (Enter) ----------}");

    let navigated = false;

    // Check the url_bar text to see if our URL is there
    const activeUrlBar = afterTypeNodes.find(
        (n: any) =>
            n.viewId === `${CHROME_PACKAGE}:id/url_bar` &&
            n.className === "android.widget.EditText" &&
            n.packageName === CHROME_PACKAGE
    );

    if (activeUrlBar) {
        const barText = activeUrlBar.text || "";
        console.log(`[Download] URL bar text: "${barText.substring(0, 70)}"`);

        // Strategy 1: Press Enter via accessibility action on url_bar
        const ACTION_ENTER = 16908372;
        if (activeUrlBar.actions && activeUrlBar.actions.includes(ACTION_ENTER)) {
            try {
                await agent.actions.nodeAction(activeUrlBar, ACTION_ENTER, {});
                console.log("[Download] ✅ ENTER action triggered on url_bar");
                navigated = true;
            } catch (e) {
                console.log("[Download] ENTER failed:", e);
            }
        }
    }

    // Strategy 2: Tap matching omnibox suggestion
    if (!navigated) {
        const suggestion = afterTypeNodes.find(
            (n: any) =>
                n.viewId === `${CHROME_PACKAGE}:id/line_1` &&
                n.className === "android.widget.TextView" &&
                n.boundsInScreen
        );
        if (suggestion) {
            const cx = Math.floor((suggestion.boundsInScreen.left + suggestion.boundsInScreen.right) / 2);
            const cy = Math.floor((suggestion.boundsInScreen.top + suggestion.boundsInScreen.bottom) / 2);
            console.log(`[Download] Tapping suggestion at (${cx}, ${cy}): "${(suggestion.text || "").substring(0, 50)}"`);
            await agent.actions.tap(cx, cy);
            navigated = true;
        }
    }

    // Strategy 3: goBack to submit (closes keyboard, submits URL)
    if (!navigated) {
        console.log("[Download] Using goBack() to navigate...");
        await agent.actions.goBack();
        navigated = true;
    }

    // Wait for video page to load
    console.log("[Download] Waiting 8s for video page to load...");
    await sleep(8000);

    // ── STEP D: Wait for video player page ──
    console.log("{---------- 🔵 STEP D: Verify video page ----------}");

    let videoNodes: any[] = [];
    let videoPageReady = false;

    for (let check = 1; check <= 5; check++) {
        const { allNodes: pageNodes } = await dumpScreenNodes(`Video check #${check}`);

        if (await handleCrashDialogs(pageNodes)) {
            console.error("[Download] ❌ Chrome crashed waiting for video page!");
            return false;
        }

        if (isVideoPlayerPage(pageNodes)) {
            console.log("[Download] ✅ Video player page detected!");
            videoNodes = pageNodes;
            videoPageReady = true;
            break;
        }

        if (check < 5) {
            console.log(`[Download] Not yet (${check}/5), waiting 5s...`);
            await sleep(5000);
        }
    }

    if (!videoPageReady) {
        console.error("[Download] ❌ Video page did not load after 33s!");
        return false;
    }

    // ── STEP E: Tap video to reveal controls, then tap 3-dots ──
    // From media_control.json: text="show more media controls", className="android.widget.Button"
    console.log("{---------- 🔵 STEP E: Tap 3-dot media controls ----------}");

    let mediaButton = videoNodes.find(
        (n: any) =>
            n.text && n.text.includes("show more media controls") &&
            n.clickable && n.packageName === CHROME_PACKAGE
    );

    if (!mediaButton) {
        // Controls might be hidden — tap video center to reveal
        console.log("[Download] Controls hidden, tapping video center...");
        const webView = videoNodes.find(
            (n: any) => n.className === "android.webkit.WebView" && n.packageName === CHROME_PACKAGE
        );
        if (webView && webView.boundsInScreen) {
            const cx = Math.floor((webView.boundsInScreen.left + webView.boundsInScreen.right) / 2);
            const cy = Math.floor((webView.boundsInScreen.top + webView.boundsInScreen.bottom) / 2);
            await agent.actions.tap(cx, cy);
        } else {
            await agent.actions.tap(540, 1200);
        }
        await sleep(2000);

        const { allNodes: revealedNodes } = await dumpScreenNodes("After revealing controls");
        videoNodes = revealedNodes;

        mediaButton = videoNodes.find(
            (n: any) =>
                n.text && n.text.includes("show more media controls") &&
                n.clickable && n.packageName === CHROME_PACKAGE
        );
    }

    // Second attempt
    if (!mediaButton) {
        console.log("[Download] Tapping video again...");
        await agent.actions.tap(540, 1200);
        await sleep(2000);
        const { allNodes: retryNodes } = await dumpScreenNodes("After second tap");
        videoNodes = retryNodes;
        mediaButton = videoNodes.find(
            (n: any) =>
                n.text && n.text.includes("show more media controls") &&
                n.clickable && n.packageName === CHROME_PACKAGE
        );
    }

    if (!mediaButton) {
        console.error("[Download] ❌ 'show more media controls' button NOT found!");
        return false;
    }

    console.log(`[Download] ✅ Found 3-dot: text="${mediaButton.text}"`);
    await mediaButton.randomClick();
    await sleep(2000);

    // ── STEP F: Tap "download media" ──
    // From download_button.json: description="download media", className="android.view.MenuItem"
    console.log("{---------- 🔵 STEP F: Tap download media ----------}");

    const { allNodes: menuNodes } = await dumpScreenNodes("After 3-dot menu");

    // Primary: exact description match
    let downloadBtn = menuNodes.find(
        (n: any) =>
            n.description && n.description.toLowerCase() === "download media" && n.clickable
    );

    // Fallback: description contains "download"
    if (!downloadBtn) {
        downloadBtn = menuNodes.find(
            (n: any) =>
                n.description && n.description.toLowerCase().includes("download") &&
                n.clickable && n.className === "android.view.MenuItem"
        );
    }

    // Last fallback: text contains "download"
    if (!downloadBtn) {
        downloadBtn = menuNodes.find(
            (n: any) =>
                n.text && n.text.toLowerCase().includes("download") && n.clickable
        );
    }

    if (!downloadBtn) {
        console.error("[Download] ❌ 'download media' button NOT found in menu!");
        const items = menuNodes.filter((n: any) => n.clickable);
        for (const item of items.slice(0, 10)) {
            console.log(`  text="${item.text || ""}" desc="${item.description || ""}" class=${item.className}`);
        }
        return false;
    }

    console.log(`[Download] ✅ Found download: desc="${downloadBtn.description || downloadBtn.text}"`);
    await downloadBtn.randomClick();

    // Wait for download
    console.log("[Download] Waiting 15s for download to complete...");
    await sleep(15000);

    console.log("\n{----------✅ debug download------}");
    return true;
}

// ════════════════════════════════════════════════════
// STAGE DEFINITION
// ════════════════════════════════════════════════════

const DownloadStageScreen = {
    Downloading: "Downloading",
} as const;

const DownloadHandles = {
    Downloading: {
        detectScreen: async (_screenContent: any) => {
            return true;
        },
        handleScreen: async () => {
            console.log("[Download] handleScreen called — download is handled by defaultHandle");
            return true;
        },
    },
} as const satisfies ScreenHandles<keyof typeof DownloadStageScreen>;

const DownloadStage = {
    name: "Download",
    maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
    screens: DownloadStageScreen,
    screenHandles: DownloadHandles,

    async defaultHandle() {
        console.log("========================================");
        console.log("[Download] DOWNLOAD STAGE STARTED");
        console.log("========================================");

        // Read video URL from job variables
        const videoUrl = getJobVar(JOB_VARS.VIDEO_URL);
        if (!videoUrl) {
            console.error("[Download] ❌ No video URL provided!");
            await fail("NO_VIDEO_URL: video_url job variable is missing");
            return;
        }
        console.log(`[Download] Video URL: ${videoUrl}`);

        addData({
            stage: "Download",
            video_url: videoUrl,
            download_started_at: new Date().toISOString(),
        });
        await submitProgress("downloading_video");

        let downloadSucceeded = false;

        // ─── RETRY LOOP ───
        for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
            console.log(`\n[Download] ══════════ ATTEMPT ${attempt}/${MAX_DOWNLOAD_ATTEMPTS} ══════════`);

            try {
                // ── 1. Launch Chrome fresh ──
                console.log("\n{---------- 🔵 STEP 1: Launch Chrome ----------}");

                // Dismiss any existing crash dialogs
                const { allNodes: preNodes } = await dumpScreenNodes("Pre-launch");
                await handleCrashDialogs(preNodes);

                // Go home → launch Chrome for clean state
                await agent.actions.goHome();
                await sleep(1000);
                await agent.actions.launchApp(CHROME_PACKAGE, true);
                await sleep(5000);

                let { allNodes } = await dumpScreenNodes("After Chrome launch");

                // Handle crash on launch
                if (await handleCrashDialogs(allNodes)) {
                    console.log("[Download] Crash dismissed, relaunching...");
                    await agent.actions.goHome();
                    await sleep(1000);
                    await agent.actions.launchApp(CHROME_PACKAGE, true);
                    await sleep(5000);
                    const r = await dumpScreenNodes("After relaunch");
                    allNodes = r.allNodes;
                    if (await handleCrashDialogs(allNodes)) {
                        console.error("[Download] ❌ Chrome keeps crashing!");
                        continue;
                    }
                }

                // Dismiss welcome/other dialogs
                for (let d = 0; d < 3; d++) {
                    if (!(await dismissChromeDialogs(allNodes))) break;
                    const r = await dumpScreenNodes("After dialog dismiss");
                    allNodes = r.allNodes;
                }

                // Verify Chrome is in foreground
                if (!isChromeInForeground(allNodes)) {
                    console.error("[Download] ❌ Chrome not in foreground!");
                    continue;
                }

                console.log("[Download] ✅ Chrome launched.");

                // ── 2. Check which screen we're on ──
                if (isHomeScreen(allNodes)) {
                    // ── PATH 1.1: Already on home screen ──
                    console.log("[Download] 📍 On HOME screen → Path 1.1");
                    const success = await downloadFromHomeScreen(allNodes, videoUrl);
                    if (success) {
                        downloadSucceeded = true;
                        break;
                    }
                } else {
                    // ── PATH 1.2: Not home screen → open 3-dot menu → New tab ──
                    console.log("[Download] 📍 NOT on home screen → Path 1.2 (menu → new tab)");

                    // Find Chrome's menu button (3-dot in toolbar)
                    // From select_3_dot.json: viewId="com.android.chrome:id/menu_button",
                    //   description="Customize and control Google Chrome"
                    const menuButton = allNodes.find(
                        (n: any) =>
                            n.packageName === CHROME_PACKAGE &&
                            n.clickable &&
                            (n.viewId === `${CHROME_PACKAGE}:id/menu_button` ||
                                (n.description && n.description.includes("Customize and control Google Chrome")))
                    );

                    if (!menuButton) {
                        console.error("[Download] ❌ Chrome menu button not found!");
                        console.log("[Download] Trying fallback: going home and relaunching...");
                        await agent.actions.goHome();
                        await sleep(1000);
                        await agent.actions.launchApp(CHROME_PACKAGE, true);
                        await sleep(5000);
                        const r = await dumpScreenNodes("After fallback relaunch");
                        allNodes = r.allNodes;

                        if (isHomeScreen(allNodes)) {
                            const success = await downloadFromHomeScreen(allNodes, videoUrl);
                            if (success) {
                                downloadSucceeded = true;
                                break;
                            }
                        }
                        continue;
                    }

                    console.log("[Download] Tapping Chrome menu button...");
                    await menuButton.randomClick();
                    await sleep(2000);

                    // Find "New tab" in the menu
                    // From new_tab_select.json: viewId="com.android.chrome:id/new_tab_menu_id",
                    //   child text="New tab"
                    const { allNodes: menuNodes } = await dumpScreenNodes("Chrome menu");

                    let newTabItem = menuNodes.find(
                        (n: any) =>
                            n.viewId === `${CHROME_PACKAGE}:id/new_tab_menu_id` &&
                            n.clickable && n.packageName === CHROME_PACKAGE
                    );

                    // Fallback: find by text "New tab"
                    if (!newTabItem) {
                        const newTabText = menuNodes.find(
                            (n: any) =>
                                n.text === "New tab" && n.packageName === CHROME_PACKAGE
                        );
                        if (newTabText && newTabText.boundsInScreen) {
                            // Tap the text node's coordinates
                            const cx = Math.floor((newTabText.boundsInScreen.left + newTabText.boundsInScreen.right) / 2);
                            const cy = Math.floor((newTabText.boundsInScreen.top + newTabText.boundsInScreen.bottom) / 2);
                            console.log(`[Download] Tapping "New tab" text at (${cx}, ${cy})...`);
                            await agent.actions.tap(cx, cy);
                            await sleep(3000);

                            const { allNodes: postNewTabNodes } = await dumpScreenNodes("After new tab");
                            if (isHomeScreen(postNewTabNodes)) {
                                console.log("[Download] ✅ On home screen after 'New tab'.");
                                const success = await downloadFromHomeScreen(postNewTabNodes, videoUrl);
                                if (success) {
                                    downloadSucceeded = true;
                                    break;
                                }
                            }
                            continue;
                        }

                        console.error("[Download] ❌ 'New tab' not found in menu!");
                        continue;
                    }

                    console.log("[Download] Tapping 'New tab'...");
                    await newTabItem.randomClick();
                    await sleep(3000);

                    // Now we should be on the home screen
                    const { allNodes: newTabNodes } = await dumpScreenNodes("After new tab");

                    if (await handleCrashDialogs(newTabNodes)) {
                        console.error("[Download] Chrome crashed after new tab!");
                        continue;
                    }

                    if (isHomeScreen(newTabNodes)) {
                        console.log("[Download] ✅ On home screen after 'New tab'.");
                        const success = await downloadFromHomeScreen(newTabNodes, videoUrl);
                        if (success) {
                            downloadSucceeded = true;
                            break;
                        }
                    } else {
                        console.error("[Download] ❌ Not on home screen after 'New tab'!");
                    }
                }

            } catch (e) {
                console.error(`[Download] ❌ Attempt ${attempt} error:`, e);
            }
        }

        // ─── Result ───
        if (!downloadSucceeded) {
            console.error("========================================");
            console.error("[Download] ❌ DOWNLOAD FAILED after all attempts!");
            console.error("========================================");
            await fail("DOWNLOAD_FAILED: Video download failed after 3 attempts.");
            return;
        }

        console.log(`[Download] ✅ DOWNLOAD SUCCEEDED!`);

        addData({
            download_completed_at: new Date().toISOString(),
            download_method: "chrome_media_download",
        });
        await submitProgress("download_complete");

        // Launch YouTube for upload stage
        console.log("[Download] Launching YouTube...");
        await agent.actions.goHome();
        await sleep(1000);
        await agent.actions.launchApp(YOUTUBE_PACKAGE, true);
        await sleep(5000);

        console.log("========================================");
        console.log("[Download] DOWNLOAD STAGE COMPLETE → Upload");
        console.log("========================================");
        await setStage(Stage.Upload);
    },
} as const satisfies Stage<typeof DownloadStageScreen>;

export default DownloadStage;
