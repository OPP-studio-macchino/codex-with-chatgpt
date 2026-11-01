// Display deadlines are separate from the 60-second post-approval checkpoint TTL.
export const OWNER_DIALOG_TIMEOUT_SECONDS = 45 * 60;
export const OWNER_DIALOG_TIMEOUT_MS = OWNER_DIALOG_TIMEOUT_SECONDS * 1000;
export const OWNER_DIALOG_HELPER_TIMEOUT_MS = OWNER_DIALOG_TIMEOUT_MS + 5_000;
// Caller-side RPC/process window; larger than the helper so transport cleanup cannot truncate the dialog.
export const OWNER_DIALOG_REQUEST_TIMEOUT_MS = OWNER_DIALOG_HELPER_TIMEOUT_MS + 5_000;
// Leave time for evidence collection and verification around the owner dialog.
export const RECONCILIATION_TIMEOUT_MS = OWNER_DIALOG_TIMEOUT_MS + 5 * 60_000;
// Two sequential dialogs, two 15s compile + 15s sign passes, and verification margin.
export const REGISTRATION_TIMEOUT_MS = 2 * OWNER_DIALOG_HELPER_TIMEOUT_MS + 2 * (15_000 + 15_000) + 120_000;
export const CODEX_TURN_TIMEOUT_MS = OWNER_DIALOG_TIMEOUT_MS + 5 * 60_000;
