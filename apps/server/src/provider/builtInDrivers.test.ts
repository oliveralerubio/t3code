import { describe, expect, it } from "@effect/vitest";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("built-in provider drivers", () => {
  it("registers Prime Agent as a selectable driver", () => {
    const driver = BUILT_IN_DRIVERS.find((candidate) => candidate.driverKind === "primeAgent");
    expect(driver?.metadata.displayName).toBe("Prime Agent");
    expect(driver?.defaultConfig()).toMatchObject({ binaryPath: "prime-agent", agentDir: "" });
  });
});
