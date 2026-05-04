/**
 * Screen Detection Utilities
 * 
 * Detects which YouTube screen we're on based on UI elements
 */

import { APP_PACKAGE_NAME } from "./config";

/**
 * Detect YouTube Home Screen
 * Indicators: YouTube toolbar with logo and filter chips (Home, Music, etc.)
 * Note: Home page DOES contain id/results, so we can't exclude based on that.
 */
export function detectYouTubeHome(allNodes: any[]): boolean {
  const hasYouTubePackage = allNodes.some(
    (node) => node.packageName === APP_PACKAGE_NAME
  );

  // Check for YouTube toolbar container (present on Home page)
  const hasToolbar = allNodes.some(
    (node) => node.viewId === "com.google.android.youtube:id/toolbar_container" ||
      node.viewId === "com.google.android.youtube:id/toolbar"
  );

  // Check for filter chips that appear on the Home page (Home, Music, Mixes, etc.)
  const hasHomeFilterChips = allNodes.some(
    (node) =>
      node.viewId === "com.google.android.youtube:id/chip_cloud_chip_modern_text" &&
      node.text &&
      (node.text === "Home" || node.text === "Music" || node.text === "Mixes" ||
        node.text === "Your custom Home" || node.text === "Gaming" || node.text === "News")
  );

  // Make sure we're not on a video player
  const hasVideoPlayer = allNodes.some(
    (node) => node.viewId === "com.google.android.youtube:id/watch_player"
  );

  // Home page has the YouTube logo
  const hasYouTubeLogo = allNodes.some(
    (node) => node.viewId === "com.google.android.youtube:id/youtube_logo"
  );

  // Primary detection: toolbar + filter chips (most reliable)
  // Secondary: toolbar + logo (fallback)
  return hasYouTubePackage && !hasVideoPlayer && hasToolbar && (hasHomeFilterChips || hasYouTubeLogo);
}

/**
 * Detect if watch history is turned off.
 * YouTube shows a banner when watch history is off that prevents Shorts from loading.
 * Indicators: "Your watch history is off" description or
 * "You can change your setting at any time..." text.
 * @returns true if watch history is off, false otherwise
 */
export function isWatchHistoryOff(allNodes: any[]): boolean {
  const hasHistoryOffDescription = allNodes.some(
    (node) => node.description === "Your watch history is off"
  );

  const hasHistoryOffText = allNodes.some(
    (node) =>
      node.text &&
      node.text.includes("You can change your setting at any time to get the latest videos tailored to you")
  );

  return hasHistoryOffDescription || hasHistoryOffText;
}

/**
 * Detect Shorts Feed (fullscreen Shorts player)
 * Indicators: Shorts-specific UI elements like reel_player, reel_recycler
 * IMPORTANT: Must NOT match the Home page Shorts carousel, which also has
 * "Shorts" descriptions and "Action menu" buttons.
 */
export function detectShortsFeed(allNodes: any[]): boolean {
  const hasYouTubePackage = allNodes.some(
    (node) => node.packageName === APP_PACKAGE_NAME
  );

  // Check for Shorts player containers (most reliable - only in fullscreen Shorts)
  const hasReelPlayer = allNodes.some(
    (node) =>
      node.viewId === "com.google.android.youtube:id/reel_player" ||
      node.viewId === "com.google.android.youtube:id/reel_player_page_container"
  );

  // Check for reel_recycler (the Shorts feed RecyclerView)
  const hasReelRecycler = allNodes.some(
    (node) => node.viewId === "com.google.android.youtube:id/reel_recycler"
  );

  // If we have definitive Shorts player elements, we're on the Shorts feed
  if (hasYouTubePackage && (hasReelPlayer || hasReelRecycler)) {
    return true;
  }

  // Fallback heuristic: multiple "Shorts" descriptions + "Action menu"
  // BUT we must exclude the Home page, which also has these elements in its Shorts carousel
  const shortsDescriptions = allNodes.filter(
    (node) => node.description === "Shorts"
  );
  const hasMultipleShortsIndicators = shortsDescriptions.length >= 2;

  const hasActionMenu = allNodes.some(
    (node) => node.description === "Action menu"
  );

  // Home page indicators that should DISQUALIFY this as a Shorts feed
  const hasToolbar = allNodes.some(
    (node) => node.viewId === "com.google.android.youtube:id/toolbar_container" ||
      node.viewId === "com.google.android.youtube:id/toolbar"
  );
  const hasHomeFilterChips = allNodes.some(
    (node) =>
      node.viewId === "com.google.android.youtube:id/chip_cloud_chip_modern_text" &&
      node.text &&
      (node.text === "Home" || node.text === "Music" || node.text === "Mixes" ||
        node.text === "Your custom Home" || node.text === "Gaming" || node.text === "News")
  );
  const hasYouTubeLogo = allNodes.some(
    (node) => node.viewId === "com.google.android.youtube:id/youtube_logo"
  );
  const isHomePage = hasToolbar && (hasHomeFilterChips || hasYouTubeLogo);

  if (isHomePage) {
    return false; // We're on the Home page, not the Shorts feed
  }

  return (
    hasYouTubePackage &&
    hasMultipleShortsIndicators && hasActionMenu
  );
}

/**
 * Check if we're on YouTube
 */
export function isYouTubeOpen(allNodes: any[]): boolean {
  return allNodes.some((node) => node.packageName === APP_PACKAGE_NAME);
}

/**
 * Check if Shorts button is visible
 */
export function isShortsButtonVisible(allNodes: any[]): boolean {
  return allNodes.some(
    (node) => node.description === "Shorts" &&
      node.className !== "android.view.View" // Exclude decorative views
  );
}

/**
 * Get the Shorts button node
 * Prioritizes clickable elements (buttons, image views) over text views
 */
export function getShortsButton(allNodes: any[]): any | undefined {
  // First try to find a button or image view (clickable elements)
  const clickableButton = allNodes.find(
    (node) => node.description === "Shorts" &&
      (node.className === "android.widget.Button" ||
        node.className === "android.widget.ImageView" ||
        node.clickable === true)
  );

  if (clickableButton) {
    return clickableButton;
  }

  // Fallback: any node with "Shorts" description that's not just a decorative view
  return allNodes.find(
    (node) => node.description === "Shorts" &&
      node.className !== "android.view.View"
  );
}

/**
 * Detect if the current Short is an ad.
 * Ad Shorts have a node with description exactly "Ad" or ending with "\nAd".
 */
export function isAdShort(allNodes: any[]): boolean {
  return allNodes.some(
    (node) =>
      node.packageName === APP_PACKAGE_NAME &&
      node.description &&
      (node.description === "Ad" ||
        node.description.endsWith("\nAd"))
  );
}

/**
 * Extract channel username from Shorts video
 * Looks for description starting with @ (e.g., "@ClipRushMoments")
 * Continuously monitors the screen while video plays
 * 
 * @param allNodes - Array of all UI nodes from screen content
 * @returns The channel username (including @) or null if not found
 */
export function extractChannelUsername(allNodes: any[]): string | null {
  // Look for nodes with description starting with @
  const channelNode = allNodes.find(
    (node) => node.description &&
      typeof node.description === "string" &&
      node.description.startsWith("@")
  );

  if (channelNode && channelNode.description) {
    return channelNode.description;
  }

  return null;
}

/**
 * Monitor screen for channel username while Short is playing.
 * Polls up to maxAttempts times before giving up (avoids infinite hang).
 * 
 * @param intervalMs - How often to check (milliseconds)
 * @param maxAttempts - Maximum number of polling attempts (default 10 = ~5s at 500ms)
 * @returns The channel username or null if not found within timeout
 */
export async function monitorForChannelUsername(
  intervalMs: number = 500,
  maxAttempts: number = 10
): Promise<string | null> {
  console.log("Monitoring for channel username...");

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const screenContent = await agent.actions.screenContent();
    const allNodes = screenContent.allNodes();

    const username = extractChannelUsername(allNodes);
    if (username) {
      console.log(`Found channel username: ${username}`);
      return username;
    }

    await sleep(intervalMs);
  }

  console.log(`Channel username not found after ${maxAttempts} attempts, giving up.`);
  return null;
}

/**
 * Detect if we're on a YouTube Channel page
 * Indicators: collapsing_header_container, subscriber count, video count
 * @param allNodes - Array of all UI nodes from screen content
 * @returns true if on channel page, false otherwise
 */
export function detectChannelPage(allNodes: any[]): boolean {
  // Check for collapsing_header_container (unique to channel pages)
  const hasCollapsingHeader = allNodes.some(
    (node) => node.viewId === "com.google.android.youtube:id/collapsing_header_container"
  );

  // Check for subscriber count
  const hasSubscriberCount = allNodes.some(
    (node) => node.text && node.text.includes("subscribers")
  );

  // Check for video count
  const hasVideoCount = allNodes.some(
    (node) => node.text && node.text.match(/\d+\s+videos/i)
  );

  // Channel pages also have a username with @
  const hasUsername = allNodes.some(
    (node) => node.text && node.text.startsWith("@")
  );

  // We need collapsing_header_container AND (subscriber count OR video count)
  return hasCollapsingHeader && (hasSubscriberCount || hasVideoCount || hasUsername);
}

/**
 * Check if "Oldest" tab is active on channel page
 * Looks for RadioButton with description "Oldest" and isChecked: 1
 * @param allNodes - Array of all UI nodes from screen content
 * @returns true if Oldest tab is active, false otherwise
 */
export function isOldestTabActive(allNodes: any[]): boolean {
  const oldestRadioButton = allNodes.find(
    (node) =>
      node.className === "android.widget.RadioButton" &&
      (node.description === "Oldest" || node.text === "Oldest")
  );

  // Check if the Oldest button is checked (isChecked: 1 or isChecked: true)
  if (oldestRadioButton) {
    return oldestRadioButton.isChecked === 1 || oldestRadioButton.isChecked === true;
  }

  return false;
}

/**
 * Detect if the current Short has multiple collaborators.
 * Collaborator Shorts show a "Collaborators" section with multiple channels.
 * @param allNodes - Array of all UI nodes from screen content
 * @returns true if Short has collaborators, false otherwise
 */
export function hasCollaborators(allNodes: any[]): boolean {
  // Check for "Collaborators" text which appears in collaborator shorts
  const hasCollaboratorsText = allNodes.some(
    (node) =>
      node.packageName === APP_PACKAGE_NAME &&
      (node.text === "Collaborators" || node.description === "Collaborators")
  );

  return hasCollaboratorsText;
}

/**
 * Wait until the Shorts video overlay UI has fully rendered.
 * Polls for the presence of action buttons (like, share, comment)
 * or channel username — these only appear once the overlay is loaded.
 * 
 * @param maxAttempts - Maximum polling attempts (default 15 = ~7.5s at 500ms)
 * @param intervalMs - Polling interval in milliseconds (default 500)
 * @returns true if overlay appeared, false if timed out
 */
export async function waitForVideoReady(
  maxAttempts: number = 15,
  intervalMs: number = 500
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const screen = await agent.actions.screenContent();
    const allNodes = screen.allNodes();

    // Check for any of these Shorts overlay indicators:
    // 1. Like button (RadioButton with "like" in description)
    // 2. Share button (Button with "Share" in description)
    // 3. Comment button (Button with "View ... comments" in description)
    // 4. Channel username (node with description starting with "@")
    const hasOverlay = allNodes.some(
      (node) =>
        node.packageName === APP_PACKAGE_NAME &&
        (
          // Like button
          (node.className === "android.widget.RadioButton" &&
            node.description?.toLowerCase().includes("like")) ||
          // Share button
          (node.className === "android.widget.Button" &&
            node.description?.includes("Share")) ||
          // Comment button
          (node.className === "android.widget.Button" &&
            node.description?.match(/View\s+[\d,.]+/)) ||
          // Channel username
          (node.description?.startsWith("@"))
        )
    );

    if (hasOverlay) {
      console.log(`Video overlay ready after ${attempt} attempt(s)`);
      return true;
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  console.log(`Video overlay not detected after ${maxAttempts} attempts (${maxAttempts * intervalMs}ms)`);
  return false;
}
