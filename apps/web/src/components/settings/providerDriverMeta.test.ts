import { describe, expect, it } from "vite-plus/test";

import {
  AntigravitySettings,
  PiSettings,
  PrimeAgentSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { AntigravityIcon, PiAgentIcon, PrimeAgentIcon } from "../Icons";
import { getDriverOption } from "./providerDriverMeta";

describe("provider driver metadata", () => {
  it("exposes Pi as a configured provider with its native settings card", () => {
    const option = getDriverOption(ProviderDriverKind.make("pi"));

    expect(option).toBeDefined();
    expect(option?.label).toBe("Pi");
    expect(option?.icon).toBe(PiAgentIcon);
    expect(option?.settingsSchema).toBe(PiSettings);
    expect(option?.badgeLabel).toBeUndefined();
  });

  it("exposes Prime Agent with its documented metadata and settings", () => {
    const option = getDriverOption(ProviderDriverKind.make("primeAgent"));
    expect(option?.label).toBe("Prime Agent");
    expect(option?.icon).toBe(PrimeAgentIcon);
    expect(option?.settingsSchema).toBe(PrimeAgentSettings);
  });

  it("exposes Antigravity with the direct CLI setting", () => {
    const option = getDriverOption(ProviderDriverKind.make("antigravity"));
    expect(option?.label).toBe("Antigravity");
    expect(option?.icon).toBe(AntigravityIcon);
    expect(option?.settingsSchema).toBe(AntigravitySettings);
  });
});
