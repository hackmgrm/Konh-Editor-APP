import type { CustomizationConfig } from "../types";

/** A read-time overlay: never copy or overwrite the planner's saved credentials. */
export function resolveSharedAI(config: CustomizationConfig, enabled: boolean, writing: { baseUrl: string; key: string; model: string }): CustomizationConfig {
  if (!enabled) return config;
  return { ...config, aiProvider: "openai", aiEndpoint: writing.baseUrl, aiModel: writing.model, aiApiKey: "", providerApiKeys: { ...config.providerApiKeys, openai: writing.key } };
}
