/**
 * Stage Management System
 *
 * This module provides a stage-based state machine for automations.
 * Each stage represents a distinct phase of your automation workflow.
 */

import { MapsSearchStage } from './MapsSearchStage';
import { RateBusinessStage } from './RateBusinessStage';
import { getData, addData } from './data';

// Register all stages here
// For our Google Maps automation, we only have one stage
export const stages = [MapsSearchStage, RateBusinessStage] as const;

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
 */
export type ScreenHandle = {
    detectScreen: (screenContent: AndroidNode) => Promise<boolean>;
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
    name: string;
    maxSteps: number;
    screens: T;
    screenHandles: ScreenHandles<keyof T & string>;
    defaultHandle: () => Promise<void>;
};
