// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off globalDate:off runEffectInsideEffect:off
import * as NodeChildProcess from "node:child_process";
import * as NodeStringDecoder from "node:string_decoder";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeItemCompletedEvent,
  type ProviderRuntimeTurnStartedEvent,
  type ProviderRuntimeTurnCompletedEvent,
  type ProviderRuntimeContentDeltaEvent,
  type ProviderRuntimeErrorEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const ASSISTANT_ITEM = `${PROVIDER}-assistant`;
const MAX_STDERR_BYTES = 16 * 1024;

export function parseAntigravityStreamJsonLine(
  line: string,
  previousText = "",
): string | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const recordType =
      typeof record.type === "string"
        ? record.type
        : typeof record.event === "string"
          ? record.event
          : undefined;
    if (recordType === "step_update" && record.step_type === "agent_response") {
      for (const key of ["text_delta", "delta", "text", "response"]) {
        const text = record[key];
        if (typeof text === "string" && text) return text;
      }
    }
    if (recordType === "result") {
      const nestedResult = record.result;
      if (nestedResult && typeof nestedResult === "object" && !Array.isArray(nestedResult)) {
        const nested = nestedResult as Record<string, unknown>;
        for (const key of ["response", "text", "result"]) {
          const response = nested[key];
          if (typeof response === "string" && response) {
            return response.startsWith(previousText)
              ? response.slice(previousText.length) || undefined
              : response;
          }
        }
      }
      for (const key of ["response", "text", "result"]) {
        const response = record[key];
        if (typeof response === "string" && response) {
          return response.startsWith(previousText)
            ? response.slice(previousText.length) || undefined
            : response;
        }
      }
      return undefined;
    }
    const delta = record.delta;
    if (
      (recordType === "content_block_delta" || recordType === "message_delta") &&
      delta &&
      typeof delta === "object" &&
      !Array.isArray(delta)
    ) {
      const text = (delta as Record<string, unknown>).text;
      return typeof text === "string" && text ? text : undefined;
    }
    const direct =
      (recordType === "text_delta" || recordType === "assistant") && typeof record.text === "string"
        ? record.text
        : undefined;
    if (direct) return direct;
    const message = record.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content && content.startsWith(previousText)
        ? content.slice(previousText.length) || undefined
        : content || undefined;
    }
    if (!Array.isArray(content)) return undefined;
    const snapshot = content
      .flatMap((part) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return [];
        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? [text] : [];
      })
      .join("");
    return snapshot && snapshot.startsWith(previousText)
      ? snapshot.slice(previousText.length) || undefined
      : snapshot || undefined;
  } catch {
    return undefined;
  }
}

export function parseAntigravityStreamJsonErrorLine(line: string): string | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const recordType =
      typeof record.type === "string"
        ? record.type
        : typeof record.event === "string"
          ? record.event
          : undefined;
    if (recordType !== "result") return undefined;
    const result =
      record.result && typeof record.result === "object" && !Array.isArray(record.result)
        ? (record.result as Record<string, unknown>)
        : record;
    const status = typeof result.status === "string" ? result.status.toLowerCase() : undefined;
    if (status !== "error" && status !== "failed") return undefined;
    for (const key of ["error", "message", "detail"]) {
      const detail = result[key];
      if (typeof detail === "string" && detail.trim()) return detail.trim();
    }
    return `status=${status}`;
  } catch {
    return undefined;
  }
}

export interface AntigravityAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

interface Session {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string | undefined;
  readonly queue: Queue.Queue<ProviderRuntimeEvent, never>;
  child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  turnId: TurnId | undefined;
  text: string;
  stopping: boolean;
  completionEmitted: boolean;
}

function base(session: Session, turnId?: TurnId, itemId?: string) {
  return {
    eventId: EventId.make(globalThis.crypto.randomUUID()),
    provider: PROVIDER,
    providerInstanceId: session.instanceId,
    threadId: session.threadId,
    createdAt: new Date().toISOString(),
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: RuntimeItemId.make(itemId) } : {}),
  };
}

// Kept on the session rather than in a module-global so separate configured
// Antigravity instances cannot share event identity or process state.
type SessionWithInstance = Session;

const assistantItemId = (session: SessionWithInstance, turnId: TurnId) =>
  `${ASSISTANT_ITEM}:${session.threadId}:${turnId}`;

function emitDelta(session: SessionWithInstance, turnId: TurnId, delta: string): void {
  session.text += delta;
  void Effect.runPromise(
    Queue.offer(session.queue, {
      type: "content.delta",
      ...base(session, turnId, assistantItemId(session, turnId)),
      payload: { streamKind: "assistant_text", delta },
    } satisfies ProviderRuntimeContentDeltaEvent),
  );
}

function isActiveTurn(session: SessionWithInstance, turnId: TurnId): boolean {
  return session.turnId === turnId;
}

export function makeAntigravityAdapter(options: AntigravityAdapterOptions) {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionWithInstance>();

    const emit = (event: ProviderRuntimeEvent): void => {
      void Effect.runPromise(Queue.offer(queue, event));
    };
    const startSession = (input: ProviderSessionStartInput): ProviderSession => {
      let session = sessions.get(input.threadId);
      if (!session) {
        session = {
          threadId: input.threadId,
          instanceId: options.instanceId,
          cwd: input.cwd,
          queue,
          child: undefined,
          turnId: undefined,
          text: "",
          stopping: false,
          completionEmitted: false,
        };
        sessions.set(input.threadId, session);
      }
      return {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    };

    const sendTurn = (input: ProviderSendTurnInput) =>
      Effect.tryPromise<
        { readonly threadId: ThreadId; readonly turnId: TurnId },
        ProviderAdapterError
      >({
        try: async () => {
          const session = sessions.get(input.threadId);
          if (!session)
            throw new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          if (session.child)
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/prompt",
              detail: "Antigravity is already streaming a turn.",
            });
          const turnId = TurnId.make(globalThis.crypto.randomUUID());
          session.turnId = turnId;
          session.text = "";
          session.stopping = false;
          session.completionEmitted = false;
          const model = input.modelSelection?.model;
          const args = [
            "--print",
            "--output-format",
            "stream-json",
            ...(model ? ["--model", model] : []),
            "--prompt",
            input.input ?? "",
          ];
          emit({
            type: "turn.started",
            ...base(session, turnId),
            payload: model ? { model } : {},
          } satisfies ProviderRuntimeTurnStartedEvent);
          const child = NodeChildProcess.spawn(options.binaryPath?.trim() || "agy-direct", args, {
            ...(session.cwd ? { cwd: session.cwd } : {}),
            env: { ...process.env, ...options.environment },
            stdio: "pipe",
          });
          session.child = child;
          const decoder = new NodeStringDecoder.StringDecoder("utf8");
          const stderrDecoder = new NodeStringDecoder.StringDecoder("utf8");
          let stdoutBuffer = "";
          let streamError: string | undefined;
          let stderrBuffer = "";
          let stderrBytes = 0;
          let stderrTruncated = false;
          const consume = (chunk: Buffer, flush = false) => {
            stdoutBuffer += decoder.write(chunk);
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = flush ? "" : (lines.pop() ?? "");
            for (const line of lines) {
              streamError = parseAntigravityStreamJsonErrorLine(line) ?? streamError;
              const delta = parseAntigravityStreamJsonLine(
                line.endsWith("\r") ? line.slice(0, -1) : line,
                session.text,
              );
              if (delta && isActiveTurn(session, turnId)) emitDelta(session, turnId, delta);
            }
          };
          child.stdout.on("data", (chunk: Buffer) => {
            consume(chunk);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            if (stderrBytes >= MAX_STDERR_BYTES) {
              stderrTruncated = true;
              return;
            }
            const remaining = MAX_STDERR_BYTES - stderrBytes;
            const accepted = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
            stderrBytes += accepted.byteLength;
            stderrBuffer += stderrDecoder.write(accepted);
            if (accepted.byteLength < chunk.byteLength) stderrTruncated = true;
          });
          child.once("error", (cause) =>
            finishFailure(session, turnId, cause instanceof Error ? cause.message : String(cause)),
          );
          child.once("close", (code, signal) => {
            stderrBuffer += stderrDecoder.end();
            stdoutBuffer += decoder.end();
            const finalLines = stdoutBuffer.split("\n");
            stdoutBuffer = "";
            for (const line of finalLines) {
              streamError = parseAntigravityStreamJsonErrorLine(line) ?? streamError;
              const delta = parseAntigravityStreamJsonLine(
                line.endsWith("\r") ? line.slice(0, -1) : line,
                session.text,
              );
              if (delta && isActiveTurn(session, turnId)) emitDelta(session, turnId, delta);
            }
            if (session.child !== child) return;
            if (session.completionEmitted) {
              clearSessionTurn(session, child, turnId);
              return;
            }
            if (!isActiveTurn(session, turnId)) return;
            if (session.stopping) {
              finishFailure(session, turnId, "Antigravity turn interrupted.", "interrupted");
              clearSessionTurn(session, child, turnId);
              return;
            }
            if (code !== 0 || signal || streamError) {
              const stderr = stderrBuffer.trim();
              const outcome =
                code !== 0 || signal
                  ? `Antigravity CLI exited unsuccessfully (${code ?? "signal"}${signal ? `:${signal}` : ""})`
                  : "Antigravity CLI reported an error";
              finishFailure(
                session,
                turnId,
                `${outcome}${streamError ? `: ${streamError}` : ""}${stderr ? `; stderr: ${stderr}` : ""}${stderrTruncated ? " [stderr truncated]" : ""}.`,
              );
              clearSessionTurn(session, child, turnId);
              return;
            }
            emit({
              type: "item.completed",
              ...base(session, turnId, assistantItemId(session, turnId)),
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                ...(session.text ? { detail: session.text } : {}),
              },
            } satisfies ProviderRuntimeItemCompletedEvent);
            emit({
              type: "turn.completed",
              ...base(session, turnId),
              payload: { state: "completed", stopReason: "stop" },
            } satisfies ProviderRuntimeTurnCompletedEvent);
            clearSessionTurn(session, child, turnId);
          });
          return { threadId: input.threadId, turnId };
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

    const finishFailure = (
      session: SessionWithInstance,
      turnId: TurnId,
      message: string,
      state: "failed" | "interrupted" = "failed",
    ): void => {
      if (!isActiveTurn(session, turnId)) return;
      if (session.completionEmitted) return;
      session.completionEmitted = true;
      if (state === "failed")
        emit({
          type: "runtime.error",
          ...base(session, turnId, assistantItemId(session, turnId)),
          payload: { message, class: "transport_error" },
        } satisfies ProviderRuntimeErrorEvent);
      emit({
        type: "turn.completed",
        ...base(session, turnId),
        payload: {
          state,
          ...(state === "interrupted" ? { stopReason: "interrupted" } : { errorMessage: message }),
        },
      } satisfies ProviderRuntimeTurnCompletedEvent);
    };
    const clearSessionTurn = (
      session: SessionWithInstance,
      child: NodeChildProcess.ChildProcessWithoutNullStreams,
      turnId: TurnId,
    ): void => {
      if (session.child !== child) return;
      session.child = undefined;
      if (session.turnId === turnId) session.turnId = undefined;
      session.stopping = false;
      session.completionEmitted = false;
    };

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession: (input) => Effect.sync(() => startSession(input)),
      sendTurn,
      interruptTurn: (threadId, requestedTurnId) =>
        Effect.sync(() => {
          const session = sessions.get(threadId);
          if (!session?.child || !session.turnId) return;
          if (requestedTurnId && requestedTurnId !== session.turnId) return;
          const turnId = session.turnId;
          const child = session.child;
          session.stopping = true;
          session.completionEmitted = true;
          session.turnId = undefined;
          child.kill("SIGINT");
          emit({
            type: "turn.completed",
            ...base(session, turnId),
            payload: { state: "interrupted", stopReason: "interrupted" },
          } satisfies ProviderRuntimeTurnCompletedEvent);
        }),
      respondToRequest: () =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: "Antigravity has no approval protocol.",
          }),
        ),
      respondToUserInput: () =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "Antigravity has no user-input protocol.",
          }),
        ),
      stopSession: (threadId) =>
        Effect.sync(() => {
          const session = sessions.get(threadId);
          const child = session?.child;
          if (session && child) {
            session.stopping = true;
            session.completionEmitted = true;
            session.turnId = undefined;
            child.kill("SIGTERM");
          }
          sessions.delete(threadId);
        }),
      listSessions: () =>
        Effect.sync(() =>
          Array.from(sessions.values()).map((session) =>
            startSession({ threadId: session.threadId, runtimeMode: "full-access" }),
          ),
        ),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId })),
      rollbackThread: (threadId) =>
        Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId })),
      stopAll: () =>
        Effect.sync(() => {
          for (const session of sessions.values())
            if (session.child) {
              const child = session.child;
              session.stopping = true;
              session.completionEmitted = true;
              session.turnId = undefined;
              child.kill("SIGTERM");
            }
          sessions.clear();
        }),
      streamEvents: Stream.fromQueue(queue),
    };
    return adapter;
  });
}
