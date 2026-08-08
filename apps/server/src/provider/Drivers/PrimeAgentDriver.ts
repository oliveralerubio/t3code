import {
  PrimeAgentSettings,
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
import { makeAgentAdapter } from "../Layers/PiAdapter.ts";
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

const DRIVER_KIND = ProviderDriverKind.make("primeAgent");
const decodeSettings = Schema.decodeSync(PrimeAgentSettings);

const stamp =
  (
    instanceId: ProviderInstance["instanceId"],
    displayName: string | undefined,
    accentColor: string | undefined,
    continuationKey: string,
  ) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId,
    driver: DRIVER_KIND,
    ...(displayName ? { displayName } : {}),
    ...(accentColor ? { accentColor } : {}),
    continuation: { groupKey: continuationKey },
  });

const snapshot = (
  settings: PrimeAgentSettings,
  name: string,
  message: string,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, DateTime.formatIso).pipe(
    Effect.map((checkedAt) =>
      buildServerProvider({
        presentation: { displayName: name, showInteractionModeToggle: false },
        enabled: settings.enabled,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message,
        },
      }),
    ),
  );

const check = (
  settings: PrimeAgentSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled)
      return yield* snapshot(
        settings,
        "Prime Agent",
        "Prime Agent is disabled in T3 Code settings.",
      );
    const models = yield* Effect.promise(() =>
      new PiRpcManager({
        binaryPath: settings.binaryPath,
        ...(settings.agentDir ? { agentDir: settings.agentDir } : {}),
        environment,
        provider: DRIVER_KIND,
        providerName: "Prime Agent",
      }).discoverModels(cwd),
    ).pipe(Effect.orElseSucceed(() => []));
    return buildServerProvider({
      presentation: { displayName: "Prime Agent", showInteractionModeToggle: false },
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
              message: `Prime Agent CLI (${settings.binaryPath}) is unavailable or has no configured models.`,
            }),
      },
    });
  });

const unsupportedTextGeneration = <A>(operation: string): Effect.Effect<A, TextGenerationError> =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Prime Agent text generation is not supported by this adapter.",
    }),
  );
const textGeneration = (): TextGeneration.TextGeneration["Service"] => ({
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
});

export type PrimeAgentDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService;

export const PrimeAgentDriver: ProviderDriver<PrimeAgentSettings, PrimeAgentDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Prime Agent", supportsMultipleInstances: true },
  configSchema: PrimeAgentSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const identity = defaultProviderContinuationIdentity({ driverKind: DRIVER_KIND, instanceId });
      const effective = { ...config, enabled } satisfies PrimeAgentSettings;
      const adapter = yield* makeAgentAdapter({
        instanceId,
        binaryPath: effective.binaryPath,
        ...(effective.agentDir ? { agentDir: effective.agentDir } : {}),
        provider: DRIVER_KIND,
        providerName: "Prime Agent",
        environment: Object.fromEntries(environment.map(({ name, value }) => [name, value])),
      });
      const settings = makeProviderSnapshotSettingsSource(effective, serverSettings);
      const managed = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<PrimeAgentSettings>
      >({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        }),
        getSettings: settings.getSettings,
        streamSettings: settings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (next) =>
          snapshot(
            next.provider,
            "Prime Agent",
            "Prime Agent provider status has not been checked in this session yet.",
          ).pipe(Effect.map(stamp(instanceId, displayName, accentColor, identity.continuationKey))),
        checkProvider: check(
          effective,
          serverConfig.cwd,
          Object.fromEntries(environment.map(({ name, value }) => [name, value])),
        ).pipe(Effect.map(stamp(instanceId, displayName, accentColor, identity.continuationKey))),
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
        snapshot: managed,
        adapter,
        textGeneration: textGeneration(),
      } satisfies ProviderInstance;
    }),
};
