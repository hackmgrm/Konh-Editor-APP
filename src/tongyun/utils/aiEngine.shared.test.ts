import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomizationConfig } from "../types";

const { values, invoke } = vi.hoisted(() => ({ values: {} as Record<string, string>, invoke: vi.fn() }));
vi.mock("../../store/appConfig", () => ({ getConfig: (key: string) => values[key] ?? null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { callAI, canUseAI } from "./aiEngine";

const planner = { aiProvider: "openai", aiApiKey: "private", aiEndpoint: "https://private", aiModel: "private-model" } as CustomizationConfig;
describe("shared AI request safety", () => {
  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    Object.assign(values, { "planner.ai.useWriting": "true", "agent.api.baseUrl": "https://shared/v1", "agent.api.model": "shared-model", "agent.api.key": "shared-key" });
    invoke.mockReset();
  });
  it.each(["agent.api.baseUrl", "agent.api.model"])("rejects blank %s without invoking the proxy", async (key) => {
    values[key] = "  ";
    expect(canUseAI(planner)).toBe(false);
    await expect(callAI(planner, "system", "user")).rejects.toThrow("SHARED_AI_ENDPOINT_OR_MODEL_MISSING");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("uses only shared settings", async () => {
    invoke.mockResolvedValue(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    expect(canUseAI(planner)).toBe(true);
    await callAI(planner, "system", "user");
    expect(invoke).toHaveBeenCalledWith("ai_proxy", expect.objectContaining({ url: "https://shared/v1/chat/completions", headers: { Authorization: "Bearer shared-key" }, body: expect.stringContaining('"model":"shared-model"') }));
  });
  it("does not fall back to the planner key", () => {
    values["agent.api.key"] = "";
    expect(canUseAI(planner)).toBe(false);
  });
});
