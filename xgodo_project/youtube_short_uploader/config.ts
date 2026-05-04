/**
 * Configuration file for YouTube Shorts Upload Automation
 * Define constants and settings here
 */

// The package name of the YouTube app
export const APP_PACKAGE_NAME = 'com.google.android.youtube';

// Maximum steps (iterations) per stage before failing with OUT_OF_STEPS
export const DEFAULT_MAX_STEPS_PER_STAGE = 500;

// Job variable keys - Input parameters from xgodo job
export const JOB_VARS = {
    // Required: URL of the video to download and upload
    // Format: host:port/file.format or domain/path/file.format
    VIDEO_URL: 'video_url',

    // Optional: Title for the YouTube Short (max 100 chars recommended)
    // If not provided, a default title will be used
    VIDEO_TITLE: 'video_title',

    // Optional: Description for the YouTube Short
    VIDEO_DESCRIPTION: 'video_description',

    // Optional: Visibility setting - "public", "unlisted", or "private"
    // Defaults to "public" if not provided
    VIDEO_VISIBILITY: 'video_visibility',

    // Optional: Hashtags to add (comma-separated, e.g., "shorts,funny,viral")
    VIDEO_HASHTAGS: 'video_hashtags',
} as const;

// Upload flow settings
export const UPLOAD_CONFIG = {
    // Delay after navigating to a new screen (milliseconds)
    SCREEN_TRANSITION_DELAY: 3000,

    // Delay after clicking a button (milliseconds)
    BUTTON_CLICK_DELAY: 2000,

    // Maximum attempts to detect a screen before giving up
    MAX_DETECT_ATTEMPTS: 5,

    // Maximum time to wait for video upload to complete (milliseconds)
    MAX_UPLOAD_WAIT: 5 * 60 * 1000, // 5 minutes

    // Polling interval while waiting for upload (milliseconds)
    UPLOAD_POLL_INTERVAL: 5000,

    // Download directory on the Android device
    DOWNLOAD_DIR: '/sdcard/Download',

    // Downloaded video filename
    DOWNLOAD_FILENAME: 'short_to_upload.mp4',
} as const;

/**
 * Safely access a job variable by key.
 * Casts jobVariables to Record<string, string> to avoid TS indexing errors
 * on the platform's JobVariables type.
 */
export function getJobVar(key: string): string | undefined {
    return (agent.arguments.jobVariables as unknown as Record<string, string>)[key];
}

/**
 * Safely access a boolean job variable.
 * xgodo job variables can be actual booleans (true/false) or strings ("true"/"false")
 * depending on how the user configures them. This normalizes both cases.
 */
export function getJobVarBool(key: string): boolean {
    const val = (agent.arguments.jobVariables as unknown as Record<string, unknown>)[key];
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    return false;
}

/**
 * Get the full download path for the video
 */
export function getDownloadPath(): string {
    return `${UPLOAD_CONFIG.DOWNLOAD_DIR}/${UPLOAD_CONFIG.DOWNLOAD_FILENAME}`;
}
