// Browser errors that say nothing about this site: extensions, cross-origin scripts, resize loops,
// scripts that wallets, in-app browsers (Facebook, Instagram, Chrome on iPhone) and Safari extensions inject,
// Safari's masked extension scripts and a property ("optionsAutoSave") read by something on visitors' iPhones that
// no script of this site has, autoplay refusals (every play() of ours handles its own; extensions that wrap
// play() leave theirs unhandled), and the rejection Microsoft's link scanner raises in every page it opens when a
// link is shared in Outlook or Teams ("Object Not Found Matching Id:1, MethodName:update, ParamCount:4").
// The pages skip them, and the server drops any that still arrive from pages built before a pattern was added.
const noise = /ResizeObserver loop|^Script error\.?$|extension:\/\/|Non-Error promise rejection captured|window\.ethereum|__gCrWeb|_AutofillCallbackHandler|webkit\.messageHandlers|webkit-masked-url:|optionsAutoSave|The play method is not allowed|play\(\) failed because the user didn't interact|Object Not Found Matching Id:\d+, MethodName:/i;

export const isBrowserNoise = (text: string) => noise.test(text);
