/**
 * YouTube Shorts Upload Agent - Main Entry Point
 *
 * Stage-based automation for uploading Short videos to YouTube.
 *
 * Flow: Login → Download → Upload → Verify
 *
 * Job Variables (configure these when creating a job on xgodo):
 * - video_url (REQUIRED): URL of the video to download and upload
 *   Format: host:port/file.format or domain/path/file.format
 * - video_title (optional): Title for the YouTube Short
 * - video_description (optional): Description for the Short
 * - video_visibility (optional): "public" | "unlisted" | "private" (default: public)
 * - video_hashtags (optional): Comma-separated hashtags (e.g., "shorts,funny,viral")
 */

import { addData, fail, getData } from './data';
import {
    stages,
    Stage,
    ScreenState,
    setStage,
    steps,
    setSteps,
    getStageObject,
    ScreenHandle,
} from './Stage';
import { hideSystemUIs } from './utils';

// Maximum times we can see the same screen without progress
// before attempting recovery (go home and retry)
const MAX_STILL_SCREENS = 5;

// Timeout: 25 minutes (adjust based on job max duration)
// If the job duration is 30 minutes, use 25-27 minutes here
setTimeout(() => {
    agent.utils.outOfSteps.submit("timeout")
        .then(result => {
            if (result.success) {
                const data = getData();
                if (data && Array.isArray(data.outOfStepIds)) {
                    addData({ outOfStepIds: [...data.outOfStepIds, result.id] })
                } else {
                    addData({ outOfStepIds: [result.id] })
                }
            } else {
                console.error(result.error);
            }
        })
        .catch(console.error);
}, 25 * 60 * 1000); // 25 minutes

async function main() {
    console.log("=== YouTube Shorts Upload Automation Started ===");
    console.log("Timestamp:", new Date().toISOString());

    // Skip Login — go straight to Download stage.
    // Download handles: Chrome launch → download video → launch YouTube → transition to Upload.
    const downloadStage = stages.find(stage => stage.name === Stage.Download);
    if (downloadStage) {
        console.log("[Main] Executing Download stage (Chrome → download → YouTube)...");
        await downloadStage.defaultHandle();
    }

    // Track consecutive same-screen detections for stuck detection
    let screenCount: { screen: (keyof typeof ScreenState) | "Unknown", count: number } | undefined = undefined;

    // Main automation loop
    do {
        // Decrement step counter
        await setSteps(steps - 1);

        const currentStageObject = await getStageObject();

        // Get current screen content
        let screenContent = await agent.actions.screenContent();

        if (await hideSystemUIs(screenContent)) {
            screenContent = await agent.actions.screenContent();
        }

        let screenState: keyof typeof ScreenState | undefined = undefined;
        let screenHandle: ScreenHandle | undefined = undefined;

        // Try to detect the current screen (with retries)
        let maxDetectSteps = 3;
        while (maxDetectSteps-- > 0 && !screenState && !screenHandle) {
            // Check each screen handler in the current stage
            for (const [screenStateDetect, screenHandleDetect] of Object.entries(currentStageObject.screenHandles)) {
                const detect = await screenHandleDetect.detectScreen(screenContent);
                if (detect) {
                    screenState = screenStateDetect as keyof typeof ScreenState;
                    screenHandle = screenHandleDetect;
                    break;
                }
            }
            // Wait before retrying if no screen detected
            if (!screenState) {
                await sleep(5_000);
            }
        }

        console.log("Detected screen:", screenState || "Unknown", "| Stage:", currentStageObject.name, "| Steps remaining:", steps);

        // Store screen for out-of-steps tracking
        await agent.utils.outOfSteps.storeScreen(
            screenContent,
            currentStageObject.name,
            screenState || "Unknown",
            steps,
            screenState ? ScreenshotRecord.LOW_QUALITY : ScreenshotRecord.HIGH_QUALITY,
        );

        // Track consecutive same-screen occurrences
        if (!screenCount || screenCount.screen !== (screenState || "Unknown")) {
            screenCount = {
                screen: screenState || "Unknown",
                count: 1,
            };
        } else {
            screenCount.count++;
        }

        // Recovery: If stuck on the same screen too long, go home and retry
        if (screenCount.count > MAX_STILL_SCREENS) {
            console.log("Stuck on same screen, attempting recovery...");
            await agent.actions.goHome();
            await sleep(1 * 60 * 1000, 2 * 60 * 1000); // Random wait 1-2 minutes
            // Re-launch the app via the current stage's default handler
            await currentStageObject.defaultHandle();
            continue;
        }

        // Skip if no screen detected
        if (!screenState || !screenHandle) {
            console.log("No screen detected, waiting...");
            await sleep(3_000);
            continue;
        }

        // Handle the detected screen
        const screenHandled = await screenHandle.handleScreen(screenContent);

        if (!screenHandled) {
            console.error("Failed to handle screen", screenState);
        }

    } while (steps > 0)

    // If we run out of steps, submit out-of-steps data and fail
    const result = await agent.utils.outOfSteps.submit("outOfSteps");
    if (result.success) {
        const data = getData();
        if (data && Array.isArray(data.outOfStepIds)) {
            addData({ outOfStepIds: [...data.outOfStepIds, result.id] })
        } else {
            addData({ outOfStepIds: [result.id] })
        }
    } else {
        console.error(result.error);
    }
    await fail("OUT_OF_STEPS");
}

// Run the automation
main()
    .catch(async e => {
        console.error(e);
        try {
            const result = await agent.utils.reportCrash(e);
            console.log(JSON.stringify(result));
        } catch (e) {
            console.error(e);
        }
        try {
            console.log("Failing task due to crash");
            await fail("CRASH");
        } catch (e) {
            console.error(e);
        }
    })
    .finally(agent.control.stopCurrentAutomation);
