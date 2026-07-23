import { describe, expect, it } from "vitest";
import { reviewReady, tailorReady } from "./ai-readiness";
import type { Schemas } from "./api/client";

type ProviderStatus = Schemas["AdminProviderStatus"];

// Minimal provider-status builder — only the fields tailorReady reads matter; the rest get safe defaults.
function provider(p: Partial<ProviderStatus> & Pick<ProviderStatus, "provider">): ProviderStatus {
  return { isSet: false, last4: null, availableModels: [], tierStrong: null, ...p };
}

function status(providers: ProviderStatus[]): Schemas["AdminStatus"] {
  return { providers };
}

describe("tailorReady", () => {
  it("is true when anthropic has a key AND a strong-tier model", () => {
    expect(
      tailorReady(
        status([provider({ provider: "anthropic", isSet: true, tierStrong: "claude-x" })]),
      ),
    ).toBe(true);
  });

  it("is false when the anthropic key is set but no strong tier is assigned", () => {
    expect(
      tailorReady(status([provider({ provider: "anthropic", isSet: true, tierStrong: null })])),
    ).toBe(false);
  });

  it("is false when the anthropic key is unset", () => {
    expect(
      tailorReady(status([provider({ provider: "anthropic", isSet: false, tierStrong: null })])),
    ).toBe(false);
  });

  it("ignores OpenAI — only the anthropic tailor flow gates Tailor", () => {
    expect(
      tailorReady(status([provider({ provider: "openai", isSet: true, tierStrong: "gpt-x" })])),
    ).toBe(false);
  });

  it("is false for an empty provider list", () => {
    expect(tailorReady(status([]))).toBe(false);
  });
});

describe("reviewReady", () => {
  const strong = (name: ProviderStatus["provider"]): ProviderStatus =>
    provider({ provider: name, isSet: true, tierStrong: `${name}-x` });

  it("is true only when BOTH openai and anthropic have a key AND a strong-tier model", () => {
    expect(reviewReady(status([strong("openai"), strong("anthropic")]))).toBe(true);
  });

  it("is false with anthropic ready but openai missing (the tailorReady blind spot)", () => {
    expect(reviewReady(status([strong("anthropic")]))).toBe(false);
    // The exact case tailorReady would wave through.
    expect(tailorReady(status([strong("anthropic")]))).toBe(true);
  });

  it("is false with openai ready but anthropic missing", () => {
    expect(reviewReady(status([strong("openai")]))).toBe(false);
  });

  it("is false when a provider has a key but no strong tier", () => {
    expect(
      reviewReady(
        status([
          strong("anthropic"),
          provider({ provider: "openai", isSet: true, tierStrong: null }),
        ]),
      ),
    ).toBe(false);
  });

  it("is false for an empty provider list", () => {
    expect(reviewReady(status([]))).toBe(false);
  });
});
