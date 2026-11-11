import { describe, expect, it } from "vitest";
import { resolveSharedAI } from "./sharedAI";
import type { CustomizationConfig } from "../types";

describe("shared writing AI configuration", () => {
  const planner = { aiProvider: "anthropic", aiEndpoint: "https://anthropic/v1/messages", aiModel: "claude", aiApiKey: "legacy", providerApiKeys: { anthropic: "private", openai: "old" }, aiAutoCategorize: true } as unknown as CustomizationConfig;
  const writing = { baseUrl: "https://example/v1", key: "shared", model: "model" };
  it("keeps the original configuration when disabled", () => {
    expect(resolveSharedAI(planner, false, writing)).toBe(planner);
  });
  it("uses OpenAI protocol and live writing values without modifying planner settings", () => {
    const result = resolveSharedAI(planner, true, writing);
    expect(result).toMatchObject({ aiProvider: "openai", aiEndpoint: writing.baseUrl, aiModel: writing.model, aiApiKey: "", providerApiKeys: { openai: "shared", anthropic: "private" }, aiAutoCategorize: true });
    expect(planner.providerApiKeys?.openai).toBe("old");
    expect(planner.aiProvider).toBe("anthropic");
  });
  it("does not fall back to a planner key when the shared key is empty", () => {
    const result = resolveSharedAI(planner, true, { ...writing, key: "" });
    expect(result.aiApiKey).toBe("");
    expect(result.providerApiKeys?.openai).toBe("");
  });
});
