import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import {
  decodePiUtf8Chunks,
  buildPiRpcArgs,
  buildPiPromptCommand,
  deletePiSessionIfCurrent,
  mapPiAvailableModels,
  PiRpcManager,
  piModelCapabilities,
} from "./piRpcManager.ts";

describe("PiRpcManager lifecycle", () => {
  it("uses offline startup for model discovery without changing interactive sessions", () => {
    expect(buildPiRpcArgs({ offline: true })).toEqual([
      "--offline",
      "--mode",
      "rpc",
      "--no-extensions",
    ]);
    expect(buildPiRpcArgs({ agentDir: "/tmp/pi-sessions" })).toEqual([
      "--mode",
      "rpc",
      "--no-extensions",
      "--session-dir",
      "/tmp/pi-sessions",
    ]);
  });

  it("removes a session when the configured binary cannot start", async () => {
    const manager = new PiRpcManager({ binaryPath: "/definitely/missing/pi" });
    const threadId = ThreadId.make("pi-cleanup-test");

    await expect(manager.startSession({ threadId, runtimeMode: "full-access" })).rejects.toThrow();
    expect(manager.hasSession(threadId)).toBe(false);
    await manager.stopAll();
  });

  it("rejects unsupported runtime modes before spawning Pi", async () => {
    const manager = new PiRpcManager({ binaryPath: "/definitely/missing/pi" });
    await expect(
      manager.startSession({
        threadId: ThreadId.make("pi-runtime-mode-test"),
        runtimeMode: "approval-required",
      }),
    ).rejects.toThrow("Pi supports only full-access runtime mode.");
  });

  it("does not advertise thinking levels until Pi reports actual support", () => {
    expect(piModelCapabilities().optionDescriptors).toEqual([]);
    expect(mapPiAvailableModels([])).toEqual([]);
  });

  it("uses steering only for an already accepted running turn", () => {
    expect(buildPiPromptCommand({ message: "first", steering: false })).toEqual({
      type: "prompt",
      message: "first",
    });
    expect(buildPiPromptCommand({ message: "follow-up", steering: true })).toEqual({
      type: "prompt",
      message: "follow-up",
      streamingBehavior: "steer",
    });
  });

  it("only advertises the levels returned by Pi", () => {
    const descriptor = piModelCapabilities(["off", "high"]).optionDescriptors?.[0];
    expect(descriptor).toMatchObject({ type: "select", id: "thinkingLevel" });
    if (descriptor?.type !== "select") throw new Error("Expected a select descriptor.");
    expect(descriptor.options.map((option) => option.id)).toEqual(["off", "high"]);
  });

  it("disambiguates duplicate model names by upstream provider", () => {
    expect(
      mapPiAvailableModels([
        {
          provider: "openai-codex",
          modelId: "gpt-5.6-luna",
          name: "GPT 5.6 Luna",
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", minimal: null, max: "max" },
        },
        {
          provider: "prime-inference",
          modelId: "openai/gpt-5.6-luna",
          name: "GPT 5.6 Luna",
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", minimal: null, max: "max" },
        },
      ]).map((model) => ({ name: model.name, subProvider: model.subProvider })),
    ).toEqual([
      { name: "GPT 5.6 Luna (OpenAI Codex)", subProvider: "OpenAI Codex" },
      { name: "GPT 5.6 Luna (Prime Inference)", subProvider: "Prime Inference" },
    ]);
  });

  it("preserves split UTF-8 code points across stream chunks", () => {
    const bytes = Buffer.from("Pi ✓ café", "utf8");
    expect(
      decodePiUtf8Chunks([bytes.subarray(0, 5), bytes.subarray(5, 8), bytes.subarray(8)]),
    ).toBe("Pi ✓ café");
  });

  it("does not let a stale process exit delete its replacement session", () => {
    const threadId = ThreadId.make("pi-replacement-test");
    const sessions = new Map<ThreadId, object>();
    const oldSession = {};
    const replacement = {};
    sessions.set(threadId, replacement);
    expect(deletePiSessionIfCurrent(sessions, threadId, oldSession)).toBe(false);
    expect(sessions.get(threadId)).toBe(replacement);
    expect(deletePiSessionIfCurrent(sessions, threadId, replacement)).toBe(true);
    expect(sessions.has(threadId)).toBe(false);
  });
});
