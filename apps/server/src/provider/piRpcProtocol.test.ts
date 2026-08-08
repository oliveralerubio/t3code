import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnId } from "@t3tools/contracts";
import {
  mapPiRpcEvent,
  mapAgentRpcEvent,
  parsePiModel,
  parsePiRpcLine,
  parsePiThinkingLevel,
  piThinkingLevelsFromModel,
} from "./piRpcProtocol.ts";

describe("Pi RPC protocol", () => {
  it("accepts strict JSONL with optional CRLF and rejects malformed records", () => {
    expect(parsePiRpcLine('{"type":"agent_start"}\r')).toEqual({ type: "agent_start" });
    expect(parsePiRpcLine("not json")).toBeNull();
    expect(parsePiRpcLine("\u2028")).toBeNull();
  });

  it("discovers only provider/model records and preserves Pi thinking vocabulary", () => {
    expect(parsePiModel({ provider: "openai", modelId: "gpt-5" })).toBe("openai/gpt-5");
    expect(parsePiModel({ provider: "openai" })).toBeUndefined();
    expect(parsePiThinkingLevel("xhigh")).toBe("xhigh");
    expect(parsePiThinkingLevel("ultrathink")).toBeUndefined();
  });

  it("maps Pi terminal stop reasons without duplicating successful completion", () => {
    const threadId = ThreadId.make("pi-thread");
    const turnId = TurnId.make("pi-turn");

    expect(
      mapPiRpcEvent({
        threadId,
        turnId,
        event: { type: "agent_settled", stopReason: "error", errorMessage: "quota exceeded" },
      })[0],
    ).toMatchObject({
      type: "turn.completed",
      payload: { state: "failed", stopReason: "error", errorMessage: "quota exceeded" },
    });
    expect(
      mapPiRpcEvent({
        threadId,
        turnId,
        event: { type: "agent_settled", stopReason: "aborted", errorMessage: "user stopped" },
      })[0],
    ).toMatchObject({
      type: "turn.completed",
      payload: { state: "interrupted", stopReason: "aborted", errorMessage: "user stopped" },
    });
  });

  it("maps the shared event protocol with the Prime Agent provider kind", () => {
    const event = mapAgentRpcEvent({
      provider: "primeAgent" as never,
      threadId: ThreadId.make("prime-agent-thread"),
      turnId: TurnId.make("prime-agent-turn"),
      event: { type: "turn_start" },
    })[0];
    expect(event).toMatchObject({ type: "turn.started", provider: "primeAgent" });
  });

  it("uses Pi message identity to separate assistant segments", () => {
    const threadId = ThreadId.make("pi-thread");
    const turnId = TurnId.make("pi-turn");
    const first = mapPiRpcEvent({
      threadId,
      turnId,
      event: {
        type: "message_end",
        message: { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "one" }] },
      },
    })[0];
    const second = mapPiRpcEvent({
      threadId,
      turnId,
      event: {
        type: "message_end",
        message: { id: "assistant-2", role: "assistant", content: [{ type: "text", text: "two" }] },
      },
    })[0];
    expect(first?.itemId).not.toBe(second?.itemId);
  });

  it("separates text-tool-text assistant segments without message ids", () => {
    const threadId = ThreadId.make("pi-thread");
    const turnId = TurnId.make("pi-turn");
    const first = mapPiRpcEvent({
      threadId,
      turnId,
      event: {
        type: "message_update",
        piAssistantSequence: 1,
        assistantMessageEvent: { type: "text_delta", delta: "one" },
      },
    })[0];
    const second = mapPiRpcEvent({
      threadId,
      turnId,
      event: {
        type: "message_update",
        piAssistantSequence: 2,
        assistantMessageEvent: { type: "text_delta", delta: "two" },
      },
    })[0];
    expect(first?.itemId).not.toBe(second?.itemId);
  });

  it("derives Pi thinking levels from model metadata", () => {
    expect(
      piThinkingLevelsFromModel({
        reasoning: true,
        thinkingLevelMap: { low: "low", medium: null, high: "high" },
      }),
    ).toEqual(["off", "minimal", "low", "high", "xhigh", "max"]);
    expect(
      piThinkingLevelsFromModel({
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", minimal: null, max: "max" },
      }),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(piThinkingLevelsFromModel({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(piThinkingLevelsFromModel({ reasoning: false })).toEqual(["off"]);
  });

  it("suppresses empty assistant completions and maps tool stages", () => {
    const threadId = ThreadId.make("pi-thread");
    const turnId = TurnId.make("pi-turn");
    expect(
      mapPiRpcEvent({
        threadId,
        turnId,
        event: { type: "message_end", message: { role: "assistant", content: [] } },
      }),
    ).toEqual([]);
    expect(
      mapPiRpcEvent({
        threadId,
        turnId,
        event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" },
      })[0]?.type,
    ).toBe("item.started");
    expect(
      mapPiRpcEvent({
        threadId,
        turnId,
        event: {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "bash",
          isError: true,
        },
      })[0]?.type,
    ).toBe("item.completed");
    expect(mapPiRpcEvent({ threadId, turnId, event: { type: "agent_end" } })).toEqual([]);
    expect(mapPiRpcEvent({ threadId, turnId, event: { type: "agent_settled" } })[0]?.type).toBe(
      "turn.completed",
    );
  });
});
