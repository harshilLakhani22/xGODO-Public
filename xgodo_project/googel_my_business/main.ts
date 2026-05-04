declare const ScreenshotRecord: any;
/**
 * Google Maps Business Search Automation
 * 
 * This automation takes a business name and address, searches for it
 * on Google Maps, and navigates to the business location on the map.
 * 
 * Stage Flow:
 * MapsSearch: SearchBarScreen → TypingScreen → SuggestionsScreen → MapResultScreen (Success!)
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
    registerStages,
} from './Stage';
import { MapsSearchStage } from './MapsSearchStage';
import { ReviewStage } from './ReviewStage';
import { hideSystemUIs, goBack, sleep, scrollDown, launchApp } from './util';
import { StageName, APP_PACKAGE_NAME } from './config';

// Register stages manually to avoid circular dependencies
registerStages([MapsSearchStage, ReviewStage]);

// Maximum times we can see the same screen without progress
const MAX_STILL_SCREENS = 15;

// Timeout after 10 minutes (adjust based on your job duration)
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
}, 10 * 60 * 1000); // 10 minutes

async function main() {
    console.log("=== Google Maps Business Search + Review Automation ===");
    console.log("Automation started");

    // Validate job variables
    const name = agent.arguments.jobVariables.name;
    const address = agent.arguments.jobVariables.address;

    // New job variables for review (optional with defaults)
    const starRating = parseInt(String(agent.arguments.jobVariables.starRating)) || 5;
    const reviewText = agent.arguments.jobVariables.reviewText || "";

    if (!name || !address) {
        console.error("Missing required job variables: 'name' and 'address'");
        await fail("MISSING_JOB_VARIABLES");
        return;
    }

    console.log(`Business Name: ${name}`);
    console.log(`Address: ${address}`);
    console.log(`Star Rating: ${starRating}`);
    console.log(`Review Text: ${reviewText ? reviewText.substring(0, 30) + "..." : "(empty - search only)"}`);

    // Store job variables in data for use by stage handlers
    addData({
        businessName: name.trim(),
        address: address.trim(),
        starRating: starRating,
        reviewText: reviewText.trim()
    });

    // Start with our MapsSearch stage
    await setStage(StageName.MapsSearch);

    // Execute the stage's default handler (launch Google Maps)
    await stages.find(stage => stage.name === StageName.MapsSearch)?.defaultHandle();

    // Track consecutive same-screen detections for stuck detection
    let screenCount: { screen: (keyof typeof ScreenState) | "Unknown", count: number } | undefined = undefined;

    // Main automation loop
    do {
        // Decrement step counter
        await setSteps(steps - 1);

        const currentStageObject = await getStageObject();

        // Get current screen content
        let screenContent = await agent.actions.screenContent();

        // Hide any system UIs that might be blocking
        if (await hideSystemUIs(screenContent)) {
            screenContent = await agent.actions.screenContent();
        }

        let screenState: keyof typeof ScreenState | undefined = undefined;
        let screenHandle: ScreenHandle | undefined = undefined;

        // Try to detect the current screen
        let maxDetectSteps = 3;
        while (maxDetectSteps-- > 0 && !screenState && !screenHandle) {
            for (const [screenStateDetect, screenHandleDetect] of Object.entries(currentStageObject.screenHandles) as [string, ScreenHandle][]) {
                const detect = await screenHandleDetect.detectScreen(screenContent);
                if (detect) {
                    screenState = screenStateDetect as keyof typeof ScreenState;
                    screenHandle = screenHandleDetect;
                    break;
                }
            }
            if (!screenState) {
                await sleep(2000);
                screenContent = await agent.actions.screenContent();
            }
        }

        console.log("Detected screen:", screenState || "Unknown", "| Steps remaining:", steps);

        // Store screen for debugging
        await agent.utils.outOfSteps.storeScreen(
            screenContent,
            currentStageObject.name,
            (screenState || "Unknown") as string,
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

        // Recovery: If stuck on the same screen too long
        // CRITICAL FIX: Don't use goHome() as it destroys the Maps context!
        if (screenCount.count > MAX_STILL_SCREENS) {
            console.log("Stuck on same screen, attempting recovery...");

            // First try: goBack() to dismiss any dialogs/overlays
            await goBack();
            await sleep(2000);

            // Check if we're still in Maps
            const recoveryScreen = await agent.actions.screenContent();
            const stillInMaps = recoveryScreen.packageName === APP_PACKAGE_NAME;

            if (!stillInMaps) {
                // Only relaunch if we actually left Maps
                // CRITICAL FIX: Use false to avoid clearing app data/state
                console.log("Left Maps app, relaunching without state reset...");
                await launchApp(APP_PACKAGE_NAME, false);
                await sleep(5000);
            } else {
                // Still in Maps, just scroll or wait
                console.log("Still in Maps, trying scroll recovery...");
                await scrollDown();
                await sleep(2000);
            }

            screenCount.count = 0;
            continue;
        }

        // Skip if no screen detected
        if (!screenState || !screenHandle) {
            console.log("No screen detected, waiting...");
            await sleep(2000);
            continue;
        }

        // Handle the detected screen
        const screenHandled = await screenHandle.handleScreen(screenContent);

        if (!screenHandled) {
            console.error("Failed to handle screen:", screenState);
        }

        // Small delay between iterations
        await sleep(1000);

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
    .catch(async (e) => {
        // Log if it crashes
        console.error(e);
        try {
            // Report crash to server
            const result = await agent.utils.reportCrash(e);
            console.log(JSON.stringify(result));
        } catch (reportError) {
            console.error("Failed to report crash:", reportError);
        }
        try {
            // Fail the task
            console.log("Failing task due to crash");
            await fail("CRASH");
        } catch (failError) {
            console.error("Failed to fail task:", failError);
        }
    })
    .finally(agent.control.stopCurrentAutomation);
