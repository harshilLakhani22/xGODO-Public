/**
 * Automation Template - Stage-Based Pattern
 *
 * This template demonstrates a robust stage-based automation pattern:
 *
 * 1. Stages: Distinct phases of your workflow (Login -> Action -> Complete)
 * 2. Screens: Different UI states within each stage
 * 3. Screen Detection: Identify which screen is currently displayed
 * 4. Screen Handling: Perform actions based on the detected screen
 *
 * Key Features:
 * - Automatic screen detection and handling
 * - Out-of-steps tracking for unknown screens
 * - Recovery from stuck states
 * - Step counting to prevent infinite loops
 *
 * To customize this template:
 * 1. Update config.ts with your app's package name
 * 2. Modify LoginStage.ts and ActionStage.ts for your app
 * 3. Add more stages as needed by creating new *Stage.ts files
 * 4. Register new stages in Stage.ts
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
import { hideSystemUIs } from './util';

// Maximum times we can see the same screen without progress
// before attempting recovery (go home and retry)
const MAX_STILL_SCREENS = 5;

// Co-ordicate with job creator about what will be max time duration that the agent can run
// For example if job duration (max time) is 30 minutes, you can use something like 25 or 27 for timeout
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
}, 25 * 60 * 1000); // 25 minutes. Change this according to job duration.

async function main() {
    console.log("Automation started");

    // Start with the first stage (Login)
    await setStage(Stage.Login);

    // Execute the stage's default handler (e.g., launch the app)
    await stages.find(stage => stage.name === Stage.Login)?.defaultHandle();

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

        console.log("Detected screen:", screenState || "Unknown");

        // Store screen for out-of-steps tracking
        // Unknown screens get high-quality screenshots for debugging
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
        // log if it crashes
        console.error(e);
        try {
            // report crash to server
            const result = await agent.utils.reportCrash(e);
            console.log(JSON.stringify(result));
        } catch (e) {
            console.error(e);
        }
        try {
            // fail the task
            console.log("Failing task due to crash");
            await fail("CRASH");
        } catch (e) {
            console.error(e);
        }
    })
    .finally(agent.control.stopCurrentAutomation);
