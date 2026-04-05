import { describe, expect, it, vi } from "vitest";

import { executeWithRetry, MalformedAIResponseError, normalizeAIError } from "./errors";

describe("normalizeAIError", () => {
  it("classifies rate limits as retryable", () => {
    const error = normalizeAIError(new Error("429 rate limit exceeded"));

    expect(error.code).toBe("rate_limit");
    expect(error.retryable).toBe(true);
  });

  it("classifies validation/json issues as malformed output", () => {
    const error = normalizeAIError(new Error("Plan output missing blocks array"));

    expect(error.code).toBe("malformed_output");
    expect(error.retryable).toBe(true);
  });

  it("classifies malformed response wrapper errors as malformed output", () => {
    const error = normalizeAIError(
      new MalformedAIResponseError({
        message: "Edge inference output missing related (boolean)",
        rawOutput: "{\"oops\":true}",
        runType: "infer_edge",
        provider: "claude",
        modelName: "claude-sonnet-4-6",
        promptVersion: "infer-edge-v1",
      }),
    );

    expect(error.code).toBe("malformed_output");
    expect(error.retryable).toBe(true);
  });

  it("classifies missing env config as non-retryable", () => {
    const error = normalizeAIError(new Error("ANTHROPIC_API_KEY is not set"));

    expect(error.code).toBe("misconfigured");
    expect(error.retryable).toBe(false);
  });
});

describe("executeWithRetry", () => {
  it("retries retryable failures until success", async () => {
    let attempts = 0;
    const onRetry = vi.fn();

    const result = await executeWithRetry({
      maxRetries: 2,
      operation: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("429 too many requests");
        }
        return "ok";
      },
      onRetry,
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable failures", async () => {
    let attempts = 0;

    await expect(
      executeWithRetry({
        maxRetries: 3,
        operation: async () => {
          attempts += 1;
          throw new Error("ANTHROPIC_API_KEY is not set");
        },
      }),
    ).rejects.toThrow("ANTHROPIC_API_KEY is not set");

    expect(attempts).toBe(1);
  });
});
