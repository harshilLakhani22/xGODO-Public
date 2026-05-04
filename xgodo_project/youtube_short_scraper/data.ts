/**
 * Data management for YouTube Shorts Data Mining Automation
 *
 * This module handles storing and retrieving data that will be
 * submitted with task results. Use this to collect information
 * during the automation that needs to be reported back.
 */

/**
 * Interface for collected Shorts video data
 */
export interface ShortsVideoData {
    // Video identification
    video_id: string;
    video_url: string;

    // Video metadata
    title: string | null;
    duration_seconds: number | null;
    upload_date: string | null; // ISO8601 format

    // Channel information
    channel_id: string | null;
    channel_name: string | null;
    channel_url: string | null;
    channel_creation_date: string | null; // ISO8601 format - from YouTube Data API
    channel_video_count: number | null; // Total number of public videos on the channel - from YouTube Data API

    // Engagement metrics
    view_count: number | null;
    like_count: number | null;
    comment_count: number | null;

    // Collection metadata
    collected_at: string; // ISO8601 timestamp
    collection_order: number; // Order in which video was collected (1, 2, 3...)
}

/**
 * Interface for the final collection result
 */
export interface CollectionResult {
    videos: ShortsVideoData[];
    total_collected: number;
    requested_count: number;
    collection_duration_seconds: number;
    collection_start_time: string; // ISO8601 timestamp
    collection_end_time: string; // ISO8601 timestamp
    api_key_used: boolean;
    errors?: string[]; // Any errors encountered during collection
}

// Internal data store
let data: Record<string, any> = {};

// Array to store collected video data
let collectedVideos: ShortsVideoData[] = [];

// Collection start time
let collectionStartTime: string | null = null;

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
 * Add a collected video to the collection
 */
export function addCollectedVideo(video: ShortsVideoData) {
    collectedVideos.push(video);
}

/**
 * Get all collected videos
 */
export function getCollectedVideos(): ShortsVideoData[] {
    return collectedVideos;
}

/**
 * Set collection start time
 */
export function setCollectionStartTime() {
    collectionStartTime = new Date().toISOString();
}

/**
 * Get collection start time
 */
export function getCollectionStartTime(): string | null {
    return collectionStartTime;
}

/**
 * Create the final collection result object
 */
export function createCollectionResult(requestedCount: number, apiKeyUsed: boolean): CollectionResult {
    const endTime = new Date().toISOString();
    const startTime = collectionStartTime || endTime;

    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    const durationSeconds = Math.round((end - start) / 1000);

    return {
        videos: collectedVideos,
        total_collected: collectedVideos.length,
        requested_count: requestedCount,
        collection_duration_seconds: durationSeconds,
        collection_start_time: startTime,
        collection_end_time: endTime,
        api_key_used: apiKeyUsed,
    };
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
 * Submit progress update without finishing the task.
 * Call this after each video is collected to show real-time progress.
 * @param apiKeyUsed - Whether YouTube Data API was used for this collection
 */
export async function submitProgress(apiKeyUsed: boolean = false) {
    const result = createCollectionResult(0, apiKeyUsed);
    await agent.utils.job.submitTask("running", {
        collection_result: result,
        videos_collected: collectedVideos.length,
    }, false, []);
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
