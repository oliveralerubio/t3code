import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

const ANTIGRAVITY = ProviderDriverKind.make("antigravity");

describe("Antigravity model defaults", () => {
  it("uses the current high-effort Gemini 3.7 Flash model", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER[ANTIGRAVITY]).toBe("gemini-3.7-flash-high");
    expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[ANTIGRAVITY]).toBe("gemini-3.7-flash-high");
  });
});
