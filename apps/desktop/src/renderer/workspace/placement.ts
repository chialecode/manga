import type { WorkspaceView } from "@manga/contracts";

/**
 * Where the content of each tab is on the page (A-107, 计划 4.1). A tab's content is drawn once into a node of its own; the node is moved into the slot of
 * the tab in the dock of the view on screen, or into the context's hidden parking layer when that view does not hold the tab. Moving keeps the
 * content's state: React does not see it, and a video moved within the document keeps playing from where it is (`moveBefore` keeps even the
 * focus and a running transition, where the browser has it).
 */
const hosts = new Map<string, HTMLDivElement>();
const slots = new Map<string, HTMLElement>();
const parkings = new Map<string, HTMLElement>();
/** The view each context was last placed for, so that a slot made later (a dock that says it is ready after the change) is filled at once. */
const placedFor = new Map<string, WorkspaceView>();

const tabKey = (key: string, tabId: string) => `${key}/${tabId}`;
const slotKey = (key: string, view: WorkspaceView, tabId: string) => `${key}/${view}/${tabId}`;

/** The node a tab's content is drawn into; made the first time it is asked for. */
export function hostOf(key: string, tabId: string): HTMLDivElement {
  const id = tabKey(key, tabId);
  let node = hosts.get(id);
  if (!node) {
    node = document.createElement("div");
    node.className = "tab-host";
    node.dataset.host = tabId;
    hosts.set(id, node);
    const parking = parkings.get(key);
    if (parking) parking.appendChild(node);
  }
  return node;
}

/** The tab is closed: its node leaves the page. */
export function releaseHost(key: string, tabId: string): void {
  const id = tabKey(key, tabId);
  hosts.get(id)?.remove();
  hosts.delete(id);
}

type Movable = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
function move(node: HTMLElement, into: HTMLElement): void {
  if (node.parentElement === into) return;
  const target = into as Movable;
  // `moveBefore` moves a node without taking it out of the document first; both ways keep a playing video playing.
  if (typeof target.moveBefore === "function" && node.isConnected && into.isConnected) {
    try { target.moveBefore(node, null); return; } catch { /* fall back to a plain move */ }
  }
  into.appendChild(node);
}

/** A tab's node goes out of sight, into its context's parking layer. */
export function park(key: string, tabId: string): void {
  const node = hosts.get(tabKey(key, tabId));
  const parking = parkings.get(key);
  if (node && parking) move(node, parking);
}

/** Puts the node of each tab of a context where `view` wants it: its slot in that view's dock, else the parking layer. */
export function placeTabs(key: string, view: WorkspaceView, tabIds: readonly string[]): void {
  placedFor.set(key, view);
  const parking = parkings.get(key);
  for (const tabId of tabIds) {
    const node = hosts.get(tabKey(key, tabId));
    if (!node) continue;
    const slot = slots.get(slotKey(key, view, tabId));
    const into = slot ?? parking;
    if (into) move(node, into);
  }
}

export function setParking(key: string, node: HTMLElement | null): void {
  if (node) {
    parkings.set(key, node);
    for (const [id, host] of hosts) if (id.startsWith(`${key}/`) && !host.isConnected) node.appendChild(host);
  } else {
    parkings.delete(key);
  }
}

/** A dock made (or unmade) the slot of a tab. A slot of the view on screen takes the tab's node at once. */
export function setSlot(key: string, view: WorkspaceView, tabId: string, node: HTMLElement | null): void {
  const id = slotKey(key, view, tabId);
  if (node) {
    slots.set(id, node);
    const host = hosts.get(tabKey(key, tabId));
    if (host && placedFor.get(key) === view) move(host, node);
    return;
  }
  const was = slots.get(id);
  slots.delete(id);
  // The slot that held the node goes (the panel was closed or moved to another column): the node waits in the parking layer.
  const host = hosts.get(tabKey(key, tabId));
  if (host && was && host.parentElement === was) park(key, tabId);
}
