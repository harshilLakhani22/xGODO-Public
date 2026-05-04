declare const agent: any;
/**
 * Data management for your automation
 *
 * This module handles storing and retrieving data that will be
 * submitted with task results. Use this to collect information
 * during the automation that needs to be reported back.
 */

// Internal data store
let data: Record<string, any> = {};

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
 * Submit a failed task with optional screenshot
 *
 * @param comment - A reason code or message for the failure
 * @param screenshot - Whether to capture a screenshot (default: true)
 */
export async function fail(comment: string, screenshot: boolean = true) {
    let existingComment = getData().comment;
    if (existingComment) {
        existingComment += "|";
    } else {
        existingComment = "";
    }

    addData({ comment: existingComment + comment });

    await agent.utils.job.submitTask(
        "failed",
        getData(),
        true,
        screenshot ? [{
            name: "failureScreenshot",
            extension: ".jpeg",
            base64Data: (await agent.actions.screenshot(1024, 1024, 100)).screenshot || ""
        }] : [],
    );

    agent.control.stopCurrentAutomation();
}

/**
 * Submit a successful task
 *
 * @param additionalData - Any additional data to include in the result
 * @param captureProof - Whether to capture a proof-of-work screenshot (default: false)
 */
export async function success(additionalData?: Record<string, any>, captureProof: boolean = false) {
    if (additionalData) {
        addData(additionalData);
    }

    // Explicitly using the full submitTask signature to support attachments
    // submitTask(status, data, isCompleted, attachments)
    await agent.utils.job.submitTask(
        "success",
        getData(),
        true, // isCompleted
        captureProof ? [{
            name: "proofOfWork",
            extension: ".jpeg",
            base64Data: (await agent.actions.screenshot(1024, 1024, 70)).screenshot || ""
        }] : []
    );
    agent.control.stopCurrentAutomation();
}
