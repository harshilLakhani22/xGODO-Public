/**
 * Action Stage - Example stage for performing the main task
 *
 * This stage handles the core action of your automation.
 * After login, this is where you perform the actual work.
 */

import { APP_PACKAGE_NAME, DEFAULT_MAX_STEPS_PER_STAGE } from "./config";
import { addData, success, fail } from "./data";
import { type Stage, type ScreenHandles } from "./Stage";

/**
 * Define the screens this stage can handle
 */
const ActionStageScreen = {
  MainScreen: "MainScreen",
  ResultScreen: "ResultScreen",
  // Add more screens as needed:
  // ConfirmDialog: "ConfirmDialog",
  // ErrorScreen: "ErrorScreen",
} as const;

/**
 * Screen handlers for the action stage
 */
const ActionHandles = {
  MainScreen: {
    /**
     * Detect the main app screen where actions are performed
     */
    detectScreen: async (screenContent) => {
      // Customize this to detect your app's main screen
      // Example: Look for a specific button, menu, or content
      return !!screenContent.findAdvanced(
        filter => filter.hasPackageName(APP_PACKAGE_NAME) &&
                  filter.text(t => !!t?.toLowerCase().includes("home") ||
                                   !!t?.toLowerCase().includes("dashboard"))
      );
    },

    /**
     * Perform the main action on this screen
     */
    handleScreen: async (screenContent) => {

      // Example: Click on a specific element
      // Customize this for your automation's task
      const targetElement = screenContent.findAdvanced(
        filter => filter.hasPackageName(APP_PACKAGE_NAME) &&
                  filter.isClickable() &&
                  filter.text(t => !!t?.includes(agent.arguments.jobVariables.targetText || ""))
      );

      if (targetElement) {
        targetElement.randomClick();
        await sleep(2_000);

        // Store data about what was clicked
        addData({ clickedElement: targetElement.text });
        return true;
      }

      // If we can't find the target, try scrolling
      screenContent.randomSwipe("up");
      await sleep(1_000);

      return false;
    },
  },

  ResultScreen: {
    /**
     * Detect when the result/success screen is shown
     */
    detectScreen: async (screenContent) => {
      // Customize to detect your success condition
      return !!screenContent.findAdvanced(
        filter => filter.hasPackageName(APP_PACKAGE_NAME) &&
                  filter.text(t => !!t?.toLowerCase().includes("success") ||
                                   !!t?.toLowerCase().includes("complete") ||
                                   !!t?.toLowerCase().includes("done"))
      );
    },

    /**
     * Handle the result screen - collect data and complete
     */
    handleScreen: async () => {
      const screenContent = await agent.actions.screenContent();

      // Example: Extract result data from the screen
      const resultText = screenContent.findAdvanced(
        filter => filter.hasPackageName(APP_PACKAGE_NAME) &&
                  filter.text(t => (t?.length || 0) > 10) // Find text content
      );

      if (resultText) {
        // Store the result
        addData({ result: resultText.text });
      }

      // Complete the task successfully
      await success();
      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof ActionStageScreen>;

/**
 * Export the stage definition
 */
const ActionStage = {
  name: "Action",
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
  screens: ActionStageScreen,
  screenHandles: ActionHandles,

  /**
   * Called when entering this stage
   * The app should already be open from the previous stage
   */
  defaultHandle: async () => {
    // Ensure the app is in foreground
    await agent.actions.launchApp(APP_PACKAGE_NAME, false);
    await sleep(1_000);
  },
} as const satisfies Stage<typeof ActionStageScreen>;

export default ActionStage;
