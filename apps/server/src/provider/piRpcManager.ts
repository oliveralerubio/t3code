// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeStringDecoder from "node:string_decoder";
import {
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type PiThinkingLevel,
  type ModelCapabilities,
  type ProviderSession,
  type ProviderTurnStartResult,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import {
  parsePiModel,
  parsePiRpcLine,
  parsePiThinkingLevel,
  type PiRpcRecord,
} from "./piRpcProtocol.ts";

function thinkingLevelLabel(level: PiThinkingLevel): string {
  return level === "xhigh" ? "Extra high" : level.charAt(0).toUpperCase() + level.slice(1);
}

export function piModelCapabilities(
  levels: ReadonlyArray<PiThinkingLevel> = [],
): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: levels.length
      ? [
          {
            id: "thinkingLevel",
            label: "Thinking",
            type: "select",
            options: levels.map((level) => ({
              id: level,
              label: thinkingLevelLabel(level),
            })),
          },
        ]
      : [],
  });
}

export function mapPiAvailableModels(
  models: ReadonlyArray<unknown>,
  thinkingLevels: ReadonlyArray<PiThinkingLevel> = [],
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return models.flatMap((model) => {
    const slug = parsePiModel(model);
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    const record = model && typeof model === "object" ? (model as PiRpcRecord) : {};
    return [
      {
        slug,
        name: stringValue(record.name) ?? slug,
        isCustom: false,
        capabilities: piModelCapabilities(thinkingLevels),
      },
    ];
  });
}

export type PiRpcManagerEvent =
  | {
      readonly kind: "rpc-event";
      readonly threadId: ThreadId;
      readonly turnId?: TurnId;
      readonly model?: string;
      readonly payload: PiRpcRecord;
    }
  | {
      readonly kind: "stderr";
      readonly threadId: ThreadId;
      readonly turnId?: TurnId;
      readonly line: string;
    }
  | { readonly kind: "stdout-parse-error"; readonly threadId: ThreadId; readonly line: string }
  | {
      readonly kind: "exit";
      readonly threadId: ThreadId;
      readonly turnId?: TurnId;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly expected: boolean;
    };

export interface PiRpcManagerOptions {
  readonly binaryPath: string;
  readonly agentDir?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (response: PiRpcRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface SessionState {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly threadId: ThreadId;
  readonly cwd: string | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly pending: Map<string, PendingRequest>;
  readonly createdAt: string;
  readonly listeners: { stdout: (chunk: Buffer) => void; stderr: (chunk: Buffer) => void };
  readonly decoders: {
    stdout: NodeStringDecoder.StringDecoder;
    stderr: NodeStringDecoder.StringDecoder;
  };
  model: string | undefined;
  thinkingLevel: PiThinkingLevel | undefined;
  thinkingLevels: ReadonlyArray<PiThinkingLevel>;
  sessionFile: string | undefined;
  sessionId: string | undefined;
  turnId: TurnId | undefined;
  status: ProviderSession["status"];
  stopping: boolean;
  stdoutBuffer: string;
  stderrBuffer: string;
  assistantMessageSequence: number;
  assistantStopReason: string | undefined;
  assistantErrorMessage: string | undefined;
  terminalTurnId: TurnId | undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function decodePiUtf8Chunks(chunks: ReadonlyArray<Buffer>): string {
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  return chunks.map((chunk) => decoder.write(chunk)).join("") + decoder.end();
}

export function deletePiSessionIfCurrent(
  sessions: Map<ThreadId, unknown>,
  threadId: ThreadId,
  session: unknown,
): boolean {
  if (sessions.get(threadId) !== session) return false;
  sessions.delete(threadId);
  return true;
}

function modelFromState(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as PiRpcRecord;
  return parsePiModel(record);
}

function commandError(command: string, response: PiRpcRecord): Error {
  return new Error(stringValue(response.error) ?? `Pi RPC command '${command}' failed.`);
}

export class PiRpcManager {
  private readonly sessions = new Map<ThreadId, SessionState>();
  private readonly listeners = new Set<(event: PiRpcManagerEvent) => void>();

  private readonly options: PiRpcManagerOptions;

  constructor(options: PiRpcManagerOptions) {
    this.options = options;
  }

  subscribe(listener: (event: PiRpcManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: PiRpcManagerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private failPending(session: SessionState, error: Error): void {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    session.pending.clear();
  }

  private processLine(session: SessionState, line: string): void {
    const parsed = parsePiRpcLine(line);
    if (!parsed) {
      if (line.trim()) this.emit({ kind: "stdout-parse-error", threadId: session.threadId, line });
      return;
    }
    if (parsed.type === "response") {
      const id = stringValue(parsed.id);
      if (!id) return;
      const pending = session.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      session.pending.delete(id);
      if (parsed.success === true) pending.resolve(parsed);
      else pending.reject(commandError(pending.command, parsed));
      return;
    }
    if (parsed.type === "extension_ui_request") {
      this.emit({
        kind: "rpc-event",
        threadId: session.threadId,
        ...(session.turnId ? { turnId: session.turnId } : {}),
        payload: {
          type: "extension_ui_request",
          errorMessage:
            "Pi requested extension UI input, which T3 Code cannot answer; the session was terminated.",
        },
      });
      if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId);
      void this.stopSessionState(session);
      return;
    }
    const eventTurnId = session.turnId;
    const event =
      parsed.type === "message_end" &&
      (parsed.message as PiRpcRecord | undefined)?.role === "assistant"
        ? { ...parsed, piAssistantSequence: session.assistantMessageSequence++ }
        : parsed;
    if (event.type === "turn_start") {
      session.status = "running";
      session.terminalTurnId = undefined;
      session.assistantStopReason = undefined;
      session.assistantErrorMessage = undefined;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as PiRpcRecord | undefined;
      const reason = stringValue(update?.reason);
      if (reason === "error" || reason === "aborted") {
        session.assistantStopReason = reason;
        session.assistantErrorMessage = stringValue(update?.errorMessage);
      }
    }
    if (event.type === "message_end") {
      const message = event.message as PiRpcRecord | undefined;
      if (message?.role === "assistant") {
        session.assistantStopReason =
          stringValue(message.stopReason) ?? session.assistantStopReason;
        session.assistantErrorMessage =
          stringValue(message.errorMessage) ?? session.assistantErrorMessage;
      }
    }
    if (event.type === "agent_settled") {
      if (session.terminalTurnId === eventTurnId) return;
      session.status = "ready";
      session.terminalTurnId = eventTurnId;
      session.turnId = undefined;
    }
    this.emit({
      kind: "rpc-event",
      threadId: session.threadId,
      ...(eventTurnId ? { turnId: eventTurnId } : {}),
      ...(session.model ? { model: session.model } : {}),
      payload:
        event.type === "agent_settled"
          ? {
              ...event,
              ...(session.assistantStopReason ? { stopReason: session.assistantStopReason } : {}),
              ...(session.assistantErrorMessage
                ? { errorMessage: session.assistantErrorMessage }
                : {}),
            }
          : event,
    });
  }

  private consume(stream: "stdout" | "stderr", session: SessionState, chunk: Buffer): void {
    const key = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
    session[key] += session.decoders[stream].write(chunk);
    const lines = session[key].split("\n");
    session[key] = lines.pop() ?? "";
    for (const line of lines) {
      if (stream === "stdout") this.processLine(session, line);
      else if (line.trim())
        this.emit({
          kind: "stderr",
          threadId: session.threadId,
          ...(session.turnId ? { turnId: session.turnId } : {}),
          line: line.endsWith("\r") ? line.slice(0, -1) : line,
        });
    }
  }

  private createSession(
    threadId: ThreadId,
    cwd: string | undefined,
    runtimeMode: RuntimeMode,
  ): SessionState {
    const args = ["--mode", "rpc"];
    if (this.options.agentDir) args.push("--session-dir", this.options.agentDir);
    const child = NodeChildProcess.spawn(this.options.binaryPath, args, {
      cwd,
      env: { ...process.env, ...this.options.environment },
      stdio: "pipe",
    });
    const session: SessionState = {
      child,
      threadId,
      cwd,
      runtimeMode,
      pending: new Map(),
      createdAt: new Date().toISOString(),
      listeners: { stdout: () => undefined, stderr: () => undefined },
      decoders: {
        stdout: new NodeStringDecoder.StringDecoder("utf8"),
        stderr: new NodeStringDecoder.StringDecoder("utf8"),
      },
      model: undefined,
      thinkingLevel: undefined,
      thinkingLevels: [],
      sessionFile: undefined,
      sessionId: undefined,
      turnId: undefined,
      status: "connecting",
      stopping: false,
      stdoutBuffer: "",
      stderrBuffer: "",
      assistantMessageSequence: 0,
      assistantStopReason: undefined,
      assistantErrorMessage: undefined,
      terminalTurnId: undefined,
    };
    session.listeners.stdout = (chunk) => this.consume("stdout", session, chunk);
    session.listeners.stderr = (chunk) => this.consume("stderr", session, chunk);
    child.stdout.on("data", session.listeners.stdout);
    child.stderr.on("data", session.listeners.stderr);
    child.on("error", (error) => {
      session.status = "error";
      this.failPending(session, error instanceof Error ? error : new Error(String(error)));
      this.emit({
        kind: "exit",
        threadId,
        ...(session.turnId ? { turnId: session.turnId } : {}),
        code: null,
        signal: null,
        expected: false,
      });
    });
    child.on("exit", (code, signal) => {
      session.status = session.stopping ? "closed" : code === 0 ? "closed" : "error";
      this.failPending(
        session,
        new Error(`Pi RPC process exited (${code ?? "signal"}${signal ? `:${signal}` : ""}).`),
      );
      this.emit({
        kind: "exit",
        threadId,
        ...(session.turnId ? { turnId: session.turnId } : {}),
        code,
        signal,
        expected: session.stopping,
      });
      deletePiSessionIfCurrent(this.sessions, threadId, session);
    });
    return session;
  }

  private request(
    session: SessionState,
    command: PiRpcRecord,
    timeoutMs = 15_000,
  ): Promise<PiRpcRecord> {
    if (session.child.stdin.destroyed) return Promise.reject(new Error("Pi RPC stdin is closed."));
    const id = stringValue(command.id) ?? NodeCrypto.randomUUID();
    const payload = JSON.stringify({ ...command, id });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.pending.delete(id);
        const error = new Error(`Pi RPC command '${String(command.type)}' timed out.`);
        reject(error);
        if (command.type === "prompt") void this.handlePromptTimeout(session, error);
      }, timeoutMs);
      session.pending.set(id, { command: String(command.type), resolve, reject, timeout });
      session.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        session.pending.delete(id);
        reject(error);
      });
    });
  }

  private async stopSessionState(session: SessionState): Promise<void> {
    session.stopping = true;
    session.child.stdout.off("data", session.listeners.stdout);
    session.child.stderr.off("data", session.listeners.stderr);
    this.failPending(session, new Error("Pi session stopped."));
    if (session.child.exitCode === null && session.child.signalCode === null)
      session.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (session.child.exitCode !== null || session.child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (session.child.exitCode === null && session.child.signalCode === null)
          session.child.kill("SIGKILL");
      }, 2_000);
      session.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async handlePromptTimeout(session: SessionState, error: Error): Promise<void> {
    if (session.stopping || session.turnId === undefined) return;
    const turnId = session.turnId;
    session.status = "error";
    session.terminalTurnId = turnId;
    this.emit({
      kind: "rpc-event",
      threadId: session.threadId,
      turnId,
      ...(session.model ? { model: session.model } : {}),
      payload: { type: "agent_settled", stopReason: "error", errorMessage: error.message },
    });
    session.turnId = undefined;
    if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId);
    await this.stopSessionState(session);
  }

  async startSession(input: {
    readonly threadId: ThreadId;
    readonly cwd?: string;
    readonly runtimeMode: RuntimeMode;
    readonly model?: string;
    readonly thinkingLevel?: PiThinkingLevel;
    readonly resumeCursor?: unknown;
  }): Promise<ProviderSession> {
    if (input.runtimeMode !== "full-access")
      throw new Error("Pi supports only full-access runtime mode.");
    await this.stopSession(input.threadId);
    const session = this.createSession(input.threadId, input.cwd, input.runtimeMode);
    this.sessions.set(input.threadId, session);
    try {
      const resume =
        input.resumeCursor && typeof input.resumeCursor === "object"
          ? (input.resumeCursor as PiRpcRecord)
          : undefined;
      if (stringValue(resume?.sessionFile))
        await this.request(session, { type: "switch_session", sessionPath: resume!.sessionFile });
      if (input.model) await this.setModelState(session, input.model);
      if (input.thinkingLevel) await this.setThinkingState(session, input.thinkingLevel);
      const state = (await this.request(session, { type: "get_state" })).data;
      const stateRecord = state && typeof state === "object" ? (state as PiRpcRecord) : {};
      session.model = modelFromState(stateRecord.model) ?? session.model;
      session.thinkingLevel =
        parsePiThinkingLevel(stateRecord.thinkingLevel) ?? session.thinkingLevel;
      await this.refreshThinkingLevels(session);
      session.sessionFile = stringValue(stateRecord.sessionFile);
      session.sessionId = stringValue(stateRecord.sessionId);
      session.status = stateRecord.isStreaming === true ? "running" : "ready";
      return {
        provider: ProviderDriverKind.make("pi"),
        status: session.status,
        runtimeMode: session.runtimeMode,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(session.model ? { model: session.model } : {}),
        threadId: input.threadId,
        resumeCursor: {
          ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
          ...(session.sessionId ? { sessionId: session.sessionId } : {}),
          ...(session.model ? { model: session.model } : {}),
          ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
        },
        createdAt: session.createdAt,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      await this.stopSessionState(session);
      this.sessions.delete(input.threadId);
      throw error;
    }
  }

  private async setModelState(session: SessionState, model: string): Promise<void> {
    const separator = model.indexOf("/");
    if (separator <= 0 || separator === model.length - 1)
      throw new Error(`Invalid Pi model '${model}'.`);
    await this.request(session, {
      type: "set_model",
      provider: model.slice(0, separator),
      modelId: model.slice(separator + 1),
    });
    session.model = model;
    await this.refreshThinkingLevels(session);
  }

  private async refreshThinkingLevels(session: SessionState): Promise<void> {
    try {
      const response = await this.request(
        session,
        { type: "get_available_thinking_levels" },
        1_000,
      );
      const data = response.data && typeof response.data === "object" ? response.data : {};
      const levels = (data as PiRpcRecord).levels;
      session.thinkingLevels = Array.isArray(levels)
        ? levels.flatMap((level: unknown) => {
            const parsed = parsePiThinkingLevel(level);
            return parsed ? [parsed] : [];
          })
        : [];
    } catch {
      session.thinkingLevels = [];
    }
  }

  private async setThinkingState(session: SessionState, level: PiThinkingLevel): Promise<void> {
    await this.request(session, { type: "set_thinking_level", level });
    await this.refreshThinkingLevels(session);
    if (session.thinkingLevels.length && !session.thinkingLevels.includes(level))
      throw new Error(`Pi model does not support thinking level '${level}'.`);
    session.thinkingLevel = level;
  }

  async sendTurn(input: {
    readonly threadId: ThreadId;
    readonly input?: string;
    readonly model?: string;
    readonly thinkingLevel?: PiThinkingLevel;
    readonly images?: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
  }): Promise<ProviderTurnStartResult> {
    const session = this.sessions.get(input.threadId);
    if (!session) throw new Error(`Unknown Pi RPC thread '${input.threadId}'.`);
    if (session.status === "error" || session.stopping)
      throw new Error("Pi session is not accepting turns after a failed request.");
    if (input.model && input.model !== session.model)
      await this.setModelState(session, input.model);
    if (input.thinkingLevel && input.thinkingLevel !== session.thinkingLevel)
      await this.setThinkingState(session, input.thinkingLevel);
    const turnId = TurnId.make(NodeCrypto.randomUUID());
    session.turnId = turnId;
    session.status = "running";
    await this.request(session, {
      type: "prompt",
      message: input.input ?? "",
      ...(input.images?.length ? { images: input.images } : {}),
    });
    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: {
        ...(session.model ? { model: session.model } : {}),
        ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
        ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
      },
    };
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`Unknown Pi RPC thread '${threadId}'.`);
    await this.request(session, { type: "abort" });
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.sessions.delete(threadId);
    await this.stopSessionState(session);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.stopSessionState(session)));
    this.sessions.clear();
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return [...this.sessions.values()].map((session) => ({
      provider: ProviderDriverKind.make("pi"),
      status: session.status,
      runtimeMode: session.runtimeMode,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.model ? { model: session.model } : {}),
      threadId: session.threadId,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
    }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  async discoverModels(cwd?: string): Promise<ReadonlyArray<ServerProviderModel>> {
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const session = this.createSession(threadId, cwd, "full-access");
    try {
      const response = await this.request(session, { type: "get_available_models" });
      const data =
        response.data && typeof response.data === "object" ? (response.data as PiRpcRecord) : {};
      const models = Array.isArray(data.models) ? data.models : [];
      const discovered: Array<ServerProviderModel> = [];
      for (const model of models) {
        const slug = parsePiModel(model);
        if (!slug) continue;
        try {
          await this.setModelState(session, slug);
        } catch {
          session.thinkingLevels = [];
        }
        discovered.push(...mapPiAvailableModels([model], session.thinkingLevels));
      }
      return discovered;
    } finally {
      await this.stopSessionState(session);
    }
  }
}
