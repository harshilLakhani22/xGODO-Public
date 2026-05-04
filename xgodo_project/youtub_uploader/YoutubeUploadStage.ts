import { DEFAULT_MAX_STEPS_PER_STAGE } from "./config";
import { success, getData, addData, clearData, fail } from "./data";
import { getAllNodesFlat, waitForStableNode, hideKeyboardIfVisible, captureDebugArtifacts } from "./util";
import { type Stage, type ScreenHandles } from "./Stage";

const YT_PACKAGE = "com.google.android.youtube";

// ── Localized button text for Publish/Upload across major locales ──
const UPLOAD_BUTTON_TEXTS = [
  // English
  'publish', 'upload short', 'upload', 'post', 'done', 'share',
  // Spanish
  'publicar', 'subir', 'subir short', 'compartir',
  // Portuguese
  'publicar', 'enviar', 'enviar short', 'compartilhar',
  // French
  'publier', 'mettre en ligne', 'partager',
  // German
  'veröffentlichen', 'hochladen', 'teilen',
  // Italian
  'pubblica', 'carica', 'condividi',
  // Hindi
  'प्रकाशित करें', 'अपलोड करें', 'पोस्ट करें',
];

/** Regex for matching upload/publish resourceId / viewId */
const UPLOAD_ID_REGEX = /publish|upload|menu_publish|post|share/i;

/** Regex for matching upload/publish button text */
const UPLOAD_TEXT_REGEX = /^(publish|upload\s*short|upload|post|done|share|publicar|subir|enviar|publier|mettre en ligne|partager|veröffentlichen|hochladen|teilen|pubblica|carica|condividi)$/i;

const YoutubeUploadStageScreen = {
    HomeScreen: "HomeScreen",
    CreationMenu: "CreationMenu",
    ShortsCameraScreen: "ShortsCameraScreen",
    GalleryScreen: "GalleryScreen",
    VideoTrimScreen: "VideoTrimScreen",
    IntermediateEditScreen: "IntermediateEditScreen",
    FinalEditScreen: "FinalEditScreen",
    UploadDetailsScreen: "UploadDetailsScreen",
} as const;

const YoutubeUploadHandles = {
    HomeScreen: {
        detectScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            return !!allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                node.description === "Create" &&
                node.className === "android.widget.Button"
            );
        },
        handleScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            const createBtn = allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                node.description === "Create" &&
                node.className === "android.widget.Button"
            );
            if (createBtn) {
                console.log("Tapping Create button on Home Screen");
                try {
                    await agent.actions.nodeAction(createBtn, agent.constants.ACTION_CLICK);
                } catch (e) {
                    createBtn.randomClick?.();
                }
                await sleep(2000);
                return true;
            }
            return false;
        },
    },

    CreationMenu: {
        detectScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            return !!allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                (node.text === "Create a Short" || node.text === "Upload a video")
            );
        },
        handleScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            const opt = allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                (node.text === "Create a Short" || node.text === "Upload a video")
            );
            if (opt) {
                console.log("Selecting option:", opt.text);
                try {
                    await agent.actions.nodeAction(opt, agent.constants.ACTION_CLICK);
                } catch (e) {
                    opt.randomClick?.();
                }
                await sleep(2000);
                return true;
            }
            return false;
        },
    },

    ShortsCameraScreen: {
        detectScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            // Exclude when the checkmark/continue-to-editor button is present
            // (that's the IntermediateEditScreen, not the camera screen)
            const hasCheckmark = allFlat.some((node: any) =>
                node.packageName === YT_PACKAGE &&
                (
                    node.viewId === "com.google.android.youtube:id/shorts_camera_next_button_delegate" ||
                    (node.description && typeof node.description === "string" && node.description.includes("Continue to editor"))
                )
            );
            if (hasCheckmark) return false;

            return !!allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                (node.viewId === "com.google.android.youtube:id/reel_camera_gallery_button_delegate" ||
                    node.description === "Import video from photo library")
            );
        },
        handleScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);

            const galleryBtn = allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                (node.viewId === "com.google.android.youtube:id/reel_camera_gallery_button_delegate" ||
                    node.description === "Import video from photo library")
            );

            if (galleryBtn) {
                console.log("Tapping Gallery button to import video");
                try {
                    await agent.actions.nodeAction(galleryBtn, agent.constants.ACTION_CLICK);
                } catch (e) {
                    galleryBtn.randomClick?.();
                }
                await sleep(2000);
                return true;
            }
            return false;
        },
    },

    GalleryScreen: {
        detectScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            return !!allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                node.viewId === "com.google.android.youtube:id/media_grid_recycler_view"
            );
        },
        handleScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);

            // First check if the Next button is available and enabled
            const nextBtn = allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                node.viewId === "com.google.android.youtube:id/multi_select_next_button" &&
                node.text === "Next" &&
                node.isEnabled
            );

            if (nextBtn) {
                console.log("Next button is ready, tapping it to proceed to trim screen.");
                try {
                    await agent.actions.nodeAction(nextBtn, agent.constants.ACTION_CLICK);
                } catch (e) {
                    nextBtn.randomClick?.();
                }
                await sleep(3000);
                return true;
            }

            await sleep(2000); // Wait for gallery thumbnails to load

            // Re-fetch screen to get loaded images
            const freshScreen = await agent.actions.screenContent();
            const freshFlat = getAllNodesFlat(freshScreen);

            // Grid view: com.google.android.youtube:id/media_grid_recycler_view
            const gridView = freshFlat.find((node: any) => node.viewId === "com.google.android.youtube:id/media_grid_recycler_view");

            if (gridView) {
                // Find children that are clickable items
                const b = gridView.boundsInScreen;
                const items = freshFlat.filter((n: any) =>
                    n.boundsInScreen &&
                    n.boundsInScreen.top >= b.top &&
                    n.boundsInScreen.bottom <= b.bottom &&
                    n.className === "android.widget.FrameLayout" &&
                    n.clickable
                );

                // Sort items by row and column
                items.sort((a, b) => {
                    const rowA = a.collectionItemInfo?.rowIndex ?? 0;
                    const rowB = b.collectionItemInfo?.rowIndex ?? 0;
                    if (rowA !== rowB) return rowA - rowB;
                    const colA = a.collectionItemInfo?.columnIndex ?? 0;
                    const colB = b.collectionItemInfo?.columnIndex ?? 0;
                    return colA - colB;
                });

                if (items.length > 0) {
                    const firstVideo = items[0];
                    console.log("Selecting first video from gallery");
                    try {
                        await agent.actions.nodeAction(firstVideo, agent.constants.ACTION_CLICK);
                    } catch (e) {
                        firstVideo.randomClick?.();
                    }
                    await sleep(3000);
                    return true;
                } else {
                    console.error("Gallery is empty or no items found");
                    await fail("No videos found in gallery");
                    return false;
                }
            }
            return false;
        },
    },

    VideoTrimScreen: {
        detectScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            return !!allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                (node.viewId === "com.google.android.youtube:id/shorts_trim_finish_trim_button" || node.text === "Done")
            );
        },
        handleScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            const doneBtn = allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                (node.viewId === "com.google.android.youtube:id/shorts_trim_finish_trim_button" || node.text === "Done")
            );

            if (doneBtn) {
                console.log("Tapping Done on Video Trim screen");
                try {
                    await agent.actions.nodeAction(doneBtn, agent.constants.ACTION_CLICK);
                } catch (e) {
                    doneBtn.randomClick?.();
                }

                // Processing might take a while, depending on the video
                console.log("Waiting for video processing...");
                await sleep(15000);
                return true;
            }
            return false;
        },
    },

    IntermediateEditScreen: {
        detectScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            return !!allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                (
                    node.viewId === "com.google.android.youtube:id/shorts_camera_next_button_delegate" || 
                    (node.description && typeof node.description === "string" && node.description.includes("Continue to editor")) ||
                    (node.className === "android.widget.FrameLayout" && node.description && node.description.includes("Continue to editor"))
                )
            );
        },
        handleScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            const tickBtn = allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                (
                    node.viewId === "com.google.android.youtube:id/shorts_camera_next_button_delegate" || 
                    (node.description && typeof node.description === "string" && node.description.includes("Continue to editor")) ||
                    (node.className === "android.widget.FrameLayout" && node.description && node.description.includes("Continue to editor"))
                )
            );

            if (tickBtn) {
                console.log("Tapping tick (Continue to editor) on Intermediate Edit screen");
                try {
                    await agent.actions.nodeAction(tickBtn, agent.constants.ACTION_CLICK);
                } catch (e) {
                    tickBtn.randomClick?.();
                }
                await sleep(3000); // Give it time to transition to Final Edit
                return true;
            }
            return false;
        },
    },

    FinalEditScreen: {
        detectScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            return !!allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                node.text === "Next" &&
                node.className === "android.widget.Button"
            );
        },
        handleScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            const nextBtn = allFlat.find((node: any) =>
                node.packageName === YT_PACKAGE &&
                node.text === "Next" &&
                node.className === "android.widget.Button"
            );

            if (nextBtn) {
                console.log("Tapping Next on Final Edit screen");
                try {
                    await agent.actions.nodeAction(nextBtn, agent.constants.ACTION_CLICK);
                } catch (e) {
                    nextBtn.randomClick?.();
                }
                await sleep(3000);
                return true;
            }
            return false;
        },
    },

    UploadDetailsScreen: {
        detectScreen: async (screenContent: AndroidNode) => {
            const allFlat = getAllNodesFlat(screenContent);
            // Broad detection: match any publish/upload/post/share button
            const hasUploadBtn = allFlat.some((node: any) => {
                if (node.packageName !== YT_PACKAGE) return false;
                // Check viewId / resourceId
                if ((node.viewId || node.resourceId) && UPLOAD_ID_REGEX.test(node.viewId || node.resourceId)) return true;
                // Check text
                if (node.text && UPLOAD_TEXT_REGEX.test(node.text.toString().trim())) return true;
                // Check content-desc
                if (node.description && UPLOAD_TEXT_REGEX.test(node.description.toString().trim())) return true;

                // Add robust detection by screen title or draft button
                const textStr = (node.text || node.description || "").toString().trim();
                if (/^(Add details|Caption your Short|Save draft)$/i.test(textStr)) return true;

                return false;
            });
            return hasUploadBtn;
        },

        handleScreen: async (_screenContent: AndroidNode) => {
            console.log('=== UploadDetailsScreen: starting robust upload flow ===');
            return await clickFinalUploadButton();
        },
    },

} as const satisfies ScreenHandles<keyof typeof YoutubeUploadStageScreen>;

/**
 * Perform the final upload click sequence.
 * Exported so it can be called as a fallback from main.ts when the screen is "Unknown".
 */
export async function clickFinalUploadButton(): Promise<boolean> {
    // ── Step 1: Hide keyboard ──
    const kbHidden = await hideKeyboardIfVisible();
    if (kbHidden) {
        console.log('Keyboard was hidden before upload click');
        await sleep(300);
    }

    // ── Step 2: Find the final upload node (fresh query) ──
    let uploadNode = await findFinalUploadNode();
    if (!uploadNode) {
        console.error('findFinalUploadNode returned null on first attempt, retrying after 3s...');
        await sleep(3000);
        uploadNode = await findFinalUploadNode();
    }

    let targetNode: any = null;

    if (uploadNode) {
        console.log(
            `Found upload node: text="${uploadNode.text}" desc="${uploadNode.description}"` +
            ` id="${uploadNode.resourceId || uploadNode.viewId}" bounds=${JSON.stringify(uploadNode.boundsInScreen)}`
        );

        // ── Step 3: Wait for stable bounds ──
        const stableNode = await waitForStableNode(
            async () => findFinalUploadNode(),
            3,
            200,
        );
        targetNode = stableNode || uploadNode;

        // ── Step 4: Ensure button is enabled ──
        const isEnabled = await ensureButtonEnabled(
            async () => findFinalUploadNode(),
            8000,
        );
        if (!isEnabled) {
            console.error('Upload button never became enabled within timeout');
            await captureDebugArtifacts('upload-button-disabled');
            // Continue anyway — some versions don't expose isEnabled correctly
        }
    } else {
        console.warn('Upload node could not be found via accessibility. Proceeding to blind fallback strategies...');
    }

    // ── Step 5: Click strategy cascade ──
    const clickStrategies: { name: string; execute: (node: any) => Promise<void> }[] = [];

    // Strategies that require a found node
    if (targetNode) {
        clickStrategies.push(
            {
                name: 'padded-coordinate-click',
                execute: async (node: any) => {
                    const b = node.boundsInScreen;
                    // Pad inward by 8px to avoid edges
                    const pad = 8;
                    const x = Math.floor((b.left + b.right) / 2);
                    const y = Math.floor((b.top + b.bottom) / 2);
                    const safeX = Math.max(b.left + pad, Math.min(x, b.right - pad));
                    const safeY = Math.max(b.top + pad, Math.min(y, b.bottom - pad));
                    console.log(`[strategy:padded-coord] clicking (${safeX}, ${safeY})`);
                    await agent.actions.click(safeX, safeY);
                },
            },
            {
                name: 'nodeAction-click',
                execute: async (node: any) => {
                    console.log('[strategy:nodeAction] ACTION_CLICK on node');
                    await agent.actions.nodeAction(node, agent.constants.ACTION_CLICK);
                },
            },
            {
                name: 'child-text-nodeAction',
                execute: async (node: any) => {
                    // Re-query and look for a child text node inside the button
                    const freshFlat = await getFreshFlatNodes();
                    const childText = freshFlat.find(
                        (n: any) =>
                            n.text &&
                            /publish|upload|post|share/i.test(n.text.toString()) &&
                            n.boundsInScreen &&
                            node.boundsInScreen &&
                            n.boundsInScreen.left >= node.boundsInScreen.left &&
                            n.boundsInScreen.right <= node.boundsInScreen.right &&
                            n.boundsInScreen.top >= node.boundsInScreen.top &&
                            n.boundsInScreen.bottom <= node.boundsInScreen.bottom
                    );
                    if (childText) {
                        console.log('[strategy:child-text] ACTION_CLICK on child text node');
                        await agent.actions.nodeAction(childText, agent.constants.ACTION_CLICK);
                    } else {
                        throw new Error('No child text node found inside upload button');
                    }
                },
            },
            {
                name: 'randomClick-fallback',
                execute: async (node: any) => {
                    const b = node.boundsInScreen;
                    if (b && typeof agent.utils.randomClick === 'function') {
                        console.log('[strategy:randomClick] randomClick on bounds');
                        await agent.utils.randomClick(b.left, b.top, b.right, b.bottom);
                    } else if (typeof node.randomClick === 'function') {
                        console.log('[strategy:randomClick] node.randomClick()');
                        await node.randomClick();
                    } else {
                        throw new Error('No randomClick method available');
                    }
                },
            }
        );
    }

    // Always add the blind coordinate fallback at the end (for empty tree case)
    clickStrategies.push({
        name: 'blind-bottom-right-click',
        execute: async () => {
            console.log('[strategy:blind-bottom-right] Empty tree fallback');
            const display = typeof agent.actions.getDisplaySize === 'function'
                ? await agent.actions.getDisplaySize()
                : { width: 1080, height: 2400 };

            // Bottom-right rectangle formula per spec
            const left = Math.floor(display.width * 0.75);
            const right = display.width - 20;
            const top = Math.floor(display.height * 0.83);
            const bottom = display.height - 60;

            console.log(`[strategy:blind-bottom-right] clicking multiple times in rect: L:${left} T:${top} R:${right} B:${bottom}`);

            if (typeof agent.utils.randomClick === 'function') {
                // Perform 3-4 randomized clicks inside the rectangle
                for (let i = 0; i < 4; i++) {
                    await agent.utils.randomClick(left, top, right, bottom);
                    await sleep(200);
                }
            } else {
                // simple fallback if randomClick isn't available
                const midX = Math.floor((left + right) / 2);
                const midY = Math.floor((top + bottom) / 2);
                for (let i = 0; i < 4; i++) {
                    await agent.actions.click(midX, midY);
                    await sleep(200);
                }
            }
        }
    });

    let uploadStarted = false;
    for (const strategy of clickStrategies) {
        try {
            console.log(`Attempting click strategy: ${strategy.name}`);
            let freshNode = null;
            if (strategy.name !== 'blind-bottom-right-click') {
                freshNode = await findFinalUploadNode() || targetNode;
            }
            await strategy.execute(freshNode);

            // Verify upload started after each attempt
            uploadStarted = await waitForUploadStart(5000);
            if (uploadStarted) {
                console.log(`✓ Upload started after strategy: ${strategy.name}`);
                break;
            }
            console.warn(`Strategy ${strategy.name} clicked but upload not detected, trying next...`);
        } catch (e) {
            console.warn(`Strategy ${strategy.name} failed:`, e);
        }
    }

    if (!uploadStarted) {
        // Final check — maybe upload started but detection missed it
        console.log('All click strategies exhausted. Final verification (60s)...');
        uploadStarted = await waitForUploadStart(60000);
    }

    if (uploadStarted) {
        console.log('Upload confirmed! Completing successfully.');
        await success({ message: 'YouTube upload flow completed successfully.' });
        return true;
    } else {
        console.error('All click strategies failed — upload never started');
        await captureDebugArtifacts('all-strategies-failed');
        await fail('UPLOAD_CLICK_ALL_STRATEGIES_FAILED');
        return false;
    }
}

const YoutubeUploadStage = {
    name: "YoutubeUpload",
    maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
    screens: YoutubeUploadStageScreen,
    screenHandles: YoutubeUploadHandles,

    defaultHandle: async () => {
        // Launch YouTube app
        await agent.actions.launchApp(YT_PACKAGE, false);
        await sleep(5_000);
    },
} as const satisfies Stage<typeof YoutubeUploadStageScreen>;

export default YoutubeUploadStage;

// ─── Internal helpers for UploadDetailsScreen ───────────────────────────────

/** Get a fresh flat array of all nodes from allScreensContent */
async function getFreshFlatNodes(): Promise<any[]> {
    const screens = await agent.actions.allScreensContent();
    return screens.flatMap((s: any) => getAllNodesFlat(s));
}

/**
 * Multi-strategy node finder for the final Upload/Publish button.
 * Priority: (1) resourceId/viewId, (2) text match, (3) content-desc, (4) bottom-right clickable heuristic.
 */
async function findFinalUploadNode(): Promise<any | null> {
    const flat = await getFreshFlatNodes();
    const ytNodes = flat.filter((n: any) => n.packageName === YT_PACKAGE);

    // Strategy 1: strict resourceId / viewId match
    const byId = ytNodes.find(
        (n: any) => (n.resourceId || n.viewId) && UPLOAD_ID_REGEX.test(n.resourceId || n.viewId)
    );
    if (byId) {
        console.log('[findFinalUploadNode] Found by resourceId/viewId:', byId.resourceId || byId.viewId);
        return byId;
    }

    // Strategy 2: text match (case-insensitive, trimmed)
    const byText = ytNodes.find(
        (n: any) => n.text && UPLOAD_TEXT_REGEX.test(n.text.toString().trim())
    );
    if (byText) {
        console.log('[findFinalUploadNode] Found by text:', byText.text);
        return byText;
    }

    // Strategy 3: content-desc / description match
    const byDesc = ytNodes.find(
        (n: any) => n.description && UPLOAD_TEXT_REGEX.test(n.description.toString().trim())
    );
    if (byDesc) {
        console.log('[findFinalUploadNode] Found by description:', byDesc.description);
        return byDesc;
    }

    // Strategy 3.5: "Save draft" heuristic
    const saveDraftNode = ytNodes.find(
        (n: any) => (n.text && /save draft/i.test(n.text.toString().trim())) || 
                    (n.description && /save draft/i.test(n.description.toString().trim()))
    );

    if (saveDraftNode && saveDraftNode.boundsInScreen) {
        console.log('[findFinalUploadNode] Found "Save draft", looking for button to its right.');
        const sb = saveDraftNode.boundsInScreen;
        const rightNodes = ytNodes.filter((n: any) =>
            n.clickable &&
            n.boundsInScreen &&
            n.boundsInScreen.left >= sb.right &&
            n.boundsInScreen.top >= sb.top - 100 &&
            n.boundsInScreen.bottom <= sb.bottom + 100
        );

        if (rightNodes.length > 0) {
            rightNodes.sort((a: any, b: any) => b.boundsInScreen.right - a.boundsInScreen.right);
            console.log('[findFinalUploadNode] Fallback: node to the right of Save draft:', rightNodes[0].viewId || "No viewId");
            return rightNodes[0];
        } else {
             console.log('[findFinalUploadNode] Fallback: no clickable node to the right of Save draft, estimating bounds.');
             return {
                 boundsInScreen: {
                     left: sb.right + 20, 
                     top: sb.top,
                     right: sb.right + 500,
                     bottom: sb.bottom
                 },
                 text: "Estimated Upload Button",
                 packageName: YT_PACKAGE,
             };
        }
    }

    // Strategy 4: bottom-right clickable node heuristic
    const clickable = ytNodes.filter((n: any) => n.clickable && n.boundsInScreen);
    if (clickable.length > 0) {
        clickable.sort(
            (a: any, b: any) =>
                (b.boundsInScreen.bottom + b.boundsInScreen.right) -
                (a.boundsInScreen.bottom + a.boundsInScreen.right)
        );
        console.log('[findFinalUploadNode] Fallback: bottom-right clickable node:', clickable[0].text || clickable[0].description);
        return clickable[0];
    }

    console.warn('[findFinalUploadNode] No candidate found at all');
    return null;
}

/**
 * Poll until the upload button's isEnabled flag is true.
 * Returns true if button became enabled, false on timeout.
 */
async function ensureButtonEnabled(
    findFn: () => Promise<any | null>,
    timeoutMs: number = 8000,
): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const node = await findFn();
        if (node && node.isEnabled !== false) {
            // isEnabled is true or undefined (treat undefined as enabled)
            return true;
        }
        if (node && node.isEnabled === false) {
            console.log('[ensureButtonEnabled] Button disabled, waiting...');
        }
        await sleep(500);
    }
    return false;
}

/**
 * Poll for signs that the upload has started:
 * - Text containing "uploading", "processing", or "%"
 * - ClassName containing "progress" or "spinner"
 * - Transition away from the upload-details screen
 */
async function waitForUploadStart(timeoutMs: number = 60000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const flat = await getFreshFlatNodes();

            // Check for uploading/processing text
            const uploadingNode = flat.find(
                (n: any) => n.text && /uploading|processing|\d+\s*%/i.test(n.text.toString())
            );
            if (uploadingNode) {
                console.log('[waitForUploadStart] Detected upload text:', uploadingNode.text);
                return true;
            }

            // Check for progress bar / spinner class
            const progressNode = flat.find(
                (n: any) => n.className && /progress|spinner/i.test(n.className)
            );
            if (progressNode) {
                console.log('[waitForUploadStart] Detected progress/spinner:', progressNode.className);
                return true;
            }

            // Check if we've transitioned away from upload-details screen
            // (i.e., no publish/upload button visible anymore = upload started)
            const ytNodes = flat.filter((n: any) => n.packageName === YT_PACKAGE);
            const stillOnUploadScreen = ytNodes.some(
                (n: any) =>
                    ((n.resourceId || n.viewId) && UPLOAD_ID_REGEX.test(n.resourceId || n.viewId)) ||
                    (n.text && UPLOAD_TEXT_REGEX.test(n.text.toString().trim())) ||
                    (n.text && /^(Add details|Caption your Short|Save draft)$/i.test(n.text.toString().trim()))
            );
            if (!stillOnUploadScreen && ytNodes.length > 0) {
                console.log('[waitForUploadStart] Upload screen transitioned away — assuming upload started');
                return true;
            }
        } catch (e) {
            console.warn('[waitForUploadStart] Error during poll:', e);
        }
        await sleep(1000);
    }
    console.warn(`[waitForUploadStart] Timed out after ${timeoutMs}ms`);
    return false;
}