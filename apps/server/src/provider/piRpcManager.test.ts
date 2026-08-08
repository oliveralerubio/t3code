import { describe, expect, it } from "@effect/vitest";
import { PI_THINKING_LEVEL_OPTIONS, ThreadId } from "@t3tools/contracts";
import { mapPiAvailableModels, PiRpcManager, piModelCapabilities } from "./piRpcManager.ts";

describe("PiRpcManager lifecycle", () => {
  it("removes a session when the configured binary cannot start", async () => {
    const manager = new PiRpcManager({ binaryPath: "/definitely/missing/pi" });
    const threadId = ThreadId.make("pi-cleanup-test");

    await expect(manager.startSession({ threadId, runtimeMode: "full-access" })).rejects.toThrow();
    expect(manager.hasSession(threadId)).toBe(false);
    await manager.stopAll();
  });

  it("publishes Pi thinking levels and does not invent a model when discovery is empty", () => {
    const descriptor = (piModelCapabilities().optionDescriptors ?? []).find(
      (candidate) => candidate.id === "thinkingLevel",
    );

    expect(descriptor?.type).toBe("select");
    if (descriptor === undefined || descriptor.type !== "select") {
      throw new Error("Expected a Pi thinking-level select descriptor.");
    }
    expect(descriptor.options.map((option) => option.id)).toEqual([...PI_THINKING_LEVEL_OPTIONS]);
    expect(mapPiAvailableModels([])).toEqual([]);
  });
});
