/**
 * Stage Management System for YouTube Shorts Upload Automation
 *
 * This module provides a stage-based state machine for the upload workflow.
 * Each stage represents a distinct phase:
 * - Login: Ensure YouTube is open and user is logged in
 * - Download: Download video from URL to device storage
 * - Upload: Navigate YouTube upload flow and publish the Short
 * - Verify: Confirm upload was successful
 */

import LoginStage from './LoginStage';
import DownloadStage from './DownloadStage';
import UploadStage from './UploadStage';
import VerifyStage from './VerifyStage';
import { getData, addData } from './data';

// Register all stages here
export const stages = [LoginStage, DownloadStage, UploadStage, VerifyStage] as const;

// Create a type-safe Stage enum from registered stages
export const Stage = Object.fromEntries(
    stages.map(stage => [stage.name, stage.name])
) as { [K in typeof stages[number]['name']]: K };

// Utility type for merging screen types
export type UnionToIntersection<U> =
    (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

// Combined ScreenState from all stages
export const ScreenState = Object.assign(
    {},
    ...stages.map(stage => stage.screens)
) as UnionToIntersection<typeof stages[number]['screens']>;

// Current active stage
export let currentStage: keyof typeof Stage = Stage[Object.keys(Stage)[0] as keyof typeof Stage];

// Current step counter
export let steps = stages.find(stage => stage.name === currentStage)!.maxSteps as number;

/**
 * Transition to a new stage
 * Resets the step counter and submits progress
 */
export async function setStage(newStage: keyof typeof Stage) {
    const newStageObject = stages.find(stage => stage.name === newStage)!;
    console.log("Transitioning to stage:", newStage, "| Max steps:", newStageObject.maxSteps);
    currentStage = newStage;
    addData({ stage: currentStage });
    await agent.utils.job.submitTask("running", getData(), false);
    steps = newStageObject.maxSteps;
}

/**
 * Get the current stage object with all its handlers
 */
export async function getStageObject() {
    return stages.find(stage => stage.name === currentStage)!;
}

/**
 * Update the step counter
 */
export async function setSteps(newSteps: number) {
    steps = newSteps;
}

/**
 * Screen handler interface
 * Implement this for each screen your automation needs to handle
 */
export type ScreenHandle = {
    /** Detect if this screen is currently displayed */
    detectScreen: (screenContent: AndroidNode) => Promise<boolean>;
    /** Handle the screen - perform actions and return success status */
    handleScreen: (screenContent: AndroidNode) => Promise<boolean>;
};

/**
 * Map of screen names to their handlers
 */
export type ScreenHandles<T extends string> = {
    [K in T]: ScreenHandle;
};

/**
 * Stage definition interface
 */
export type Stage<T extends Record<string, string>> = {
    /** Unique name for this stage */
    name: string;
    /** Maximum iterations before timeout */
    maxSteps: number;
    /** Screen state enum for this stage */
    screens: T;
    /** Handlers for each screen in this stage */
    screenHandles: ScreenHandles<keyof T & string>;
    /** Called when entering this stage (e.g., launch app) */
    defaultHandle: () => Promise<void>;
};
