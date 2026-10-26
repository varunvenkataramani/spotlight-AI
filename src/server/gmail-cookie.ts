// Short-lived cookie carrying the Gmail consent state between /connect and /callback.
export const GMAIL_COOKIE = "spotlight_gmail";
export const GMAIL_COOKIE_PATH = "/api/gmail";

export type GmailConnectState = { state: string; codeVerifier: string; scanDays: number; userId: string };
