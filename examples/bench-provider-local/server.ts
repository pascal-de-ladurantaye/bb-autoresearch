// Local bench provider (example) — BB server entry. Wiring only; the logic is
// in provider.ts. Machines are directories under the OS temp dir.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { benchProviderContract } from "./contract.ts";
import { createLocalBenchProvider } from "./provider.ts";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const provider = createLocalBenchProvider();
  bb.rpc.register(benchProviderContract, provider.handlers, {
    experimental_description: "Example bench provider: lends local temp directories as bench machines.",
  });
  // Stops timers and kills running execs; machines and state.json stay so a
  // reloaded plugin still lists and destroys them.
  bb.onDispose(() => provider.dispose());
}
