import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"

import {
  clearPostRevertBranchOverlay,
  getEffectiveVisibleMessages,
  getSessionRevertMessageID,
  hasEffectivePostRevertBranch,
  isEffectivelyVisibleMessage,
  reconcilePostRevertBranchOverlay,
  setPostRevertBranchOverlay,
} from "./message-visibility"

const message = (id: string, role: "user" | "assistant" = "user"): Message => ({
  id,
  role,
  sessionID: "ses_1",
  time: { created: 1 },
} as Message)

const sessionWithRevert = (messageID?: string) => (messageID ? { revert: { messageID } } : {})

const branch = (revertMessageID: string, replacementMessageID: string) => ({
  revertMessageID,
  replacementMessageID,
})

describe("getSessionRevertMessageID", () => {
  test("returns the marker only for a non-empty string", () => {
    expect(getSessionRevertMessageID(undefined)).toBe(undefined)
    expect(getSessionRevertMessageID({})).toBe(undefined)
    expect(getSessionRevertMessageID({ revert: null })).toBe(undefined)
    expect(getSessionRevertMessageID({ revert: { messageID: "" } })).toBe(undefined)
    expect(getSessionRevertMessageID({ revert: { messageID: "msg_1" } })).toBe("msg_1")
  })
})

describe("getEffectiveVisibleMessages", () => {
  test("returns every message when the session has no revert marker", () => {
    const messages = [message("msg_001"), message("msg_002")]
    expect(getEffectiveVisibleMessages(messages, sessionWithRevert(), undefined)).toBe(messages)
  })

  test("hides messages at and after the revert marker without an overlay", () => {
    const messages = [message("msg_001"), message("msg_002"), message("msg_003", "assistant")]
    expect(
      getEffectiveVisibleMessages(messages, sessionWithRevert("msg_002"), undefined).map((m) => m.id),
    ).toEqual(["msg_001"])
  })

  test("keeps the replacement branch visible while hiding the discarded interval", () => {
    const messages = [
      message("msg_001"),
      message("msg_002"),
      message("msg_003", "assistant"),
      message("msg_004"),
      message("msg_005", "assistant"),
    ]
    expect(
      getEffectiveVisibleMessages(messages, sessionWithRevert("msg_002"), branch("msg_002", "msg_004")).map((m) => m.id),
    ).toEqual(["msg_001", "msg_004", "msg_005"])
  })

  test("ignores an overlay captured for a different marker", () => {
    const messages = [message("msg_001"), message("msg_002"), message("msg_003", "assistant"), message("msg_004")]
    expect(
      getEffectiveVisibleMessages(messages, sessionWithRevert("msg_003"), branch("msg_002", "msg_004")).map((m) => m.id),
    ).toEqual(["msg_001", "msg_002"])
  })

  test("ignores an overlay when the marker is cleared", () => {
    const messages = [message("msg_001"), message("msg_002"), message("msg_003")]
    expect(
      getEffectiveVisibleMessages(messages, sessionWithRevert(), branch("msg_002", "msg_003")).map((m) => m.id),
    ).toEqual(["msg_001", "msg_002", "msg_003"])
  })
})

describe("isEffectivelyVisibleMessage", () => {
  test("mirrors the collection filter", () => {
    const session = sessionWithRevert("msg_002")
    const overlay = branch("msg_002", "msg_004")
    expect(isEffectivelyVisibleMessage("msg_001", session, overlay)).toBe(true)
    expect(isEffectivelyVisibleMessage("msg_002", session, overlay)).toBe(false)
    expect(isEffectivelyVisibleMessage("msg_003", session, overlay)).toBe(false)
    expect(isEffectivelyVisibleMessage("msg_004", session, overlay)).toBe(true)
    expect(isEffectivelyVisibleMessage("msg_005", session, overlay)).toBe(true)
  })
})

describe("hasEffectivePostRevertBranch", () => {
  test("is true only when the overlay matches the current marker", () => {
    const overlay = branch("msg_002", "msg_004")
    expect(hasEffectivePostRevertBranch(sessionWithRevert("msg_002"), overlay)).toBe(true)
    expect(hasEffectivePostRevertBranch(sessionWithRevert("msg_003"), overlay)).toBe(false)
    expect(hasEffectivePostRevertBranch(sessionWithRevert(), overlay)).toBe(false)
    expect(hasEffectivePostRevertBranch(sessionWithRevert("msg_002"), undefined)).toBe(false)
  })
})

describe("overlay helpers", () => {
  test("setPostRevertBranchOverlay replaces one session without touching others", () => {
    const other = branch("msg_b_002", "msg_b_004")
    const overlay = branch("msg_002", "msg_004")
    const next = setPostRevertBranchOverlay({ ses_b: other }, "ses_1", overlay)
    expect(next.ses_1).toBe(overlay)
    expect(next.ses_b).toBe(other)
    expect(setPostRevertBranchOverlay(next, "ses_1", undefined).ses_1).toBe(undefined)
  })

  test("clearPostRevertBranchOverlay removes only the target session", () => {
    const overlays = { ses_1: branch("msg_002", "msg_004"), ses_2: branch("msg_x", "msg_y") }
    const next = clearPostRevertBranchOverlay(overlays, "ses_1")
    expect(next.ses_1).toBe(undefined)
    expect(next.ses_2).toBe(overlays.ses_2)
    expect(clearPostRevertBranchOverlay(overlays, "ses_missing")).toBe(overlays)
  })
})

describe("reconcilePostRevertBranchOverlay", () => {
  test("keeps the overlay while the same marker survives a session update", () => {
    const overlays = { ses_1: branch("msg_002", "msg_004") }
    expect(reconcilePostRevertBranchOverlay(overlays, "ses_1", sessionWithRevert("msg_002"))).toBe(overlays)
  })

  test("retires the overlay when the marker moves or is cleared", () => {
    const overlays = { ses_1: branch("msg_002", "msg_004") }
    expect(reconcilePostRevertBranchOverlay(overlays, "ses_1", sessionWithRevert("msg_003"))).toEqual({})
    expect(reconcilePostRevertBranchOverlay(overlays, "ses_1", sessionWithRevert())).toEqual({})
    expect(reconcilePostRevertBranchOverlay(overlays, "ses_1", undefined)).toEqual({})
  })

  test("leaves untracked sessions alone", () => {
    const overlays = { ses_1: branch("msg_002", "msg_004") }
    expect(reconcilePostRevertBranchOverlay(overlays, "ses_other", undefined)).toBe(overlays)
  })
})
