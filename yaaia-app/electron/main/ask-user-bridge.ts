/**
 * Bridge for ask_user tool: waits for user reply (via agent-inject-message).
 */

const ASK_USER_TIMEOUT_MS = 60_000;
const ASK_USER_TIMEOUT_MESSAGE = "User did not reply in time. You can ask again up to 3 times";

let resolveAskUser: ((reply: string) => void) | null = null;
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

export function isWaitingForAskUser(): boolean {
  return resolveAskUser !== null;
}

export interface WaitForUserReplyOptions {
  timeoutMs?: number;
  onTimeout?: () => void;
}

export function waitForUserReply(options?: WaitForUserReplyOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? ASK_USER_TIMEOUT_MS;
  const onTimeout = options?.onTimeout;

  return new Promise<string>((resolve) => {
    const doResolve = (reply: string) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = null;
      resolveAskUser = null;
      resolve(reply);
    };
    resolveAskUser = doResolve;
    timeoutTimer = setTimeout(() => {
      if (resolveAskUser) {
        resolveAskUser = null;
        timeoutTimer = null;
        onTimeout?.();
        resolve(ASK_USER_TIMEOUT_MESSAGE);
      }
    }, timeoutMs);
  });
}

export function deliverUserReply(reply: string): boolean {
  if (resolveAskUser) {
    const fn = resolveAskUser;
    resolveAskUser = null;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    fn(reply.trim() || "(no message)");
    return true;
  }
  return false;
}
