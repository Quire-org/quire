/** Which computer the app runs on, for words that name it: a Mac is "this Mac", any other "this computer". */
export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
export const thisComputer = IS_MAC ? "this Mac" : "this computer";
