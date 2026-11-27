/** Shared command host facets used across `packages/app-core/src/commands/`. */
import type { MangaProductApp } from "../product-app.ts";

/** Base application surface shared by connections, settings, voice, agent, and library commands. */
export type CoreCommandHost = Pick<
  MangaProductApp,
  | "assertWritable"
  | "covers"
  | "debugContext"
  | "grantOf"
  | "interruptRuns"
  | "layout"
  | "listModules"
  | "notify"
  | "pendingRecoveryJobs"
  | "providers"
  | "publicLayout"
  | "queryLog"
  | "quickTasks"
  | "resolvePath"
  | "runtime"
  | "scanAbort"
  | "screenshots"
  | "sealed"
  | "secrets"
  | "setModule"
  | "store"
  | "trace"
  | "uiFacets"
  | "vault"
  | "workFolders"
>;

/** Extended application surface shared by agent, agent-run, library-io, and library commands. */
export type AgentCommandHost = CoreCommandHost & Pick<
  MangaProductApp,
  | "agentAccess"
  | "builtinDanmakuCredentials"
  | "call"
  | "closed"
  | "comics"
  | "conversations"
  | "danmaku"
  | "emitAgentStream"
  | "extras"
  | "followFiles"
  | "grants"
  | "issueAgentGrant"
  | "log"
  | "materials"
  | "media"
  | "metadata"
  | "parseGeneration"
  | "parseWorker"
  | "projects"
  | "proposals"
  | "requireModule"
  | "resolvePathFor"
  | "runAbort"
  | "suggestedQuery"
  | "videos"
  | "voice"
>;
