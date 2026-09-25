import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadPluginConfig({ env = process.env } = {}) {
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR;
  if (!configDir) return { renameTab: true };

  let config;
  try {
    config = JSON.parse(await readFile(path.join(configDir, "config.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { renameTab: true };
    throw error;
  }

  if (config.rename_tab !== undefined && typeof config.rename_tab !== "boolean") {
    throw new TypeError("config.json rename_tab must be a boolean");
  }
  return { renameTab: config.rename_tab ?? true };
}
