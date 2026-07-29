import type { Message } from "@opencode-ai/sdk/v2/client"
import type { PostRevertBranchOverlay, PostRevertBranchOverlays } from "./types"

type SessionRevertCarrier = {
  revert?: { messageID?: string } | null
}

export function getSessionRevertMessageID(session: SessionRevertCarrier | undefined): string | undefined {
  const messageID = session?.revert?.messageID
  return messageID ? messageID : undefined
}

export function hasEffectivePostRevertBranch(
  session: SessionRevertCarrier | undefined,
  overlay: PostRevertBranchOverlay | undefined,
): boolean {
  return getReplacementBoundary(getSessionRevertMessageID(session), overlay) !== undefined
}

/**
 * Derive timeline-visible messages from the authoritative marker plus the
 * local replacement-branch overlay. OpenCode message IDs are ascending, so
 * the replacement ID is the boundary for messages that belong to the
 * replacement branch.
 */
export function getEffectiveVisibleMessages(
  messages: Message[],
  session: SessionRevertCarrier | undefined,
  overlay: PostRevertBranchOverlay | undefined,
): Message[] {
  const revertMessageID = getSessionRevertMessageID(session)
  if (!revertMessageID) return messages

  const replacementBoundary = getReplacementBoundary(revertMessageID, overlay)
  return messages.filter((message) => isVisibleAtBoundary(message.id, revertMessageID, replacementBoundary))
}

export function isEffectivelyVisibleMessage(
  messageID: string,
  session: SessionRevertCarrier | undefined,
  overlay: PostRevertBranchOverlay | undefined,
): boolean {
  const revertMessageID = getSessionRevertMessageID(session)
  if (!revertMessageID) return true

  return isVisibleAtBoundary(messageID, revertMessageID, getReplacementBoundary(revertMessageID, overlay))
}

/** An overlay only applies while it still describes the current marker. */
function getReplacementBoundary(
  revertMessageID: string | undefined,
  overlay: PostRevertBranchOverlay | undefined,
): string | undefined {
  if (!revertMessageID || overlay?.revertMessageID !== revertMessageID) return undefined
  return overlay.replacementMessageID
}

function isVisibleAtBoundary(
  messageID: string,
  revertMessageID: string,
  replacementBoundary: string | undefined,
): boolean {
  // Identifier.ascending IDs sort lexicographically by creation order, and
  // server message snapshots preserve that ordering contract.
  return (
    messageID < revertMessageID
    || (replacementBoundary !== undefined && messageID >= replacementBoundary)
  )
}

/** Replace one session's overlay without disturbing concurrent sessions. */
export function setPostRevertBranchOverlay(
  overlays: PostRevertBranchOverlays,
  sessionID: string,
  overlay: PostRevertBranchOverlay | undefined,
): PostRevertBranchOverlays {
  if (!overlay) return clearPostRevertBranchOverlay(overlays, sessionID)
  return { ...overlays, [sessionID]: overlay }
}

export function clearPostRevertBranchOverlay(
  overlays: PostRevertBranchOverlays,
  sessionID: string,
): PostRevertBranchOverlays {
  if (!overlays[sessionID]) return overlays
  const next = { ...overlays }
  delete next[sessionID]
  return next
}

/**
 * An overlay is valid only while the exact same authoritative marker remains
 * in place. A new revert, unrevert, session removal, or any other marker
 * transition retires it instead of letting it revive against unrelated state.
 */
export function reconcilePostRevertBranchOverlay(
  overlays: PostRevertBranchOverlays,
  sessionID: string,
  session: SessionRevertCarrier | undefined,
): PostRevertBranchOverlays {
  const overlay = overlays[sessionID]
  if (!overlay || getSessionRevertMessageID(session) === overlay.revertMessageID) return overlays
  return clearPostRevertBranchOverlay(overlays, sessionID)
}
