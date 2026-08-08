import {
  PiSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { PiRpcManager } from "../piRpcManager.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const decodePiSettings = Schema.decodeSync(PiSettings);

function stamp(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly continuationKey: string;
}) {
  return (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationKey },
  });
}

function pending(settings: PiSettings): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, DateTime.formatIso).pipe(
    Effect.map((checkedAt) =>
      buildServerProvider({
        presentation: { displayName: "Pi", showInteractionModeToggle: false },
        enabled: settings.enabled,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi provider status has not been checked in this session yet.",
        },
      }),
    ),
  );
}

function check(settings: PiSettings, cwd: string): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled)
      return buildServerProvider({
        presentation: { displayName: "Pi", showInteractionModeToggle: false },
        enabled: false,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    const models = yield* Effect.promise(() =>
      new PiRpcManager({
        binaryPath: settings.binaryPath,
        ...(settings.agentDir ? { agentDir: settings.agentDir } : {}),
      }).discoverModels(cwd),
    ).pipe(Effect.orElseSucceed(() => []));
    return buildServerProvider({
      presentation: { displayName: "Pi", showInteractionModeToggle: false },
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: models.length > 0,
        version: null,
        status: models.length > 0 ? "ready" : "error",
        auth: { status: "unknown" },
        ...(models.length > 0
          ? {}
          : {
              message: `Pi CLI (${settings.binaryPath}) is unavailable or has no configured models.`,
            }),
      },
    });
  });
}

const unsupportedTextGeneration = <A>(operation: string): Effect.Effect<A, TextGenerationError> =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Pi text generation is not supported by this v1 adapter.",
    }),
  );
const makeTextGeneration = (): TextGeneration.TextGeneration["Service"] => ({
  generateCommitMessage: (_input) => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: (_input) => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: (_input) => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: (_input) => unsupportedTextGeneration("generateThreadTitle"),
});

export type PiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService;

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const identity = defaultProviderContinuationIdentity({ driverKind: DRIVER_KIND, instanceId });
      const effective = { ...config, enabled } satisfies PiSettings;
      const adapter = yield* makePiAdapter({
        instanceId,
        binaryPath: effective.binaryPath,
        ...(effective.agentDir ? { agentDir: effective.agentDir } : {}),
        environment: Object.fromEntries(environment.map(({ name, value }) => [name, value])),
      });
      const settings = makeProviderSnapshotSettingsSource(effective, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        }),
        getSettings: settings.getSettings,
        streamSettings: settings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (next) =>
          pending(next.provider).pipe(
            Effect.map(
              stamp({
                instanceId,
                displayName,
                accentColor,
                continuationKey: identity.continuationKey,
              }),
            ),
          ),
        checkProvider: check(effective, serverConfig.cwd).pipe(
          Effect.map(
            stamp({
              instanceId,
              displayName,
              accentColor,
              continuationKey: identity.continuationKey,
            }),
          ),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: identity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
