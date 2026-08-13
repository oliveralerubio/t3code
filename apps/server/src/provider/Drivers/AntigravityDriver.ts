import {
  AntigravitySettings,
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
import { makeAntigravityAdapter } from "../Layers/AntigravityAdapter.ts";
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
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";

const DRIVER_KIND = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);

const stamp =
  (input: {
    instanceId: ProviderInstance["instanceId"];
    displayName: string | undefined;
    accentColor?: string | undefined;
    continuationKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationKey },
  });

const providerSnapshot = (settings: AntigravitySettings): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, DateTime.formatIso).pipe(
    Effect.map((checkedAt) =>
      buildServerProvider({
        presentation: { displayName: "Antigravity", showInteractionModeToggle: false },
        enabled: settings.enabled,
        checkedAt,
        models: [],
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "unknown" },
          message: "Antigravity CLI is configured; authentication is checked when a turn starts.",
        },
      }),
    ),
  );

const unsupportedTextGeneration = <A>(operation: string): Effect.Effect<A, TextGenerationError> =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Antigravity text generation is not part of the conversational adapter.",
    }),
  );
const textGeneration = (): TextGeneration.TextGeneration["Service"] => ({
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
});

export type AntigravityDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService;

export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const identity = defaultProviderContinuationIdentity({ driverKind: DRIVER_KIND, instanceId });
      const effective = { ...config, enabled } satisfies AntigravitySettings;
      const adapter = yield* makeAntigravityAdapter({
        instanceId,
        binaryPath: effective.binaryPath,
        environment: Object.fromEntries(environment.map(({ name, value }) => [name, value])),
      });
      const settings = makeProviderSnapshotSettingsSource(effective, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<AntigravitySettings>
      >({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        }),
        getSettings: settings.getSettings,
        streamSettings: settings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (next) =>
          providerSnapshot(next.provider).pipe(
            Effect.map(
              stamp({
                instanceId,
                displayName,
                accentColor,
                continuationKey: identity.continuationKey,
              }),
            ),
          ),
        checkProvider: providerSnapshot(effective).pipe(
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
        textGeneration: textGeneration(),
      } satisfies ProviderInstance;
    }),
};
