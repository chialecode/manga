/** Where another context has been in a resource when this one has not started (Q-33 item 3): `progress.get` and `library.read` say so. */
export type Elsewhere = {
  contextId: string | null;
  contextName: string;
  locator: unknown;
  percent: number;
  completion: string;
  lastInteractionAt: string;
};
