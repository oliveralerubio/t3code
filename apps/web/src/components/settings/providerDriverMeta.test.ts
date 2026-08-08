import { describe, expect, it } from "vite-plus/test";

import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
import { PiAgentIcon } from "../Icons";
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
});
