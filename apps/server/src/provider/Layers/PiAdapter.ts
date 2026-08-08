// @effect-diagnostics globalDate:off runEffectInsideEffect:off
import * as NodeCrypto from "node:crypto";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { PiRpcManager, type PiRpcManagerEvent } from "../piRpcManager.ts";
import { mapAgentRpcEvent } from "../piRpcProtocol.ts";

function base(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
  turnId?: TurnId,
  itemId?: string,
) {
  return {
    eventId: EventId.make(NodeCrypto.randomUUID()),
    provider,
    providerInstanceId: instanceId,
    threadId,
    createdAt: new Date().toISOString(),
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: RuntimeItemId.make(itemId) } : {}),
  };
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message.trim() : fallback;
}

function mapManagerEvent(
  event: PiRpcManagerEvent,
  instanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  providerName: string,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "rpc-event")
    return mapAgentRpcEvent({
      provider,
      threadId: event.threadId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      event: event.payload,
    }).map((mapped) => ({ ...mapped, providerInstanceId: instanceId }));
  if (event.kind === "stderr")
    return [
      {
        type: "runtime.warning",
        ...base(provider, event.threadId, instanceId, event.turnId),
        payload: { message: event.line || `${providerName} RPC stderr output` },
      } as ProviderRuntimeEvent,
    ];
  if (event.kind === "stdout-parse-error")
    return [
      {
        type: "runtime.warning",
        ...base(provider, event.threadId, instanceId),
        payload: {
          message: `${providerName} RPC emitted malformed JSON.`,
          detail: { line: event.line },
        },
      } as ProviderRuntimeEvent,
    ];
  return [
    {
      type: event.expected ? "session.exited" : "runtime.error",
      ...base(provider, event.threadId, instanceId, event.turnId),
      payload: event.expected
        ? { reason: `${providerName} session stopped`, recoverable: true, exitKind: "graceful" }
        : {
            message: `${providerName} RPC process exited unexpectedly (${event.code ?? "signal"}${event.signal ? `:${event.signal}` : ""}).`,
            class: "transport_error",
          },
    } as ProviderRuntimeEvent,
  ];
}

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly agentDir?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly provider?: ProviderDriverKind;
  readonly providerName?: string;
}

export const makeAgentAdapter = (options: PiAdapterOptions) =>
  Effect.gen(function* () {
    const provider = options.provider ?? ProviderDriverKind.make("pi");
    const providerName = options.providerName ?? provider;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const manager = yield* Effect.acquireRelease(
      Effect.sync(() => new PiRpcManager(options)),
      (value) => Effect.promise(() => value.stopAll()).pipe(Effect.ignore),
    );
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        manager.subscribe((event) =>
          Effect.runFork(
            Queue.offerAll(
              queue,
              mapManagerEvent(event, options.instanceId, provider, providerName),
            ),
          ),
        ),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    const selected = (input: ProviderSessionStartInput | ProviderSendTurnInput) =>
      input.modelSelection?.instanceId === options.instanceId ? input.modelSelection : undefined;
    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.startSession({
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(selected(input) ? { model: selected(input)!.model } : {}),
            ...(selected(input) &&
            getModelSelectionStringOptionValue(selected(input), "thinkingLevel")
              ? {
                  thinkingLevel: getModelSelectionStringOptionValue(
                    selected(input),
                    "thinkingLevel",
                  ) as never,
                }
              : {}),
            ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider,
            threadId: input.threadId,
            detail: errorMessage(cause, `Failed to start ${providerName} session.`),
            cause,
          }),
      });
    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
          Effect.gen(function* () {
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!path)
              return yield* new ProviderAdapterValidationError({
                provider,
                operation: "sendTurn",
                issue: `Invalid attachment '${attachment.id}'.`,
              });
            const bytes = yield* fileSystem.readFile(path).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider,
                    method: "turn/prompt",
                    detail: errorMessage(cause, "Unable to read image attachment."),
                    cause,
                  }),
              ),
            );
            return {
              type: "image" as const,
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            };
          }),
        );
        const selection = selected(input);
        return yield* Effect.tryPromise({
          try: () =>
            manager.sendTurn({
              threadId: input.threadId,
              ...(input.input !== undefined ? { input: input.input } : {}),
              ...(selection ? { model: selection.model } : {}),
              ...(selection && getModelSelectionStringOptionValue(selection, "thinkingLevel")
                ? {
                    thinkingLevel: getModelSelectionStringOptionValue(
                      selection,
                      "thinkingLevel",
                    ) as never,
                  }
                : {}),
              ...(images.length ? { images } : {}),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider,
              method: "turn/prompt",
              detail: errorMessage(cause, `${providerName} prompt failed.`),
              cause,
            }),
        });
      });
    const withRequestError = <A>(method: string, threadId: ThreadId, action: () => Promise<A>) =>
      Effect.tryPromise({
        try: action,
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider,
            method,
            detail: errorMessage(cause, `${method} failed.`),
            cause,
          }),
      });
    return {
      provider,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn: (threadId: ThreadId) =>
        withRequestError("turn/abort", threadId, () => manager.interruptTurn(threadId)),
      respondToRequest: (threadId: ThreadId) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider,
            operation: "respondToRequest",
            issue: `${providerName} does not expose approval requests for '${threadId}'.`,
          }),
        ),
      respondToUserInput: (threadId: ThreadId) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider,
            operation: "respondToUserInput",
            issue: `${providerName} does not expose structured user input for '${threadId}'.`,
          }),
        ),
      stopSession: (threadId: ThreadId) =>
        withRequestError("session/stop", threadId, () => manager.stopSession(threadId)),
      listSessions: () => Effect.sync(() => manager.listSessions()),
      hasSession: (threadId: ThreadId) => Effect.sync(() => manager.hasSession(threadId)),
      readThread: (threadId: ThreadId) =>
        Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId })),
      rollbackThread: (threadId: ThreadId) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider,
            operation: "rollbackThread",
            issue: `${providerName} does not expose rollback for '${threadId}'.`,
          }),
        ),
      stopAll: () => Effect.promise(() => manager.stopAll()),
      streamEvents: Stream.fromQueue(queue),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });

export const makePiAdapter = (options: PiAdapterOptions) =>
  makeAgentAdapter({ ...options, provider: ProviderDriverKind.make("pi"), providerName: "Pi" });
