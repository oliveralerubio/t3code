import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { spawnAndCollect } from "./providerSnapshot.ts";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const ANTIGRAVITY_MODELS_TIMEOUT = Duration.seconds(4);

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
    Effect.timeout(ANTIGRAVITY_MODELS_TIMEOUT),
    Effect.orElseSucceed(() => ({
      models: ANTIGRAVITY_FALLBACK_MODELS,
      installed: false,
      message: `${command} models could not be started or timed out.`,
    })),
  );
}
