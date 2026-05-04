declare const ScreenshotRecord: any;
declare const agent: any;
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
} from './Stage';
import { hideSystemUIs } from './util';

// Maximum times we can see the same screen without progress
const MAX_STILL_SCREENS = 5;

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
    console.log("=== Google Maps Business Search Automation ===");
    console.log("Automation started");

    // Validate job variables
    const name = agent.arguments.jobVariables.name;
    const address = agent.arguments.jobVariables.address;
    const starRating = agent.arguments.jobVariables.starRating;
    const reviewText = agent.arguments.jobVariables.reviewText;

    if (!name || !address) {
        console.error("Missing required job variables: 'name' and 'address'");
        await fail("MISSING_JOB_VARIABLES");
        return;
    }

    console.log(`Business Name: ${name}`);
    console.log(`Address: ${address}`);
    console.log(`Rating: ${starRating}`);
    console.log(`Review: ${reviewText}`);

    // Store job variables in data for use by stage handlers
    addData({
        businessName: name.trim(),
        address: address.trim(),
        starRating: starRating,
        reviewText: reviewText
    });

    // Start with our MapsSearch stage
    await setStage(Stage.MapsSearch);

    // Execute the stage's default handler (launch Google Maps)
    await stages.find(stage => stage.name === Stage.MapsSearch)?.defaultHandle();

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
        if (screenCount.count > MAX_STILL_SCREENS) {
            console.log("Stuck on same screen, attempting recovery...");
            await agent.actions.goHome();
            await sleep(3000);
            await currentStageObject.defaultHandle();
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
    .catch(console.error)
    .finally(agent.control.stopCurrentAutomation);
