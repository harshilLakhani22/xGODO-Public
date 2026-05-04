/**
 * Screen Detection Utilities for YouTube Shorts Upload Automation
 *
 * Detects which YouTube screen we're on based on UI elements.
 * These are best-guess detections based on common YouTube app patterns.
 * They will need refinement once we get actual UI JSON from the device.
 *
 * IMPORTANT: If a detectScreen function doesn't work, capture the full UI JSON
 * from the device and share it so we can update the selectors.
 */

import { APP_PACKAGE_NAME } from './config';

// ============================================================
// YOUTUBE HOME / GENERAL SCREENS
// ============================================================

/**
 * Detect YouTube Home Screen
 * Indicators: YouTube toolbar with logo and filter chips
 */
export function detectYouTubeHome(allNodes: any[]): boolean {
    const hasYouTubePackage = allNodes.some(
        (node) => node.packageName === APP_PACKAGE_NAME
    );

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

    const hasVideoPlayer = allNodes.some(
        (node) => node.viewId === "com.google.android.youtube:id/watch_player"
    );

    return hasYouTubePackage && !hasVideoPlayer && hasToolbar && (hasHomeFilterChips || hasYouTubeLogo);
}

// ============================================================
// UPLOAD FLOW SCREENS
// ============================================================

/**
 * Detect the "Create" bottom sheet / menu
 * When user taps the "+" create button, YouTube shows a creation mode switcher
 * with options like "Short", "Upload a video", "Go live", etc.
 *
 * Real device UI (from select_short_in_add_short.json):
 * - viewId: "com.google.android.youtube:id/creation_mode_button"
 * - text: "Short"
 * - Parent viewId: "com.google.android.youtube:id/creation_modes_switcher_item"
 */
export function detectCreateMenu(allNodes: any[]): boolean {
    const hasYouTubePackage = allNodes.some(
        (node) => node.packageName === APP_PACKAGE_NAME
    );

    // Primary: Match real device viewId from JSON data
    const hasCreationModeSwitcher = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId &&
            (node.viewId === "com.google.android.youtube:id/creation_mode_button" ||
                node.viewId === "com.google.android.youtube:id/creation_modes_switcher_item")
    );

    // Secondary: Match "Short" text button (from real device)
    const hasShortButton = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            ((node.text === "Short" && node.className === "android.widget.Button") ||
                (node.description === "Short" && node.clickable))
    );

    // Fallback: Legacy text patterns for different YouTube versions
    const hasCreateShort = allNodes.some(
        (node) => node.text &&
            (node.text === "Create a Short" ||
                node.text === "Create a short" ||
                node.text.toLowerCase().includes("create a short"))
    );

    const hasUploadVideo = allNodes.some(
        (node) => node.text &&
            (node.text === "Upload a video" ||
                node.text.toLowerCase().includes("upload a video"))
    );

    // IMPORTANT: The creation_mode_button tabs (Video, Short, Live, Post) persist
    // on the Shorts Camera screen too! We must exclude the camera screen by checking
    // for camera-specific elements that only appear when the camera is already open.
    const isCameraScreen = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId &&
            (node.viewId === "com.google.android.youtube:id/reel_camera_gallery_button_label" ||
                node.viewId === "com.google.android.youtube:id/shorts_camera_sticker_warning_text" ||
                node.viewId === "com.google.android.youtube:id/duration_button_text" ||
                node.viewId === "com.google.android.youtube:id/shorts_record_button" ||
                node.viewId === "com.google.android.youtube:id/sound_button_title" ||
                node.viewId === "com.google.android.youtube:id/reel_camera_layout")
    );

    if (isCameraScreen) {
        // We're on the Shorts Camera, not the Create Menu
        return false;
    }

    return hasYouTubePackage && (hasCreationModeSwitcher || hasShortButton || hasCreateShort || hasUploadVideo);
}

/**
 * Detect YouTube's built-in Gallery bottom sheet for video selection
 *
 * Real device UI (from gallery.json):
 * - viewId: "com.google.android.youtube:id/media_grid_fragment"
 * - viewId: "com.google.android.youtube:id/select_album_button" (text="Gallery")
 * - viewId: "com.google.android.youtube:id/media_grid_recycler_view" (GridView)
 * - viewId: "com.google.android.youtube:id/thumb_image_view" (video thumbnails)
 * - Buttons: "Create video", "Search YouTube"
 */
export function detectGalleryBottomSheet(allNodes: any[]): boolean {
    const hasYouTubePackage = allNodes.some(
        (node) => node.packageName === APP_PACKAGE_NAME
    );

    // Primary: Check for the media grid fragment (most reliable)
    const hasMediaGrid = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId &&
            (node.viewId === "com.google.android.youtube:id/media_grid_fragment" ||
                node.viewId === "com.google.android.youtube:id/media_grid_recycler_view")
    );

    // Secondary: Check for the album selector button (text="Gallery")
    const hasAlbumSelector = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId === "com.google.android.youtube:id/select_album_button"
    );

    // Tertiary: Check for thumb_image_view (video thumbnails in the grid)
    const hasThumbImages = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId === "com.google.android.youtube:id/thumb_image_view"
    );

    // Also detect gallery screen with "Next" button after video selection
    const hasNextButton = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId === "com.google.android.youtube:id/multi_select_next_button"
    );

    return hasYouTubePackage && (hasMediaGrid || hasAlbumSelector || hasThumbImages || hasNextButton);
}

/**
 * Detect the Trim/Cut screen for the selected video
 *
 * Real device UI (from edit.json / edit_done.json):
 * - viewId: "com.google.android.youtube:id/shorts_trim_back" (description="Close trim")
 * - viewId: "com.google.android.youtube:id/shorts_trim_finish_trim_button" (text="Done")
 * - viewId: "com.google.android.youtube:id/shorts_duration_button"
 * - viewId: "com.google.android.youtube:id/filmstrip_playhead"
 * - SeekBars with descriptions like "Filmstrip selected at...", "Left Trim Handle..."
 * - viewId: "com.google.android.youtube:id/shorts_creation_player_view_container"
 */
export function detectTrimScreen(allNodes: any[]): boolean {
    const hasYouTubePackage = allNodes.some(
        (node) => node.packageName === APP_PACKAGE_NAME
    );

    // Primary: Check for the trim-specific elements
    const hasTrimButton = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId &&
            (node.viewId === "com.google.android.youtube:id/shorts_trim_finish_trim_button" ||
                node.viewId === "com.google.android.youtube:id/shorts_trim_back")
    );

    // Secondary: Check for filmstrip/playhead
    const hasFilmstrip = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            (node.viewId === "com.google.android.youtube:id/filmstrip_playhead" ||
                (node.description && node.description.includes("Filmstrip selected at")))
    );

    // Tertiary: Check for duration button (3m/15s toggle)
    const hasDurationButton = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId === "com.google.android.youtube:id/shorts_duration_button"
    );

    return hasYouTubePackage && (hasTrimButton || (hasFilmstrip && hasDurationButton));
}

/**
 * Detect the YouTube Shorts camera/recording screen
 * This appears immediately after tapping "Short" from the creation menu.
 *
 * Real device UI (from add_shorts.json):
 * - viewId: "com.google.android.youtube:id/reel_camera_layout"
 * - viewId: "com.google.android.youtube:id/shorts_record_button_view_container"
 * - viewId: "com.google.android.youtube:id/camera_preview"
 * - viewId: "com.google.android.youtube:id/shorts_camera_toolbar"
 *
 * On this screen, a gallery thumbnail appears at the bottom-left
 * which we need to tap to select the downloaded video.
 */
export function detectShortsCamera(allNodes: any[]): boolean {
    const hasYouTubePackage = allNodes.some(
        (node) => node.packageName === APP_PACKAGE_NAME
    );

    // Primary: Check for the camera layout (most reliable)
    const hasCameraLayout = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId &&
            (node.viewId === "com.google.android.youtube:id/reel_camera_layout" ||
                node.viewId === "com.google.android.youtube:id/camera_preview")
    );

    // Secondary: Check for the record button
    const hasRecordButton = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId &&
            (node.viewId === "com.google.android.youtube:id/shorts_record_button_view_container" ||
                node.viewId === "com.google.android.youtube:id/shorts_record_button_touch_area")
    );

    // Tertiary: Check for camera toolbar buttons (Flip, Timer, etc.)
    const hasCameraToolbar = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId === "com.google.android.youtube:id/shorts_camera_toolbar"
    );

    // Additional: Check for camera-specific elements confirmed from real device logs
    // These viewIds consistently appear on the camera screen alongside creation_mode_button tabs
    const hasCameraElements = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId &&
            (node.viewId === "com.google.android.youtube:id/reel_camera_gallery_button_label" ||
                node.viewId === "com.google.android.youtube:id/sound_button_title" ||
                node.viewId === "com.google.android.youtube:id/duration_button_text" ||
                node.viewId === "com.google.android.youtube:id/shorts_camera_sticker_warning_text")
    );

    return hasYouTubePackage && (hasCameraLayout || hasRecordButton || hasCameraToolbar || hasCameraElements);
}

/**
 * Detect YouTube Short editor/preview screen (the FINAL edit screen)
 * After trimming, YouTube shows the full editor with:
 * - Video preview with editing tools (Text, Filters, Captions, Stickers, Voiceover)
 * - "Add sound" button at top
 * - "Edit" and "Next" buttons at bottom
 * - "Swipe up to edit" prompt
 *
 * Real device UI (from final_edit.json):
 * - viewId: "com.google.android.youtube:id/shorts_edit_container"
 * - viewId: "com.google.android.youtube:id/edit_fragment_container"
 * - viewId: "com.google.android.youtube:id/shorts_post_bottom_button" (text="Next")
 * - viewId: "com.google.android.youtube:id/button_scroller" (Text/Filters/Stickers)
 * - viewId: "com.google.android.youtube:id/shorts_edit_text_button" (desc="Text")
 *
 * IMPORTANT: This must NOT match the Trim screen. The key differentiator is
 * shorts_edit_container / shorts_post_bottom_button which only appear on the
 * final edit screen, NOT the trim screen.
 */
export function detectShortEditor(allNodes: any[]): boolean {
    const hasYouTubePackage = allNodes.some(
        (node) => node.packageName === APP_PACKAGE_NAME
    );

    // Primary: Check for the edit container (most reliable, unique to final edit screen)
    const hasEditContainer = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId &&
            (node.viewId === "com.google.android.youtube:id/shorts_edit_container" ||
                node.viewId === "com.google.android.youtube:id/edit_fragment_container")
    );

    // Secondary: Check for the "Next" button with specific viewId
    const hasNextButton = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId === "com.google.android.youtube:id/shorts_post_bottom_button" &&
            node.text === "Next"
    );

    // Tertiary: Check for editing tool buttons (Text, Filters, etc.)
    const hasEditTools = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId &&
            (node.viewId === "com.google.android.youtube:id/shorts_edit_text_button" ||
                node.viewId === "com.google.android.youtube:id/shorts_edit_preset_button" ||
                node.viewId === "com.google.android.youtube:id/shorts_edit_captions_button")
    );

    return hasYouTubePackage && (hasEditContainer || hasNextButton || hasEditTools);
}

/**
 * Detect the metadata/details screen ("Add details")
 * This appears after tapping "Next" on the final edit screen.
 *
 * Real device UI (from final_screen.png):
 * - "Add details" heading text
 * - "Caption your Short" hint text
 * - "Upload Short" button
 * - "Save draft" button
 * - Visibility section showing "Public"
 * - "Select audience" option
 */
export function detectMetadataScreen(allNodes: any[]): boolean {
    const hasYouTubePackage = allNodes.some(
        (node) => node.packageName === APP_PACKAGE_NAME
    );

    // Primary: Look for "Upload Short" button text
    const hasUploadShortButton = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.text &&
            (node.text === "Upload Short" ||
                node.text === "Upload" ||
                node.text === "UPLOAD")
    );

    // Secondary: Look for "Caption your Short" text (the hint text on the title field)
    const hasCaptionHint = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            (
                (node.text && node.text === "Caption your Short") ||
                (node.hintText && node.hintText === "Caption your Short")
            )
    );

    // Tertiary: Look for "Add details" heading
    const hasAddDetails = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.text &&
            (node.text === "Add details" || node.text === "Add a title")
    );

    // Look for "Save draft" button (unique to metadata screen)
    const hasSaveDraft = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.text === "Save draft"
    );

    // Look for "Select audience" option
    const hasSelectAudience = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.text === "Select audience"
    );

    // We need YouTube package + at least 2 indicators to be confident
    const indicators = [hasUploadShortButton, hasCaptionHint, hasAddDetails, hasSaveDraft, hasSelectAudience];
    const matchCount = indicators.filter(Boolean).length;

    return hasYouTubePackage && matchCount >= 2;
}

/**
 * Detect the uploading/processing screen
 * YouTube shows a progress bar and "Uploading..." or "Processing..." text
 */
export function detectUploadingScreen(allNodes: any[]): boolean {
    const hasYouTubePackage = allNodes.some(
        (node) => node.packageName === APP_PACKAGE_NAME
    );

    const hasUploadingText = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.text &&
            (
                node.text.toLowerCase().includes("uploading") ||
                node.text.toLowerCase().includes("processing") ||
                node.text.toLowerCase().includes("publishing")
            )
    );

    // Look for progress bar
    const hasProgressBar = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.className === "android.widget.ProgressBar"
    );

    return hasYouTubePackage && (hasUploadingText || hasProgressBar);
}

/**
 * Detect upload success screen
 * YouTube typically shows a success message or redirects back to the feed
 */
export function detectUploadSuccess(allNodes: any[]): boolean {
    const hasYouTubePackage = allNodes.some(
        (node) => node.packageName === APP_PACKAGE_NAME
    );

    const hasSuccessText = allNodes.some(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.text &&
            (
                node.text.toLowerCase().includes("video uploaded") ||
                node.text.toLowerCase().includes("upload complete") ||
                node.text.toLowerCase().includes("short uploaded") ||
                node.text.toLowerCase().includes("your video has been uploaded") ||
                node.text.toLowerCase().includes("done")
            )
    );

    return hasYouTubePackage && hasSuccessText;
}

/**
 * Detect visibility selection dialog/screen
 * When user taps on visibility, a dialog appears with Public/Unlisted/Private options
 */
export function detectVisibilitySelector(allNodes: any[]): boolean {
    const hasYouTubePackage = allNodes.some(
        (node) => node.packageName === APP_PACKAGE_NAME
    );

    // Look for multiple visibility options in a list/dialog
    const visibilityOptions = ['Public', 'Unlisted', 'Private'];
    const foundOptions = visibilityOptions.filter(option =>
        allNodes.some((node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.text === option &&
            node.clickable
        )
    );

    // If 2 or more visibility options are visible and clickable, we're on the selector
    return hasYouTubePackage && foundOptions.length >= 2;
}

/**
 * Get the "Create" / "+" button on YouTube home/main screen
 * This is the bottom bar create button.
 *
 * Real device UI (from +button.json):
 * - description: "Create"
 * - className: "android.widget.Button"
 * - clickable: true
 * - bounds: bottom area (top: 2211, bottom: 2337)
 */
export function getCreateButton(allNodes: any[]): any | undefined {
    // Primary: Match exact real device data — description="Create" + Button class
    const createByDescriptionButton = allNodes.find(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.description === "Create" &&
            node.className === "android.widget.Button" &&
            node.clickable
    );

    if (createByDescriptionButton) return createByDescriptionButton;

    // Secondary: description="Create" with any clickable class
    const createByDescription = allNodes.find(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.description === "Create" &&
            (node.clickable || node.className === "android.widget.ImageView")
    );

    if (createByDescription) return createByDescription;

    // Tertiary: Try viewId-based matching
    const createByViewId = allNodes.find(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            node.viewId &&
            (node.viewId.includes("fab") ||
                node.viewId.includes("create") ||
                node.viewId.includes("upload_button"))
    );

    if (createByViewId) return createByViewId;

    // Fallback: look for "+" text or related content description
    return allNodes.find(
        (node) =>
            node.packageName === APP_PACKAGE_NAME &&
            (node.text === "+" || node.description === "+") &&
            node.clickable
    );
}
