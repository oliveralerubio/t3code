// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import {
  PI_THINKING_LEVEL_OPTIONS,
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

export function piModelCapabilities(): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinkingLevel",
        label: "Thinking",
        type: "select",
        options: PI_THINKING_LEVEL_OPTIONS.map((level) => ({
          id: level,
          label: thinkingLevelLabel(level),
        })),
      },
    ],
  });
}

export function mapPiAvailableModels(
  models: ReadonlyArray<unknown>,
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
        capabilities: piModelCapabilities(),
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
  model: string | undefined;
  thinkingLevel: PiThinkingLevel | undefined;
  sessionFile: string | undefined;
  sessionId: string | undefined;
  turnId: TurnId | undefined;
  status: ProviderSession["status"];
  stopping: boolean;
  stdoutBuffer: string;
  stderrBuffer: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    const eventTurnId = session.turnId;
    if (parsed.type === "turn_start") session.status = "running";
    if (parsed.type === "agent_settled") {
      session.status = "ready";
      session.turnId = undefined;
    }
    this.emit({
      kind: "rpc-event",
      threadId: session.threadId,
      ...(eventTurnId ? { turnId: eventTurnId } : {}),
      ...(session.model ? { model: session.model } : {}),
      payload: parsed,
    });
  }

  private consume(stream: "stdout" | "stderr", session: SessionState, chunk: Buffer): void {
    const key = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
    session[key] += chunk.toString("utf8");
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
      model: undefined,
      thinkingLevel: undefined,
      sessionFile: undefined,
      sessionId: undefined,
      turnId: undefined,
      status: "connecting",
      stopping: false,
      stdoutBuffer: "",
      stderrBuffer: "",
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
      this.sessions.delete(threadId);
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
        reject(new Error(`Pi RPC command '${String(command.type)}' timed out.`));
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
    if (!session.child.killed) session.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (session.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (!session.child.killed) session.child.kill("SIGKILL");
        resolve();
      }, 2_000);
      session.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
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
  }

  private async setThinkingState(session: SessionState, level: PiThinkingLevel): Promise<void> {
    await this.request(session, { type: "set_thinking_level", level });
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
      return mapPiAvailableModels(models);
    } finally {
      await this.stopSessionState(session);
    }
  }
}
