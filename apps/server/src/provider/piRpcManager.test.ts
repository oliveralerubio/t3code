import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { PiRpcManager } from "./piRpcManager.ts";

describe("PiRpcManager lifecycle", () => {
  it("removes a session when the configured binary cannot start", async () => {
    const manager = new PiRpcManager({ binaryPath: "/definitely/missing/pi" });
    const threadId = ThreadId.make("pi-cleanup-test");

    await expect(manager.startSession({ threadId, runtimeMode: "full-access" })).rejects.toThrow();
    expect(manager.hasSession(threadId)).toBe(false);
    await manager.stopAll();
  });
});
