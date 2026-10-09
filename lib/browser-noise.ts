// Browser errors that say nothing about this site: extensions, cross-origin scripts, resize loops,
// scripts that wallets, in-app browsers (Facebook, Instagram, Chrome on iPhone) and Safari extensions inject,
// and autoplay refusals (every play() of ours handles its own; extensions that wrap play() leave theirs unhandled).
// The pages skip them, and the server drops any that still arrive from pages built before a pattern was added.
const noise = /ResizeObserver loop|^Script error\.?$|extension:\/\/|Non-Error promise rejection captured|window\.ethereum|__gCrWeb|_AutofillCallbackHandler|webkit\.messageHandlers|The play method is not allowed|play\(\) failed because the user didn't interact/i;

export const isBrowserNoise = (text: string) => noise.test(text);
