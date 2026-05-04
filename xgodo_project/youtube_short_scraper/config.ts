/**
 * Configuration file for YouTube Shorts Data Mining Automation
 * Define constants and settings here
 */

// The package name of the app you want to automate
export const APP_PACKAGE_NAME = 'com.google.android.youtube';

// Maximum steps (iterations) per stage before failing with OUT_OF_STEPS
// Set to 1000 to support collecting 20+ videos with GUI verification
export const DEFAULT_MAX_STEPS_PER_STAGE = 1000;

// Job variable keys - Input parameters
export const JOB_VARS = {
  // Required: Number of Shorts videos to collect data from
  NUM_VIDEOS: 'num_videos',

  // Optional: Whether to fetch channel age (creation date) via YouTube Data API
  // If true, youtube_api_key must also be provided
  FETCH_CHANNEL_AGE: 'fetch_channel_age',

  // Optional: Whether to fetch total number of videos on the channel via YouTube Data API
  // If true, youtube_api_key must also be provided
  FETCH_CHANNEL_VIDEO_COUNT: 'fetch_channel_video_count',

  // Optional: YouTube Data API v3 key for fetching channel_id, channel_creation_date, and video duration
  // Required if fetch_channel_age is true
  YOUTUBE_API_KEY: 'youtube_api_key',

  // Optional: Whether to verify channel age via GUI navigation (for bought channel detection)
  // When true, navigates to channel page to check oldest video date for channels >2 months old
  // When false (default), uses only the API creation date — much faster
  VERIFY_BOUGHT_CHANNELS: 'verify_bought_channels',
} as const;

// Collection settings
export const COLLECTION_CONFIG = {
  // Delay between swipes (milliseconds) - allows video to load
  SWIPE_DELAY: 5000,

  // Maximum attempts to swipe to next video before giving up
  MAX_SWIPE_ATTEMPTS: 3,

  // Delay after clicking share button (milliseconds)
  SHARE_DIALOG_DELAY: 2000,

  // Delay after extracting clipboard (milliseconds)
  CLIPBOARD_DELAY: 1000,
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
