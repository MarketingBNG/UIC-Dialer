/** Shared animation timing: fast and calm, ease-out, no springs. */
export const EASE_OUT = [0.2, 0, 0, 1] as const;
export const FAST = { duration: 0.18, ease: EASE_OUT };
export const BASE = { duration: 0.22, ease: EASE_OUT };
