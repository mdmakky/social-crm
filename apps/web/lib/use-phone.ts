import * as React from "react";

const Q = "(max-width: 767.98px)";
const sub = (cb: () => void) => { const m = window.matchMedia(Q); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
/** True below the md breakpoint (the phone layout). False during server render, so the desktop markup is what hydrates. */
export const usePhone = () => React.useSyncExternalStore(sub, () => window.matchMedia(Q).matches, () => false);
