/**
 * Upload Stage - Core upload flow via YouTube app GUI
 *
 * Handles the complete YouTube Shorts upload flow:
 * 1. YouTube Home → Tap "Create" (+) button
 * 2. Create Menu → Tap "Short"
 * 3. Shorts Camera → Tap gallery thumbnail (bottom-left)
 * 4. Gallery Bottom Sheet → Select downloaded video
 * 5. Trim Screen → Tap "Done"
 * 6. Final Edit Screen → Tap "Next"
 * 7. Metadata Screen → Set title, tap "Upload Short"
 *
 * Screen detection uses real device viewIds from JSON data files.
 */

import {
    APP_PACKAGE_NAME,
    DEFAULT_MAX_STEPS_PER_STAGE,
    JOB_VARS,
    UPLOAD_CONFIG,
    getJobVar,
    getDownloadPath,
} from "./config";
import { Stage, type ScreenHandles, setStage } from "./Stage";
import {
    detectYouTubeHome,
    detectCreateMenu,
    detectGalleryBottomSheet,
    detectTrimScreen,
    detectShortsCamera,
    detectShortEditor,
    detectMetadataScreen,
    detectUploadingScreen,
    detectUploadSuccess,
    getCreateButton,
} from "./screenDetector";
import { isYouTubeOpen, findClickableByText, findNodeByText, findEditText, findClickableByDescription } from "./utils";
import { fail, addData, submitProgress } from "./data";

/**
 * Define all screens in the upload flow
 */
const UploadStageScreen = {
    YouTubeHome: "YouTubeHome",
    CreateMenu: "CreateMenu",
    ShortsCamera: "ShortsCamera",
    GalleryPicker: "GalleryPicker",
    TrimScreen: "TrimScreen",
    ShortEditor: "ShortEditor",
    MetadataScreen: "MetadataScreen",
    Uploading: "Uploading",
    UploadSuccess: "UploadSuccess",
    NotYouTube: "NotYouTube",
} as const;

// Track which sub-steps we've completed
let hasClickedCreate = false;
let hasSelectedVideo = false;
let hasPassedTrim = false;
let hasPassedEditor = false;
let hasSetMetadata = false;
let hasStartedUpload = false;

// Retry counter for permission dialog coordinate-based fallback
let lowNodeRetries = 0;

// Helper to handle any subsequent permission dialogs
async function handleAdditionalPermissions(PERM_PACKAGES: string[], allowTexts: string[]) {
    const afterScreen = await agent.actions.screenContent();
    const afterNodes = afterScreen.allNodes();
    const morePerms = afterNodes.some(
        (node: any) => PERM_PACKAGES.some(pkg => node.packageName === pkg)
    );
    if (morePerms) {
        console.log("[Upload] 🔐 Another permission dialog detected, granting...");
        for (const text of allowTexts) {
            const btn = afterNodes.find(
                (node: any) =>
                    node.text === text &&
                    node.clickable &&
                    PERM_PACKAGES.some(pkg => node.packageName === pkg)
            );
            if (btn) {
                console.log(`[Upload] ✅ Tapping additional permission: "${text}"`);
                await btn.randomClick();
                await sleep(2000);
                break;
            }
        }
    }
}

// Helper to tap "Add from Gallery" on middleware screen once permissions are granted
async function tryTapAddFromGallery() {
    const midScreen = await agent.actions.screenContent();
    const midNodes = midScreen.allNodes();
    const addFromGallery = midNodes.find(
        (node: any) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.clickable &&
            ((node.text && node.text === "Add from Gallery") ||
                (node.viewId === "com.google.android.youtube:id/unified_permissions_primary_button"))
    );
    if (addFromGallery) {
        console.log("[Upload] ✅ Found 'Add from Gallery' after permission grant, tapping...");
        await addFromGallery.randomClick();
        await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
    } else {
        console.log("[Upload] ⚠️ Permission granted, 'Add from Gallery' not found. Will re-detect screen.");
    }
}

// System packages that can open when YouTube triggers a picker
// These should NOT be treated as "not YouTube"
const SYSTEM_PICKER_PACKAGES = [
    "com.google.android.apps.photos",       // Google Photos
    "com.android.documentsui",              // Android file picker
    "com.google.android.documentsui",       // Google's file picker
    "com.google.android.permissioncontroller", // Permission dialogs
    "com.android.permissioncontroller",
    "com.android.packageinstaller",
];

/**
 * Reset all upload state flags.
 * Called when we need to restart the upload flow from scratch.
 */
function resetUploadState() {
    console.log("[Upload] 🔄 Resetting all upload state flags...");
    hasClickedCreate = false;
    hasSelectedVideo = false;
    hasPassedTrim = false;
    hasPassedEditor = false;
    hasSetMetadata = false;
    hasStartedUpload = false;
}

/**
 * Screen handlers for the upload flow
 */
const UploadHandles = {
    /**
     * Not in YouTube — re-launch
     */
    NotYouTube: {
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            // YouTube is open → not "NotYouTube"
            if (isYouTubeOpen(allNodes)) return false;
            // System picker apps that YouTube may have opened (gallery, permissions)
            // should NOT trigger NotYouTube — they're part of the YouTube flow
            const isSystemPicker = allNodes.some(
                (node: any) => SYSTEM_PICKER_PACKAGES.some(pkg => node.packageName === pkg)
            );
            if (isSystemPicker) {
                console.log("[Upload] System picker detected (not YouTube but part of flow), skipping NotYouTube...");
                return false;
            }
            // When permission dialog appears, sometimes accessibility returns very few or no nodes.
            // Don't treat this as "not YouTube" — let handleScreen check with a fresh dump.
            if (allNodes.length <= 2) {
                console.log(`[Upload] ⚠️ Very few nodes (${allNodes.length}), treating as potential permission dialog...`);
                return true; // Let handleScreen investigate with fresh screen content
            }
            return true;
        },

        handleScreen: async () => {
            // ─── Permission Dialog Detection & Coordinate-Based Fallback ───
            // When Android shows a permission dialog after tapping Create+Short,
            // the accessibility tree often returns empty/minimal nodes.
            // We use a multi-strategy approach to handle this.

            const PERM_PACKAGES = [
                "com.android.permissioncontroller",
                "com.google.android.permissioncontroller",
                "com.android.packageinstaller",
            ];

            const allowTexts = [
                "While using the app",
                "Only this time",
                "Allow",
                "ALLOW",
                "Allow all the time",
            ];

            try {
                // Wait a bit for the screen to settle before checking
                await sleep(1000);
                const freshScreen = await agent.actions.screenContent();
                const freshNodes = freshScreen.allNodes();

                console.log(`[Upload] NotYouTube handler: fresh dump has ${freshNodes.length} nodes`);

                // ─── STRATEGY 1: Node-based permission granting ───
                const isPermDialog = freshNodes.some(
                    (node: any) => PERM_PACKAGES.some(pkg => node.packageName === pkg)
                );

                if (isPermDialog) {
                    console.log("[Upload] 🔐 Permission dialog detected via nodes! Granting permission...");

                    let tapped = false;
                    for (const text of allowTexts) {
                        const allowButton = freshNodes.find(
                            (node: any) =>
                                node.text === text &&
                                node.clickable &&
                                PERM_PACKAGES.some(pkg => node.packageName === pkg)
                        );
                        if (allowButton) {
                            console.log(`[Upload] ✅ Tapping permission button: "${text}"`);
                            await allowButton.randomClick();
                            await sleep(2000);
                            tapped = true;
                            break;
                        }
                    }

                    if (!tapped) {
                        // Fallback: tap any non-deny button
                        const anyAllowBtn = freshNodes.find(
                            (node: any) =>
                                node.clickable &&
                                node.className === "android.widget.Button" &&
                                PERM_PACKAGES.some(pkg => node.packageName === pkg) &&
                                node.text &&
                                !node.text.toLowerCase().includes("deny") &&
                                !node.text.toLowerCase().includes("don't allow") &&
                                !node.text.toLowerCase().includes("don\u2019t allow")
                        );
                        if (anyAllowBtn) {
                            console.log(`[Upload] ✅ Tapping fallback permission button: "${anyAllowBtn.text}"`);
                            await anyAllowBtn.randomClick();
                            await sleep(2000);
                            tapped = true;
                        }
                    }

                    if (tapped) {
                        lowNodeRetries = 0;
                        // Handle additional permission dialogs
                        await handleAdditionalPermissions(PERM_PACKAGES, allowTexts);
                        // Look for "Add from Gallery"
                        await tryTapAddFromGallery();
                        return true;
                    }
                }

                // ─── STRATEGY 2: Low-node count → likely invisible permission dialog ───
                if (freshNodes.length <= 5) {
                    lowNodeRetries++;
                    console.log(`[Upload] 📊 Low node count (${freshNodes.length}), retry #${lowNodeRetries}`);

                    if (lowNodeRetries <= 2) {
                        // First 2 attempts: just wait longer for accessibility to catch up
                        console.log("[Upload] ⏳ Waiting 3s for accessibility tree to populate...");
                        await sleep(3000);
                        return true;
                    }

                    if (lowNodeRetries === 3) {
                        // Third attempt: wait even longer
                        console.log("[Upload] ⏳ Waiting 5s for accessibility tree to populate...");
                        await sleep(5000);
                        return true;
                    }

                    if (lowNodeRetries >= 4 && lowNodeRetries <= 7) {
                        // ─── STRATEGY 3: Coordinate-based blind tap (FALLBACK) ───
                        // On a 1080x2400 Android screen, the permission dialog buttons are typically:
                        //   "While using the app" ≈ y:1300-1400, centered x:540
                        //   "Only this time"      ≈ y:1450-1550, centered x:540
                        //   "Don't allow"          ≈ y:1600-1700, centered x:540
                        // We tap at these coordinates to grant the permission blindly.

                        const tapTargets = [
                            { name: "While using the app (estimated)", x: 540, y: 1350 },
                            { name: "Only this time (estimated)", x: 540, y: 1500 },
                            { name: "While using the app (alt pos)", x: 540, y: 1280 },
                            { name: "Only this time (alt pos)", x: 540, y: 1430 },
                        ];

                        const targetIndex = (lowNodeRetries - 4) % tapTargets.length;
                        const target = tapTargets[targetIndex];

                        console.log(`[Upload] 🎯 FALLBACK: Blind tap at (${target.x}, ${target.y}) — "${target.name}"`);
                        await agent.actions.tap(target.x, target.y);
                        await sleep(3000);

                        // Check if the tap worked — did we get more nodes now?
                        const afterTapScreen = await agent.actions.screenContent();
                        const afterTapNodes = afterTapScreen.allNodes();
                        console.log(`[Upload] 📊 After blind tap: ${afterTapNodes.length} nodes`);

                        if (afterTapNodes.length > 5) {
                            console.log("[Upload] ✅ Screen changed after blind tap! Resetting counter.");
                            lowNodeRetries = 0;

                            // Check if we're now on the permission dialog (finally visible)
                            const nowPermDialog = afterTapNodes.some(
                                (node: any) => PERM_PACKAGES.some(pkg => node.packageName === pkg)
                            );
                            if (nowPermDialog) {
                                console.log("[Upload] 🔐 Permission dialog now visible, granting...");
                                for (const text of allowTexts) {
                                    const btn = afterTapNodes.find(
                                        (node: any) =>
                                            node.text === text &&
                                            node.clickable &&
                                            PERM_PACKAGES.some(pkg => node.packageName === pkg)
                                    );
                                    if (btn) {
                                        console.log(`[Upload] ✅ Tapping: "${text}"`);
                                        await btn.randomClick();
                                        await sleep(2000);
                                        break;
                                    }
                                }
                            }

                            // Try to find "Add from Gallery"
                            await tryTapAddFromGallery();
                        }
                        return true;
                    }

                    // After 8+ retries with low nodes — the screen is genuinely stuck
                    console.log(`[Upload] ❌ ${lowNodeRetries} consecutive low-node attempts. Giving up — relaunching YouTube.`);
                    lowNodeRetries = 0;
                    // Fall through to relaunch below
                }
            } catch (err) {
                console.log("[Upload] ⚠️ Error in NotYouTube handler:", err);
            }

            // Genuinely not YouTube — relaunch
            console.log("[Upload] Not in YouTube, relaunching...");
            lowNodeRetries = 0;
            resetUploadState();
            await agent.actions.launchApp(APP_PACKAGE_NAME, true);
            await sleep(3000);
            return true;
        },
    },

    /**
     * YouTube Home — tap the Create "+" button
     */
    YouTubeHome: {
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            return detectYouTubeHome(allNodes) && !hasClickedCreate;
        },

        handleScreen: async (screenContent) => {
            console.log("[Upload] STEP 1: YouTubeHome — looking for Create '+' button...");
            const allNodes = screenContent.allNodes();

            // Log all bottom-area clickable nodes for debugging
            const bottomNodes = allNodes.filter((node: any) => node.clickable && node.boundsInScreen && node.boundsInScreen.top > 1800);
            console.log(`[Upload] Found ${bottomNodes.length} clickable nodes in bottom area:`);
            for (const node of bottomNodes.slice(0, 10)) {
                console.log(`  desc="${node.description || ''}" text="${node.text || ''}" id=${node.viewId || ''} class=${node.className}`);
            }

            const createButton = getCreateButton(allNodes);
            if (createButton) {
                console.log("[Upload] ✅ Found Create button:", createButton.description || createButton.text || createButton.viewId);
                await createButton.randomClick();
                hasClickedCreate = true;
                // Wait longer for any permission dialogs to render
                await sleep(4000);
                return true;
            }

            // Fallback: tap bottom center where "+" button usually is
            console.log("[Upload] ⚠️ Create button not found by selector, trying bottom center tap...");
            const screenWidth = 1080;
            const screenHeight = 2340;
            await agent.actions.tap(screenWidth / 2, screenHeight - 100);
            hasClickedCreate = true;
            // Wait longer for any permission dialogs to render
            await sleep(4000);
            return true;
        },
    },

    /**
     * Create Menu — select "Short" from the creation mode switcher
     *
     * Real device UI (from select_short_in_add_short.json):
     * - Button with viewId: "creation_mode_button", text: "Short", description: "Short"
     */
    CreateMenu: {
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            return detectCreateMenu(allNodes);
        },

        handleScreen: async (screenContent) => {
            console.log("[Upload] STEP 2: CreateMenu — looking for 'Short' button...");
            const allNodes = screenContent.allNodes();

            // Log all visible text nodes for debugging
            const textNodes = allNodes.filter((node: any) => node.text && node.text.length > 0);
            console.log(`[Upload] Text nodes on Create menu (${textNodes.length} total):`);
            for (const node of textNodes.slice(0, 15)) {
                console.log(`  text="${node.text}" desc="${node.description || ''}" clickable=${node.clickable} id=${node.viewId || ''} class=${node.className}`);
            }

            // Primary: Find by real device viewId (most reliable)
            let option = allNodes.find(
                (node: any) =>
                    node.viewId === "com.google.android.youtube:id/creation_mode_button" &&
                    (node.text === "Short" || node.description === "Short") &&
                    node.clickable
            );

            if (option) {
                console.log(`[Upload] ✅ Found Short button by viewId: creation_mode_button, text="${option.text}", desc="${option.description}"`);
            }

            // Secondary: Find by text "Short" (any clickable)
            if (!option) {
                option = findClickableByText(allNodes, "Short");
                if (option) console.log("[Upload] ✅ Found Short button by text match");
            }

            // Tertiary: Find by description "Short"
            if (!option) {
                option = findClickableByDescription(allNodes, "Short");
                if (option) console.log("[Upload] ✅ Found Short button by description match");
            }

            // Fallback: Legacy patterns for different YouTube versions
            if (!option) option = findClickableByText(allNodes, "Create a Short");
            if (!option) option = findNodeByText(allNodes, "Create a Short");

            if (option) {
                console.log("[Upload] ✅ Tapping upload option:", option.text || option.description);
                await option.randomClick();
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            console.log("[Upload] ❌ No upload option found in create menu, going back...");
            hasClickedCreate = false;
            await agent.actions.goBack();
            await sleep(1000);
            return false;
        },
    },

    /**
     * Shorts Camera — the recording screen after tapping "Short"
     *
     * Real device UI (from add_shorts.json):
     * - reel_camera_layout, camera_preview, shorts_record_button
     * - Gallery thumbnail at bottom-left to select existing video
     *
     * We need to find and tap the gallery/upload icon to pick
     * the previously downloaded video.
     */
    ShortsCamera: {
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            return detectShortsCamera(allNodes) && !hasSelectedVideo;
        },

        handleScreen: async (screenContent) => {
            console.log("[Upload] STEP 3: ShortsCamera — handling camera/permission screen...");
            const allNodes = screenContent.allNodes();

            // Log camera screen nodes for debugging
            const ytNodes = allNodes.filter((node: any) => node.packageName === APP_PACKAGE_NAME);
            console.log(`[Upload] YouTube nodes on camera screen: ${ytNodes.length}`);
            for (const node of ytNodes.filter((n: any) => n.clickable).slice(0, 15)) {
                console.log(`  desc="${node.description || ''}" text="${node.text || ''}" id=${node.viewId || ''} class=${node.className} bounds=${JSON.stringify(node.boundsInScreen || {})}`);
            }

            // ─── PRIORITY CHECK: Android system permission dialog? ───
            // "Allow YouTube to take pictures and record video?"
            // This appears from com.android.permissioncontroller or com.google.android.permissioncontroller
            // We MUST grant the permission (pressing back exits to YouTube Home)
            const PERM_PACKAGES = [
                "com.android.permissioncontroller",
                "com.google.android.permissioncontroller",
                "com.android.packageinstaller",
            ];

            const isPermissionDialog = allNodes.some(
                (node: any) => PERM_PACKAGES.some(pkg => node.packageName === pkg)
            );

            if (isPermissionDialog) {
                console.log("[Upload] 🔐 Android permission dialog detected! Granting permission...");

                // Handle up to 3 consecutive permission dialogs (e.g., camera + microphone + storage)
                let currentNodes = allNodes;
                for (let dialogIdx = 0; dialogIdx < 3; dialogIdx++) {
                    const hasDialog = currentNodes.some(
                        (node: any) => PERM_PACKAGES.some(pkg => node.packageName === pkg)
                    );
                    if (!hasDialog) {
                        console.log(`[Upload] No more permission dialogs after ${dialogIdx} handled.`);
                        break;
                    }

                    // Priority order: "While using the app" > "Only this time" > "Allow"
                    const allowTexts = [
                        "While using the app",
                        "Only this time",
                        "Allow",
                        "ALLOW",
                        "Allow all the time",
                    ];

                    let tapped = false;
                    for (const text of allowTexts) {
                        const allowButton = currentNodes.find(
                            (node: any) =>
                                node.text === text &&
                                node.clickable &&
                                PERM_PACKAGES.some(pkg => node.packageName === pkg)
                        );
                        if (allowButton) {
                            console.log(`[Upload] ✅ Tapping permission button: "${text}" (dialog #${dialogIdx + 1})`);
                            await allowButton.randomClick();
                            await sleep(2000);
                            tapped = true;
                            break;
                        }
                    }

                    if (!tapped) {
                        // Fallback: tap any clickable button that isn't "Deny" / "Don't allow"
                        const anyAllowBtn = currentNodes.find(
                            (node: any) =>
                                node.clickable &&
                                node.className === "android.widget.Button" &&
                                PERM_PACKAGES.some(pkg => node.packageName === pkg) &&
                                node.text &&
                                !node.text.toLowerCase().includes("deny") &&
                                !node.text.toLowerCase().includes("don't allow") &&
                                !node.text.toLowerCase().includes("don\u2019t allow")
                        );
                        if (anyAllowBtn) {
                            console.log(`[Upload] ✅ Tapping fallback permission button: "${anyAllowBtn.text}" (dialog #${dialogIdx + 1})`);
                            await anyAllowBtn.randomClick();
                            await sleep(2000);
                            tapped = true;
                        } else {
                            console.log("[Upload] ⚠️ No suitable permission button found, cannot proceed");
                            break;
                        }
                    }

                    // Refresh screen for next dialog check
                    const refreshedScreen = await agent.actions.screenContent();
                    currentNodes = refreshedScreen.allNodes();
                }

                // After granting all permissions, we should be on the middleware screen
                // with "Add from Gallery" button. Look for it and tap.
                const afterPermScreen = await agent.actions.screenContent();
                const afterPermNodes = afterPermScreen.allNodes();

                const addFromGalleryBtn = afterPermNodes.find(
                    (node: any) =>
                        node.packageName === APP_PACKAGE_NAME &&
                        node.clickable &&
                        ((node.text && node.text === "Add from Gallery") ||
                            (node.viewId === "com.google.android.youtube:id/unified_permissions_primary_button"))
                );

                if (addFromGalleryBtn) {
                    console.log(`[Upload] ✅ Found 'Add from Gallery' on middleware screen, tapping...`);
                    await addFromGalleryBtn.randomClick();
                    await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                    return true;
                }

                console.log("[Upload] ⚠️ Permissions granted but 'Add from Gallery' not found. Will re-detect screen.");
                return true;
            }

            // ─── CHECK: Are we on the middleware permission screen? ───
            // This screen has: "Add from Gallery" button + "Open Settings" button + camera layout
            // viewId: unified_permissions_primary_button with text "Add from Gallery"
            const addFromGalleryButton = allNodes.find(
                (node: any) =>
                    node.packageName === APP_PACKAGE_NAME &&
                    node.clickable &&
                    ((node.text && node.text === "Add from Gallery") ||
                        (node.viewId === "com.google.android.youtube:id/unified_permissions_primary_button"))
            );

            if (addFromGalleryButton) {
                console.log(`[Upload] ✅ Found 'Add from Gallery' button (text="${addFromGalleryButton.text}"), tapping...`);
                await addFromGalleryButton.randomClick();
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            // ─── FALLBACK: Actual camera screen with gallery thumbnail ───
            console.log("[Upload] No permission/middleware screen detected, looking for gallery thumbnail...");

            // Strategy 1: Find gallery button by exact viewId
            let galleryButton = allNodes.find(
                (node: any) =>
                    node.packageName === APP_PACKAGE_NAME &&
                    node.viewId === "com.google.android.youtube:id/reel_camera_gallery_button_delegate" &&
                    node.clickable
            );

            if (galleryButton) {
                console.log(`[Upload] ✅ Found gallery button by exact viewId: reel_camera_gallery_button_delegate`);
                await galleryButton.randomClick();
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            // Strategy 1b: Find gallery/upload button by partial viewId match
            galleryButton = allNodes.find(
                (node: any) =>
                    node.packageName === APP_PACKAGE_NAME &&
                    node.viewId &&
                    (node.viewId.includes("gallery") ||
                        node.viewId.includes("upload") ||
                        node.viewId.includes("media_picker") ||
                        node.viewId.includes("shorts_photo_library") ||
                        node.viewId.includes("image_gallery_button")) &&
                    node.clickable
            );

            if (galleryButton) {
                console.log(`[Upload] ✅ Found gallery button by viewId: ${galleryButton.viewId}`);
                await galleryButton.randomClick();
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            // Strategy 2: Find by description containing "gallery" or "upload" or "photo"
            galleryButton = allNodes.find(
                (node: any) =>
                    node.packageName === APP_PACKAGE_NAME &&
                    node.description &&
                    (node.description.toLowerCase().includes("gallery") ||
                        node.description.toLowerCase().includes("upload") ||
                        node.description.toLowerCase().includes("photo") ||
                        node.description.toLowerCase().includes("media")) &&
                    node.clickable
            );

            if (galleryButton) {
                console.log(`[Upload] ✅ Found gallery button by description: "${galleryButton.description}"`);
                await galleryButton.randomClick();
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            // Strategy 3: Direct tap at bottom-left where gallery thumbnail usually is
            console.log("[Upload] ⚠️ Gallery button not found by selector, tapping bottom-left area...");
            await agent.actions.tap(100, 1850);
            await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
            return true;
        },
    },

    /**
     * Gallery Bottom Sheet — YouTube's built-in media picker
     *
     * Real device UI (from gallery.json):
     * - viewId: "com.google.android.youtube:id/media_grid_fragment"
     * - viewId: "com.google.android.youtube:id/select_album_button" (text="Gallery")
     * - viewId: "com.google.android.youtube:id/media_grid_recycler_view" (GridView)
     * - viewId: "com.google.android.youtube:id/thumb_image_view" (video thumbnails)
     * - description on thumbnails has the filename, e.g. "ForBiggerBlazes.mp4"
     *
     * The downloaded video should appear as the most recent item in the grid.
     */
    GalleryPicker: {
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            return detectGalleryBottomSheet(allNodes);
        },

        handleScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();

            // If we've already selected the video, look for the "Next" button
            if (hasSelectedVideo) {
                console.log("[Upload] STEP 4b: GalleryPicker — video already selected, looking for 'Next' button...");

                // Primary: Find "Next" button by exact viewId (from galley_next.json)
                let nextButton = allNodes.find(
                    (node: any) =>
                        node.packageName === APP_PACKAGE_NAME &&
                        node.viewId === "com.google.android.youtube:id/multi_select_next_button" &&
                        node.clickable
                );

                if (nextButton) {
                    console.log(`[Upload] ✅ Found Next button by viewId (multi_select_next_button), text="${nextButton.text}"`);
                    await nextButton.randomClick();
                    await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                    return true;
                }

                // Fallback: Find by text "Next"
                nextButton = findClickableByText(allNodes, "Next");
                if (nextButton) {
                    console.log("[Upload] ✅ Found Next button by text match");
                    await nextButton.randomClick();
                    await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                    return true;
                }

                console.log("[Upload] ❌ Next button not found after video selection");
                return false;
            }

            // Otherwise, select the video first
            console.log("[Upload] STEP 4: GalleryPicker — looking for downloaded video in gallery...");
            const filename = UPLOAD_CONFIG.DOWNLOAD_FILENAME;

            // Log gallery items for debugging
            const thumbNodes = allNodes.filter((node: any) =>
                node.packageName === APP_PACKAGE_NAME &&
                node.viewId === "com.google.android.youtube:id/thumb_image_view"
            );
            console.log(`[Upload] Found ${thumbNodes.length} thumb_image_view nodes:`);
            for (const node of thumbNodes.slice(0, 6)) {
                console.log(`  desc="${node.description || ''}" bounds=${JSON.stringify(node.boundsInScreen || {})}`);
            }

            // Strategy 1: Find by filename in description (e.g. "ForBiggerBlazes.mp4")
            const videoByFilename = allNodes.find(
                (node: any) =>
                    node.packageName === APP_PACKAGE_NAME &&
                    node.description &&
                    (node.description.includes(filename) ||
                        node.description.includes(filename.replace('.mp4', '')) ||
                        node.description.toLowerCase().includes('.mp4'))
            );

            if (videoByFilename) {
                console.log(`[Upload] ✅ Found video by filename: "${videoByFilename.description}"`);
                // The thumb_image_view itself may not be clickable - click its parent FrameLayout
                const parentFrame = allNodes.find(
                    (node: any) =>
                        node.packageName === APP_PACKAGE_NAME &&
                        node.clickable &&
                        node.boundsInScreen &&
                        videoByFilename.boundsInScreen &&
                        node.boundsInScreen.left === videoByFilename.boundsInScreen.left &&
                        node.boundsInScreen.top === videoByFilename.boundsInScreen.top
                );
                if (parentFrame) {
                    await parentFrame.randomClick();
                } else {
                    // Try tapping at the center of the thumbnail
                    const bounds = videoByFilename.boundsInScreen;
                    if (bounds) {
                        const cx = (bounds.left + bounds.right) / 2;
                        const cy = (bounds.top + bounds.bottom) / 2;
                        console.log(`[Upload] Tapping thumbnail center at (${cx}, ${cy})`);
                        await agent.actions.tap(cx, cy);
                    }
                }
                hasSelectedVideo = true;
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            // Strategy 2: Find the first clickable FrameLayout in the media grid
            // (these are the video item containers, typically the most recent first)
            const gridItems = allNodes.filter(
                (node: any) =>
                    node.packageName === APP_PACKAGE_NAME &&
                    node.className === "android.widget.FrameLayout" &&
                    node.clickable &&
                    node.collectionItemInfo && // Items in the grid have collectionItemInfo
                    node.boundsInScreen &&
                    node.boundsInScreen.top > 150 // Below the header
            );

            if (gridItems.length > 0) {
                // Sort by position — first item (top-left) is most recent
                const firstItem = gridItems.sort((a: any, b: any) =>
                    (a.boundsInScreen.top - b.boundsInScreen.top) || (a.boundsInScreen.left - b.boundsInScreen.left)
                )[0];
                console.log(`[Upload] ✅ Found ${gridItems.length} grid items, tapping first (most recent)...`);
                console.log(`  bounds=${JSON.stringify(firstItem.boundsInScreen)}`);
                await firstItem.randomClick();
                hasSelectedVideo = true;
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            // Strategy 3: Find any ImageView with thumb_image_view viewId and tap its coordinates
            if (thumbNodes.length > 0) {
                const firstThumb = thumbNodes[0];
                const bounds = firstThumb.boundsInScreen;
                if (bounds) {
                    const cx = (bounds.left + bounds.right) / 2;
                    const cy = (bounds.top + bounds.bottom) / 2;
                    console.log(`[Upload] ✅ Tapping first thumbnail at (${cx}, ${cy})`);
                    await agent.actions.tap(cx, cy);
                    hasSelectedVideo = true;
                    await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                    return true;
                }
            }

            console.log("[Upload] ❌ Could not find video in gallery");
            return false;
        },
    },

    /**
     * Trim Screen — trim/cut the selected video
     *
     * Real device UI (from edit.json / edit_done.json):
     * - viewId: "com.google.android.youtube:id/shorts_trim_back" (description="Close trim")
     * - viewId: "com.google.android.youtube:id/shorts_trim_finish_trim_button" (text="Done")
     * - viewId: "com.google.android.youtube:id/shorts_duration_button"
     * - Filmstrip SeekBars for trimming
     *
     * We just tap "Done" to accept the default trim and move on.
     */
    TrimScreen: {
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            return detectTrimScreen(allNodes) && !hasPassedTrim;
        },

        handleScreen: async (screenContent) => {
            console.log("[Upload] STEP 5: TrimScreen — looking for 'Done' button to accept trim...");
            const allNodes = screenContent.allNodes();

            // Primary: Find "Done" button by viewId (most reliable)
            let doneButton = allNodes.find(
                (node: any) =>
                    node.packageName === APP_PACKAGE_NAME &&
                    node.viewId === "com.google.android.youtube:id/shorts_trim_finish_trim_button" &&
                    node.clickable
            );

            if (doneButton) {
                console.log(`[Upload] ✅ Found Done button by viewId (shorts_trim_finish_trim_button), text="${doneButton.text}"`);
                await doneButton.randomClick();
                hasPassedTrim = true;
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            // Fallback: Find by text "Done"
            doneButton = findClickableByText(allNodes, "Done");
            if (doneButton) {
                console.log("[Upload] ✅ Found Done button by text match");
                await doneButton.randomClick();
                hasPassedTrim = true;
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            // Fallback: Find by description
            doneButton = findClickableByDescription(allNodes, "Done") ||
                findClickableByDescription(allNodes, "Add segment to project");
            if (doneButton) {
                console.log("[Upload] ✅ Found Done button by description");
                await doneButton.randomClick();
                hasPassedTrim = true;
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            console.log("[Upload] ❌ Done button not found on trim screen");
            return false;
        },
    },

    /**
     * Short Editor — the final edit screen with Text/Filters/Stickers tools
     *
     * Real device UI (from final_edit.json):
     * - viewId: "com.google.android.youtube:id/shorts_edit_container"
     * - viewId: "com.google.android.youtube:id/shorts_post_bottom_button" (text="Next")
     * - viewId: "com.google.android.youtube:id/shorts_edit_timeline_edit_text" (text="Edit")
     * - Tools: Text, Filters, Captions, Stickers, Voiceover
     * - "Add sound" button at top
     * - "Swipe up to edit" prompt
     *
     * We tap "Next" to proceed to the metadata screen.
     */
    ShortEditor: {
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            return detectShortEditor(allNodes) && !hasPassedEditor;
        },

        handleScreen: async (screenContent) => {
            console.log("[Upload] STEP 6: ShortEditor — looking for 'Next' button...");
            const allNodes = screenContent.allNodes();

            // Primary: Find "Next" button by viewId (most reliable)
            let nextButton = allNodes.find(
                (node: any) =>
                    node.packageName === APP_PACKAGE_NAME &&
                    node.viewId === "com.google.android.youtube:id/shorts_post_bottom_button" &&
                    node.clickable
            );

            if (nextButton) {
                console.log(`[Upload] ✅ Found Next button by viewId (shorts_post_bottom_button), text="${nextButton.text}"`);
                await nextButton.randomClick();
                hasPassedEditor = true;
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            // Fallback: Find "Next" by text
            nextButton = findClickableByText(allNodes, "Next");
            if (nextButton) {
                console.log("[Upload] ✅ Found Next button by text match");
                await nextButton.randomClick();
                hasPassedEditor = true;
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            // Fallback: Find by description
            nextButton = findClickableByDescription(allNodes, "Next");
            if (nextButton) {
                console.log("[Upload] ✅ Found Next button by description");
                await nextButton.randomClick();
                hasPassedEditor = true;
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                return true;
            }

            console.log("[Upload] ❌ Next button not found in editor");
            return false;
        },
    },

    /**
     * Metadata Screen — "Add details" screen with title, visibility, upload
     *
     * Real device UI (from final_screen.png):
     * - "Add details" heading
     * - "Caption your Short" (title EditText hint)
     * - Visibility: "Public" (with arrow to change)
     * - "Select audience" option
     * - "Upload Short" button
     * - "Save draft" button
     */
    MetadataScreen: {
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();

            // Primary: detect by UI elements (text, viewIds)
            if (detectMetadataScreen(allNodes) && !hasStartedUpload) {
                return true;
            }

            // Fallback: YouTube's metadata screen often has an EMPTY UI hierarchy
            // (root FrameLayout with children: []). If we've passed the editor,
            // YouTube is in the foreground, and no other screen matches, it must be
            // the metadata screen.
            if (hasPassedEditor && !hasStartedUpload && isYouTubeOpen(allNodes)) {
                const isOtherScreen =
                    detectShortEditor(allNodes) ||
                    detectTrimScreen(allNodes) ||
                    detectGalleryBottomSheet(allNodes) ||
                    detectShortsCamera(allNodes) ||
                    detectCreateMenu(allNodes) ||
                    detectYouTubeHome(allNodes) ||
                    detectUploadingScreen(allNodes) ||
                    detectUploadSuccess(allNodes);
                if (!isOtherScreen) {
                    console.log("[Upload] MetadataScreen detected via fallback (empty hierarchy, post-editor)");
                    return true;
                }
            }

            return false;
        },

        handleScreen: async (screenContent) => {
            console.log("[Upload] STEP 7: MetadataScreen — setting video details and uploading...");
            const allNodes = screenContent.allNodes();

            addData({ upload_started_at: new Date().toISOString() });

            // 1. Set title
            const title = getJobVar(JOB_VARS.VIDEO_TITLE) || "Short video #shorts";
            const hashtags = getJobVar(JOB_VARS.VIDEO_HASHTAGS);
            const fullTitle = hashtags
                ? `${title} ${hashtags.split(',').map(h => h.trim().startsWith('#') ? h.trim() : `#${h.trim()}`).join(' ')}`
                : title;

            console.log("[Upload] Setting title:", fullTitle);

            // Find the title input field — look for EditText with "Caption your Short" hint
            let titleField = allNodes.find(
                (node: any) =>
                    node.packageName === APP_PACKAGE_NAME &&
                    node.className === "android.widget.EditText" &&
                    (node.hintText === "Caption your Short" ||
                        node.text === "Caption your Short" ||
                        node.description?.includes("Caption"))
            );

            // Fallback: any EditText in the YouTube package
            if (!titleField) {
                titleField = findEditText(allNodes);
            }

            if (titleField) {
                console.log("[Upload] ✅ Found title EditText field, setting text...");
                await titleField.randomClick();
                await sleep(500);
                try {
                    console.log("[Upload] Setting title via ACTION_SET_TEXT...");
                    await agent.actions.nodeAction(titleField, agent.constants.ACTION_SET_TEXT, { text: fullTitle });
                    console.log("[Upload] ✅ Title set successfully");
                } catch (e) {
                    console.error("[Upload] ❌ ACTION_SET_TEXT for title failed:", e);
                    // Retry with a fresh node reference
                    const freshScreen = await agent.actions.screenContent();
                    const freshNodes = freshScreen.allNodes();
                    const freshField = freshNodes.find(
                        (node: any) =>
                            node.packageName === APP_PACKAGE_NAME &&
                            node.className === "android.widget.EditText"
                    );
                    if (freshField) {
                        try {
                            await agent.actions.nodeAction(freshField, agent.constants.ACTION_SET_TEXT, { text: fullTitle });
                            console.log("[Upload] ✅ Title set on retry");
                        } catch (e2) {
                            console.error("[Upload] ❌ Retry also failed:", e2);
                        }
                    }
                }
                await sleep(1000);

                // Dismiss keyboard
                await agent.actions.goBack();
                await sleep(500);
            } else {
                console.log("[Upload] ⚠️ Title EditText field not found on screen (empty hierarchy)");
                // FALLBACK: Tap the caption field area by coordinates and type the title
                // On a 1080x2400 screen, "Caption your Short" field is in the upper area
                console.log("[Upload] Attempting coordinate-based title input at (540, 155)...");
                await agent.actions.tap(540, 155);
                await sleep(1000);

                // Try to type the title using keyboard input
                try {
                    // Re-read screen after tapping — the field may now be focused and accessible
                    const tappedScreen = await agent.actions.screenContent();
                    const tappedNodes = tappedScreen.allNodes();
                    const focusedField = tappedNodes.find(
                        (node: any) =>
                            node.packageName === APP_PACKAGE_NAME &&
                            (node.className === "android.widget.EditText" || node.isEditable)
                    );
                    if (focusedField) {
                        console.log("[Upload] ✅ EditText appeared after tapping, setting text...");
                        await agent.actions.nodeAction(focusedField, agent.constants.ACTION_SET_TEXT, { text: fullTitle });
                        console.log("[Upload] ✅ Title set successfully via focused field");
                    } else {
                        console.log("[Upload] ⚠️ Still no EditText after tap — skipping title");
                    }
                } catch (e) {
                    console.error("[Upload] ❌ Coordinate-based title input failed:", e);
                }

                // Dismiss keyboard
                await agent.actions.goBack();
                await sleep(500);
            }

            // 2. Tap Upload Short button
            console.log("[Upload] Looking for 'Upload Short' button...");
            // Re-read screen after title was set
            const finalScreen = await agent.actions.screenContent();
            const finalNodes = finalScreen.allNodes();

            const uploadButton =
                findClickableByText(finalNodes, "Upload Short") ||
                findClickableByText(finalNodes, "Upload") ||
                findClickableByText(finalNodes, "UPLOAD") ||
                findClickableByText(finalNodes, "Publish") ||
                findClickableByDescription(finalNodes, "Upload Short") ||
                findClickableByDescription(finalNodes, "Upload") ||
                findClickableByDescription(finalNodes, "Publish");

            if (uploadButton) {
                console.log("[Upload] ✅ Found Upload button, tapping to publish...");
                await uploadButton.randomClick();
                hasStartedUpload = true;
                hasSetMetadata = true;
                await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
                await submitProgress("uploading_video");
                return true;
            }

            // FALLBACK: YouTube's metadata screen often has an empty UI hierarchy
            // (no accessible children). In this case we must tap by coordinates.
            // On a 1080x2400 screen:
            //   "Upload Short" button is at bottom-right, roughly (900, 2340)
            //   "Save draft" button is at bottom-left, roughly (270, 2340)
            console.log("[Upload] ⚠️ Upload button not found by selector — using coordinate tap...");
            console.log("[Upload] Tapping 'Upload Short' at coordinates (900, 2340)...");
            await agent.actions.tap(900, 2340);
            hasStartedUpload = true;
            hasSetMetadata = true;
            await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
            await submitProgress("uploading_video");
            return true;
        },
    },

    /**
     * Uploading/Processing — wait for upload to complete
     */
    Uploading: {
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            return detectUploadingScreen(allNodes);
        },

        handleScreen: async () => {
            console.log("[Upload] Upload in progress, waiting...");
            await submitProgress("upload_in_progress");
            // Just wait — the next iteration will check if it's done
            await sleep(UPLOAD_CONFIG.UPLOAD_POLL_INTERVAL);
            return true;
        },
    },

    /**
     * Upload Success — video was uploaded successfully!
     */
    UploadSuccess: {
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            return detectUploadSuccess(allNodes);
        },

        handleScreen: async () => {
            console.log("[Upload] ===== UPLOAD SUCCESSFUL! =====");
            addData({ upload_completed_at: new Date().toISOString() });
            await setStage(Stage.Verify);
            return true;
        },
    },
} as const satisfies ScreenHandles<keyof typeof UploadStageScreen>;

/**
 * Export the stage definition
 */
const UploadStage = {
    name: "Upload",
    maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
    screens: UploadStageScreen,
    screenHandles: UploadHandles,

    /**
     * Called when entering this stage
     * The YouTube app should already be open from the Download stage
     */
    defaultHandle: async () => {
        console.log("=== UPLOAD STAGE STARTED ===");
        console.log("Video will be uploaded from:", getDownloadPath());

        // Reset sub-step tracking
        hasClickedCreate = false;
        hasSelectedVideo = false;
        hasPassedTrim = false;
        hasPassedEditor = false;
        hasSetMetadata = false;
        hasStartedUpload = false;

        addData({ upload_stage_started_at: new Date().toISOString() });
        await submitProgress("starting_upload_flow");

        // Ensure YouTube is in the foreground
        const screenContent = await agent.actions.screenContent();
        const allNodes = screenContent.allNodes();

        if (!isYouTubeOpen(allNodes)) {
            console.log("[Upload] YouTube not in foreground, launching...");
            await agent.actions.launchApp(APP_PACKAGE_NAME, true);
            await sleep(UPLOAD_CONFIG.SCREEN_TRANSITION_DELAY);
        }

        // The main loop in main.ts will handle screen detection and transitions from here
    },
} as const satisfies Stage<typeof UploadStageScreen>;

export default UploadStage;
