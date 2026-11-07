import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { WorkspaceTab } from "@manga/contracts";
import type { WorkspaceController } from "./controller.ts";

const Context = createContext<WorkspaceController | null>(null);

export function WorkspaceProvider(props: { controller: WorkspaceController; children: ReactNode }) {
  return <Context.Provider value={props.controller}>{props.children}</Context.Provider>;
}

/** The controller of the window's workspace. */
export function useWorkspace(): WorkspaceController {
  const controller = useContext(Context);
  if (!controller) throw new Error("no workspace around this component");
  return controller;
}

/**
 * Something read from the workspace, redrawn when it changes. The selector must answer the same value while nothing it reads has changed (the tabs
 * of a context are replaced, not edited, so a tab or the list of tabs is such a value).
 */
export function useWorkspaceValue<T>(select: (controller: WorkspaceController) => T): T {
  const controller = useWorkspace();
  return useSyncExternalStore(controller.subscribe, () => select(controller), () => select(controller));
}

/** One tab of a context, as it is now. */
export function useTabModel(contextKey: string, tabId: string): WorkspaceTab | undefined {
  return useWorkspaceValue((controller) => controller.tab(contextKey, tabId));
}
