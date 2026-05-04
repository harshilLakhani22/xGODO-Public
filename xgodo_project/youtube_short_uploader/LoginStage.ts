/**
 * Login Stage - Opens YouTube and ensures user is logged in
 *
 * This stage:
 * 1. Launches YouTube app
 * 2. Waits for YouTube home screen to load
 * 3. Checks if user is logged in (profile icon visible)
 * 4. Transitions to Download stage once ready
 */

import { APP_PACKAGE_NAME, DEFAULT_MAX_STEPS_PER_STAGE } from "./config";
import { Stage, type ScreenHandles, setStage } from "./Stage";
import { detectYouTubeHome } from "./screenDetector";
import { isYouTubeOpen } from "./utils";
import { fail } from "./data";

/**
 * Define the screens this stage can handle
 */
const LoginStageScreen = {
    YouTubeHome: "YouTubeHome",
    NotYouTube: "NotYouTube",
} as const;

/**
 * Screen handlers for the login stage
 */
const LoginHandles = {
    NotYouTube: {
        /**
         * Detect if we're not in YouTube app
         */
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            return !isYouTubeOpen(allNodes);
        },

        /**
         * Handle not being in YouTube - launch the app
         */
        handleScreen: async () => {
            console.log("[Login] STEP: Not in YouTube app, launching...");
            console.log("[Login] App package:", APP_PACKAGE_NAME);
            await agent.actions.launchApp(APP_PACKAGE_NAME, true);
            console.log("[Login] ✅ App launch command sent, waiting 3s...");
            await sleep(3000);
            return true;
        },
    },

    YouTubeHome: {
        /**
         * Detect if we're on YouTube home screen (means we're logged in)
         */
        detectScreen: async (screenContent) => {
            const allNodes = screenContent.allNodes();
            return detectYouTubeHome(allNodes);
        },

        /**
         * YouTube is open and we're on home - transition to Download stage
         */
        handleScreen: async () => {
            console.log("[Login] ✅ YouTube is open and user is logged in!");
            console.log("[Login] Transitioning to Download stage...");
            await setStage(Stage.Download);
            return true;
        },
    },
} as const satisfies ScreenHandles<keyof typeof LoginStageScreen>;

/**
 * Export the stage definition
 */
const LoginStage = {
    name: "Login",
    maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
    screens: LoginStageScreen,
    screenHandles: LoginHandles,

    /**
     * Called when entering this stage
     * Launch YouTube and verify it's loaded
     */
    defaultHandle: async () => {
        console.log("========================================");
        console.log("[Login] LOGIN STAGE STARTED");
        console.log("========================================");
        console.log("[Login] STEP 1: Launching YouTube app...");
        console.log("[Login] App package:", APP_PACKAGE_NAME);
        await agent.actions.launchApp(APP_PACKAGE_NAME, true);
        console.log("[Login] ✅ Launch command sent, waiting 5s...");
        await sleep(5000);

        let attempts = 0;
        const maxAttempts = 5;

        while (attempts < maxAttempts) {
            attempts++;
            console.log(`[Login] STEP 2: Checking YouTube state (attempt ${attempts}/${maxAttempts})...`);

            const screenContent = await agent.actions.screenContent();
            const allNodes = screenContent.allNodes();
            console.log(`[Login] Screen has ${allNodes.length} nodes`);

            // Log key nodes for debugging
            const ytNodes = allNodes.filter((n: any) => n.packageName === APP_PACKAGE_NAME);
            console.log(`[Login] YouTube nodes: ${ytNodes.length}`);
            for (const n of ytNodes.slice(0, 10)) {
                console.log(`  class=${n.className || '?'} id=${n.viewId || ''} text="${(n.text || '').substring(0, 40)}" desc="${(n.description || '').substring(0, 40)}"`);
            }

            if (!isYouTubeOpen(allNodes)) {
                console.log("[Login] ⚠️ YouTube not open yet, waiting 2s...");
                await sleep(2000);
                continue;
            }

            if (detectYouTubeHome(allNodes)) {
                console.log("[Login] ✅ YouTube Home screen detected! User is logged in.");
                await setStage(Stage.Download);
                return;
            }

            if (attempts < maxAttempts) {
                console.log("[Login] ⚠️ YouTube open but not on Home, pressing back...");
                await agent.actions.goBack();
                await sleep(2000);
            }
        }

        console.error(`[Login] ❌ FATAL: Failed to reach YouTube Home after ${maxAttempts} attempts`);
        await fail(`YouTube Home not reachable after ${maxAttempts} attempts`);
    },
} as const satisfies Stage<typeof LoginStageScreen>;

export default LoginStage;
