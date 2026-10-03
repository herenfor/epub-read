/**
 * Web/compile-time application version injected by Vite from package.json.
 * Native builds must read the handshake buildInfo instead of this constant.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = __APP_VERSION__;
