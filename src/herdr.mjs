import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readPane({
  env = process.env,
  herdrBin = env.HERDR_BIN_PATH || "herdr",
  paneId,
  timeoutMs = 10_000,
}) {
  const response = await runHerdrJson({
    args: ["pane", "get", paneId],
    env,
    herdrBin,
    timeoutMs,
  });
  const pane = response?.result?.pane;
  if (!pane?.pane_id) throw new Error(`Herdr did not return pane ${paneId}`);
  if (!pane.tab_id) return pane;
  const tabResponse = await runHerdrJson({
    args: ["tab", "get", pane.tab_id],
    env,
    herdrBin,
    timeoutMs,
  });
  const tab = tabResponse?.result?.tab;
  if (!tab?.tab_id) throw new Error(`Herdr did not return tab ${pane.tab_id}`);
  return { ...pane, tab };
}

export async function writePaneTitle({
  agent = null,
  env = process.env,
  herdrBin = env.HERDR_BIN_PATH || "herdr",
  onPaneTitleWritten = null,
  onTabTitleWritten = null,
  paneId,
  previousPluginTitle = null,
  source = "plugin:auto-session-title",
  tabId = null,
  timeoutMs = 10_000,
  title,
}) {
  const args = ["pane", "report-metadata", paneId, "--source", source];
  if (agent) {
    args.push("--agent", agent);
  }
  args.push("--title", title, "--display-agent", title);
  await runHerdrJson({ args, env, herdrBin, timeoutMs });
  await onPaneTitleWritten?.({ title });
  if (tabId) {
    const response = await runHerdrJson({
      args: ["tab", "get", tabId],
      env,
      herdrBin,
      timeoutMs,
    });
    const tab = response?.result?.tab;
    if (!tab?.tab_id) throw new Error(`Herdr did not return tab ${tabId}`);
    const tabLabel = tab.label?.trim() || null;
    const defaultTabLabel =
      tabLabel && tab.number != null && tabLabel === String(tab.number);
    if (tabLabel && !defaultTabLabel && tabLabel !== previousPluginTitle) {
      return { status: "preserved", title: tabLabel };
    }
    if (tabLabel === title) {
      await onTabTitleWritten?.({ title });
      return { status: "unchanged", title };
    }
    await runHerdrJson({
      args: ["tab", "rename", tabId, title],
      env,
      herdrBin,
      timeoutMs,
    });
    await onTabTitleWritten?.({ title });
  }
  return { status: "updated", title };
}

export async function clearPaneTitle({
  env = process.env,
  herdrBin = env.HERDR_BIN_PATH || "herdr",
  onPaneTitleCleared = null,
  onTabTitleCleared = null,
  paneId,
  previousPluginTitle = null,
  source = "plugin:auto-session-title",
  tabId = null,
  timeoutMs = 10_000,
}) {
  await runHerdrJson({
    args: [
      "pane",
      "report-metadata",
      paneId,
      "--source",
      source,
      "--clear-title",
      "--clear-display-agent",
    ],
    env,
    herdrBin,
    timeoutMs,
  });
  await onPaneTitleCleared?.();
  if (!tabId) return { status: "updated" };

  const response = await runHerdrJson({
    args: ["tab", "get", tabId],
    env,
    herdrBin,
    timeoutMs,
  });
  const tab = response?.result?.tab;
  if (!tab?.tab_id) throw new Error(`Herdr did not return tab ${tabId}`);
  const tabLabel = tab.label?.trim() || null;
  const defaultTabTitle = tab.number == null ? null : String(tab.number);
  if (!tabLabel || tabLabel === defaultTabTitle) {
    await onTabTitleCleared?.();
    return { status: "updated" };
  }
  if (!previousPluginTitle || tabLabel !== previousPluginTitle) {
    return { status: "preserved", title: tabLabel };
  }
  if (!defaultTabTitle) return { status: "preserved", title: tabLabel };

  await runHerdrJson({
    args: ["tab", "rename", tabId, defaultTabTitle],
    env,
    herdrBin,
    timeoutMs,
  });
  await onTabTitleCleared?.();
  return { status: "updated" };
}

async function runHerdrJson({ args, env, herdrBin, timeoutMs }) {
  const { stdout } = await execFileAsync(herdrBin, args, {
    encoding: "utf8",
    env,
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const output = stdout.trim();
  return output ? JSON.parse(output) : null;
}
