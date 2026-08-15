import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { isCommandMissingCause, spawnAndCollect } from "./providerSnapshot.ts";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
export const ANTIGRAVITY_MODELS_TIMEOUT = Duration.seconds(15);
const ANTIGRAVITY_FORCE_KILL_AFTER = Duration.seconds(1);

const ANTIGRAVITY_FALLBACK_CATALOG: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash High",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-3.7-flash-medium",
    name: "Gemini 3.7 Flash Medium",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-3.7-flash-low",
    name: "Gemini 3.7 Flash Low",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export interface AntigravityModelDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly installed: boolean;
  readonly message?: string;
}

function discoveryFallback(
  command: string,
  timeout: Duration.Duration,
  error: unknown,
): AntigravityModelDiscovery {
  if (Cause.isTimeoutError(error)) {
    return {
      models: ANTIGRAVITY_FALLBACK_MODELS,
      installed: true,
      message: `${command} models timed out after ${Duration.toMillis(timeout)}ms.`,
    };
  }

  const commandMissing = isCommandMissingCause(error);
  return {
    models: ANTIGRAVITY_FALLBACK_MODELS,
    installed: !commandMissing,
    message: commandMissing
      ? `${command} models could not be started because the command was not found.`
      : `${command} models could not be started.`,
  };
}

export function markAntigravityDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const defaultSlug =
    models.find((model) => model.slug === "gemini-3.7-flash-high")?.slug ??
    models.find((model) => !model.isCustom)?.slug;
  return models.map((model) => ({
    ...model,
    ...(model.slug === defaultSlug ? { isDefault: true } : {}),
  }));
}

export const ANTIGRAVITY_FALLBACK_MODELS = markAntigravityDefaultModel(
  ANTIGRAVITY_FALLBACK_CATALOG,
);

export function parseAntigravityModels(output: string): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  for (const line of output.split(/\r?\n/)) {
    const [rawSlug, rawName] = line.split("\t", 2);
    const slug = rawSlug?.trim();
    const name = rawName?.trim();
    if (!slug || !name || seen.has(slug)) continue;
    seen.add(slug);
    models.push({ slug, name, isCustom: false, capabilities: EMPTY_CAPABILITIES });
  }

  return models;
}

export function discoverAntigravityModels(
  binaryPath: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  timeout: Duration.Duration = ANTIGRAVITY_MODELS_TIMEOUT,
): Effect.Effect<AntigravityModelDiscovery, never, ChildProcessSpawner.ChildProcessSpawner> {
  const command = binaryPath?.trim() || "agy-direct";
  return Effect.gen(function* () {
    const effectiveEnvironment = { ...process.env, ...environment };
    const spawnCommand = yield* resolveSpawnCommand(command, ["models"], {
      env: effectiveEnvironment,
    });
    const result = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: effectiveEnvironment,
        shell: spawnCommand.shell,
        stdin: "ignore",
        forceKillAfter: ANTIGRAVITY_FORCE_KILL_AFTER,
      }),
    );
    const models = result.code === 0 ? parseAntigravityModels(result.stdout) : [];
    if (result.code !== 0) {
      return {
        models: ANTIGRAVITY_FALLBACK_MODELS,
        installed: true,
        message: result.stderr.trim() || `${command} models exited with code ${result.code}.`,
      } satisfies AntigravityModelDiscovery;
    }
    if (models.length === 0) {
      return {
        models: ANTIGRAVITY_FALLBACK_MODELS,
        installed: true,
        message: `${command} models returned no selectable models.`,
      } satisfies AntigravityModelDiscovery;
    }
    return {
      models: markAntigravityDefaultModel(models),
      installed: true,
    } satisfies AntigravityModelDiscovery;
  }).pipe(
    Effect.timeout(timeout),
    Effect.catch((error) => Effect.succeed(discoveryFallback(command, timeout, error))),
  );
}
