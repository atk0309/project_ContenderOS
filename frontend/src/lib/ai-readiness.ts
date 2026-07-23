// Pure derivation of whether AI tailoring is usable, from the admin provider status. The Parser and
// Tailor agents (the whole tailor flow) both resolve to anthropic/strong, so tailoring is available iff
// the Anthropic provider has a key set AND a strong-tier model assigned. `tierStrong != null` already
// implies `isSet` (the store drops a provider's models when its key is deleted), but we check both
// defensively. This is the SAME condition the backend resolver enforces at call time — surfaced here so
// the UI can lead with Tailor when it will actually work, instead of letting the user discover a 503.
import type { Schemas } from "./api/client";

export function tailorReady(status: Schemas["AdminStatus"]): boolean {
  const anthropic = status.providers.find((p) => p.provider === "anthropic");
  return anthropic?.isSet === true && anthropic.tierStrong != null;
}

// The review fan-out needs BOTH providers at strong tier: Editor/Fact-Checker/Gatekeeper resolve to
// openai/strong, the Spotter to anthropic/strong (invariant 6). `tailorReady` (anthropic-only) is
// necessary-but-insufficient here — a workspace with Anthropic but no OpenAI key would pass it yet
// 503 on three of four agents. So gate Review on this stricter, both-providers condition, mirroring
// what `build_panel_runner` enforces server-side (a clean preflight 503 if either is missing).
export function reviewReady(status: Schemas["AdminStatus"]): boolean {
  const ready = (name: string): boolean => {
    const p = status.providers.find((x) => x.provider === name);
    return p?.isSet === true && p.tierStrong != null;
  };
  return ready("openai") && ready("anthropic");
}
