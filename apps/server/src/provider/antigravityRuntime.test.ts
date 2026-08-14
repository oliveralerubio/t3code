import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vite-plus/test";

import {
  ANTIGRAVITY_FALLBACK_MODELS,
  discoverAntigravityModels,
  markAntigravityDefaultModel,
  parseAntigravityModels,
} from "./antigravityRuntime.ts";

const makeSpawner = (
  stdout: string,
  code = 0,
  seenCommand?: { command?: unknown },
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.make(
    (command) => (
      seenCommand ? (seenCommand.command = command) : undefined,
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      )
    ),
  );

describe("Antigravity model discovery", () => {
  it("parses tab-separated model slugs and display names", () => {
    expect(
      parseAntigravityModels(
        "gemini-3.7-flash-high\tGemini 3.7 Flash High\n" +
          "gemini-3.7-flash-medium\tGemini 3.7 Flash Medium\n",
      ),
    ).toEqual([
      {
        slug: "gemini-3.7-flash-high",
        name: "Gemini 3.7 Flash High",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "gemini-3.7-flash-medium",
        name: "Gemini 3.7 Flash Medium",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("ignores malformed rows and keeps the first duplicate", () => {
    expect(
      parseAntigravityModels(
        "not-a-model\n" +
          "gemini-3.7-flash-high\t High \n" +
          "gemini-3.7-flash-high\tLater\n" +
          "\tMissing slug\n" +
          "gemini-3.7-flash-low\t\n",
      ),
    ).toEqual([
      {
        slug: "gemini-3.7-flash-high",
        name: "High",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("provides the observed Gemini 3.7 catalog as the offline fallback", () => {
    expect(ANTIGRAVITY_FALLBACK_MODELS.map(({ slug }) => slug)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
      "gemini-3.7-flash-low",
    ]);
    expect(ANTIGRAVITY_FALLBACK_MODELS.every((model) => model.capabilities)).toBe(true);
    expect(ANTIGRAVITY_FALLBACK_MODELS.find((model) => model.isDefault)?.slug).toBe(
      "gemini-3.7-flash-high",
    );
  });

  it("selects an available model when the preferred high profile is absent", () => {
    expect(
      markAntigravityDefaultModel([
        {
          slug: "gemini-3.7-flash-medium",
          name: "Gemini 3.7 Flash Medium",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
      ]),
    ).toEqual([
      {
        slug: "gemini-3.7-flash-medium",
        name: "Gemini 3.7 Flash Medium",
        isCustom: false,
        isDefault: true,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("invokes the configured binary with models", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const seenCommand: { command?: unknown } = {};
        const discovery = yield* discoverAntigravityModels("/tmp/configured-agy", {
          AGY_TEST: "yes",
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeSpawner("gemini-3.7-flash-high\tHigh\n", 0, seenCommand),
          ),
        );
        expect(seenCommand.command).toMatchObject({
          command: "/tmp/configured-agy",
          args: ["models"],
        });
        expect(discovery.installed).toBe(true);
        expect(discovery.models[0]?.slug).toBe("gemini-3.7-flash-high");
      }),
    );
  });

  it("falls back when the models command exits unsuccessfully", async () => {
    await Effect.runPromise(
      discoverAntigravityModels("agy-direct").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeSpawner("", 1)),
        Effect.tap((discovery) =>
          Effect.sync(() => {
            expect(discovery.installed).toBe(true);
            expect(discovery.models).toEqual(ANTIGRAVITY_FALLBACK_MODELS);
            expect(discovery.message).toContain("exited with code 1");
          }),
        ),
      ),
    );
  });
});
