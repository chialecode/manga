import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { AgentChatSettings, ModelProfile, ReasoningEffort } from "@manga/contracts/models";
import { Menu, type MenuGroup, type MenuItem } from "../components/menu.tsx";
import { attempt } from "../lib/api.ts";
import { createPatchQueue } from "../lib/patch-queue.ts";
import { useServices } from "./services.tsx";

type Connection = { id: string; label?: string; modelId?: string; purpose?: string; baseUrl?: string; profile?: ModelProfile; providerModel?: string | null; account?: { id: string; label: string; providerRef: string; available: boolean } | null };
type CatalogModel = { id: string; name: string; contextWindow: number; inputTypes: string[]; reasoningLevels: string[] };
type Providers = { providers: Array<{ ref: string; name: string; models: CatalogModel[] }>; accounts: Array<{ id: string; providerRef: string; available: boolean }> };

const NO_CHOICE: AgentChatSettings = { connectionId: null, reasoningEffort: null, contextWindow: null };
/** The windows offered below the model's own, in tokens. */
const WINDOWS = [32_768, 65_536, 131_072, 262_144, 524_288];
const FALLBACK_LEVELS: ReasoningEffort[] = ["low", "medium", "high"];

/**
 * The conversation's choice (A-137), shared by every conversation surface on the page (the dock and the chat page show the same), read once from the
 * agent settings and written back there via a serialized patch queue.
 */
const choiceStore = (() => {
  let value: AgentChatSettings = NO_CHOICE;
  let loaded = false;
  let lastError: string | undefined;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const queue = createPatchQueue<AgentChatSettings, Partial<AgentChatSettings>>({
    initial: NO_CHOICE,
    apply: (state, patch) => ({ ...state, ...patch }),
    send: async (patch) => {
      const result = await attempt<{ chat: AgentChatSettings }>("settings.setAgent", { chat: patch });
      if (!result.ok) return { ok: false, error: result.error.message };
      return { ok: true, state: { ...NO_CHOICE, ...result.value.chat } };
    },
    onState: (next) => { value = next; notify(); },
    onError: (message) => { lastError = message; },
  });
  return {
    get: () => value,
    loaded: () => loaded,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async load() {
      const result = await attempt<{ chat?: AgentChatSettings }>("settings.getAgent");
      if (result.ok) {
        loaded = true;
        queue.hydrate({ ...NO_CHOICE, ...result.value.chat });
      }
    },
    async save(patch: Partial<AgentChatSettings>): Promise<string | null> {
      lastError = undefined;
      const ok = await queue.enqueue(patch);
      return ok ? null : (lastError ?? "failed to save");
    },
  };
})();

/** 131072 → "128K", 1048576 → "1M". */
export function windowLabel(tokens: number): string {
  if (tokens >= 1_048_576 && tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`;
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1024)}K`;
}

/** The model's own name, without the account's in front ("DeepSeek · DeepSeek V4.1 Flash" → "DeepSeek V4.1 Flash"). */
function modelName(connection: Connection): string {
  const label = connection.label || connection.providerModel || connection.modelId || connection.id;
  const parts = label.split(" · ");
  return connection.account && parts.length > 1 ? parts.slice(1).join(" · ") : label;
}

/**
 * The picker on the conversation page (A-137) plus the effective active text connection it resolves to:
 * which model the next message goes to, how hard it thinks, and how much of the window a task may fill. A
 * project with its own model shows that one, and choosing another there changes the project's model. A model of a provider's catalogue that the account
 * has not added yet is offered too; choosing it adds it to that account. Without any text model there is nothing to pick (the composer says so).
 */
export function useModelChoice(contextId: string | null): { picker: ReactNode; activeConnection: Connection | null } {
  const s = useServices();
  const t = s.t;
  const choice = useSyncExternalStore(choiceStore.subscribe, choiceStore.get, choiceStore.get);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [projectModel, setProjectModel] = useState<string | null>(null);
  const connections = useMemo(() => ((s.settings?.connections as Connection[] | undefined) ?? []).filter((item) => item.purpose === "text" && typeof item.id === "string"), [s.settings]);
  const sRef = useRef(s);
  sRef.current = s;

  useEffect(() => { if (!choiceStore.loaded()) void choiceStore.load(); }, []);
  useEffect(() => {
    const off = window.manga?.onNotice?.((notice) => {
      if (notice.topic === "settings.changed") void choiceStore.load();
    });
    return () => { off?.(); };
  }, []);
  useEffect(() => {
    if (!s.facets.has("plugins") && !connections.some((item) => item.account)) { setProviders(null); return; }
    let live = true;
    void attempt<Providers>("providers.list").then((result) => { if (live && result.ok) setProviders(result.value); });
    return () => { live = false; };
  }, [s.facets, connections]);
  useEffect(() => {
    if (!contextId) { setProjectModel(null); return; }
    let live = true;
    void attempt<{ project?: { modelConnectionId?: string | null } }>("project.get", { projectId: contextId }).then((result) => {
      if (live) setProjectModel(result.ok ? result.value.project?.modelConnectionId ?? null : null);
    });
    return () => { live = false; };
  }, [contextId, s.projectsVersion]);

  const save = useCallback(async (patch: Partial<AgentChatSettings>) => {
    const error = await choiceStore.save(patch);
    if (error) sRef.current.setError(error);
  }, []);

  const chooseConnection = useCallback(async (connectionId: string) => {
    if (contextId && projectModel) {
      const result = await attempt("project.update", { projectId: contextId, modelConnectionId: connectionId });
      if (!result.ok) { sRef.current.setError(result.error.message); return; }
      setProjectModel(connectionId);
      return;
    }
    await save({ connectionId });
  }, [contextId, projectModel, save]);

  const addAndChoose = useCallback(async (providerRef: string, accountId: string, model: CatalogModel) => {
    const added = await attempt<{ connections: Array<{ id: string; purpose: string; modelId: string }> }>("providers.add", { providerRef, accountId, models: [model.id], services: [] });
    if (!added.ok) { sRef.current.setError(added.error.message); return; }
    const made = added.value.connections.find((item) => item.purpose === "text");
    await sRef.current.refresh();
    if (made) await chooseConnection(made.id);
    sRef.current.setNotice(t("chat.model.added", { name: model.name }));
  }, [chooseConnection, t]);

  if (!connections.length) return { picker: null, activeConnection: null };
  const valid = (id: string | null) => (id && connections.some((item) => item.id === id) ? id : null);
  const currentId = valid(projectModel) ?? valid(choice.connectionId) ?? connections[0]!.id;
  const current = connections.find((item) => item.id === currentId)!;
  const profile = current.profile;

  const modelItems: MenuItem[] = connections.map((item) => ({
    id: item.id,
    testId: `chat-model-${item.id}`,
    label: item.id === projectModel ? t("chat.model.project", { name: modelName(item) }) : modelName(item),
    checked: item.id === currentId,
    onSelect: () => { void chooseConnection(item.id); },
  }));
  // The models a provider's account could add: offered under the ones there are, once each.
  for (const account of providers?.accounts ?? []) {
    if (!account.available) continue;
    const provider = providers!.providers.find((item) => item.ref === account.providerRef);
    for (const model of provider?.models ?? []) {
      if (connections.some((item) => item.account?.id === account.id && item.providerModel === model.id)) continue;
      modelItems.push({ id: `add-${account.id}-${model.id}`, testId: `chat-model-add-${model.id}`, label: t("chat.model.add", { name: model.name }), onSelect: () => { void addAndChoose(account.providerRef, account.id, model); } });
    }
  }
  modelItems.push({ id: "manage", testId: "chat-model-manage", label: t("chat.model.manage"), onSelect: () => s.open.settings("models") });
  const groups: MenuGroup[] = [{ id: "models", title: t("chat.model.models"), items: modelItems }];

  // How hard it thinks: the model's own levels (and off), only for a model that reasons.
  const reasons = Boolean(profile?.capabilities.includes("reasoning"));
  const levels = (profile?.reasoningLevels?.length ? profile.reasoningLevels : FALLBACK_LEVELS) as ReasoningEffort[];
  const chosenEffort = choice.reasoningEffort === "off" || (choice.reasoningEffort && levels.includes(choice.reasoningEffort)) ? choice.reasoningEffort : null;
  const effort: ReasoningEffort | "off" = chosenEffort ?? profile?.reasoningEffort ?? "off";
  if (reasons) {
    groups.push({
      id: "effort",
      title: t("chat.model.effort"),
      items: (["off", ...levels] as const).map((level) => ({
        id: level, testId: `chat-effort-${level}`, label: t(`models.effort.${level}`), checked: effort === level, onSelect: () => { void save({ reasoningEffort: level }); },
      })),
    });
  }

  // The window: the model's whole one, or less.
  const whole = profile?.contextWindow ?? 128_000;
  const contextSize = choice.contextWindow && choice.contextWindow < whole ? choice.contextWindow : whole;
  groups.push({
    id: "window",
    title: t("chat.model.window"),
    items: [
      ...WINDOWS.filter((size) => size < whole).map((size) => ({ id: String(size), testId: `chat-window-${size}`, label: windowLabel(size), checked: contextSize === size, onSelect: () => { void save({ contextWindow: size }); } })),
      { id: "whole", testId: "chat-window-whole", label: t("chat.model.windowAll", { size: windowLabel(whole) }), checked: contextSize === whole, onSelect: () => { void save({ contextWindow: null }); } },
    ],
  });

  const summary = [modelName(current), reasons ? t(`models.effort.${effort}`) : null, windowLabel(contextSize)].filter(Boolean).join(" · ");
  const picker = (
    <Menu
      label={t("chat.model")}
      testId="chat-model"
      className="chat-model"
      placement="above"
      groups={groups}
      trigger={<><span className="chat-model-name" data-testid="chat-model-summary">{summary}</span><ChevronDown size={13} aria-hidden="true" /></>}
    />
  );
  return { picker, activeConnection: current };
}
