import { describe, expect, it } from "vite-plus/test";

import { PiSettings, PrimeAgentSettings, ProviderDriverKind } from "@t3tools/contracts";
import { PiAgentIcon, PrimeAgentIcon } from "../Icons";
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
});
