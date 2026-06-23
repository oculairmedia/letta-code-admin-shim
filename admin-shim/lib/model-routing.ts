export interface RouteModelConfig {
  jobType?: "mechanical" | "test" | "standard" | "high-risk";
  overrideModel?: string;
  defaultModel?: string;
}

export function routeModel(config: RouteModelConfig = {}): string {
  if (config.overrideModel) {
    return config.overrideModel;
  }

  const baseModel = config.defaultModel ?? "gpt-4o";

  if (config.jobType === "mechanical" || config.jobType === "test") {
    // Lower cost model for mechanical/test jobs
    return "gpt-4o-mini";
  }

  if (config.jobType === "high-risk") {
    // Escalate to a more capable reasoning model for high-risk work
    return "o1-preview";
  }

  return baseModel;
}
