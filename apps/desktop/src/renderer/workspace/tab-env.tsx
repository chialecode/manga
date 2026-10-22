import { contextKey } from "@manga/contracts";
import { useTab } from "./tab-context.tsx";
import { useTabModel, useWorkspace, useWorkspaceValue } from "./context.tsx";

/**
 * What a tab's content knows about its tab: the tab as saved (kind, target, view, history), the controller to change it with, and the request waiting for
 * it. `launchN` changes when something asks the content to do something once more (jump to a place, show a block); `takeLaunch` takes the request.
 */
export function useTabEnv() {
  const tab = useTab();
  const controller = useWorkspace();
  const key = contextKey(tab.contextId);
  const model = useTabModel(key, tab.tabId);
  const launchN = useWorkspaceValue((c) => c.launchOf(key, tab.tabId)?.n ?? 0);
  return { ...tab, key, model, controller, launchN, takeLaunch: () => controller.takeLaunch(key, tab.tabId) };
}

export type TabEnv = ReturnType<typeof useTabEnv>;
