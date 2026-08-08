// @effect-diagnostics globalDate:off cryptoRandomUUID:off
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  type PiThinkingLevel,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

export type PiRpcRecord = Readonly<Record<string, unknown>>;

export function parsePiRpcLine(line: string): PiRpcRecord | null {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (normalized.length === 0) return null;
  try {
    const value: unknown = JSON.parse(normalized);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as PiRpcRecord)
      : null;
  } catch {
    return null;
  }
}

export function parsePiModel(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as PiRpcRecord;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const modelId =
    typeof record.modelId === "string"
      ? record.modelId.trim()
      : typeof record.id === "string"
        ? record.id.trim()
        : "";
  return provider && modelId ? `${provider}/${modelId}` : undefined;
}

export function parsePiThinkingLevel(value: unknown): PiThinkingLevel | undefined {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return undefined;
  }
}

function asRecord(value: unknown): PiRpcRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as PiRpcRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textFromMessage(value: unknown): string | undefined {
  const record = asRecord(value);
  const content = record?.content;
  if (Array.isArray(content)) {
    const text = content
      .flatMap((part) => {
        const item = asRecord(part);
        return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
      })
      .join("")
      .trim();
    if (text) return text;
  }
  const direct = asString(record?.text)?.trim();
  return direct || undefined;
}

function base(threadId: ThreadId, turnId?: TurnId, itemId?: string) {
  return {
    eventId: EventId.make(globalThis.crypto.randomUUID()),
    provider: ProviderDriverKind.make("pi"),
    threadId,
    createdAt: new Date().toISOString(),
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: RuntimeItemId.make(itemId) } : {}),
  };
}

export function mapPiRpcEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly event: PiRpcRecord;
}): ReadonlyArray<ProviderRuntimeEvent> {
  const type = asString(input.event.type);
  if (!type) return [];
  const payload = input.event;
  if (type === "message_update") {
    const update = asRecord(payload.assistantMessageEvent);
    const delta = asString(update?.delta);
    if (!delta) return [];
    const streamKind = update?.type === "thinking_delta" ? "reasoning_text" : "assistant_text";
    if (update?.type !== "text_delta" && update?.type !== "thinking_delta") return [];
    return [
      {
        type: "content.delta",
        ...base(
          input.threadId,
          input.turnId,
          `pi-assistant:${input.threadId}:${input.turnId ?? "session"}`,
        ),
        payload: { streamKind, delta },
      } as unknown as ProviderRuntimeEvent,
    ];
  }
  if (type === "message_end" && asString(asRecord(payload.message)?.role) === "assistant") {
    const text = textFromMessage(payload.message);
    return text
      ? [
          {
            type: "item.completed",
            ...base(
              input.threadId,
              input.turnId,
              `pi-assistant:${input.threadId}:${input.turnId ?? "session"}`,
            ),
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: text,
              data: payload.message,
            },
          } as unknown as ProviderRuntimeEvent,
        ]
      : [];
  }
  if (
    type === "tool_execution_start" ||
    type === "tool_execution_update" ||
    type === "tool_execution_end"
  ) {
    const toolId = asString(payload.toolCallId) ?? asString(payload.toolName) ?? "unknown";
    const status =
      type === "tool_execution_end"
        ? payload.isError === true
          ? "failed"
          : "completed"
        : "inProgress";
    return [
      {
        type:
          type === "tool_execution_start"
            ? "item.started"
            : type === "tool_execution_end"
              ? "item.completed"
              : "item.updated",
        ...base(input.threadId, input.turnId, `pi-tool:${toolId}`),
        payload: {
          itemType: "dynamic_tool_call",
          status,
          title: asString(payload.toolName) ?? "Tool call",
          data: payload,
        },
      } as unknown as ProviderRuntimeEvent,
    ];
  }
  if (type === "turn_start") {
    return [
      {
        type: "turn.started",
        ...base(input.threadId, input.turnId),
        payload: {},
      } as unknown as ProviderRuntimeEvent,
    ];
  }
  if (type === "agent_settled") {
    return [
      {
        type: "turn.completed",
        ...base(input.threadId, input.turnId),
        payload: { state: "completed", stopReason: null },
      } as unknown as ProviderRuntimeEvent,
    ];
  }
  return [];
}
