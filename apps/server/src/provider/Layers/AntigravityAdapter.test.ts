// @effect-diagnostics nodeBuiltinImport:off
import { PassThrough } from "node:stream";
import type * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeAntigravityAdapter, parseAntigravityStreamJsonLine } from "./AntigravityAdapter.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

const makeChild = () => {
  const child = Object.assign(new PassThrough(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams;
};

describe("Antigravity stream-json", () => {
  it("extracts assistant text and ignores non-text events", () => {
    expect(parseAntigravityStreamJsonLine('{"type":"assistant","text":"Hola"}')).toBe("Hola");
    expect(
      parseAntigravityStreamJsonLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":" mundo"}]}}',
      ),
    ).toBe(" mundo");
    expect(parseAntigravityStreamJsonLine('{"type":"tool_use","name":"shell"}')).toBeUndefined();
    expect(parseAntigravityStreamJsonLine("not json")).toBeUndefined();
  });

  it("extracts incremental text deltas from stream-json events", () => {
    expect(parseAntigravityStreamJsonLine('{"type":"init"}')).toBeUndefined();
    expect(
      parseAntigravityStreamJsonLine(
        '{"type":"step_update","step_type":"tool_call","tool_info":{"name":"bash"}}',
      ),
    ).toBeUndefined();
    expect(
      parseAntigravityStreamJsonLine(
        '{"type":"step_update","step_type":"agent_response","text_delta":"uno"}',
      ),
    ).toBe("uno");
    expect(
      parseAntigravityStreamJsonLine(
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"uno"}}',
      ),
    ).toBe("uno");
    expect(parseAntigravityStreamJsonLine('{"type":"message_delta","delta":{"text":" dos"}}')).toBe(
      " dos",
    );
    expect(parseAntigravityStreamJsonLine('{"type":"result","status":"success"}')).toBeUndefined();
    expect(parseAntigravityStreamJsonLine('{"type":"result","response":"uno dos"}', "uno")).toBe(
      " dos",
    );
  });

  it("turns cumulative assistant snapshots into only the unseen suffix", () => {
    expect(
      parseAntigravityStreamJsonLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hola mundo"}]}}',
        "hola",
      ),
    ).toBe(" mundo");
  });
});

it("keeps an interrupted child owned until close and emits one completion", async () => {
  const firstChild = makeChild();
  const secondChild = makeChild();
  spawn.mockReset().mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

  const adapter = await Effect.runPromise(
    makeAntigravityAdapter({
      instanceId: ProviderInstanceId.make("instance"),
      binaryPath: "agy-direct",
    }),
  );
  const threadId = ThreadId.make("thread");
  await Effect.runPromise(adapter.startSession({ threadId, runtimeMode: "full-access" }));
  const eventsPromise = Effect.runPromise(
    Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect),
  );

  await Effect.runPromise(adapter.sendTurn({ threadId, input: "hello" }));
  await Effect.runPromise(adapter.interruptTurn(threadId));
  const interruptedEvents = await eventsPromise;

  expect(firstChild.kill).toHaveBeenCalledWith("SIGINT");
  expect(interruptedEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  let blockedError: unknown;
  try {
    await Effect.runPromise(adapter.sendTurn({ threadId, input: "should wait" }));
  } catch (error) {
    blockedError = error;
  }
  expect(blockedError).toBeDefined();
  expect(String(blockedError)).toContain("already streaming a turn");

  firstChild.emit("close", 130, "SIGINT");
  await Effect.runPromise(adapter.sendTurn({ threadId, input: "after close" }));
  expect(spawn).toHaveBeenCalledTimes(2);
});
