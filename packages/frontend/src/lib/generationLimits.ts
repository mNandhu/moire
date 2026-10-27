/** Generation limits, equal to the backend's services/generation_limits.py
 *  (tests/test_mirrored_vocab.py keeps the two in step). */
export const STEPS_RANGE = [1, 200] as const;
export const CFG_RANGE = [0, 30] as const;
/** As many characters as one prompt takes (the backend keeps this many). */
export const MAX_CHARACTERS = 8;
/** ComfyUI's seed widgets take an unsigned 64-bit value; stay well inside it. */
export const SEED_MAX = 2 ** 50;
/** The most images ComfyUI makes at once in one request. */
export const PER_REQUEST_MAX = 64;
