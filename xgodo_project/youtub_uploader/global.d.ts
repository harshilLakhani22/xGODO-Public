declare const agent: any;
declare function sleep(ms: number, max?: number): Promise<void>;
declare function getAllNodes(screen: any): any[];
type AndroidNode = any;
type AndroidNodeFilter = any;
declare const ScreenshotRecord: {
    LOW_QUALITY: any;
    HIGH_QUALITY: any;
};
declare namespace agent {
    export const actions: {
        [key: string]: any;
    };
}
