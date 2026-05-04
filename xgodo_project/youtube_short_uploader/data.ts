/**
 * Data management for YouTube Shorts Upload Automation
 *
 * This module handles storing and retrieving data that will be
 * submitted with task results. Use this to collect information
 * during the automation that needs to be reported back.
 */

/**
 * Interface for upload result
 */
export interface UploadResult {
    // Input parameters
    video_url: string;
    video_title: string;
    video_description: string | null;
    video_visibility: string;

    // Upload result
    upload_status: 'success' | 'failed' | 'unknown';
    upload_error: string | null;

    // Timestamps
    download_started_at: string | null;
    download_completed_at: string | null;
    upload_started_at: string | null;
    upload_completed_at: string | null;

    // Task duration
    total_duration_seconds: number;
}

// Internal data store
let data: Record<string, any> = {};

// Task start time
let taskStartTime: string = new Date().toISOString();

/**
 * Get all collected data
 */
export function getData() {
    return data;
}

/**
 * Replace all data with new data
 */
export function setData(newData: Record<string, any>) {
    data = newData;
}

/**
 * Merge new data into existing data
 * Useful for adding results from different stages
 */
export function addData(dataToAdd: Record<string, any>) {
    data = { ...data, ...dataToAdd };
}

/**
 * Get task start time
 */
export function getTaskStartTime(): string {
    return taskStartTime;
}

/**
 * Calculate task duration in seconds
 */
export function getTaskDuration(): number {
    const start = new Date(taskStartTime).getTime();
    const end = new Date().getTime();
    return Math.round((end - start) / 1000);
}

/**
 * Submit debug out-of-steps data before ending the task.
 * Stores the submission ID in the task data for traceability.
 */
async function submitDebugData() {
    try {
        const result = await agent.utils.outOfSteps.submit("debug");
        if (result.success) {
            const existing = getData();
            if (existing && Array.isArray(existing.outOfStepIds)) {
                addData({ outOfStepIds: [...existing.outOfStepIds, result.id] });
            } else {
                addData({ outOfStepIds: [result.id] });
            }
            console.log("Debug data submitted with ID:", result.id);
        } else {
            console.error("Failed to submit debug data:", result.error);
        }
    } catch (error) {
        console.error("Error submitting debug data:", error);
    }
}

/**
 * Submit a failed task with optional screenshot
 *
 * @param comment - A reason code or message for the failure
 * @param screenshot - Whether to capture a screenshot (default: true)
 */
export async function fail(comment: string, screenshot: boolean = true) {
    let existingComment = getData().comments;
    if (existingComment) {
        existingComment += "|";
    } else {
        existingComment = "";
    }

    addData({ comments: existingComment + comment });

    // Submit debug out-of-steps data before failing
    await submitDebugData();

    // Capture screenshot before going home (to preserve failure state)
    const screenshotData = screenshot
        ? (await agent.actions.screenshot(1024, 1024, 100)).screenshot || ""
        : "";

    // Go home to close the app before ending
    await agent.actions.goHome();

    await agent.utils.job.submitTask(
        "failed",
        getData(),
        true,
        screenshot ? [{
            name: "failureScreenshot",
            extension: ".jpeg",
            base64Data: screenshotData
        }] : [],
    );

    agent.control.stopCurrentAutomation();
}

/**
 * Submit a successful task with collected data
 *
 * @param additionalData - Any additional data to include in the result
 */
export async function success(additionalData?: Record<string, any>) {
    if (additionalData) {
        addData(additionalData);
    }

    // Submit debug out-of-steps data before succeeding
    await submitDebugData();

    // Go home to close the app before ending
    await agent.actions.goHome();

    await agent.utils.job.submitTask("success", getData(), true, []);
    agent.control.stopCurrentAutomation();
}

/**
 * Submit progress update without finishing the task.
 * Call this to show real-time progress to the job dashboard.
 */
export async function submitProgress(status: string) {
    addData({ progress_status: status });
    await agent.utils.job.submitTask("running", getData(), false, []);
}
