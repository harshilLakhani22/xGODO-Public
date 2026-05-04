/**
 * Video URL Extraction Utilities
 * 
 * Handles extracting video URLs via the Share button and Copy link functionality
 */

import { COLLECTION_CONFIG } from "./config";
import { detectShortsFeed, detectChannelPage, extractChannelUsername, hasCollaborators, isOldestTabActive } from "./screenDetector";

/**
 * Extract video URL using Share button and Copy link
 * This function:
 * 1. Clicks the Share button
 * 2. Finds and clicks Copy link
 * 3. Extracts URL from clipboard
 * 4. Closes the share dialog
 * 
 * @returns The video URL or null if extraction failed
 */
export async function extractVideoUrl(): Promise<string | null> {
  console.log("Extracting video URL via Share button...");

  // Find Share button
  const shareButton = await findShareButton();
  if (!shareButton) {
    console.error("Share button not found");
    return null;
  }

  // Click Share and get Copy link button
  let copyLinkButton = await clickShareAndFindCopyLink(shareButton);

  // Fallback: if Copy link not found, check if it's visible on screen and click it
  if (!copyLinkButton) {
    console.log("Copy link button not found immediately, checking if visible on screen...");
    await sleep(1000);
    copyLinkButton = await findCopyLinkButton();

    if (copyLinkButton) {
      console.log("Found Copy link button on screen, clicking it...");
    } else {
      console.error("Copy link button not found after clicking Share");
      // Dismiss any leftover share dialog so it doesn't block subsequent actions
      await dismissShareDialog();
      return null;
    }
  }

  // Click Copy link and extract URL from clipboard
  // Share dialog auto-dismisses after clicking Copy link, no need to close it
  const videoUrl = await clickCopyLinkAndExtractUrl(copyLinkButton);

  return videoUrl;
}

/**
 * Find the Share button on screen
 * Looks for "Share this video" description (Shorts format)
 */
async function findShareButton(): Promise<AndroidNode | undefined> {
  const screen = await agent.actions.screenContent();
  const allNodes = screen.allNodes();

  // Try "Share this video" first (Shorts format)
  let shareButton = allNodes.find(
    (node) => node.description === "Share this video" &&
      node.className === "android.widget.Button"
  );

  // Fallback to "Share" (regular format)
  if (!shareButton) {
    shareButton = allNodes.find(
      (node) => node.description === "Share" &&
        node.className === "android.widget.Button"
    );
  }

  // Additional fallback: look for any button with "Share" in the description
  if (!shareButton) {
    shareButton = allNodes.find(
      (node) => node.description?.includes("Share") &&
        node.className === "android.widget.Button"
    );
  }

  // Fallback: look for share by viewId
  if (!shareButton) {
    shareButton = allNodes.find(
      (node) => node.viewId?.includes("share") &&
        (node.clickable === true || node.className === "android.widget.Button" || node.className === "android.widget.ImageView")
    );
  }

  // Last resort: look for share icon by checking for ImageView with share-related description
  if (!shareButton) {
    shareButton = allNodes.find(
      (node) => (node.description?.includes("Share") || node.text?.includes("Share")) &&
        (node.className === "android.widget.ImageView" || node.clickable === true)
    );
  }

  // Debug: if still not found, log what we can see
  if (!shareButton) {
    console.error("Share button not found. Clickable nodes on screen:");
    const clickableNodes = allNodes.filter(
      (node) => node.clickable && node.packageName === "com.google.android.youtube"
    );
    for (const c of clickableNodes.slice(0, 15)) {
      console.log(`  class=${c.className} text="${(c.text || '').substring(0, 40)}" desc="${(c.description || '').substring(0, 40)}" id="${c.viewId || ''}"`);
    }
  }

  return shareButton;
}

/**
 * Click Share button and find Copy link button
 * Retries if Copy link not found immediately
 */
async function clickShareAndFindCopyLink(
  shareButton: AndroidNode
): Promise<AndroidNode | undefined> {
  let copyLinkButton: AndroidNode | undefined;
  let attempts = 0;
  const maxAttempts = COLLECTION_CONFIG.MAX_SWIPE_ATTEMPTS;

  while (attempts < maxAttempts && !copyLinkButton) {
    attempts++;
    console.log(`Attempt ${attempts}/${maxAttempts} to click Share and find Copy link...`);

    // Click Share button
    console.log("Clicking Share button...");
    await shareButton.randomClick();
    await sleep(COLLECTION_CONFIG.SHARE_DIALOG_DELAY);

    // Wait 1 second before looking for Copy link button
    await sleep(1000);

    // Look for Copy link button
    copyLinkButton = await findCopyLinkButton();

    if (copyLinkButton) {
      console.log("Found Copy link button!");
      break;
    }

    console.log("Copy link button not found, checking screen state...");

    // Check if a share dialog is actually open before pressing back
    const checkScreen = await agent.actions.screenContent();
    const checkNodes = checkScreen.allNodes();
    const stillOnShorts = detectShortsFeed(checkNodes);

    if (!stillOnShorts) {
      console.log("Not on Shorts feed, checking if Copy link is visible on current screen...");
      // Maybe the Copy link button is there but wasn't found by findCopyLinkButton
      // Let's try a broader search
      const allNodes = checkScreen.allNodes();
      const fallbackCopyButton = allNodes.find(
        (node) =>
          (node.description?.includes("Copy") || node.text?.includes("Copy")) &&
          (node.className === "android.view.ViewGroup" || node.clickable === true)
      );

      if (fallbackCopyButton) {
        console.log("Found Copy link button via fallback search!");
        return fallbackCopyButton;
      }

      // Something is on top (share dialog or other overlay), safe to goBack
      console.log("Closing overlay with goBack...");
      await agent.actions.goBack();
      await sleep(1000);

      // Verify we're back on Shorts feed after goBack
      const postBackScreen = await agent.actions.screenContent();
      const postBackNodes = postBackScreen.allNodes();
      if (!detectShortsFeed(postBackNodes)) {
        console.error("Lost Shorts feed after closing share dialog, aborting URL extraction");
        return undefined;
      }
    } else {
      console.log("Still on Shorts feed, dialog may have auto-dismissed. Retrying...");
    }
  }

  if (!copyLinkButton) {
    console.error(`Failed to find Copy link button after ${maxAttempts} attempts`);
  }

  return copyLinkButton;
}

/**
 * Find Copy link button in share dialog
 * Matches: description="Copy link", text="Copy link", className="android.view.ViewGroup"
 */
async function findCopyLinkButton(): Promise<AndroidNode | undefined> {
  const screen = await agent.actions.screenContent();
  const allNodes = screen.allNodes();

  // First try: exact match
  let copyButton = allNodes.find((node) => {
    // Check for "Copy link" in both description and text
    const hasCopyLinkDescription = node.description === "Copy link";
    const hasCopyLinkText = node.text === "Copy link";

    // Accept if either description or text matches (or both)
    const hasCopyLink = hasCopyLinkDescription || hasCopyLinkText;

    // Check for ViewGroup class (as seen in the hierarchy)
    const isViewGroup = node.className === "android.view.ViewGroup";

    return hasCopyLink && isViewGroup;
  });

  // Second try: partial match with "Copy" in description or text
  if (!copyButton) {
    copyButton = allNodes.find((node) => {
      const hasCopy = node.description?.includes("Copy") || node.text?.includes("Copy");
      const isClickable = node.clickable === true;
      return hasCopy && isClickable;
    });
  }

  // Third try: look for any clickable element that might be the copy button
  if (!copyButton) {
    copyButton = allNodes.find((node) => {
      const hasLink = node.description?.includes("link") || node.text?.includes("link");
      const isClickable = node.clickable === true;
      return hasLink && isClickable;
    });
  }

  return copyButton;
}

/**
 * Dismiss any open share dialog or overlay by pressing goBack until we're back on Shorts feed.
 * Called when share flow fails to prevent the dialog from blocking subsequent actions.
 */
async function dismissShareDialog(): Promise<void> {
  const maxAttempts = 3;
  for (let i = 0; i < maxAttempts; i++) {
    const screen = await agent.actions.screenContent();
    const nodes = screen.allNodes();
    const onShorts = detectShortsFeed(nodes);

    if (onShorts) {
      console.log("Back on Shorts feed after dismissing share dialog.");
      return;
    }

    console.log(`Dismissing share dialog/overlay (attempt ${i + 1})...`);
    await agent.actions.goBack();
    await sleep(1000);
  }

  // Final check
  const finalScreen = await agent.actions.screenContent();
  const finalNodes = finalScreen.allNodes();
  if (detectShortsFeed(finalNodes)) {
    console.log("Back on Shorts feed after dismissing share dialog.");
  } else {
    console.log("Warning: still not on Shorts feed after dismissing share dialog.");
  }
}

/**
 * Click Copy link and extract URL from clipboard
 * Retries if clipboard is empty
 */
async function clickCopyLinkAndExtractUrl(
  copyLinkButton: AndroidNode
): Promise<string | null> {
  let videoUrl: string | null = null;
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts && !videoUrl) {
    attempts++;
    console.log(`Clicking Copy link button (attempt ${attempts}/${maxAttempts})...`);

    // Click Copy link
    await copyLinkButton.randomClick();
    await sleep(COLLECTION_CONFIG.CLIPBOARD_DELAY);

    // Extract from clipboard
    const clipboardContent = await agent.actions.reverseCopy();
    const extractedUrl = clipboardContent.text;

    // Validate URL
    if (!extractedUrl || extractedUrl.trim() === "") {
      console.error(`Clipboard is empty after clicking Copy link (attempt ${attempts})`);
      if (attempts < maxAttempts) {
        console.log("Waiting before retry...");
        await sleep(1000);
        continue;
      }
      return null;
    }

    if (!extractedUrl.includes("youtube.com") && !extractedUrl.includes("youtu.be")) {
      console.error(`Clipboard doesn't contain YouTube URL: ${extractedUrl.substring(0, 100)}`);
      if (attempts < maxAttempts) {
        console.log("Waiting before retry...");
        await sleep(1000);
        continue;
      }
      return null;
    }

    videoUrl = extractedUrl;
    console.log(`Successfully extracted URL: ${videoUrl}`);
  }

  return videoUrl;
}

/**
 * Metadata extracted from the description page
 */
export interface DescriptionMetadata {
  likes: string | null;       // e.g. "262K"
  views: string | null;       // e.g. "12,241,142"
  uploadDate: string | null;  // e.g. "Aug 28, 2025"
  title: string | null;       // full description text
}

/**
 * Close the description panel and verify it's actually closed.
 * Retries the close button click if the panel is still visible.
 * Falls back to goBack() if close button can't be found.
 */
async function closeDescriptionPanel(currentScreen: any): Promise<void> {
  const maxCloseAttempts = 3;

  for (let attempt = 1; attempt <= maxCloseAttempts; attempt++) {
    // Find close button on current screen
    const screenToSearch = attempt === 1 ? currentScreen : await agent.actions.screenContent();
    const nodes = screenToSearch.allNodes();

    const closeButton = nodes.find(
      (node: AndroidNode) =>
        node.viewId === "com.google.android.youtube:id/close_button" ||
        (node.description === "Close" && node.className === "android.widget.ImageView")
    );

    if (!closeButton) {
      // No close button found — check if we're back on Shorts feed
      const onShorts = nodes.some(
        (n: AndroidNode) =>
          n.viewId === "com.google.android.youtube:id/reel_recycler" ||
          n.viewId === "com.google.android.youtube:id/reel_player_page_container"
      );
      if (onShorts) {
        console.log("Description panel already closed, back on Shorts feed.");
        return;
      }
      // Not on Shorts and no close button — use goBack() as fallback
      console.log(`Close button not found (attempt ${attempt}), pressing back...`);
      await agent.actions.goBack();
      await sleep(1000);
      continue;
    }

    console.log(`Closing description panel (attempt ${attempt})...`);
    await closeButton.randomClick();
    await sleep(1000);

    // Verify the panel is actually closed
    const verifyScreen = await agent.actions.screenContent();
    const verifyNodes = verifyScreen.allNodes();

    const stillHasCloseButton = verifyNodes.some(
      (n: AndroidNode) => n.viewId === "com.google.android.youtube:id/close_button"
    );

    if (!stillHasCloseButton) {
      console.log("Description panel closed successfully.");
      return;
    }

    console.log(`Description panel still open after close attempt ${attempt}, retrying...`);
  }

  // Last resort after all attempts failed
  console.log("Failed to close description panel after all attempts, pressing back...");
  await agent.actions.goBack();
  await sleep(1000);
}

/**
 * Click the video description, extract metadata (likes, views, upload date),
 * then close the description panel.
 */
export async function clickDescriptionAndExtract(): Promise<DescriptionMetadata | null> {
  // No need for an extra sleep here — waitForVideoReady() in collectShortData
  // already ensures the UI overlay is rendered.

  const screen = await agent.actions.screenContent();
  const allNodes = screen.allNodes();

  // Find the description node — clickable node with long text, inside YouTube
  // The description can be either a ViewGroup or a Button depending on the YouTube version
  // First try non-hashtag descriptions (safe to click directly)
  let descNode = allNodes.find(
    (node) =>
      node.clickable &&
      node.text &&
      node.text.length > 10 &&
      (node.className === "android.view.ViewGroup" || node.className === "android.widget.Button") &&
      node.packageName === "com.google.android.youtube" &&
      !node.text.startsWith("@") &&
      !node.text.startsWith("#") &&
      !node.text.match(/\d+[KM]?\s*views?/i) &&
      // Exclude nav buttons and subscribe
      node.text !== "Subscribe" &&
      !node.description?.startsWith("Subscribe")
  );

  // If not found, try descriptions with hashtags
  // Some Shorts don't have music, so the description layout is different
  const isHashtagDesc = !descNode;
  if (!descNode) {
    descNode = allNodes.find(
      (node) =>
        node.clickable &&
        node.text &&
        node.text.length > 10 &&
        (node.className === "android.view.ViewGroup" || node.className === "android.widget.Button") &&
        node.packageName === "com.google.android.youtube" &&
        (node.text.startsWith("#") || node.text.includes("#")) &&
        !node.text.startsWith("@")
    );
  }

  // If still not found, try any clickable ViewGroup with long text (fallback)
  if (!descNode) {
    descNode = allNodes.find(
      (node) =>
        node.clickable &&
        node.text &&
        node.text.length > 20 &&
        (node.className === "android.view.ViewGroup" || node.className === "android.widget.Button") &&
        node.packageName === "com.google.android.youtube" &&
        !node.text.startsWith("@") &&
        !node.text.match(/^\d+[KM]?\s*(likes?|views?)$/i)
    );
  }

  // Broader fallback: any clickable YouTube node with text (not restricted to ViewGroup)
  if (!descNode) {
    descNode = allNodes.find(
      (node) =>
        node.clickable &&
        node.text &&
        node.text.length > 10 &&
        node.packageName === "com.google.android.youtube" &&
        !node.text.startsWith("@") &&
        !node.text.startsWith("#") &&
        !node.text.match(/^\d+[KM]?\s*(likes?|views?)$/i) &&
        node.text !== "Shorts" &&
        node.text !== "Home" &&
        node.text !== "Subscriptions" &&
        node.text !== "You" &&
        node.text !== "Library"
    );
  }

  // Even broader fallback: any YouTube node with text > 5 chars (even if not clickable)
  if (!descNode) {
    descNode = allNodes.find(
      (node) =>
        node.text &&
        node.text.length > 5 &&
        node.packageName === "com.google.android.youtube" &&
        !node.text.startsWith("@") &&
        node.text !== "Shorts" &&
        node.text !== "Home" &&
        node.text !== "Subscriptions" &&
        node.text !== "You" &&
        node.text !== "Library" &&
        !node.text.match(/^\d+[KM]?\s*(likes?|views?)$/i) &&
        node.className !== "android.widget.ImageView"
    );
  }

  if (!descNode) {
    // EXPANDED DEBUG: log ALL YouTube nodes so we can see the full UI structure
    console.error("Description node not found. FULL screen dump:");
    const ytNodes = allNodes.filter(
      (node) => node.packageName === "com.google.android.youtube"
    );
    console.log(`Total YouTube nodes: ${ytNodes.length}`);
    for (const c of ytNodes.slice(0, 20)) {
      console.log(`  class=${c.className} clickable=${c.clickable} text="${(c.text || '').substring(0, 80)}" desc="${(c.description || '').substring(0, 80)}" id="${c.viewId || ''}"`.trim());
    }
    // Also log non-YouTube nodes in case the Shorts content is under a different package
    const nonYtNodes = allNodes.filter(
      (node) => node.packageName !== "com.google.android.youtube" && (node.text || node.description)
    );
    if (nonYtNodes.length > 0) {
      console.log(`Non-YouTube nodes with text/desc (${nonYtNodes.length}):`);
      for (const c of nonYtNodes.slice(0, 10)) {
        console.log(`  pkg=${c.packageName} class=${c.className} text="${(c.text || '').substring(0, 50)}" desc="${(c.description || '').substring(0, 50)}"`);
      }
    }
    // Return empty metadata instead of null to allow collection to continue
    console.log("Returning empty metadata - continuing without description data");
    return {
      likes: null,
      views: null,
      uploadDate: null,
      title: null,
    };
  }

  console.log(`Clicking description: "${descNode.text!.substring(0, 60)}..."`);

  // Tap the TOP-LEFT corner (1st line only) to avoid hitting hashtag links
  const bounds = descNode.boundsInScreen;
  const descHeight = bounds.bottom - bounds.top;
  const firstLineY = bounds.top + Math.floor(descHeight * 0.25); // 25% down from top

  const tapX = bounds.left + 15;
  const tapY = firstLineY;

  console.log(`Tapping description at (${tapX}, ${tapY}) - 1st line upper`);
  await agent.actions.tap(tapX, tapY);
  await sleep(2000);

  // Check if the description panel opened
  let checkScreen = await agent.actions.screenContent();
  let checkCloseBtn = checkScreen.findByIdOne("com.google.android.youtube:id/close_button");

  if (!checkCloseBtn) {
    // Fallback 1: Try mid-height tap (better for smaller screens)
    const midY = bounds.top + Math.floor(descHeight * 0.5);
    console.log(`Description panel did not open, trying mid-height tap at (${tapX}, ${midY})...`);
    await agent.actions.tap(tapX, midY);
    await sleep(2000);

    checkScreen = await agent.actions.screenContent();
    checkCloseBtn = checkScreen.findByIdOne("com.google.android.youtube:id/close_button");
  }

  if (!checkCloseBtn) {
    // Fallback 2: Try randomClick() directly on the description node
    console.log("Trying randomClick() on description node...");
    await descNode.randomClick();
    await sleep(2000);

    checkScreen = await agent.actions.screenContent();
    checkCloseBtn = checkScreen.findByIdOne("com.google.android.youtube:id/close_button");
  }

  if (!checkCloseBtn) {
    // All fallbacks failed — return partial metadata instead of null
    // so the video can still be collected with channel/URL/comments
    console.log("Description panel failed to open after all fallbacks. Returning partial metadata.");
    return {
      likes: null,
      views: null,
      uploadDate: null,
      title: null,
    };
  }

  console.log("Description panel opened successfully");

  // Wait for description panel to appear (look for close_button as indicator)
  let descScreen = await agent.actions.screenContent();
  let panelOpened = false;
  let attempts = 0;
  while (attempts < 5) {
    const closeBtn = descScreen.findByIdOne("com.google.android.youtube:id/close_button");
    if (closeBtn) {
      panelOpened = true;
      break;
    }
    attempts++;
    console.log(`Waiting for description panel to load (attempt ${attempts})...`);
    await sleep(1000);
    descScreen = await agent.actions.screenContent();
  }

  // If the panel never opened, check if we're still on the Shorts feed
  if (!panelOpened) {
    const currentNodes = descScreen.allNodes();
    const stillOnShorts = currentNodes.some(
      (node) =>
        node.viewId === "com.google.android.youtube:id/reel_recycler" ||
        node.viewId === "com.google.android.youtube:id/reel_player_page_container"
    );

    if (stillOnShorts) {
      console.log("Description panel did not open, but still on Shorts feed. Skipping goBack().");
      return null;
    }

    // Something else is on screen (maybe a panel without close_button) — try goBack() carefully
    console.log("Description panel did not open and not on Shorts feed. Pressing back...");
    await agent.actions.goBack();
    await sleep(500);
    return null;
  }

  const descNodes = descScreen.allNodes();

  const metadata: DescriptionMetadata = {
    likes: null,
    views: null,
    uploadDate: null,
    title: null,
  };

  for (const node of descNodes) {
    // IMPORTANT: Check views FIRST — views always have "views" in the description,
    // which is a more reliable signal than likes. This prevents the likes regex
    // from accidentally matching raw view count numbers.

    // Views: description like "12,241,142 views" or text like view count
    const isViewsDescription = node.description?.match(/[\d,]+\s*views?/i) ||
      node.text?.match(/^[\d,]+\s*views?$/i);

    if (isViewsDescription && !metadata.views) {
      const countChild = descNodes.find(
        (n) => n.className === "android.widget.TextView" &&
          n.text &&
          n.text.match(/^[\d,]+/) &&
          n.boundsInScreen?.top >= node.boundsInScreen?.top &&
          n.boundsInScreen?.bottom <= node.boundsInScreen?.bottom &&
          n.boundsInScreen?.left >= node.boundsInScreen?.left &&
          n.boundsInScreen?.right <= node.boundsInScreen?.right
      );
      metadata.views = countChild?.text ?? node.text ?? node.description ?? null;
      console.log(`Found views: ${metadata.views}`);
      continue;
    }

    // Likes: description must contain "likes" 
    // Handles both abbreviations ("1.2K likes") and spelled-out ("62 thousand likes", "1.2 million likes")
    const isLikesDescription = node.description?.match(/\d[\d,.]*\s*(?:[KMB]|thousand|million|billion)?\s*likes?/i);

    if (isLikesDescription && !metadata.likes) {
      // Get the text child with the count (e.g. "55K", "262K", "1.2M")
      const countChild = descNodes.find(
        (n) => n.className === "android.widget.TextView" &&
          n.text &&
          n.text.match(/^\d[\d,.]*\s*[KMB]?$/i) &&
          n.boundsInScreen?.top >= node.boundsInScreen?.top &&
          n.boundsInScreen?.bottom <= node.boundsInScreen?.bottom &&
          n.boundsInScreen?.left >= node.boundsInScreen?.left &&
          n.boundsInScreen?.right <= node.boundsInScreen?.right
      );
      metadata.likes = countChild?.text ?? node.text ?? node.description ?? null;
      console.log(`Found likes: ${metadata.likes}`);
      continue;
    }

    // Upload date: description matches date pattern like "Aug 28, 2025"
    if (node.description?.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}$/) && !metadata.uploadDate) {
      metadata.uploadDate = node.description;
      console.log(`Found upload date: ${metadata.uploadDate}`);
      continue;
    }
  }

  // Title: look for long text that doesn't match views/likes patterns
  // Try ViewGroup first (most common), then TextView as fallback
  const titleNode = descNodes.find(
    (node) =>
      (node.className === "android.view.ViewGroup" || node.className === "android.widget.TextView") &&
      node.text &&
      node.text.length > 10 &&
      !node.text.match(/^\d[\d,.]*\s*[KMB]?\s*(likes?|views?)$/i) &&
      !node.text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}$/)
  );

  if (titleNode) {
    metadata.title = titleNode.text ?? null;
    console.log(`Found title: "${metadata.title?.substring(0, 50)}..."`);
  } else {
    // Fallback: look for any long text node
    const fallbackTitle = descNodes.find(
      (node) => node.text && node.text.length > 20
    );
    if (fallbackTitle) {
      metadata.title = fallbackTitle.text ?? null;
      console.log(`Found title (fallback): "${metadata.title?.substring(0, 50)}..."`);
    }
  }

  console.log("Description metadata:", JSON.stringify(metadata));

  // Close the description panel via close button, with verification
  await closeDescriptionPanel(descScreen);

  return metadata;
}

/**
 * Extract comment count from the Shorts feed screen.
 * Looks for a button with description like "View 12 comments" or "View 1.5K comments".
 * Must be called BEFORE share/description clicks (which change the screen).
 */
export async function extractCommentCount(): Promise<number | null> {
  const screen = await agent.actions.screenContent();
  const allNodes = screen.allNodes();

  const commentNode = allNodes.find(
    (node) =>
      node.description?.match(/^View\s+[\d,.]+[KMB]?\s+comments?$/i) &&
      node.className === "android.widget.Button"
  );

  if (!commentNode) {
    console.log("Comment count node not found on screen");
    return null;
  }

  // Parse "View 12 comments" / "View 1.5K comments" / "View 2M comments"
  const match = commentNode.description!.match(/View\s+([\d,.]+)\s*([KMB]?)\s+comments?/i);
  if (!match) return null;

  let count = parseFloat(match[1].replace(/,/g, ""));
  const suffix = match[2].toUpperCase();

  if (suffix === "K") count *= 1000;
  if (suffix === "M") count *= 1000000;
  if (suffix === "B") count *= 1000000000;

  console.log(`Comment count extracted: ${Math.floor(count)} (from "${commentNode.description}")`);
  return Math.floor(count);
}

/**
 * Extract video ID from YouTube URL
 * Supports youtube.com/shorts/VIDEO_ID and youtu.be/VIDEO_ID formats
 */
export function extractVideoId(url: string): string | null {
  // Match youtube.com/shorts/VIDEO_ID
  let match = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];

  // Match youtu.be/VIDEO_ID
  match = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];

  // Match youtube.com/watch?v=VIDEO_ID
  match = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];

  return null;
}

/**
 * Extract video ID from current screen by looking for video URLs in the UI
 * Used to verify we're on the correct Short after navigation
 * @param nodes - Array of UI nodes from screen content
 * @returns The video ID if found, null otherwise
 */
export function extractVideoIdFromScreen(nodes: any[]): string | null {
  // Look for nodes that might contain video URLs
  for (const node of nodes) {
    // Check text content
    if (node.text) {
      const videoId = extractVideoId(node.text);
      if (videoId) return videoId;
    }
    // Check description
    if (node.description) {
      const videoId = extractVideoId(node.description);
      if (videoId) return videoId;
    }
    // Check viewId for reel_player which might contain video reference
    if (node.viewId?.includes('reel_player')) {
      // The video ID might be in a child node or content description
      // Try to find it in the hierarchy
      const findVideoIdInChildren = (n: any): string | null => {
        if (n.text) {
          const id = extractVideoId(n.text);
          if (id) return id;
        }
        if (n.description) {
          const id = extractVideoId(n.description);
          if (id) return id;
        }
        if (n.children) {
          for (const child of n.children) {
            const result = findVideoIdInChildren(child);
            if (result) return result;
          }
        }
        return null;
      };
      const childVideoId = findVideoIdInChildren(node);
      if (childVideoId) return childVideoId;
    }
  }
  return null;
}

/**
 * Channel info returned from YouTube Data API
 */
export interface ChannelApiInfo {
  channel_id: string;
  channel_creation_date: string; // ISO8601
  channel_video_count: number | null; // Total number of public videos on the channel
}

/**
 * Cache for channel API results to avoid duplicate calls.
 * Key: channel handle (e.g., "@rhumbux"), Value: API result
 */
const channelApiCache: Map<string, ChannelApiInfo> = new Map();

/**
 * Track if we've hit the API quota limit to skip subsequent calls
 */
let apiQuotaExceeded = false;

/**
 * Reset the API quota exceeded flag.
 * Call this at the start of a new task to allow API calls again.
 */
export function resetApiQuotaFlag(): void {
  apiQuotaExceeded = false;
  console.log('API quota flag reset - API calls enabled');
}

/**
 * Check if a channel is less than 2 months old based on creation date.
 * Used to determine if we need GUI verification for bought channels.
 * @param creationDate - ISO8601 date string from YouTube API
 * @returns true if channel is less than 2 months old, false otherwise
 */
export function isChannelLessThan2MonthsOld(creationDate: string | null): boolean {
  if (!creationDate) return false;

  const channelDate = new Date(creationDate);
  const now = new Date();
  const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, now.getDate());

  return channelDate > twoMonthsAgo;
}

/**
 * Verify channel age via GUI by navigating to channel page and checking oldest video.
 * This is used when API shows channel is 2+ months old (might be a bought channel).
 * @param channelUsername - Channel username (e.g., "@channelname")
 * @param expectedVideoId - The video ID we expect to see after returning to Shorts feed (for verification)
 * @returns The upload date of the oldest video (ISO8601) or null if verification fails
 */
export async function verifyChannelAgeViaGUI(channelUsername: string, expectedVideoId?: string): Promise<string | null> {
  console.log(`Verifying channel age via GUI for ${channelUsername}...`);

  try {
    // Step 1: Click on channel username to navigate to channel page (with retry logic)
    let channelPageLoaded = false;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts && !channelPageLoaded) {
      attempts++;
      console.log(`Attempt ${attempts}/${maxAttempts}: Clicking channel username...`);

      const screen = await agent.actions.screenContent();
      const channelNode = screen.findTextOne(channelUsername);

      if (!channelNode) {
        console.log(`Channel username ${channelUsername} not found on screen`);

        // Check if we're still on Shorts feed
        const currentNodes = screen.allNodes();
        if (!detectShortsFeed(currentNodes)) {
          // We might already be on channel page, verify
          if (detectChannelPage(currentNodes)) {
            console.log("Already on channel page!");
            channelPageLoaded = true;
            break;
          }
        }

        if (attempts < maxAttempts) {
          console.log("Waiting before retry...");
          await sleep(2000);
          continue;
        } else {
          return null;
        }
      }

      console.log(`Clicking channel username: ${channelUsername}`);
      await channelNode.randomClick();

      // Wait 3 seconds for page/dialog to load
      console.log("Waiting 3 seconds...");
      await sleep(3000);

      // Check if collaborators dialog appeared
      const checkScreen = await agent.actions.screenContent();
      const checkNodes = checkScreen.allNodes();

      // Check for collaborators dialog first
      if (hasCollaborators(checkNodes)) {
        console.log("Collaborators detected! This Short has multiple collaborators.");
        console.log("Pressing back to close dialog...");
        await agent.actions.goBack();
        await sleep(1000);
        return null;
      }

      if (detectChannelPage(checkNodes)) {
        console.log("Channel page loaded successfully!");
        channelPageLoaded = true;
        break;
      } else {
        console.log("Channel page did not load (still on Shorts feed or other page)");

        // Check if we're still on Shorts feed
        if (detectShortsFeed(checkNodes)) {
          console.log("Still on Shorts feed after click, will retry...");

          if (attempts >= maxAttempts) {
            console.log(`Failed to navigate to channel page after ${maxAttempts} attempts`);
            return null;
          }

          // Wait a bit before retrying
          await sleep(1000);
        } else {
          // We're on some other page, not channel page
          console.log("Not on channel page and not on Shorts feed - unknown state");

          if (attempts >= maxAttempts) {
            console.log(`Failed to navigate to channel page after ${maxAttempts} attempts`);
            return null;
          }

          // Try pressing back to get back to Shorts feed, then retry
          console.log("Pressing back to return to Shorts feed...");
          await agent.actions.goBack();
          await sleep(2000);
        }
      }
    }

    if (!channelPageLoaded) {
      console.log(`Failed to load channel page after ${maxAttempts} attempts`);
      return null;
    }

    // Give a bit more time for channel page to fully render
    await sleep(1000);

    // Step 2: Find and click "Oldest" radio button to sort videos
    const channelScreen = await agent.actions.screenContent();
    const oldestButton = channelScreen.allNodes().find(
      (node: AndroidNode) => node.description === "Oldest" && node.className === "android.widget.RadioButton"
    );

    if (!oldestButton) {
      console.log("Oldest sort button not found, trying to find by text...");
      const oldestByText = channelScreen.allNodes().find(
        (node: AndroidNode) => node.text === "Oldest" && node.className === "android.widget.RadioButton"
      );

      if (!oldestByText) {
        console.log("Could not find Oldest sort button, returning to Shorts feed...");
        await returnToShortsFeed();
        return null;
      }
    }

    let sortButton = oldestButton || channelScreen.allNodes().find(
      (node: AndroidNode) => node.text === "Oldest" && node.className === "android.widget.RadioButton"
    );

    // Try clicking "Oldest" up to 2 times
    let oldestActive = false;
    let attempt = 0;
    const maxSortAttempts = 2;

    while (attempt < maxSortAttempts && !oldestActive) {
      attempt++;
      console.log(`Clicking Oldest sort button (attempt ${attempt}/${maxSortAttempts})...`);
      await sortButton!.randomClick();

      // Poll for "Oldest" tab activation (max 8 seconds)
      console.log("Waiting for videos to be sorted...");
      const sortTimeout = 8000;
      const sortInterval = 1000; // Check every 1s (loading takes time)
      const startTime = Date.now();

      while (Date.now() - startTime < sortTimeout) {
        await sleep(sortInterval);
        const sortCheckScreen = await agent.actions.screenContent();
        if (isOldestTabActive(sortCheckScreen.allNodes())) {
          console.log(`✓ Confirmed: Oldest tab is now active (took ${Date.now() - startTime}ms)`);
          oldestActive = true;
          break;
        }
      }

      if (oldestActive) break;

      console.log(`WARNING: Oldest tab is NOT active after attempt ${attempt}`);

      if (attempt < maxSortAttempts) {
        console.log("Will retry clicking Oldest button...");
        // Refresh sortButton reference in case UI changed
        const refreshedScreen = await agent.actions.screenContent();
        sortButton = refreshedScreen.allNodes().find(
          (node: AndroidNode) => node.description === "Oldest" && node.className === "android.widget.RadioButton"
        ) || refreshedScreen.allNodes().find(
          (node: AndroidNode) => node.text === "Oldest" && node.className === "android.widget.RadioButton"
        );

        if (!sortButton) {
          console.log("Could not find Oldest button for retry");
          break;
        }
      }
    }

    if (!oldestActive) {
      console.log("ERROR: Oldest tab failed to activate after 2 attempts");
      console.log("Sort may have failed. Falling back to API date...");
      await returnToShortsFeed();
      return null;
    }

    // Step 3: Click the first video
    const sortedScreen = await agent.actions.screenContent();
    const firstVideo = sortedScreen.allNodes().find(
      (node: AndroidNode): boolean => {
        // Try multiple patterns for video elements
        const isPlayableVideo =
          (node.className?.includes("Button") && node.description?.includes("play")) ||
          (node.className?.includes("ImageView") && node.clickable && node.description?.includes("video")) ||
          (node.clickable && node.viewId?.includes("thumbnail"));

        // Should be in the main content area (not header)
        const inContentArea = node.boundsInScreen && node.boundsInScreen.top > 400;

        return !!(isPlayableVideo && inContentArea);
      }
    );

    if (!firstVideo) {
      console.log("First video button not found, returning to Shorts feed...");
      await returnToShortsFeed();
      return null;
    }

    console.log("Clicking first video...");
    await firstVideo.randomClick();

    // Wait for video page to fully load and render description
    // Removed fixed 4s sleep in favor of polling below

    // Wait for video page to load
    console.log("Waiting for video page to load...");
    const videoLoaded = await agent.utils.waitForNode(
      (node): boolean => {
        // Check for video player container
        const isVideoPlayer =
          node.viewId?.includes("player") ||
          node.viewId?.includes("watch") ||
          node.className?.includes("Player");

        // Check for video title/description
        const hasVideoInfo =
          node.text &&
          node.text.length > 10 &&
          (node.className?.includes("TextView") || node.className?.includes("ViewGroup"));

        // Check for like/dislike buttons (common on video pages)
        const hasEngagementBtns =
          (node.text === "Like" || node.description?.includes("like") ||
            node.text === "Share" || node.description?.includes("Share")) &&
          node.clickable;

        return !!(isVideoPlayer || hasVideoInfo || hasEngagementBtns);
      },
      10000, // 10 second timeout
      500    // Check every 500ms
    );

    if (!videoLoaded) {
      console.log("Video page did not load within timeout, returning to Shorts feed...");
      await returnToShortsFeed();
      return null;
    }

    // Step 4: Extract upload date directly from the video page
    // On regular video pages (not Shorts), the upload date is often visible without clicking description
    const videoScreen = await agent.actions.screenContent();
    let uploadDate: string | null = null;

    // First try: Look for date pattern directly on the video page
    for (const node of videoScreen.allNodes()) {
      if (node.description?.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}$/)) {
        uploadDate = node.description;
        console.log(`Found upload date on video page: ${uploadDate}`);
        break;
      }
    }

    // If not found, try clicking the description area
    if (!uploadDate) {
      console.log("Upload date not visible, trying to click description...");

      // Use SAME description finding logic as main Shorts collection (from test.ts)
      // First try non-hashtag descriptions (safe to click directly)
      let descriptionNode = videoScreen.allNodes().find(
        (node: AndroidNode) =>
          node.clickable &&
          node.text &&
          node.text.length > 10 &&
          node.className === "android.view.ViewGroup" &&
          node.packageName === "com.google.android.youtube" &&
          !node.text.startsWith("@") &&
          !node.text.startsWith("#") &&
          !node.text.match(/\d+[KM]?\s*views?/i)
      );

      // If not found, try descriptions with hashtags
      if (!descriptionNode) {
        descriptionNode = videoScreen.allNodes().find(
          (node: AndroidNode) =>
            node.clickable &&
            node.text &&
            node.text.length > 10 &&
            node.className === "android.view.ViewGroup" &&
            node.packageName === "com.google.android.youtube" &&
            (node.text.startsWith("#") || node.text.includes("#")) &&
            !node.text.startsWith("@")
        );
      }

      // If still not found, try any clickable ViewGroup with long text (fallback)
      if (!descriptionNode) {
        descriptionNode = videoScreen.allNodes().find(
          (node: AndroidNode) =>
            node.clickable &&
            node.text &&
            node.text.length > 20 &&
            node.className === "android.view.ViewGroup" &&
            node.packageName === "com.google.android.youtube" &&
            !node.text.startsWith("@") &&
            !node.text.match(/^\d+[KM]?\s*(likes?|views?)$/i)
        );
      }

      if (descriptionNode) {
        console.log(`Found description node: "${descriptionNode.text!.substring(0, 50)}..."`)

        // Use SAME tapping logic as main Shorts collection
        // Tap the TOP-LEFT corner (1st line only) to avoid hashtags on 2nd line
        const bounds = descriptionNode.boundsInScreen;
        const descHeight = bounds.bottom - bounds.top;
        const firstLineY = bounds.top + Math.floor(descHeight * 0.25); // 25% down from top (upper half of 1st line)

        // Use the first position that worked in testing: bounds.left + 15, firstLineY
        const tapX = bounds.left + 15;
        const tapY = firstLineY;

        console.log(`Tapping description at (${tapX}, ${tapY}) - 1st line upper`);
        await agent.actions.tap(tapX, tapY);
        await sleep(2000);

        // Check if the description panel opened
        const checkScreen = await agent.actions.screenContent();
        const checkCloseBtn = checkScreen.findByIdOne("com.google.android.youtube:id/close_button");

        if (!checkCloseBtn) {
          console.log("Description panel did not open, trying fallback position...");
          // Fallback: try slightly different position
          await agent.actions.tap(bounds.left + 25, firstLineY);
          await sleep(2000);

          const fallbackScreen = await agent.actions.screenContent();
          const fallbackCloseBtn = fallbackScreen.findByIdOne("com.google.android.youtube:id/close_button");

          if (!fallbackCloseBtn) {
            console.log("Description panel failed to open");
          }
        } else {
          console.log("Description panel opened successfully");
        }

        // Step 5: Extract upload date from description panel
        const descScreen = await agent.actions.screenContent();

        for (const node of descScreen.allNodes()) {
          if (node.description?.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}$/)) {
            uploadDate = node.description;
            console.log(`Found upload date in description panel: ${uploadDate}`);
            break;
          }
        }

        // Close the description panel
        await closeDescriptionPanel(descScreen);
      } else {
        console.log("No description node found...");
      }
    }

    if (!uploadDate) {
      console.log("Upload date not found, returning to Shorts feed...");
      await returnToShortsFeed();
      return null;
    }

    console.log(`Found oldest video upload date: ${uploadDate}`);

    // Step 6: Return to Shorts feed
    await returnToShortsFeed();

    // Step 7: Verify we're back on the correct Short (if expectedVideoId provided)
    if (expectedVideoId) {
      console.log(`Verifying we're back on the correct Short (expected: ${expectedVideoId})...`);
      const maxVerifyAttempts = 3;
      let verified = false;

      const verifyTimeout = 6000;
      const verifyInterval = 1000;
      const startTime = Date.now();

      while (Date.now() - startTime < verifyTimeout) {
        await sleep(verifyInterval); // Wait for Short to load
        const verifyScreen = await agent.actions.screenContent();
        const verifyNodes = verifyScreen.allNodes();

        // Try to extract current video URL and check if it matches
        const currentVideoId = extractVideoIdFromScreen(verifyNodes);

        if (currentVideoId === expectedVideoId) {
          console.log(`Verified: Back on correct Short (${currentVideoId}) in ${Date.now() - startTime}ms`);
          verified = true;
          break;
        } else {
          console.log(`Verification check: Expected ${expectedVideoId}, found ${currentVideoId || 'none'}`);
        }
      }

      if (!verified) {
        console.warn("WARNING: Could not verify we're on the correct Short after GUI verification. Data may be assigned to wrong video.");
        // Still return the date since we got it, but log the warning
      }
    }

    // Convert to ISO8601 format
    const dateObj = new Date(uploadDate);
    return dateObj.toISOString();

  } catch (error) {
    console.error(`Error verifying channel age via GUI: ${error}`);
    await returnToShortsFeed();
    return null;
  }
}

/**
 * Helper function to return to Shorts feed from any screen.
 */
async function returnToShortsFeed(): Promise<void> {
  console.log("Returning to Shorts feed...");

  // Try to find and click Shorts button
  const screen = await agent.actions.screenContent();
  const shortsButton = screen.allNodes().find(
    (node: AndroidNode) => node.description === "Shorts" && node.clickable
  );

  if (shortsButton) {
    await shortsButton.randomClick();
    await sleep(3000);
    console.log("Clicked Shorts button, returned to feed");
  } else {
    // Fallback: press back until we're on Shorts feed
    console.log("Shorts button not found, pressing back...");
    await agent.actions.goBack();
    await sleep(2000);
  }
}

/**
 * Fetch channel ID and creation date from YouTube Data API in a single call.
 * Uses `forHandle` with `part=id,snippet` to get both in one request.
 * Results are cached by handle to avoid repeated API calls for the same channel.
 *
 * @param channelHandle - Channel handle (e.g., "@rhumbux")
 * @param apiKey - YouTube Data API v3 key
 * @returns ChannelApiInfo or null if not found / error
 */
export async function fetchChannelInfo(
  channelHandle: string,
  apiKey: string
): Promise<ChannelApiInfo | null> {
  // Skip API calls if we've already hit the quota limit
  if (apiQuotaExceeded) {
    console.log('Skipping API call - quota already exceeded');
    return null;
  }

  // Normalize handle
  const normalizedHandle = channelHandle.startsWith("@") ? channelHandle : `@${channelHandle}`;

  // Check cache first
  const cached = channelApiCache.get(normalizedHandle);
  if (cached) {
    console.log(`Channel info cache hit for ${normalizedHandle}`);
    return cached;
  }

  try {
    const handle = normalizedHandle.slice(1); // Remove @ for API
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet,statistics&forHandle=${encodeURIComponent(handle)}&key=${encodeURIComponent(apiKey)}`;

    console.log(`Fetching channel info for handle: ${normalizedHandle}`);

    const response = await fetch(url);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorReason = errorData?.error?.errors?.[0]?.reason;
      const errorMessage = errorData?.error?.errors?.[0]?.message;

      // Handle quota exceeded (403)
      if (response.status === 403 && errorReason === 'quotaExceeded') {
        console.error(`YouTube API quota exceeded: ${errorMessage}`);
        console.error('Daily quota limit reached. Please try again tomorrow or request a quota increase.');
        apiQuotaExceeded = true; // Set flag to skip future API calls
        return null;
      }

      // Handle rate limit exceeded (400 or 429)
      if ((response.status === 400 && errorReason === 'rateLimitExceeded') ||
        (response.status === 429 && errorReason === 'rateLimitExceeded')) {
        console.error(`YouTube API rate limit exceeded: ${errorMessage}`);
        console.error('Too many requests. Please wait a moment and try again.');
        return null;
      }

      console.error(`YouTube API error: ${response.status} ${response.statusText} - ${errorReason || 'Unknown error'}`);
      return null;
    }

    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      console.log(`No channel found for handle: ${normalizedHandle}`);
      return null;
    }

    const channel = data.items[0];
    const info: ChannelApiInfo = {
      channel_id: channel.id,
      channel_creation_date: channel.snippet?.publishedAt || null,
      channel_video_count: channel.statistics?.videoCount ? parseInt(channel.statistics.videoCount, 10) : null,
    };

    // Cache the result
    channelApiCache.set(normalizedHandle, info);

    console.log(`Channel info fetched: id=${info.channel_id}, created=${info.channel_creation_date}, videoCount=${info.channel_video_count}`);
    return info;
  } catch (error) {
    console.error(`Error fetching channel info: ${error}`);
    return null;
  }
}

/**
 * Parse ISO 8601 duration (e.g., "PT30S", "PT1M5S") to seconds.
 */
function parseISO8601Duration(duration: string): number | null {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;

  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Fetch video duration from YouTube Data API.
 * Uses the `videos` endpoint with `part=contentDetails` to get duration.
 *
 * @param videoId - YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @param apiKey - YouTube Data API v3 key
 * @returns Duration in seconds or null if not found / error
 */
export async function fetchVideoDuration(
  videoId: string,
  apiKey: string
): Promise<number | null> {
  // Skip API calls if we've already hit the quota limit
  if (apiQuotaExceeded) {
    console.log('Skipping API call - quota already exceeded');
    return null;
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;

    console.log(`Fetching video duration for: ${videoId}`);

    const response = await fetch(url);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorReason = errorData?.error?.errors?.[0]?.reason;
      const errorMessage = errorData?.error?.errors?.[0]?.message;

      // Handle quota exceeded (403)
      if (response.status === 403 && errorReason === 'quotaExceeded') {
        console.error(`YouTube API quota exceeded: ${errorMessage}`);
        console.error('Daily quota limit reached. Please try again tomorrow or request a quota increase.');
        apiQuotaExceeded = true; // Set flag to skip future API calls
        return null;
      }

      // Handle rate limit exceeded (400 or 429)
      if ((response.status === 400 && errorReason === 'rateLimitExceeded') ||
        (response.status === 429 && errorReason === 'rateLimitExceeded')) {
        console.error(`YouTube API rate limit exceeded: ${errorMessage}`);
        console.error('Too many requests. Please wait a moment and try again.');
        return null;
      }

      console.error(`YouTube API error (video): ${response.status} ${response.statusText} - ${errorReason || 'Unknown error'}`);
      return null;
    }

    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      console.log(`No video found for ID: ${videoId}`);
      return null;
    }

    const isoDuration = data.items[0].contentDetails?.duration;
    if (!isoDuration) return null;

    const seconds = parseISO8601Duration(isoDuration);
    console.log(`Video duration: ${isoDuration} = ${seconds}s`);
    return seconds;
  } catch (error) {
    console.error(`Error fetching video duration: ${error}`);
    return null;
  }
}
