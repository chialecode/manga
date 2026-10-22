import { createContext, useContext } from "react";

/**
 * What a tab's content knows about the tab it is in. A reader speaks to the Agent and to the recorder under its tab's id, and the tab says
 * whether it is the focused one and whether it can be seen at all (an unseen video pauses). Outside a workspace, in a test or a trial page, a
 * component gets the defaults: one tab, in front, in "最近".
 */
export type TabInfo = {
  tabId: string;
  /** The context the tab belongs to: a project id, null for "最近". Progress, sessions and materials are read and written for it. */
  contextId: string | null;
  /** The tab is the one the keyboard and the Agent follow. */
  focused: boolean;
  /** The tab is in front in its column and the column is on screen. */
  visible: boolean;
};

export const DEFAULT_TAB: TabInfo = { tabId: "", contextId: null, focused: true, visible: true };

const Context = createContext<TabInfo>(DEFAULT_TAB);
export const TabProvider = Context.Provider;
export const useTab = (): TabInfo => useContext(Context);
