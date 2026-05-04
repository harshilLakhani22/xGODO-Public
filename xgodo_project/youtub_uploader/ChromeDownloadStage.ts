/**
 * Chrome Download Stage
 *
 * Robust Chrome video download flow with:
 * - Intent launch (am start) as fastest path — bypasses omnibox entirely
 * - Idempotency guard (skip re-typing if URL already submitted)
 * - Text verification after writeText
 * - Omnibox suggestion tap as preferred submit method (mimics human interaction)
 * - IME editorAction('go') as secondary fallback
 * - 5-level Enter fallbacks: keyEvent → nodeAction → on-screen button → shell keyevent → keyboard click
 * - Navigation polling with webview, media controls, and URL change detection
 */

import { APP_PACKAGE_NAME, DEFAULT_MAX_STEPS_PER_STAGE } from "./config";
import { success, getData, addData, clearData } from "./data";
import { getAllNodesFlat } from "./util";
import { type Stage, type ScreenHandles, setStage, Stage as Stages } from "./Stage";

/** Navigation polling constants */
const DEFAULT_POLL_MS = 30_000;
const POLL_INTERVAL = 1_000;

/**
 * Poll for navigation evidence: webview nodes, media controls, or URL change.
 * Reused by both the Intent path and the omnibox-type path.
 */
async function pollForNavigation(videoUrl: string, timeoutMs: number): Promise<boolean> {
    let elapsed = 0;
    while (elapsed < timeoutMs) {
        await sleep(POLL_INTERVAL);
        elapsed += POLL_INTERVAL;
        try {
            const screens = await agent.actions.allScreensContent();
            const flat = screens.flatMap((s: any) => getAllNodesFlat(s));

            // Signal 1: Webview node (strongest indicator of page load)
            const webview = flat.find((n: any) =>
                n.className && typeof n.className === "string" &&
                n.className.toLowerCase().includes("webview")
            );
            if (webview) {
                console.log("Detected webview node — likely navigated.");
                return true;
            }

            // Signal 2: Media / video controls
            const mediaControl = flat.find((n: any) =>
                (n.description && typeof n.description === "string" && n.description.toLowerCase().includes("media")) ||
                (n.text && typeof n.text === "string" && n.text.toLowerCase().includes("play")) ||
                (n.resourceId && typeof n.resourceId === "string" && /media|video|play/.test(n.resourceId))
            );
            if (mediaControl) {
                console.log("Detected media control node:", mediaControl.text || mediaControl.description || mediaControl.resourceId);
                return true;
            }

            // Signal 3: URL bar changed (navigated to a real page)
            const urlNodeNow = flat.find((n: any) =>
                n.viewId === "com.android.chrome:id/url_bar" ||
                (n.resourceId && n.resourceId.endsWith("url_bar"))
            );
            if (urlNodeNow && urlNodeNow.text && typeof urlNodeNow.text === "string") {
                const t = urlNodeNow.text.toLowerCase();
                if (t.includes("http") && t !== videoUrl.toLowerCase() && !t.includes("about:blank") && !t.includes("new tab")) {
                    console.log("URL bar now contains:", urlNodeNow.text.slice(0, 140));
                    return true;
                }
                if (t.includes(videoUrl.slice(0, 20).toLowerCase())) {
                    console.log("URL bar still contains the requested URL (navigation may be loading).");
                }
            }
        } catch (e) {
            console.warn("Polling iteration failed (will retry):", e);
        }
    }
    return false;
}

function normLabel(value: unknown): string {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isChromeMenuItem(node: any): boolean {
    return !!node &&
        node.packageName === APP_PACKAGE_NAME &&
        node.className === "android.view.MenuItem" &&
        !!node.boundsInScreen;
}

function isPictureInPictureItem(node: any): boolean {
    const d = normLabel(node?.description);
    const t = normLabel(node?.text);
    return d.includes("picture-in-picture") || d.includes("picture in picture") ||
        t.includes("picture-in-picture") || t.includes("picture in picture");
}

function isPlaybackSpeedItem(node: any): boolean {
    const d = normLabel(node?.description);
    const t = normLabel(node?.text);
    return d.includes("playback speed") || t.includes("playback speed");
}

function isDownloadItem(node: any): boolean {
    const d = normLabel(node?.description);
    const t = normLabel(node?.text);
    return (d.includes("download") || t.includes("download")) &&
        !isPictureInPictureItem(node) &&
        !isPlaybackSpeedItem(node);
}

function sortMenuItems(a: any, b: any): number {
    const rowA = typeof a?.collectionItemInfo?.rowIndex === "number" ? a.collectionItemInfo.rowIndex : Number.MAX_SAFE_INTEGER;
    const rowB = typeof b?.collectionItemInfo?.rowIndex === "number" ? b.collectionItemInfo.rowIndex : Number.MAX_SAFE_INTEGER;
    if (rowA !== rowB) return rowA - rowB;

    const topA = typeof a?.boundsInScreen?.top === "number" ? a.boundsInScreen.top : Number.MAX_SAFE_INTEGER;
    const topB = typeof b?.boundsInScreen?.top === "number" ? b.boundsInScreen.top : Number.MAX_SAFE_INTEGER;
    return topA - topB;
}

function pickDownloadMenuNode(flatNodes: any[]): any | null {
    const menuItems = flatNodes.filter(isChromeMenuItem).sort(sortMenuItems);
    if (!menuItems.length) return null;

    const exactDownload = menuItems.find(isDownloadItem);
    if (exactDownload) return exactDownload;

    const row0 = menuItems.find((n: any) => n?.collectionItemInfo?.rowIndex === 0 && !isPictureInPictureItem(n) && !isPlaybackSpeedItem(n));
    if (row0) return row0;

    // Last resort: first menu row if we have no labels (some Chrome builds hide text fields).
    return menuItems.find((n: any) => !isPictureInPictureItem(n) && !isPlaybackSpeedItem(n)) || null;
}

async function getFreshFlatNodesWithRetry(screenContent: AndroidNode, tries = 5, delayMs = 300): Promise<any[]> {
    for (let i = 0; i < tries; i++) {
        try {
            const allScreens = await agent.actions.allScreensContent();
            const flat = allScreens.flatMap((s: any) => getAllNodesFlat(s));
            if (flat.length) return flat;
        } catch (e) {
            console.warn(`Fresh screen fetch failed (${i + 1}/${tries}):`, e);
        }
        await sleep(delayMs);
    }
    return [screenContent, ...getAllNodesFlat(screenContent)];
}

const ChromeDownloadStageScreen = {
    HomeSearchBox: "HomeSearchBox",
    ActiveUrlBar: "ActiveUrlBar",
    PlayingVideo: "PlayingVideo",
    VideoMenu: "VideoMenu",
    DuplicateDownloadPopup: "DuplicateDownloadPopup",
} as const;

const ChromeDownloadHandles = {
    HomeSearchBox: {
        detectScreen: async (screenContent: AndroidNode) => {
            return !!screenContent.find((node: any) => node.packageName === APP_PACKAGE_NAME && node.viewId === "com.android.chrome:id/search_box_text");
        },
        handleScreen: async (screenContent: AndroidNode) => {
            const searchBoxNode = screenContent.find((node: any) => node.packageName === APP_PACKAGE_NAME && node.viewId === "com.android.chrome:id/search_box_text");

            if (searchBoxNode) {
                searchBoxNode.randomClick();
                await sleep(1_000);
                return true;
            }
            return false;
        },
    },

    ActiveUrlBar: {
        detectScreen: async (screenContent: AndroidNode) => {
            // Only match when the omnibox is actively focused/editable (typing mode).
            // Once the URL is submitted, we should stop detecting this screen,
            // because Chrome keeps the url_bar editable even while video is playing!
            const jobVariables = agent.arguments?.jobVariables || {};
            const videoUrl = jobVariables.video_url || jobVariables.videoUrl;
            const current = getData();

            if (videoUrl && current.phase1_url_submitted === videoUrl) {
                return false;
            }

            return !!screenContent.find((node: any) =>
                node.packageName === APP_PACKAGE_NAME &&
                (node.viewId === "com.android.chrome:id/url_bar" ||
                    (node.resourceId && node.resourceId.endsWith("url_bar"))) &&
                (node.isFocused || node.isEditable)
            );
        },

        handleScreen: async (screenContent: AndroidNode) => {
            const jobVariables = agent.arguments?.jobVariables || {};
            const videoUrl = jobVariables.video_url || jobVariables.videoUrl;

            if (!videoUrl) {
                console.error("Missing job variable: video_url");
                return false;
            }

            // ── Idempotency guard ──────────────────────────────────────
            const current = getData();
            if (current.phase1_url_submitted === videoUrl) {
                console.log("URL already submitted for this job — skipping re-type.");
                await sleep(1500);
                return true;
            }

            // ── Step 0: Preferred — Intent launch (am start) ───────────
            // Bypasses omnibox and IME entirely; fastest and most reliable path
            try {
                if (agent.utils && agent.utils.shell) {
                    console.log("Attempting Intent launch (am start) to open URL directly...");
                    const intentCmd = `am start -a android.intent.action.VIEW -d "${videoUrl}" com.android.chrome`;
                    const shellRes = await agent.utils.shell(intentCmd);
                    console.log("Intent shell result:", shellRes?.stdout || shellRes);
                    await sleep(700);

                    if (await pollForNavigation(videoUrl, DEFAULT_POLL_MS)) {
                        addData({ phase1_url_submitted: videoUrl });
                        console.log("Intent launch succeeded — navigation detected.");
                        return true;
                    }
                    console.warn("Intent launched but navigation not detected — falling through to omnibox path.");
                }
            } catch (e) {
                console.warn("Intent launch attempt failed:", e);
            }

            // ── Step 1: Find and click URL bar ─────────────────────────
            const urlBarNode = screenContent.find((node: any) =>
                node.packageName === APP_PACKAGE_NAME &&
                (node.viewId === "com.android.chrome:id/url_bar" ||
                    (node.resourceId && node.resourceId.endsWith("url_bar")))
            );

            if (!urlBarNode) {
                console.warn("URL bar node not found in current screenContent.");
                return false;
            }

            // Debug metadata for diagnosing device-specific issues
            console.log("urlBarNode.text:", urlBarNode.text?.slice?.(0, 200));
            console.log("urlBarNode.actions:", urlBarNode.actions);
            console.log("urlBarNode.actionLabels:", urlBarNode.actionLabels);
            console.log("urlBarNode.className:", urlBarNode.className);

            try {
                urlBarNode.randomClick?.();
            } catch (e) {
                try { await agent.actions.nodeAction(urlBarNode, agent.constants.ACTION_CLICK); } catch (e2) { /* ignore */ }
            }
            await sleep(500);

            // ── Step 2: Write URL and verify ────────────────────────────
            try {
                await agent.actions.writeText(videoUrl);
            } catch (e) {
                console.error("writeText failed:", e);
                return false;
            }
            await sleep(700);

            // Read back and verify
            let allNodes: any[] = [];
            try {
                allNodes = (await agent.actions.allScreensContent()).flatMap((s: any) => getAllNodesFlat(s));
            } catch (e) {
                console.warn("Could not read screen content for verification:", e);
            }
            const urlNodeAfter = allNodes.find((n: any) =>
                n.viewId === "com.android.chrome:id/url_bar" ||
                (n.resourceId && n.resourceId.endsWith("url_bar"))
            );
            const typedText = urlNodeAfter?.text || urlNodeAfter?.contentDescription || "";
            console.log("Typed text preview:", typeof typedText === "string" ? typedText.slice(0, 200) : typedText);

            if (!typedText || (typeof typedText === "string" && !typedText.includes(videoUrl.slice(0, 20)))) {
                console.warn("Typed text mismatch; retrying write once...");
                try {
                    await agent.actions.writeText(videoUrl);
                } catch (e) {
                    console.error("writeText retry failed:", e);
                }
                await sleep(600);
            }

            // ── Step 3: Preferred — Tap first matching omnibox suggestion ──
            // This mimics human interaction and is the most reliable submit method.
            let submitSucceeded = false;

            try {
                console.log("Polling for omnibox suggestion matching URL...");
                const SUGGESTION_POLL_TIMEOUT = 2000;
                const SUGGESTION_POLL_INTERVAL = 200;
                let suggestionElapsed = 0;

                while (suggestionElapsed < SUGGESTION_POLL_TIMEOUT && !submitSucceeded) {
                    try {
                        const screens = await agent.actions.allScreensContent();
                        const flatNodes = screens.flatMap((s: any) => getAllNodesFlat(s));

                        // Find the omnibox suggestion dropdown container
                        const dropdown = flatNodes.find((n: any) =>
                            n.viewId && typeof n.viewId === "string" &&
                            n.viewId.includes("omnibox_suggestions_dropdown")
                        );

                        if (dropdown) {
                            // Walk dropdown children: each suggestion is a clickable ViewGroup
                            // with a child TextView (line_1) containing the suggestion text
                            const suggestionRows = flatNodes.filter((n: any) =>
                                n.clickable &&
                                n.className === "android.view.ViewGroup" &&
                                n.collectionItemInfo &&
                                n.packageName === APP_PACKAGE_NAME
                            );

                            // Extract the domain and first 20 chars for matching
                            const urlLower = videoUrl.toLowerCase();
                            const urlPrefix = urlLower.slice(0, 20);
                            let domainMatch = "";
                            try {
                                const urlObj = new URL(videoUrl);
                                domainMatch = urlObj.hostname.toLowerCase();
                            } catch { /* not a valid URL — skip domain matching */ }

                            for (const row of suggestionRows) {
                                // Find the line_1 text node inside this suggestion row
                                const textNode = flatNodes.find((n: any) =>
                                    n.viewId && typeof n.viewId === "string" &&
                                    n.viewId.endsWith("line_1") &&
                                    n.text && typeof n.text === "string" &&
                                    n.boundsInScreen &&
                                    row.boundsInScreen &&
                                    n.boundsInScreen.top >= row.boundsInScreen.top &&
                                    n.boundsInScreen.bottom <= row.boundsInScreen.bottom
                                );

                                if (!textNode) continue;

                                const suggText = textNode.text.toLowerCase();

                                // Match: suggestion contains URL prefix, domain, or full URL
                                if (
                                    suggText.includes(urlPrefix) ||
                                    (domainMatch && suggText.includes(domainMatch)) ||
                                    suggText.includes("http") && suggText.includes(urlLower.slice(8, 28))
                                ) {
                                    console.log("Found matching suggestion — tapping it:", textNode.text.slice(0, 120));
                                    try {
                                        await agent.actions.nodeAction(row, agent.constants.ACTION_CLICK);
                                        submitSucceeded = true;
                                        console.log("Suggestion tap succeeded.");
                                    } catch (tapErr) {
                                        // Try randomClick on the suggestion row bounds as fallback
                                        try {
                                            const b = row.boundsInScreen;
                                            await agent.utils.randomClick(b.left, b.top, b.right, b.bottom);
                                            submitSucceeded = true;
                                            console.log("Suggestion tap via randomClick succeeded.");
                                        } catch (clickErr) {
                                            console.warn("Suggestion tap failed:", clickErr);
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                    } catch (pollErr) {
                        console.warn("Suggestion poll iteration error (will retry):", pollErr);
                    }

                    if (!submitSucceeded) {
                        await sleep(SUGGESTION_POLL_INTERVAL);
                        suggestionElapsed += SUGGESTION_POLL_INTERVAL;
                    }
                }

                if (!submitSucceeded) {
                    console.log("No matching suggestion found — falling through to Enter fallbacks.");
                }
            } catch (e) {
                console.warn("Suggestion-tap logic failed:", e);
            }

            // ── Step 4: IME editorAction('go') ─────────────────────────
            // Chrome listens for IME actions; this is more reliable than raw KEYCODE_ENTER.
            if (!submitSucceeded) {
                try {
                    if (agent.actions && typeof agent.actions.editorAction === "function") {
                        console.log("Attempting IME editorAction('go')...");
                        await agent.actions.editorAction("go");
                        submitSucceeded = true;
                        console.log("editorAction('go') succeeded.");
                    }
                } catch (e) {
                    console.warn("editorAction('go') failed:", e);
                }
            }

            // ── Step 5: Enter key fallbacks (5 levels) ─────────────────

            // 5a: agent keyEvent (KEYCODE_ENTER == 66)
            if (!submitSucceeded) {
                try {
                    if (agent.actions && typeof agent.actions.keyEvent === "function") {
                        console.log("Attempting agent.actions.keyEvent(66) (KEYCODE_ENTER)");
                        await agent.actions.keyEvent(66);
                        submitSucceeded = true;
                    } else if (agent.actions && typeof agent.actions.sendKeyEvent === "function") {
                        console.log("Attempting agent.actions.sendKeyEvent('KEYCODE_ENTER')");
                        await agent.actions.sendKeyEvent("KEYCODE_ENTER");
                        submitSucceeded = true;
                    }
                } catch (e) {
                    console.warn("agent keyEvent attempts failed:", e);
                }
            }

            // 5b: nodeAction on url bar (prefer labeled Go/Search/Enter action)
            if (!submitSucceeded && urlBarNode.actions && urlBarNode.actions.length) {
                try {
                    let actionId: any = undefined;
                    if (urlBarNode.actionLabels && urlBarNode.actionLabels.length) {
                        const labelMatch = urlBarNode.actionLabels.find((a: any) =>
                            a.label && ["go", "search", "enter", "done"].includes(a.label.toLowerCase())
                        );
                        if (labelMatch) actionId = labelMatch.id;
                    }
                    if (!actionId) actionId = urlBarNode.actions.includes(16908372) ? 16908372 : urlBarNode.actions[0];

                    console.log("Attempting nodeAction on url bar actionId:", actionId);
                    await agent.actions.nodeAction(urlBarNode, actionId);
                    submitSucceeded = true;
                    console.log("nodeAction Enter succeeded.");
                } catch (e) {
                    console.warn("nodeAction on url bar failed, will try next fallback:", e);
                }
            }

            // 5c: on-screen Go/Search/Enter/Done button
            if (!submitSucceeded) {
                try {
                    allNodes = (await agent.actions.allScreensContent()).flatMap((s: any) => getAllNodesFlat(s));
                } catch (e) {
                    console.warn("Could not read screen for fallback 5c:", e);
                    allNodes = [];
                }
                const goBtn = allNodes.find((n: any) =>
                    n.text && ["go", "search", "enter", "done"].includes(n.text.toString().toLowerCase())
                );
                if (goBtn) {
                    try {
                        console.log("Clicking found on-screen button:", goBtn.text || goBtn.viewId);
                        await agent.actions.nodeAction(goBtn, agent.constants.ACTION_CLICK);
                        submitSucceeded = true;
                    } catch (e) {
                        console.warn("Clicking on-screen go button failed:", e);
                    }
                }
            }

            // 5d: shell input keyevent 66
            if (!submitSucceeded) {
                try {
                    if (agent.utils && agent.utils.shell) {
                        console.log("Fallback: shell input keyevent 66");
                        await agent.utils.shell("input keyevent 66");
                        submitSucceeded = true;
                    }
                } catch (e) {
                    console.warn("Shell input keyevent failed:", e);
                }
            }

            // 5e: keyboard-area click (device-specific coordinates)
            if (!submitSucceeded) {
                try {
                    console.log("Final fallback: clicking approximate keyboard enter area.");
                    await agent.utils.randomClick(900, 1700, 1079, 1999);
                    submitSucceeded = true;
                } catch (e) {
                    console.warn("Keyboard-area click failed:", e);
                }
            }

            if (!submitSucceeded) {
                console.error("All submit attempts failed; aborting this attempt.");
                return false;
            }

            // ── Step 6: Mark URL as submitted (idempotency) ────────────
            addData({ phase1_url_submitted: videoUrl });

            // ── Step 7: Poll for navigation evidence ───────────────────
            const navOk = await pollForNavigation(videoUrl, DEFAULT_POLL_MS);
            if (!navOk) {
                console.warn("Navigation not detected within timeout — clearing submitted flag for retry.");
                clearData("phase1_url_submitted");
                return false;
            }

            console.log("Navigation detected; handing control over to next stage.");
            return true;
        },
    },

    PlayingVideo: {
        detectScreen: async (screenContent: AndroidNode) => {
            // ── PRIORITY CHECK: If the download menu popup is visible,
            // yield to VideoMenu (which is checked after us in iteration order).
            // Without this guard, PlayingVideo always wins because the
            // "show more media controls" button remains in the tree even
            // when the popup is open, causing an infinite tap loop.
            const allFlat = getAllNodesFlat(screenContent);
            const menuPopupOpen = allFlat.some((node: any) =>
                node.packageName === APP_PACKAGE_NAME &&
                ((node.className === "android.view.MenuItem" &&
                    node.description && node.description === "download media") ||
                    (node.description && node.description === "download media") ||
                    (node.text && node.text === "download media"))
            );
            if (menuPopupOpen) {
                return false; // Let VideoMenu handle this screen
            }

            // Check both "text" and "description" — Chrome versions vary on which property holds this label
            const hasControls = !!screenContent.find((node: any) =>
                node.packageName === APP_PACKAGE_NAME &&
                ((node.description && node.description === "show more media controls") ||
                    (node.text && node.text === "show more media controls"))
            );
            if (hasControls) return true;

            // If controls are mostly hidden but we've submitted the URL and see the webview, we are on the video player
            const current = getData();
            const jobVariables = agent.arguments?.jobVariables || {};
            const videoUrl = jobVariables.video_url || jobVariables.videoUrl;
            if (videoUrl && current.phase1_url_submitted === videoUrl) {
                return !!screenContent.find((node: any) => node.className === "android.webkit.WebView");
            }
            return false;
        },
        handleScreen: async (screenContent: AndroidNode) => {
            const jobVariables = agent.arguments?.jobVariables || {};
            const videoUrl = jobVariables.video_url || jobVariables.videoUrl;

            // ── Handle any permission dialogs first ──────────────────
            try {
                const allScreens = await agent.actions.allScreensContent();
                const flatNodes = allScreens.flatMap((s: any) => getAllNodesFlat(s));
                const allowBtn = flatNodes.find((n: any) =>
                    n.clickable && n.text && typeof n.text === "string" &&
                    ["allow", "allow only while using the app", "while using the app"].includes(n.text.toLowerCase())
                );
                if (allowBtn) {
                    console.log("Permission dialog detected — tapping Allow:", allowBtn.text);
                    try { await agent.actions.nodeAction(allowBtn, agent.constants.ACTION_CLICK); } catch (e) { allowBtn.randomClick?.(); }
                    await sleep(1_000);
                }
            } catch (e) { console.warn("Permission check failed:", e); }

            // ── Preferred: shell curl download (bypasses Chrome player entirely) ──
            if (videoUrl && agent.utils?.shell) {
                try {
                    const filename = videoUrl.split('/').pop() || 'video.mp4';
                    const dest = `/sdcard/Download/${filename}`;
                    console.log(`Attempting shell curl download: ${videoUrl} → ${dest}`);
                    const curlRes = await agent.utils.shell(`curl -L -o "${dest}" "${videoUrl}"`);
                    console.log("curl result:", curlRes?.stdout || curlRes?.stderr || curlRes);
                    await sleep(2_000);

                    // Verify file exists and has size > 0
                    const check = await agent.utils.shell(`ls -la "${dest}"`);
                    const checkOut = check?.stdout || "";
                    console.log("File check:", checkOut.slice(0, 200));
                    if (checkOut.includes(filename)) {
                        console.log("Shell curl download succeeded!");
                        await setStage(Stages.YoutubeUpload);
                        return true;
                    }
                    console.warn("Shell curl download file not found — falling back to UI download.");
                } catch (e) {
                    console.warn("Shell curl download failed:", e);
                }
            }

            // ── Fallback: Tap "show more media controls" to open download menu ──
            const showMoreControlsNode = screenContent.find((node: any) =>
                node.packageName === APP_PACKAGE_NAME &&
                ((node.description && node.description === "show more media controls") ||
                    (node.text && node.text === "show more media controls"))
            );

            if (showMoreControlsNode) {
                console.log("Tapping 'show more media controls' to access download menu.");
                showMoreControlsNode.randomClick();
                await sleep(2_000);
                return true;
            } else {
                console.log("Media controls hidden — tapping center of screen to reveal them.");
                // Approximate center of webview tap to reveal the hidden media controls
                try {
                    await agent.utils.randomClick(400, 800, 600, 1200);
                } catch (e) { }
                await sleep(1_000);
                return true;
            }
        },
    },

    VideoMenu: {
        detectScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            return !!pickDownloadMenuNode(allFlat);
        },
        handleScreen: async (screenContent: AndroidNode) => {
            // Wait for popup animation to settle so bounds are stable.
            await sleep(1300);

            let flatNodes = await getFreshFlatNodesWithRetry(screenContent, 6, 250);

            // ── Handle any permission dialogs first ──────────────────
            try {
                const allowBtn = flatNodes.find((n: any) =>
                    n.clickable && n.text && typeof n.text === "string" &&
                    ["allow", "allow only while using the app", "while using the app"].includes(n.text.toLowerCase())
                );
                if (allowBtn) {
                    console.log("Permission dialog detected — tapping Allow:", allowBtn.text);
                    try { await agent.actions.nodeAction(allowBtn, agent.constants.ACTION_CLICK); } catch (e) { allowBtn.randomClick?.(); }
                    await sleep(1_000);
                }
            } catch (e) { console.warn("Permission check failed:", e); }

            // Re-read just before selecting target to avoid stale node refs.
            flatNodes = await getFreshFlatNodesWithRetry(screenContent, 4, 200);
            const targetNode = pickDownloadMenuNode(flatNodes);

            if (!targetNode) {
                console.warn("Could not find download menu item. Dumping all MenuItem nodes:");
                flatNodes
                    .filter((n: any) => n.className === "android.view.MenuItem")
                    .forEach((n: any, i: number) => {
                        console.log(`  MenuItem[${i}]: description="${n.description}", text="${n.text}", row=${n.collectionItemInfo?.rowIndex}, bounds=${JSON.stringify(n.boundsInScreen)}`);
                    });
                return false;
            }

            console.log("Clicking download menu item:", {
                description: targetNode.description,
                text: targetNode.text,
                row: targetNode.collectionItemInfo?.rowIndex,
                bounds: targetNode.boundsInScreen,
            });

            let clicked = false;
            const b = targetNode.boundsInScreen;
            if (b && agent.utils?.randomClick) {
                // Click upper-middle area of the selected row to avoid row boundary drift.
                const x = Math.round((b.left + b.right) / 2);
                const y = Math.round(b.top + ((b.bottom - b.top) * 0.35));
                try {
                    await agent.utils.randomClick(x - 2, y - 2, x + 2, y + 2);
                    clicked = true;
                } catch (e) {
                    console.warn("Coordinate click failed:", e);
                }
            }

            if (!clicked) {
                try {
                    await agent.actions.nodeAction(targetNode, agent.constants.ACTION_CLICK);
                    clicked = true;
                } catch (e) {
                    console.warn("ACTION_CLICK failed:", e);
                }
            }

            if (!clicked && targetNode.randomClick) {
                try {
                    targetNode.randomClick();
                    clicked = true;
                } catch (e) {
                    console.warn("Node randomClick failed:", e);
                }
            }

            if (!clicked) {
                console.error("All click attempts on download item failed.");
                return false;
            }

            // Poll for the "Download file again?" popup during the download wait.
            // The popup is a dialog window, so we MUST use allScreensContent() and
            // search each screen with its native findByIdOne/findTextOne methods
            // (which return real AndroidNode objects with performAction/randomClick).
            const DOWNLOAD_WAIT_MS = 15_000;
            const POLL_INTERVAL_MS = 1_000;
            let elapsed = 0;
            let popupHandled = false;

            while (elapsed < DOWNLOAD_WAIT_MS) {
                await sleep(POLL_INTERVAL_MS);
                elapsed += POLL_INTERVAL_MS;

                if (popupHandled) continue;

                try {
                    const allScreens = await agent.actions.allScreensContent();

                    for (const screen of allScreens) {
                        // Detect the popup: look for "Download file again?" or "Download again" text
                        const popupText = screen.findTextOne?.("Download file again?")
                            || screen.findTextOne?.("Download again");

                        if (!popupText) continue;

                        console.log("Detected 'Download file again?' popup during download wait.");

                        // Strategy 1: Find button by viewId (most reliable)
                        let btn = screen.findByIdOne?.("com.android.chrome:id/positive_button");

                        // Strategy 2: Find by text "Download again"
                        if (!btn) {
                            btn = screen.findTextOne?.("Download again");
                        }

                        if (!btn) {
                            console.warn("Popup found but 'Download again' button not located.");
                            break;
                        }

                        console.log("Found 'Download again' button. Attempting click...");

                        // Click strategy 1: performAction (preferred per xgodo docs)
                        let btnClicked = false;
                        try {
                            const result = await btn.performAction(agent.constants.ACTION_CLICK);
                            if (result?.actionPerformed) {
                                btnClicked = true;
                                console.log("performAction(ACTION_CLICK) succeeded.");
                            }
                        } catch (e) {
                            console.warn("performAction failed:", e);
                        }

                        // Click strategy 2: randomClick on the node
                        if (!btnClicked) {
                            try {
                                btn.randomClick();
                                btnClicked = true;
                                console.log("randomClick() succeeded.");
                            } catch (e) {
                                console.warn("randomClick failed:", e);
                            }
                        }

                        let isClicked = false;

                        // Click strategy 3: tap at center of bounds
                        if (!btnClicked && btn.boundsInScreen) {
                            try {
                                const { left, top, right, bottom } = btn.boundsInScreen;
                                const cx = Math.floor((left + right) / 2);
                                const cy = Math.floor((top + bottom) / 2);
                                isClicked = await agent.actions.tap(cx, cy);
                                if(isClicked) isClicked = true;
                                console.log(`tap(${cx}, ${cy}) succeeded.`);
                            } catch (e) {
                                console.warn("tap fallback failed:", e);
                            }
                        }

                        if (isClicked) {
                            console.log("Successfully clicked 'Download again'. Waiting for download to complete...");
                            popupHandled = true;
                            // Reset elapsed to give full time for the actual download
                            elapsed = 0;
                        }

                        break; // Stop iterating screens once popup is found
                    }
                } catch (e) {
                    // Polling error is non-fatal; continue waiting
                    console.warn("Popup poll error (will retry):", e);
                }
            }

            await setStage(Stages.YoutubeUpload);
            return true;
        },
    },

    DuplicateDownloadPopup: {
        detectScreen: async (screenContent: AndroidNode) => {
            // Check the main screen tree using native find method
            const fromTree = screenContent.findTextOne?.("Download file again?")
                || screenContent.findTextOne?.("Download again");
            if (fromTree) return true;

            // Fallback: check all windows (the popup is a dialog overlay)
            try {
                const allScreens = await agent.actions.allScreensContent();
                for (const screen of allScreens) {
                    const found = screen.findTextOne?.("Download file again?")
                        || screen.findTextOne?.("Download again");
                    if (found) return true;
                }
            } catch (e) { /* ignore */ }

            return false;
        },
        handleScreen: async (_screenContent: AndroidNode) => {
            // Fetch all windows fresh — the popup is a dialog overlay
            const allScreens = await agent.actions.allScreensContent();

            let btn: any = null;
            for (const screen of allScreens) {
                // Strategy 1: Find by viewId (most reliable)
                btn = screen.findByIdOne?.("com.android.chrome:id/positive_button");
                if (btn) break;

                // Strategy 2: Find by text
                btn = screen.findTextOne?.("Download again");
                if (btn) break;
            }

            if (!btn) {
                console.warn("Could not find 'Download again' button in popup.");
                return false;
            }

            console.log("Found 'Download again' button, tapping:", btn.text || btn.viewId);

            // Click strategy 1: performAction (preferred per xgodo docs)
            let clicked = false;
            try {
                const result = await btn.performAction(agent.constants.ACTION_CLICK);
                if (result?.actionPerformed) {
                    clicked = true;
                    console.log("performAction(ACTION_CLICK) succeeded.");
                }
            } catch (e) {
                console.warn("performAction failed:", e);
            }

            // Click strategy 2: randomClick
            if (!clicked) {
                try {
                    btn.randomClick();
                    clicked = true;
                    console.log("randomClick() succeeded.");
                } catch (e) {
                    console.warn("randomClick failed:", e);
                }
            }

            // Click strategy 3: tap at center of bounds
            if (!clicked && btn.boundsInScreen) {
                try {
                    const { left, top, right, bottom } = btn.boundsInScreen;
                    const cx = Math.floor((left + right) / 2);
                    const cy = Math.floor((top + bottom) / 2);
                    await agent.actions.tap(cx, cy);
                    clicked = true;
                    console.log(`tap(${cx}, ${cy}) succeeded.`);
                } catch (e) {
                    console.warn("tap fallback failed:", e);
                }
            }

            if (!clicked) {
                console.error("All click attempts on 'Download again' button failed.");
                return false;
            }

            // Wait for the download to finish
            await sleep(15_000);
            await setStage(Stages.YoutubeUpload);
            return true;
        },
    },
} as const satisfies ScreenHandles<keyof typeof ChromeDownloadStageScreen>;

const ChromeDownloadStage = {
    name: "ChromeDownload",
    maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
    screens: ChromeDownloadStageScreen,
    screenHandles: ChromeDownloadHandles,

    defaultHandle: async () => {
        // Launch Chrome app
        await agent.actions.launchApp(APP_PACKAGE_NAME, false);
        await sleep(3_000);
    },
} as const satisfies Stage<typeof ChromeDownloadStageScreen>;

export default ChromeDownloadStage;