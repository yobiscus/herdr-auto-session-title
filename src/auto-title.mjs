#!/usr/bin/env node

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readCodexThreadTitle, syncCodexThreadTitle } from "./codex-rpc.mjs";
import { generateTitle } from "./generator.mjs";
import {
  clearPaneTitle,
  readPane,
  writePaneDisplayAgent,
  writePaneTitle,
} from "./herdr.mjs";
import { extractSessionPrompt, locateSessionFile } from "./session.mjs";
import {
  LockBusyError,
  readPaneState,
  removePaneState,
  withPaneLock,
  writePaneState,
} from "./state.mjs";
import { sanitizeDescription, sanitizeTitle } from "./title.mjs";

const defaultDependencies = {
  clearPaneTitle,
  extractSessionPrompt,
  generateTitle,
  locateSessionFile,
  readCodexThreadTitle,
  readPane,
  sleep,
  syncCodexThreadTitle,
  writePaneDisplayAgent,
  writePaneTitle,
};
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export function shouldHandleInvocation(env) {
  if (env.HERDR_PLUGIN_ACTION_ID === "refresh") return Boolean(env.HERDR_PANE_ID);
  if (env.HERDR_PLUGIN_EVENT === "pane.agent_detected") return true;
  if (env.HERDR_PLUGIN_EVENT === "pane.focused") return true;
  if (env.HERDR_PLUGIN_EVENT !== "pane.agent_status_changed") return false;
  const event = parseJson(env.HERDR_PLUGIN_EVENT_JSON);
  return event?.data?.agent_status === "working" || event?.data?.agent_status === "idle";
}

export async function runAutoTitle({
  codexBin = "codex",
  deps: dependencyOverrides = {},
  env = process.env,
  herdrBin = env.HERDR_BIN_PATH || "herdr",
  model = null,
  pluginRoot = path.join(moduleDirectory, ".."),
  sessionPollAttempts = 20,
  sessionPollIntervalMs = 100,
  sessionRoots = defaultSessionRoots(env),
  stateDir = env.HERDR_PLUGIN_STATE_DIR || path.join(os.tmpdir(), "herdr-auto-session-title"),
} = {}) {
  if (!shouldHandleInvocation(env)) return { status: "ignored" };
  const event = parseJson(env.HERDR_PLUGIN_EVENT_JSON);
  const paneId = env.HERDR_PANE_ID || event?.data?.pane_id;
  if (!paneId) return { status: "ignored" };
  const deps = { ...defaultDependencies, ...dependencyOverrides };

  try {
    return await withPaneLock({ paneId, stateDir }, async () => {
      let previous = await readPaneState({ paneId, stateDir });
      let pane = await deps.readPane({ env, herdrBin, paneId });
      const releaseRequested =
        isCodexReleaseEvent(event, previous) ||
        shouldRecoverMissedCodexRelease(event, pane, previous);
      const staleReleaseForCurrentSession =
        releaseRequested &&
        !previous?.releasePending &&
        paneSessionKey(pane) === previous?.sessionKey;
      if (
        (releaseRequested || previous?.releasePending) &&
        !staleReleaseForCurrentSession
      ) {
        const releaseResult = await clearReleasedPresentation({
          deps,
          env,
          herdrBin,
          pane,
          paneId,
          previous,
          stateDir,
        });
        previous = null;
        pane = await deps.readPane({ env, herdrBin, paneId });
        if (!pane.agent_session?.value) return releaseResult;
      }
      if (shouldWaitForCodexSession(event, pane)) {
        pane = await waitForAgentSession({
          attempts: sessionPollAttempts,
          deps,
          env,
          herdrBin,
          intervalMs: sessionPollIntervalMs,
          pane,
          paneId,
        });
      }
      const session = pane.agent_session;
      const agent = String(session?.agent || pane.agent || "").trim().toLowerCase();
      if (!session?.value || (agent !== "codex" && agent !== "claude")) {
        return { status: "unsupported" };
      }

      const currentPaneTitle = pane.title?.trim() || null;
      if (currentPaneTitle) {
        await deps.writePaneDisplayAgent({
          agent,
          env,
          herdrBin,
          paneId,
          title: currentPaneTitle,
        });
        const displayState = {
          ...previous,
          sessionKey: paneSessionKey(pane),
          herdrPaneTitle: confirmedPaneTitle(previous) || currentPaneTitle,
          herdrTabTitle: confirmedTabTitle(previous) ?? "",
          herdrTitle: previous?.herdrTitle || currentPaneTitle,
        };
        await writePaneState({ paneId, state: displayState, stateDir });
        previous = displayState;
      }

      const tabLabel = pane.tab?.label?.trim() || null;
      const defaultTabLabel =
        tabLabel && pane.tab?.number != null && tabLabel === String(pane.tab.number);
      const currentTabTitle = defaultTabLabel ? null : tabLabel;
      const ownedPaneTitle = confirmedPaneTitle(previous);
      const ownedTabTitle = confirmedTabTitle(previous);
      const manualTitle =
        (currentPaneTitle && currentPaneTitle !== ownedPaneTitle
          ? currentPaneTitle
          : null) ||
        (currentTabTitle && currentTabTitle !== ownedTabTitle ? currentTabTitle : null);
      if (manualTitle) {
        return { status: "preserved", title: manualTitle };
      }

      const sessionKey = paneSessionKey(pane);
      const sameSession = previous?.sessionKey === sessionKey;
      const force = env.HERDR_PLUGIN_ACTION_ID === "refresh";
      if (
        sameSession &&
        (previous.pendingHerdrTitle || previous.herdrTitle) &&
        !force
      ) {
        return await reconcileExistingSession({
          agent,
          codexBin,
          deps,
          env,
          herdrBin,
          pane,
          paneId,
          previous,
          stateDir,
          threadId: session.value,
        });
      }

      let prompt = null;
      let generated = null;
      let resolvedTitle = null;
      let codexTitle = sameSession ? previous?.codexTitle || null : null;
      let codexOwnedTitle = sameSession ? confirmedCodexOwnedTitle(previous) : null;
      if (shouldPreferNativeCodexTitle({ agent, force, sameSession })) {
        try {
          resolvedTitle = await deps.readCodexThreadTitle({
            codexBin,
            env,
            threadId: session.value,
          });
          codexTitle = resolvedTitle;
        } catch {}
      }

      if (!resolvedTitle) {
        const sessionPath =
          session.kind === "path"
            ? session.value
            : await deps.locateSessionFile({
                agent,
                roots: sessionRoots,
                sessionId: session.value,
              });
        if (!sessionPath) return { status: "pending", reason: "session-file-not-found" };
        prompt = await deps.extractSessionPrompt({ agent, sessionPath });
        if (!prompt) return { status: "pending", reason: "prompt-not-found" };

        try {
          generated = await deps.generateTitle({
            codexBin,
            cwd: pane.foreground_cwd || pane.cwd || pluginRoot,
            env,
            model,
            pluginRoot,
            prompt,
            stateDir,
          });
        } catch {
          generated = {
            title: sanitizeTitle(prompt, 36),
            description: sanitizeDescription(prompt, 100),
          };
        }
        if (!generated?.title) return { status: "pending", reason: "empty-title" };
        resolvedTitle = generated.title;

        if (agent === "codex") {
          try {
            const synced = await deps.syncCodexThreadTitle({
              codexBin,
              env,
              previousPluginTitle: codexOwnedTitle,
              threadId: session.value,
              title: generated.title,
            });
            resolvedTitle = synced.title;
            codexTitle = synced.title;
            codexOwnedTitle = synced.status === "updated" ? synced.title : null;
          } catch {}
        }
      }

      const stagedState = {
        ...previous,
        codexOwnedTitle,
        codexTitle,
        herdrPaneTitle: confirmedPaneTitle(previous),
        herdrTabTitle: confirmedTabTitle(previous),
        herdrTitle: previous?.herdrTitle || null,
        pendingHerdrTitle: resolvedTitle,
        promptHash: prompt ? hash(prompt) : null,
        sessionKey,
      };
      await writePaneState({ paneId, state: stagedState, stateDir });
      const herdrResult = await deps.writePaneTitle({
        agent,
        env,
        herdrBin,
        onPaneTitleWritten: async () => {
          stagedState.herdrPaneTitle = resolvedTitle;
          await writePaneState({ paneId, state: stagedState, stateDir });
        },
        onTabTitleWritten: async () => {
          stagedState.herdrTabTitle = resolvedTitle;
          await writePaneState({ paneId, state: stagedState, stateDir });
        },
        paneId,
        previousPluginTitle: stagedState.herdrTabTitle,
        tabId: pane.tab_id,
        title: resolvedTitle,
      });
      if (herdrResult?.status === "preserved") {
        await writePaneState({ paneId, state: stagedState, stateDir });
        return herdrResult;
      }
      const completedState = {
        ...stagedState,
        herdrPaneTitle: resolvedTitle,
        herdrTabTitle: pane.tab_id ? resolvedTitle : stagedState.herdrTabTitle,
        herdrTitle: resolvedTitle,
      };
      delete completedState.pendingHerdrTitle;
      await writePaneState({
        paneId,
        state: completedState,
        stateDir,
      });
      return { status: "updated", title: resolvedTitle };
    });
  } catch (error) {
    if (error instanceof LockBusyError) return { status: "busy" };
    throw error;
  }
}

async function reconcileExistingSession({
  agent,
  codexBin,
  deps,
  env,
  herdrBin,
  pane,
  paneId,
  previous,
  stateDir,
  threadId,
}) {
  let target = previous.pendingHerdrTitle || previous.herdrTitle;
  let codexTitle = previous.codexTitle;
  let codexOwnedTitle = confirmedCodexOwnedTitle(previous);
  let codexUpdated = false;
  if (agent === "codex" && codexTitle !== target) {
    try {
      const synced = await deps.syncCodexThreadTitle({
        codexBin,
        env,
        previousPluginTitle: codexOwnedTitle,
        threadId,
        title: target,
      });
      target = synced.title;
      codexTitle = synced.title;
      codexOwnedTitle = synced.status === "updated" ? synced.title : null;
      codexUpdated = synced.status === "updated";
    } catch {
      // Codex and Herdr are reconciled independently so either side can recover.
    }
  }

  let herdrUpdated = false;
  await deps.writePaneDisplayAgent({
    agent,
    env,
    herdrBin,
    paneId,
    title: target,
  });
  if (!herdrPresentationMatches(pane, target)) {
    const stagedState = {
      ...previous,
      codexOwnedTitle,
      codexTitle,
      herdrPaneTitle: confirmedPaneTitle(previous),
      herdrTabTitle: confirmedTabTitle(previous),
      pendingHerdrTitle: target,
    };
    await writePaneState({
      paneId,
      state: stagedState,
      stateDir,
    });
    const reconciled = await deps.writePaneTitle({
      agent,
      env,
      herdrBin,
      onPaneTitleWritten: async () => {
        stagedState.herdrPaneTitle = target;
        await writePaneState({ paneId, state: stagedState, stateDir });
      },
      onTabTitleWritten: async () => {
        stagedState.herdrTabTitle = target;
        await writePaneState({ paneId, state: stagedState, stateDir });
      },
      paneId,
      previousPluginTitle: stagedState.herdrTabTitle,
      tabId: pane.tab_id,
      title: target,
    });
    if (reconciled?.status === "preserved") {
      await writePaneState({ paneId, state: stagedState, stateDir });
      return reconciled;
    }
    herdrUpdated = true;
  }

  const reconciledState = {
    ...previous,
    codexOwnedTitle,
    codexTitle,
    herdrPaneTitle: target,
    herdrTabTitle: pane.tab_id ? target : confirmedTabTitle(previous),
    herdrTitle: target,
  };
  delete reconciledState.pendingHerdrTitle;
  await writePaneState({ paneId, state: reconciledState, stateDir });
  const status =
    codexUpdated || herdrUpdated || previous.pendingHerdrTitle ? "updated" : "unchanged";
  return { status, title: target };
}

async function clearReleasedPresentation({
  deps,
  env,
  herdrBin,
  pane,
  paneId,
  previous,
  stateDir,
}) {
  if (!previous) return { status: "unchanged" };
  const stagedState = {
    ...previous,
    releasePending: true,
    releaseTabTitle: previous.releaseTabTitle ?? confirmedTabTitle(previous),
  };
  await writePaneState({ paneId, state: stagedState, stateDir });
  await deps.clearPaneTitle({
    env,
    herdrBin,
    onPaneTitleCleared: async () => {
      stagedState.herdrPaneTitle = null;
      await writePaneState({ paneId, state: stagedState, stateDir });
    },
    onTabTitleCleared: async () => {
      stagedState.herdrTabTitle = null;
      await writePaneState({ paneId, state: stagedState, stateDir });
    },
    paneId,
    previousPluginTitle: stagedState.releaseTabTitle,
    tabId: pane.tab_id,
  });
  await removePaneState({ paneId, stateDir });
  return { status: "cleared" };
}

function defaultSessionRoots(env) {
  const userHomeDirectory = os.homedir();
  const codexHomeDirectory = env.CODEX_HOME || path.join(userHomeDirectory, ".codex");
  return {
    claude: path.join(userHomeDirectory, ".claude", "projects"),
    codex: path.join(codexHomeDirectory, "sessions"),
  };
}

function paneSessionKey(pane) {
  const session = pane.agent_session;
  if (!session?.value) return null;
  const agent = String(session.agent || pane.agent || "").trim().toLowerCase();
  if (!agent) return null;
  return [agent, session.source, session.kind, session.value].join(":");
}

async function waitForAgentSession({
  attempts,
  deps,
  env,
  herdrBin,
  intervalMs,
  pane,
  paneId,
}) {
  let current = pane;
  for (let attempt = 0; attempt < attempts && !current.agent_session?.value; attempt += 1) {
    await deps.sleep(intervalMs);
    current = await deps.readPane({ env, herdrBin, paneId });
  }
  return current;
}

function shouldPreferNativeCodexTitle({ agent, force, sameSession }) {
  return agent === "codex" && !force && !sameSession;
}

function shouldWaitForCodexSession(event, pane) {
  return (
    !pane.agent_session?.value &&
    event?.event === "pane.agent_detected" &&
    event?.data?.agent === "codex" &&
    event?.data?.released !== true
  );
}

function isCodexReleaseEvent(event, state) {
  return (
    event?.event === "pane.agent_detected" &&
    event?.data?.released === true &&
    (state?.sessionKey?.startsWith("codex:") || state?.releasePending === true)
  );
}

function shouldRecoverMissedCodexRelease(event, pane, state) {
  return (
    event?.event === "pane.focused" &&
    state?.sessionKey?.startsWith("codex:") &&
    !pane.agent_session?.value &&
    !String(pane.agent || "").trim()
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function herdrPresentationMatches(pane, title) {
  return (
    pane.title?.trim() === title &&
    (!pane.tab || pane.tab.label?.trim() === title)
  );
}

function confirmedPaneTitle(state) {
  return state?.herdrPaneTitle ?? state?.herdrTitle ?? null;
}

function confirmedTabTitle(state) {
  return state?.herdrTabTitle ?? state?.herdrTitle ?? null;
}

function confirmedCodexOwnedTitle(state) {
  if (!state) return null;
  if (Object.prototype.hasOwnProperty.call(state, "codexOwnedTitle")) {
    return state.codexOwnedTitle ?? null;
  }
  return null;
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAutoTitle()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
