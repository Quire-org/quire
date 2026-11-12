/** Which computer the app runs on, for words that name it: a Mac is "this Mac", any other "this computer". */
export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
export const thisComputer = IS_MAC ? "this Mac" : "this computer";

/** The phone and tablet app: a page of its own (mobile.html). */
export const IS_MOBILE = typeof location !== "undefined" && /\/mobile(\.html)?$/.test(location.pathname);
/** Which Home this device has: a computer's (none named), a phone's or a tablet's. */
export const HOME_DEVICE: "phone" | "tablet" | undefined = !IS_MOBILE ? undefined : Math.min(window.screen.width, window.screen.height) < 600 ? "phone" : "tablet";
