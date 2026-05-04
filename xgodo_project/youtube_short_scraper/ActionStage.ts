/**
 * Action Stage - YouTube Shorts Data Collection
 *
 * This stage handles the core data collection from YouTube Shorts feed:
 * 1. Monitor for channel username while Short plays
 * 2. Collect video metadata (views, likes, comments, etc.) via description panel
 * 3. Click Share button and extract video URL (done after description to avoid clipboard popup)
 * 4. Swipe to next Short and repeat
 */

import { APP_PACKAGE_NAME, DEFAULT_MAX_STEPS_PER_STAGE, JOB_VARS, COLLECTION_CONFIG, getJobVar, getJobVarBool } from "./config";
import {
  success,
  fail,
  submitProgress,
  addCollectedVideo,
  setCollectionStartTime,
  createCollectionResult,
  type ShortsVideoData
} from "./data";
import { type Stage, type ScreenHandles, steps } from "./Stage";
import {
  detectShortsFeed,
  detectYouTubeHome,
  getShortsButton,
  monitorForChannelUsername,
  extractChannelUsername,
  isAdShort,
  hasCollaborators,
  waitForVideoReady,
} from "./screenDetector";
import {
  extractVideoUrl,
  extractVideoId,
  clickDescriptionAndExtract,
  extractCommentCount,
  fetchChannelInfo,
  fetchVideoDuration,
  resetApiQuotaFlag,
  isChannelLessThan2MonthsOld,
  verifyChannelAgeViaGUI,
} from "./videoExtractor";

/**
 * Define the screens this stage can handle
 */
const ActionStageScreen = {
  ShortsFeed: "ShortsFeed",
} as const;

/**
 * Parse count from text (e.g., "1.2K" -> 1200)
 */
function parseCount(text: string): number | null {
  if (!text) return null;

  const match = text.match(/([\d,.]+)\s*([KM]?)/i);
  if (!match) return null;

  let count = parseFloat(match[1].replace(/,/g, ''));
  const suffix = match[2].toUpperCase();

  if (suffix === 'K') count *= 1000;
  if (suffix === 'M') count *= 1000000;

  return Math.floor(count);
}

/**
 * Collect data from a single Short video
 */
async function collectShortData(order: number): Promise<ShortsVideoData | null> {
  console.log(`\n=== Collecting data for Short #${order} ===`);

  // Wait for the Shorts video overlay UI to fully render
  // This is critical — the video container loads before the overlay buttons
  // (like, share, description text, channel name) appear in the accessibility tree.
  const overlayReady = await waitForVideoReady();
  if (!overlayReady) {
    console.log("Video overlay did not load in time, skipping this Short.");
    return null;
  }

  // Check if this Short is an ad — if so, skip it
  const screenCheck = await agent.actions.screenContent();
  const checkNodes = screenCheck.allNodes();
  if (isAdShort(checkNodes)) {
    console.log("Ad detected, skipping this Short.");
    return null;
  }

  // Check if this Short has multiple collaborators — if so, skip it
  if (hasCollaborators(checkNodes)) {
    console.log("Collaborators detected, skipping this Short.");
    return null;
  }

  // Step 1: Monitor for channel username (with timeout)
  console.log("Monitoring for channel username...");
  const channelUsername = await monitorForChannelUsername(500, 10);
  if (channelUsername) {
    console.log(`Found channel: ${channelUsername}`);
  } else {
    console.log("Channel username not found within timeout, continuing without it.");
  }

  // If no channel username found, try to extract it from the video URL later
  // This prevents getting stuck when username is not immediately visible

  // Step 2: Extract comment count from Shorts feed screen (before any navigation)
  console.log("Extracting comment count...");
  const commentCount = await extractCommentCount();

  // Step 3: Click description and extract metadata (likes, views, upload date)
  // Done BEFORE share/copy to avoid clipboard popup interfering with description click
  // Retry up to 3 times if we don't get complete metadata
  console.log("Opening description for metadata...");
  let descMetadata: Awaited<ReturnType<typeof clickDescriptionAndExtract>> = null;
  const maxDescRetries = 3;

  for (let descAttempt = 1; descAttempt <= maxDescRetries; descAttempt++) {
    console.log(`Description extraction attempt ${descAttempt}/${maxDescRetries}...`);
    const result = await clickDescriptionAndExtract();

    descMetadata = result;

    // Check if we got the essential metadata (title and views are most important)
    const hasTitle = descMetadata?.title && descMetadata.title.length > 0;
    const hasViews = descMetadata?.views && descMetadata.views.length > 0;

    if (hasTitle && hasViews) {
      console.log(`Successfully extracted description metadata on attempt ${descAttempt}`);
      break;
    } else if (descMetadata) {
      console.log(`Incomplete metadata on attempt ${descAttempt}: title=${hasTitle}, views=${hasViews}`);
      if (descAttempt < maxDescRetries) {
        console.log("Waiting before retry...");
        await sleep(1500);
      }
    } else {
      console.log(`Description extraction returned null on attempt ${descAttempt}`);
      if (descAttempt < maxDescRetries) {
        console.log("Waiting before retry...");
        await sleep(1500);
      }
    }
  }

  if (!descMetadata || (!descMetadata.title && !descMetadata.views)) {
    console.warn("Failed to extract description metadata after all retries");
  }

  // Step 4: Click Share and extract video URL
  console.log("Extracting video URL...");
  const videoUrl = await extractVideoUrl();

  if (!videoUrl) {
    console.error("Failed to extract video URL");
    return null;
  }

  const videoId = extractVideoId(videoUrl);

  // Wait for screen to settle after share dialog auto-dismisses
  // Also wait for clipboard popup to disappear before clicking username
  await sleep(6000);

  // Step 5: Build channel URL from username  
  const channelUrl = channelUsername
    ? `https://www.youtube.com/${channelUsername}`
    : null;

  // Step 6: Fetch video duration from YouTube Data API if fetch_channel_age is enabled
  let durationSeconds: number | null = null;
  const apiKey = getJobVar(JOB_VARS.YOUTUBE_API_KEY);
  const fetchChannelAge = getJobVarBool(JOB_VARS.FETCH_CHANNEL_AGE);
  const fetchChannelVideoCount = getJobVarBool(JOB_VARS.FETCH_CHANNEL_VIDEO_COUNT);

  if (fetchChannelAge && apiKey && videoId) {
    console.log("Fetching video duration via YouTube API...");
    durationSeconds = await fetchVideoDuration(videoId, apiKey);
    if (durationSeconds === null) {
      console.log("Could not fetch duration from API (quota exceeded or API error). Duration will be null.");
    }
  }

  // Validate minimum required data
  if (!videoId || videoId === "unknown") {
    console.error("Cannot collect data: video ID is missing or unknown");
    return null;
  }

  // Build preliminary video data object (without channel API info yet)
  const videoData: ShortsVideoData = {
    video_id: videoId,
    video_url: videoUrl,
    title: descMetadata?.title || null,
    duration_seconds: durationSeconds,
    upload_date: descMetadata?.uploadDate || null,
    channel_id: null,
    channel_name: channelUsername || null,
    channel_url: channelUrl,
    channel_creation_date: null,
    channel_video_count: null,
    view_count: descMetadata?.views ? parseInt(descMetadata.views.replace(/,/g, ''), 10) || null : null,
    like_count: descMetadata?.likes ? parseCount(descMetadata.likes) : null,
    comment_count: commentCount,
    collected_at: new Date().toISOString(),
    collection_order: order,
  };

  console.log(`Collected preliminary data for Short #${order}:`, {
    title: videoData.title?.substring(0, 50),
    channel: videoData.channel_name,
    views: videoData.view_count,
  });

  return videoData;
}

/**
 * Check channel age and update video data with channel info.
 * This is the LAST step before swiping - checks if channel is < 2 months old via API,
 * and if not, navigates to channel page to verify real age from oldest video.
 * @returns Object containing updated video data and flag indicating if GUI verification performed a swipe
 */
async function checkChannelAgeAndUpdate(videoData: ShortsVideoData): Promise<{ videoData: ShortsVideoData; guiPerformedSwipe: boolean }> {
  if (!videoData.channel_name) {
    return { videoData, guiPerformedSwipe: false };
  }

  const apiKey = getJobVar(JOB_VARS.YOUTUBE_API_KEY);
  const fetchChannelAge = getJobVarBool(JOB_VARS.FETCH_CHANNEL_AGE);
  const fetchChannelVideoCount = getJobVarBool(JOB_VARS.FETCH_CHANNEL_VIDEO_COUNT);
  const verifyBoughtChannels = getJobVarBool(JOB_VARS.VERIFY_BOUGHT_CHANNELS);
  let guiPerformedSwipe = false;

  // Fetch channel info if either fetch_channel_age or fetch_channel_video_count is enabled
  if ((fetchChannelAge || fetchChannelVideoCount) && apiKey) {
    console.log(`Checking channel age for ${videoData.channel_name}...`);
    const channelInfo = await fetchChannelInfo(videoData.channel_name, apiKey);

    if (channelInfo) {
      videoData.channel_id = channelInfo.channel_id;
      videoData.channel_creation_date = channelInfo.channel_creation_date;
      videoData.channel_video_count = channelInfo.channel_video_count ?? null;

      // Check if channel is less than 2 months old
      if (isChannelLessThan2MonthsOld(channelInfo.channel_creation_date)) {
        console.log(`Channel ${videoData.channel_name} is less than 2 months old (API date: ${channelInfo.channel_creation_date}). Using API date.`);
      } else if (verifyBoughtChannels) {
        console.log(`Channel ${videoData.channel_name} is 2+ months old (API date: ${channelInfo.channel_creation_date}). May be a bought channel.`);
        // Navigate to channel page in GUI to verify real age
        console.log("Navigating to channel page to verify real age via GUI...");
        const guiVerifiedDate = await verifyChannelAgeViaGUI(videoData.channel_name, videoData.video_id);

        if (guiVerifiedDate) {
          console.log(`GUI verification successful. Real channel age from oldest video: ${guiVerifiedDate}`);
          // Update the creation date with the GUI-verified date (oldest video upload date)
          videoData.channel_creation_date = guiVerifiedDate;

          // After GUI verification, we need to swipe once since YouTube puts us back at the same Short
          console.log("GUI verification complete. Swiping to next Short...");
          await swipeToNextShort();
          guiPerformedSwipe = true;
        } else {
          console.log("GUI verification failed. Falling back to API date.");
          // Keep the API date as fallback
        }
      } else {
        console.log(`Channel ${videoData.channel_name} is 2+ months old (API date: ${channelInfo.channel_creation_date}). Using API date (GUI verification disabled).`);
      }
    } else {
      // API call failed or returned no data
      if (verifyBoughtChannels) {
        console.log(`API call failed for ${videoData.channel_name}. Trying GUI verification as fallback...`);
        const guiVerifiedDate = await verifyChannelAgeViaGUI(videoData.channel_name, videoData.video_id);

        if (guiVerifiedDate) {
          console.log(`GUI fallback successful. Channel age from oldest video: ${guiVerifiedDate}`);
          videoData.channel_creation_date = guiVerifiedDate;

          // After GUI verification, swipe once since YouTube puts us back at the same Short
          console.log("GUI fallback complete. Swiping to next Short...");
          await swipeToNextShort();
          guiPerformedSwipe = true;
        } else {
          console.log("GUI fallback also failed. No channel age data available.");
        }
      } else {
        console.log(`API call failed for ${videoData.channel_name}. GUI verification disabled. No channel age data available.`);
      }
    }
  }

  return { videoData, guiPerformedSwipe };
}

/**
 * Ensure we're on the Shorts feed before proceeding.
 * If we're on home page or elsewhere, navigate back to Shorts feed.
 */
async function ensureOnShortsFeed(): Promise<boolean> {
  const maxAttempts = 3;

  for (let i = 0; i < maxAttempts; i++) {
    const screen = await agent.actions.screenContent();
    const nodes = screen.allNodes();

    if (detectShortsFeed(nodes)) {
      console.log("Confirmed: Currently on Shorts feed");
      return true;
    }

    console.log(`Not on Shorts feed (attempt ${i + 1}/${maxAttempts}), attempting recovery...`);

    // Check if we're on YouTube Home page
    const isHomePage = detectYouTubeHome(nodes);

    if (isHomePage) {
      console.log("Detected: On YouTube Home page. Clicking Shorts button...");
      const shortsBtn = getShortsButton(nodes);
      if (shortsBtn) {
        await shortsBtn.randomClick();
        await sleep(3000);

        // Verify we made it to Shorts
        const verifyScreen = await agent.actions.screenContent();
        const verifyNodes = verifyScreen.allNodes();
        if (detectShortsFeed(verifyNodes)) {
          console.log("Successfully navigated to Shorts feed from Home");
          return true;
        }
      } else {
        console.log("Shorts button not found on Home page");
      }
    } else {
      // Try going back first (for dialogs, overlays, etc.)
      console.log("Pressing back to recover...");
      await agent.actions.goBack();
      await sleep(1000);

      // Check if back button got us to Shorts
      const backScreen = await agent.actions.screenContent();
      const backNodes = backScreen.allNodes();
      if (detectShortsFeed(backNodes)) {
        console.log("Recovered to Shorts feed via back button");
        return true;
      }

      // If back didn't work and we're on Home now, try Shorts button
      if (detectYouTubeHome(backNodes)) {
        console.log("Back button brought us to Home. Clicking Shorts button...");
        const shortsBtn = getShortsButton(backNodes);
        if (shortsBtn) {
          await shortsBtn.randomClick();
          await sleep(3000);

          const finalVerify = await agent.actions.screenContent();
          const finalNodes = finalVerify.allNodes();
          if (detectShortsFeed(finalNodes)) {
            console.log("Successfully navigated to Shorts feed");
            return true;
          }
        }
      }
    }
  }

  // Final check after all attempts
  const finalScreen = await agent.actions.screenContent();
  const finalNodes = finalScreen.allNodes();
  const recovered = detectShortsFeed(finalNodes);

  if (recovered) {
    console.log("Recovered to Shorts feed.");
  } else {
    console.error("CRITICAL: Could not recover to Shorts feed after multiple attempts. Current screen is not Shorts feed.");
  }

  return recovered;
}

/**
 * Swipe to next Short video
 * Uses agent.actions.swipe() with explicit coordinates for a long, fast upward swipe
 * to reliably trigger YouTube's page snap transition.
 * 
 * node.randomSwipe("up") was unreliable because the random start point could land
 * too close to the top, resulting in insufficient swipe distance to trigger the snap.
 */
async function swipeToNextShort(): Promise<boolean> {
  console.log("Swiping to next Short...");

  const deviceInfo = agent.info.getDeviceInfo();
  const centerX = Math.floor(deviceInfo.width / 2);

  // Long swipe from ~80% down to ~25% down the screen
  // On 1080x2400: swipe from (540, 1920) to (540, 600) = 1320px distance
  const startY = Math.floor(deviceInfo.height * 0.80);
  const endY = Math.floor(deviceInfo.height * 0.25);

  // Add small random horizontal offset (±50px) to look more human-like
  const xOffset = Math.floor(Math.random() * 100) - 50;
  const swipeX = centerX + xOffset;

  console.log(`Swiping from (${swipeX}, ${startY}) to (${swipeX}, ${endY}), duration=1000ms`);
  await agent.actions.swipe(swipeX, startY, swipeX, endY, 1000);

  // Wait for the next Short to load
  await sleep(COLLECTION_CONFIG.SWIPE_DELAY);

  console.log("Swipe complete, waiting for next Short to load...");
  return true;
}

/**
 * Screen handlers for the action stage
 */
const ActionHandles = {
  ShortsFeed: {
    /**
     * Detect when we're on the Shorts feed
     */
    detectScreen: async (screenContent) => {
      const allNodes = screenContent.allNodes();
      return detectShortsFeed(allNodes);
    },

    /**
     * Handle data collection from Shorts feed
     */
    handleScreen: async () => {
      const numVideosStr = getJobVar(JOB_VARS.NUM_VIDEOS);
      const numVideos = parseInt(numVideosStr || '0', 10);

      if (isNaN(numVideos) || numVideos <= 0) {
        console.error(`Invalid num_videos: ${numVideosStr}`);
        return false;
      }

      // Validate: if fetch_channel_age or fetch_channel_video_count is true, API key must be provided
      const fetchChannelAge = getJobVarBool(JOB_VARS.FETCH_CHANNEL_AGE);
      const fetchChannelVideoCount = getJobVarBool(JOB_VARS.FETCH_CHANNEL_VIDEO_COUNT);
      const apiKey = getJobVar(JOB_VARS.YOUTUBE_API_KEY);

      if ((fetchChannelAge || fetchChannelVideoCount) && !apiKey) {
        console.error("fetch_channel_age or fetch_channel_video_count is enabled but no youtube_api_key provided.");
        await fail("fetch_channel_age or fetch_channel_video_count is enabled but no youtube_api_key was provided. Please provide a YouTube Data API v3 key.");
        return false;
      }

      console.log(`🚀 ActionStage v2.1-timeout-fix | Full-iteration 120s timeout + hard reset enabled`);
      console.log(`Starting collection of ${numVideos} Shorts...`);
      setCollectionStartTime();

      // Reset API quota flag at the start of each task
      resetApiQuotaFlag();

      let collectedCount = 0;
      let attempts = 0;
      const maxAttempts = numVideos * 10; // Increased limit to ensure we get requested videos despite ads/duplicates
      const collectedVideoIds = new Set<string>(); // Track collected IDs to avoid duplicates
      let consecutiveDuplicates = 0; // Track consecutive duplicate detections
      const maxConsecutiveDuplicates = 3; // Force recovery after this many consecutive duplicates

      while (collectedCount < numVideos && attempts < maxAttempts) {
        attempts++;

        // ===================================================================
        // FULL-ITERATION TIMEOUT (120s)
        // Wraps the ENTIRE loop body — data collection, swipe, verification,
        // and storeScreen — in a single 120s timeout.
        // If ANY part hangs (e.g. screenContent on a frozen device), we abort
        // this iteration and hard-reset the app.
        // ===================================================================
        try {
          const iterationResult = await Promise.race([
            (async () => {
              // --- Data Collection ---
              const videoData = await collectShortData(collectedCount + 1);

              let guiVerificationPerformedSwipe = false;

              if (videoData) {
                // Deduplicate: skip if we already collected this video
                if (collectedVideoIds.has(videoData.video_id)) {
                  console.log(`Duplicate video ${videoData.video_id}, skipping.`);
                  consecutiveDuplicates++;

                  // If we've seen too many consecutive duplicates, force a recovery
                  if (consecutiveDuplicates >= maxConsecutiveDuplicates) {
                    console.log(`Detected ${consecutiveDuplicates} consecutive duplicates. Forcing recovery...`);
                    const screenCheck = await agent.actions.screenContent();
                    const shortsBtn = screenCheck.findTextOne("Shorts");
                    if (shortsBtn) {
                      await shortsBtn.randomClick();
                      await sleep(3000);
                      console.log("Clicked Shorts button to reset feed position.");
                    }
                    await swipeToNextShort();
                    await swipeToNextShort();
                    consecutiveDuplicates = 0;
                    return "continue";
                  }
                } else {
                  consecutiveDuplicates = 0;
                  const { videoData: videoDataWithChannelAge, guiPerformedSwipe } = await checkChannelAgeAndUpdate(videoData);
                  guiVerificationPerformedSwipe = guiPerformedSwipe;

                  collectedVideoIds.add(videoDataWithChannelAge.video_id);
                  addCollectedVideo(videoDataWithChannelAge);
                  collectedCount++;

                  const apiKeyUsed = (fetchChannelAge || fetchChannelVideoCount) && !!apiKey;
                  await submitProgress(apiKeyUsed);
                  console.log(`Progress submitted: ${collectedCount}/${numVideos} videos collected`);

                  if (collectedCount >= numVideos) {
                    return "break";
                  }
                }
              }

              // --- Pre-Swipe Recovery ---
              await ensureOnShortsFeed();

              const isDuplicate = videoData && collectedVideoIds.has(videoData.video_id);
              if (!videoData || isDuplicate) {
                console.log(`Swiping to next Short (previous was ${!videoData ? 'skipped/null' : 'duplicate'})...`);
              }

              if (guiVerificationPerformedSwipe) {
                console.log("Skipping swipe - GUI verification already moved to next Short.");
                return "continue";
              }

              // --- Final Verification + Hard Reset ---
              const preSwipeScreen = await agent.actions.screenContent();
              const preSwipeNodes = preSwipeScreen.allNodes();
              if (!detectShortsFeed(preSwipeNodes)) {
                console.warn("WARNING: Not on Shorts feed before swipe! Attempting to recover or restart...");
                await agent.utils.outOfSteps.storeScreen(
                  preSwipeScreen, "Action", `stuck_state_before_restart_${attempts}`, steps,
                );
                const recovered = await recoverToShortsFeedOrRestart();
                if (!recovered) {
                  console.error("CRITICAL: Hard reset failed. Skipping this iteration.");
                  return "continue";
                }
              }

              // --- Swipe to Next Short ---
              const prevChannel = videoData?.channel_name || null;
              let swipeRetries = 0;
              const maxSwipeRetries = 2;

              while (swipeRetries <= maxSwipeRetries) {
                await swipeToNextShort();

                if (prevChannel) {
                  const postSwipeScreenCheck = await agent.actions.screenContent();
                  const postSwipeNodes = postSwipeScreenCheck.allNodes();
                  const newChannel = extractChannelUsername(postSwipeNodes);

                  if (newChannel && newChannel === prevChannel) {
                    swipeRetries++;
                    if (swipeRetries <= maxSwipeRetries) {
                      console.log(`Swipe didn't advance (still on ${prevChannel}), retrying swipe (${swipeRetries}/${maxSwipeRetries})...`);
                      continue;
                    } else {
                      console.log(`Swipe still didn't advance. Clicking Shorts button to reload feed...`);
                      const screenCheck = await agent.actions.screenContent();
                      const shortsBtn = screenCheck.findTextOne("Shorts");
                      if (shortsBtn) {
                        await shortsBtn.randomClick();
                        await sleep(3000);
                        console.log("Shorts button clicked, feed reloaded.");
                      } else {
                        console.log("Shorts button not found, proceeding anyway.");
                      }
                    }
                  }
                }
                break;
              }

              // --- Post-Swipe Verification ---
              const postSwipeScreen = await agent.actions.screenContent();
              const postSwipeNodes = postSwipeScreen.allNodes();
              if (!detectShortsFeed(postSwipeNodes)) {
                console.warn("WARNING: Not on Shorts feed after swipe! Attempting to recover...");
                const recovered = await ensureOnShortsFeed();
                if (!recovered) {
                  console.error("CRITICAL: Could not recover to Shorts feed after swipe.");
                }
              }

              // --- Store Debug Screenshot ---
              await agent.utils.outOfSteps.storeScreen(
                postSwipeScreen, "Action", `post_swipe_attempt_${attempts}`, steps,
                ScreenshotRecord.LOW_QUALITY
              );

              return "ok";
            })(),

            // 120s TIMEOUT — if the entire iteration above hangs, this fires
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error("ITERATION TIMEOUT: Entire loop iteration exceeded 120s")), 120000)
            ),
          ]);

          // Handle flow control signals from the iteration
          if (iterationResult === "break") {
            break;
          }
          // "continue" and "ok" both just proceed to the next iteration naturally

        } catch (iterationError) {
          // Timeout or unexpected error — log and hard-reset
          console.error(`🚨 ITERATION FAILED (attempt ${attempts}): ${iterationError}`);
          console.error("Performing hard reset to recover...");

          try {
            await recoverToShortsFeedOrRestart();
            console.log("Hard reset completed after iteration timeout. Continuing...");
          } catch (resetError) {
            console.error(`Hard reset also failed: ${resetError}`);
          }
        }
      }

      console.log(`Collection loop finished. Collected ${collectedCount}/${numVideos} videos in ${attempts} attempts.`);

      // Strict check: only succeed if ALL requested videos were collected
      if (collectedCount < numVideos) {
        console.error(`FAILED: Could only collect ${collectedCount}/${numVideos} videos.`);
        console.error(`  Possible reasons:`);
        console.error(`  - Too many ads encountered`);
        console.error(`  - Too many duplicate videos`);
        console.error(`  - Reached maximum attempts (${maxAttempts})`);
        console.error(`  - Feed issues or navigation problems`);
        console.error(`  - Screen detection failure (wrong page)`);
        await fail(`Could only collect ${collectedCount}/${numVideos} videos. Task requires all ${numVideos} videos to be collected.`);
        return false;
      }

      // Create final result — only reached when all videos are collected
      const apiKeyUsed = !!getJobVar(JOB_VARS.YOUTUBE_API_KEY);
      const result = createCollectionResult(numVideos, apiKeyUsed);

      // Submit success with collected data
      await success({
        collection_result: result,
        videos_collected: collectedCount,
        requested_count: numVideos,
      });

      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof ActionStageScreen>;

/**
 * Attempts to recover to the Shorts feed.
 * If standard recovery fails, it performs a HARD RESET by restarting the app.
 * This prevents the script from getting stuck in an infinite loop on a bad state.
 */
async function recoverToShortsFeedOrRestart(): Promise<boolean> {
  console.log("Attempting to recover to Shorts feed...");

  // Try standard recovery first
  const recovered = await ensureOnShortsFeed();
  if (recovered) {
    return true;
  }

  // If standard recovery failed, force a HARD RESET
  console.error("Standard recovery failed. Performing HARD RESET (Restarting App)...");

  try {
    // 1. Force stop and restart app
    await agent.actions.launchApp(APP_PACKAGE_NAME, true);
    await sleep(8000); // Wait for app to cold boot

    // 2. Click Shorts button
    const screen = await agent.actions.screenContent();
    const shortsBtn = getShortsButton(screen.allNodes());

    if (shortsBtn) {
      console.log("App restarted. Clicking Shorts button...");
      await shortsBtn.click();
      await sleep(5000);

      // 3. Verify we are on Shorts feed
      const newScreen = await agent.actions.screenContent();
      return detectShortsFeed(newScreen.allNodes());
    } else {
      console.error("Could not find Shorts button after app restart.");
      return false;
    }
  } catch (error) {
    console.error(`Hard reset failed: ${error}`);
    return false;
  }
}

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
   * Ensure we're on the Shorts feed
   */
  defaultHandle: async () => {
    console.log("Entering Action Stage - Starting data collection...");
    // The Shorts feed should already be active from LoginStage
    await sleep(1000);
  },
} as const satisfies Stage<typeof ActionStageScreen>;

export default ActionStage;
