import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnId } from "@t3tools/contracts";
import {
  mapPiRpcEvent,
  parsePiModel,
  parsePiRpcLine,
  parsePiThinkingLevel,
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
  });
});
