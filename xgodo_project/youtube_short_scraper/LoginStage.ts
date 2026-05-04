/**
 * YouTube Launch Stage - Opens YouTube and navigates to Shorts
 *
 * This stage:
 * 1. Launches YouTube app
 * 2. Waits for YouTube home screen to load
 * 3. Looks for and clicks the Shorts button
 * 4. If not found, goes back and tries again
 */

import { APP_PACKAGE_NAME, DEFAULT_MAX_STEPS_PER_STAGE } from "./config";
import { Stage, type ScreenHandles, setStage } from "./Stage";
import {
  detectYouTubeHome,
  detectShortsFeed,
  getShortsButton,
  isYouTubeOpen,
  isWatchHistoryOff
} from "./screenDetector";
import { fail } from "./data";

/**
 * Define the screens this stage can handle
 */
const LaunchStageScreen = {
  YouTubeHome: "YouTubeHome",
  ShortsFeed: "ShortsFeed",
  NotYouTube: "NotYouTube",
} as const;

/**
 * Screen handlers for the launch stage
 */
const LaunchHandles = {
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
      console.log("Not in YouTube, launching app...");
      await agent.actions.launchApp(APP_PACKAGE_NAME, true);
      await sleep(3000);
      return true;
    },
  },

  YouTubeHome: {
    /**
     * Detect if we're on YouTube home screen
     */
    detectScreen: async (screenContent) => {
      const allNodes = screenContent.allNodes();
      return detectYouTubeHome(allNodes);
    },

    /**
     * Handle YouTube home - click on Shorts button
     */
    handleScreen: async (screenContent) => {
      const allNodes = screenContent.allNodes();
      const shortsButton = getShortsButton(allNodes);

      if (shortsButton) {
        console.log("Found Shorts button on home screen, clicking...");
        await shortsButton.randomClick();
        await sleep(3000);

        // Transition to Action stage after clicking Shorts
        await setStage(Stage.Action);
        return true;
      }

      console.log("On YouTube home but Shorts button not found");
      return false;
    },
  },

  ShortsFeed: {
    /**
     * Detect if we're already on Shorts feed
     */
    detectScreen: async (screenContent) => {
      const allNodes = screenContent.allNodes();
      return detectShortsFeed(allNodes);
    },

    /**
     * Already on Shorts, transition to Action stage
     */
    handleScreen: async () => {
      console.log("Already on Shorts feed");
      await setStage(Stage.Action);
      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof LaunchStageScreen>;

/**
 * Export the stage definition
 */
const LaunchStage = {
  name: "Login", // Keeping name as "Login" to match Stage.ts registration
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
  screens: LaunchStageScreen,
  screenHandles: LaunchHandles,

  /**
   * Called when entering this stage
   * Launch YouTube and check for Shorts button up to 5 times
   * If not found after 5 attempts, fail the task
   */
  defaultHandle: async () => {
    console.log("Launching YouTube...");
    await agent.actions.launchApp(APP_PACKAGE_NAME, true);
    await sleep(5000); // Wait 5 seconds for app to fully load

    // Check for Shorts button up to 5 times
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      attempts++;
      console.log(`Checking for Shorts button (attempt ${attempts}/${maxAttempts})...`);

      const screenContent = await agent.actions.screenContent();
      const allNodes = screenContent.allNodes();

      // Check if we're on YouTube
      if (!isYouTubeOpen(allNodes)) {
        console.log("Not on YouTube, waiting...");
        await sleep(2000);
        continue;
      }

      // Check if watch history is turned off (prevents Shorts from loading)
      if (isWatchHistoryOff(allNodes)) {
        console.error("Watch history is turned off. YouTube Shorts cannot load without watch history enabled.");
        await fail("Watch history is turned off. Please enable watch history in YouTube settings to use Shorts.");
        return;
      }

      // Look for Shorts button
      console.log("On YouTube, looking for Shorts button...");
      const shortsButton = getShortsButton(allNodes);

      if (shortsButton) {
        console.log("Found Shorts button!");
        console.log("Clicking Shorts button...");
        await shortsButton.randomClick();
        await sleep(3000);

        // Check if we're now on Shorts feed
        const newScreen = await agent.actions.screenContent();
        if (detectShortsFeed(newScreen.allNodes())) {
          console.log("Successfully navigated to Shorts feed!");
          await setStage(Stage.Action);
          return;
        } else {
          console.log("Clicked Shorts button but not on Shorts feed yet");
        }
      } else {
        console.log("Shorts button not found on screen");
      }

      // If we haven't found Shorts button (or not on Shorts feed), press back and try again
      if (attempts < maxAttempts) {
        console.log("Pressing back to retry...");
        await agent.actions.goBack();
        await sleep(2000);
      }
    }

    // Failed after 5 attempts
    console.error(`Failed to find Shorts button after ${maxAttempts} attempts`);
    await fail(`Shorts button not found after ${maxAttempts} attempts. Unable to navigate to Shorts feed.`);
  },
} as const satisfies Stage<typeof LaunchStageScreen>;

export default LaunchStage;
