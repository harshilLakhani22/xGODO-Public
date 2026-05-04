declare const agent: any;
type AndroidNode = any;
import { getData, addData } from './data';
import { StageName } from './config';

// Internal list of stages (populated via registerStages)
export let stages: any[] = [];

/**
 * Register stages for the automation
 * Call this from main.ts before starting
 */
export function registerStages(stageList: any[]) {
    stages = stageList;
}

// Utility type for merging screen types
export type UnionToIntersection<U> =
    (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

// Combined ScreenState - simplified type since we can't infer from generic array easily
// Dynamic casting will be used where necessary
export const ScreenState: any = {};

// Current active stage
export let currentStage: StageName = StageName.MapsSearch;

// Current step counter
export let steps = 0;

/**
 * Transition to a new stage
 * Resets the step counter and submits progress
 */
export async function setStage(newStage: StageName) {
    const newStageObject = stages.find(stage => stage.name === newStage);
    if (!newStageObject) {
        console.error(`Stage ${newStage} not registered!`);
        return;
    }
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
