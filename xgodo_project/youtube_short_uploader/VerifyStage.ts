/**
 * Verify Stage - Confirms upload success and submits results
 *
 * This stage:
 * 1. Confirms the video was uploaded successfully
 * 2. Collects any result data (video URL, etc.)
 * 3. Submits the success result back to xgodo
 */

import { DEFAULT_MAX_STEPS_PER_STAGE, JOB_VARS, getJobVar } from "./config";
import { Stage, type ScreenHandles } from "./Stage";
import { success, addData, getTaskDuration } from "./data";
import type { UploadResult } from "./data";

/**
 * Define the screens this stage can handle
 * 
 * 
 */
const VerifyStageScreen = {
    Verifying: "Verifying",
} as const;

/**
 * Screen handlers for the verify stage
 */
const VerifyHandles = {
    Verifying: {
        /**
         * Always detect — this stage just wraps up
         */
        detectScreen: async (_screenContent) => {
            return true;
        },

        /**
         * Submit success and finish
         */
        handleScreen: async () => {
            console.log("[Verify] handleScreen called — success should already be submitted by defaultHandle");
            return true;
        },
    },
} as const satisfies ScreenHandles<keyof typeof VerifyStageScreen>;

/**
 * Export the stage definition
 */
const VerifyStage = {
    name: "Verify",
    maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
    screens: VerifyStageScreen,
    screenHandles: VerifyHandles,

    /**
     * Called when entering this stage
     * Compile the final result and submit success
     */
    defaultHandle: async () => {
        console.log("=== VERIFY STAGE - SUBMITTING SUCCESS ===");

        // Compile the upload result
        const uploadResult: UploadResult = {
            video_url: getJobVar(JOB_VARS.VIDEO_URL) || "unknown",
            video_title: getJobVar(JOB_VARS.VIDEO_TITLE) || "Short video #shorts",
            video_description: getJobVar(JOB_VARS.VIDEO_DESCRIPTION) || null,
            video_visibility: getJobVar(JOB_VARS.VIDEO_VISIBILITY) || "Public",
            upload_status: "success",
            upload_error: null,
            download_started_at: null, // These will be in the data store already
            download_completed_at: null,
            upload_started_at: null,
            upload_completed_at: new Date().toISOString(),
            total_duration_seconds: getTaskDuration(),
        };

        console.log("Upload Result:", JSON.stringify(uploadResult, null, 2));

        // Take a final screenshot as proof of completion
        try {
            const screenshot = await agent.actions.screenshot(1024, 1024, 100);
            if (screenshot.screenshot) {
                addData({
                    upload_result: uploadResult,
                    completion_screenshot: screenshot.screenshot,
                });
            } else {
                addData({ upload_result: uploadResult });
            }
        } catch (e) {
            console.log("Could not capture completion screenshot:", e);
            addData({ upload_result: uploadResult });
        }

        // Submit success!
        await success({ upload_result: uploadResult });
        console.log("=== AUTOMATION COMPLETE ===");
    },
} as const satisfies Stage<typeof VerifyStageScreen>;

export default VerifyStage;
