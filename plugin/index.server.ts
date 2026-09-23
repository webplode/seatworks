import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadKit } from "./server/catalog/kit.ts";
import { applyModels, readModels } from "./server/catalog/models.ts";
import { PLUGIN_ID, pluginDir, stateRoot } from "./server/core/paths.ts";
import { Runtime } from "./server/runtime/runtime.ts";

export default function contribute(server: PluginServerContext) {
  const dir = pluginDir();
  if (!dir) {
    console.error(`${PLUGIN_ID}: this plugin's directory is not in ~/.paseo/config.json under plugins.${PLUGIN_ID}`);
    return () => {};
  }
  let runtime: Runtime;
  try {
    const kit = loadKit(dir, stateRoot());
    applyModels(kit, readModels(stateRoot()));
    runtime = new Runtime(kit);
  } catch (error) {
    console.error(`${PLUGIN_ID}: the kit in ${dir} failed to load:`, error);
    return () => {};
  }
  runtime.prepare();
  runtime.register(server);
  void runtime.connect().catch(() => console.error("seatworks-v2: startup connection failed; recovery waits for a host hook or panel request"));
  return () => runtime.dispose();
}
