import type { AppUpdateSource } from "./appUpdateSourceValue";

declare const __APP_UPDATE_SOURCE__: AppUpdateSource;

/** The build's update source (see vite.config.ts); never overridden at run time. */
export const APP_UPDATE_SOURCE: AppUpdateSource = __APP_UPDATE_SOURCE__;
