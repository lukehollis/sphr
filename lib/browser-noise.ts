// Browser errors that say nothing about this site: extensions, cross-origin scripts, resize loops, and
// scripts that wallets, in-app browsers (Facebook, Instagram, Chrome on iPhone) and Safari extensions inject.
// The pages skip them, and the server drops any that still arrive from pages built before a pattern was added.
const noise = /ResizeObserver loop|^Script error\.?$|extension:\/\/|Non-Error promise rejection captured|window\.ethereum|__gCrWeb|_AutofillCallbackHandler|webkit\.messageHandlers/i;

export const isBrowserNoise = (text: string) => noise.test(text);
