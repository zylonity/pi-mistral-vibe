import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createVibeProvider, ID } from "./provider.ts";
import { getRequestDiagnostics } from "./diagnostics.ts";

export default function mistralVibe(pi: ExtensionAPI) {
  pi.registerProvider(createVibeProvider());
  // Children load a fresh provider and only restore catalogs offline. A parent's
  // refresh cannot initialize this instance's key-scoped admission state.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model?.provider !== ID) return;
    const result = await ctx.modelRegistry.refresh({ providers: [ID], signal: AbortSignal.timeout(15_000) });
    const error = result.errors.get(ID);
    if (error) throw error;
    if (result.aborted) throw new Error("Mistral Vibe startup catalog refresh cancelled");
  });
  pi.registerCommand("mistral-vibe-diagnostics", {
    description: "Show payload-free metadata for the last Mistral Vibe HTTP request",
    async handler(_args, ctx) {
      const diagnostics = getRequestDiagnostics();
      ctx.ui.notify(diagnostics ? JSON.stringify(diagnostics, null, 2) : "No Mistral Vibe inference request recorded since reload.", "info");
    },
  });
  pi.registerCommand("mistral-vibe-refresh", {
    description: "Refresh Mistral Vibe's account-visible chat models (no inference)",
    async handler(_args, ctx) {
      const result = await ctx.modelRegistry.refresh({ providers: [ID], force: true, signal: AbortSignal.timeout(15_000) });
      const error = result.errors.get(ID);
      ctx.ui.notify(error ? error.message : result.aborted ? "Mistral Vibe refresh cancelled" : "Mistral Vibe catalog refreshed. Select a model with /model. Visibility is not proof of quota coverage.", error || result.aborted ? "warning" : "info");
    },
  });
}
