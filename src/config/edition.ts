/**
 * The application edition is injected by Vite as a build-time literal.
 * Core is the safe default for production builds; AI builds opt in with
 * `VITE_EDITION=ai`.
 */
import type { AppEdition } from "./editionValue";

export type { AppEdition } from "./editionValue";
export { normalizeAppEdition } from "./editionValue";

declare const __APP_EDITION__: AppEdition;

export const APP_EDITION: AppEdition = __APP_EDITION__;
export const IS_AI_EDITION = APP_EDITION === "ai";
