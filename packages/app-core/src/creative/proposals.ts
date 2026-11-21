import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MangaError, createId,
  type Actor, type CommandEnvelope, type CommandResult, type ErrorCode, type ProposalCard, type ProposalKind, type ProposalPreview,
  type ProposalStatus, type ProposalTarget, type ProposalTargetKind, type RoughcutActionInput, type RoughcutExportOptions, type RoughcutExportView, type ScopeGrant,
} from "@manga/contracts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import type { EmbedService } from "./embeds.ts";
import { safeFileName, type ExportFileIntent } from "./export-file.ts";
import type { OperationLog } from "../ops/operation-log.ts";
import { PROJECT_PACKAGE_EXTENSION } from "./project-package.ts";
import type { ProjectService } from "./projects.ts";
import {
  KIND_LABELS, MODULE_CHECKS, SOURCE_KIND_LABELS, SYNC_OWNER_COMMANDS,
  collectBacklinks, decisionFailureReason, findTargetState, formatBytes, formatDuration, idFieldOf, parseJsonObject, projectExportFingerprint, shortHash,
} from "./proposal-state.ts";
import { formatClock } from "./roughcut-plan.ts";
import type { RoughcutService } from "./roughcut.ts";
import { estimateTokens } from "../agent-context.ts";

export const MAX_PENDING_PROPOSALS = 20;

export type ProposalCreated = {
  proposalId: string;
  status: "pending";
  summary: string;
  proposal: ProposalCard;
};

type ProposalRow = {
  id: string;
  session_id: string;
  run_id: string;
  project_id: string;
  kind: ProposalKind;
  command_id: string;
  input_json: string;
  preview_json: string;
  target_json: string;
  reason: string | null;
  status: ProposalStatus;
  result_json: string | null;
  created_at: string;
  decided_at: string | null;
};

export type ProposalDeps = {
  store: DrizzleStore;
  projects: ProjectService;
  embeds: EmbedService;
  roughcuts: RoughcutService;
  log: OperationLog;
  requireModule: (commandId: string, label: string) => void;
  holdsResource: (resourceId: string, projectId: string, grant: ScopeGrant) => boolean;
  callOwner: (actor: Actor, command: { commandId: string; idempotencyKey: string; input: Record<string, unknown> }, grantHandle: string) => Promise<CommandResult>;
  notify?: (topic: string, payload: Record<string, unknown>) => void;
};

export class ProposalService {
  private readonly d: ProposalDeps;

  constructor(deps: ProposalDeps) {
    this.d = deps;
  }

  private get sqlite() {
    return this.d.store.sqlite;
  }

  private assertRunContext(grant: ScopeGrant, projectId: string): { sessionId: string; runId: string; projectId: string } {
    if (!projectId || !grant.sessionId || !grant.runId) {
      throw new MangaError("FORBIDDEN", "proposals can only be created by an agent run inside a project conversation", { details: { reason: "no-project-run" } });
    }
    const session = this.sqlite.prepare("SELECT project_id FROM agent_sessions WHERE id = ?").get(grant.sessionId) as { project_id: string | null } | undefined;
    if (!session || session.project_id !== projectId) throw new MangaError("SCOPE_DENIED", "the proposal's conversation is no longer in this project");
    return { sessionId: grant.sessionId, runId: grant.runId, projectId };
  }

  private checkSessionLimit(sessionId: string): void {
    const pendingRows = this.sqlite.prepare("SELECT * FROM agent_proposals WHERE session_id = ? AND status = 'pending'").all(sessionId) as ProposalRow[];
    this.refreshRows(pendingRows);
    const count = (this.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_proposals WHERE session_id = ? AND status = 'pending'").get(sessionId) as { n: number }).n;
    if (count >= MAX_PENDING_PROPOSALS) {
      throw new MangaError("PROPOSAL_LIMIT", `当前对话待确认的提议已满 ${MAX_PENDING_PROPOSALS} 条，请先确认或拒绝已有提议后再继续提出`, { details: { limit: MAX_PENDING_PROPOSALS, count } });
    }
  }

  /** Reads the current revision of a target object; returns `null` when it has been deleted or moved out of the project. */
  findTargetState(kind: ProposalTargetKind, targetId: string, projectId: string): ProposalTarget | null {
    return findTargetState(this.sqlite, kind, targetId, projectId);
  }

  /** Asserts that the target object exists and belongs to `projectId`, and returns its current `ProposalTarget`. */
  targetState(kind: ProposalTargetKind, targetId: string, projectId: string): ProposalTarget {
    if (kind === "project") {
      if (targetId !== projectId) throw new MangaError("SCOPE_DENIED", "that project is outside the current conversation's project");
      const found = this.findTargetState("project", targetId, projectId);
      if (!found) throw new MangaError("NOT_FOUND", "the project does not exist");
      return found;
    }
    const table = kind === "whiteboard" ? "whiteboards" : kind === "mindmap" ? "mindmaps" : kind === "draft" ? "drafts" : "rough_cuts";
    const row = this.sqlite.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(targetId) as { project_id: string | null } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "that object does not exist");
    if (row.project_id !== projectId) throw new MangaError("SCOPE_DENIED", "that object does not belong to this project");
    return this.findTargetState(kind, targetId, projectId)!;
  }

  private collectBacklinks(kind: Exclude<ProposalTargetKind, "project">, targetId: string): Array<{ sourceKind: string; sourceId: string; title: string }> {
    return collectBacklinks(this.sqlite, this.d.embeds, kind, targetId);
  }

  /** A deletion also affects its references; a project export depends on all rows and snapshots that the package carries. */
  private withDependencies(target: ProposalTarget, projectId: string, purpose: ProposalKind): ProposalTarget {
    if (purpose === "delete" && target.kind !== "project") {
      const backlinks = this.collectBacklinks(target.kind, target.targetId).sort((a, b) => `${a.sourceKind}:${a.sourceId}`.localeCompare(`${b.sourceKind}:${b.sourceId}`));
      return { ...target, revision: `${target.revision}:refs:${shortHash(backlinks)}` };
    }
    if (purpose === "exportProject") {
      const fingerprint = projectExportFingerprint(this.d.store, projectId);
      if (!fingerprint) return target;
      return { ...target, revision: `${target.revision}:bundle:${fingerprint.digest}` };
    }
    return target;
  }

  private currentTarget(row: ProposalRow): ProposalTarget | null {
    const target = JSON.parse(row.target_json) as ProposalTarget;
    const current = this.findTargetState(target.kind, target.targetId, row.project_id);
    return current ? this.withDependencies(current, row.project_id, row.kind) : null;
  }

  private assertCurrent(row: ProposalRow): void {
    const target = JSON.parse(row.target_json) as ProposalTarget;
    const current = this.currentTarget(row);
    if (!current || current.revision !== target.revision) {
      const verdict = this.staleVerdict(target, current);
      throw new MangaError("PROPOSAL_STALE", verdict.reason, { details: { proposalId: row.id, reason: verdict.code } });
    }
  }

  private ownerProposal(envelope: CommandEnvelope): ProposalRow | undefined {
    if (envelope.actor.kind !== "user") return undefined;
    return this.sqlite.prepare("SELECT * FROM agent_proposals WHERE id = ? AND command_id = ? AND status = 'applying'")
      .get(envelope.idempotencyKey, envelope.commandId) as ProposalRow | undefined;
  }

  private recordReceipt(row: ProposalRow, value: unknown): void {
    this.sqlite.prepare("INSERT OR IGNORE INTO operations(idempotency_key, command_id, result_json, committed_at) VALUES (?, ?, ?, ?)")
      .run(row.id, row.command_id, JSON.stringify({ status: "ok", value }), new Date().toISOString());
  }

  /** Called at the owner handler, after the gateway's awaits. The effect and its receipt commit together. */
  executeOwnerCommand(envelope: CommandEnvelope, handler: () => unknown): unknown {
    if (!SYNC_OWNER_COMMANDS.has(envelope.commandId)) return handler();
    const row = this.ownerProposal(envelope);
    if (!row) return handler();
    return this.sqlite.transaction(() => {
      this.assertCurrent(row);
      const value = handler();
      this.d.store.maybeCrash("proposal-owner-after-effect");
      this.recordReceipt(row, value);
      return value;
    })();
  }

  projectExportHooks(envelope: CommandEnvelope) {
    const row = this.ownerProposal(envelope);
    if (!row) return undefined;
    return {
      beforePublish: (intent: ExportFileIntent, counts: Record<string, number>) => {
        this.assertCurrent(row);
        const output = { fileName: intent.fileName, bytes: intent.bytes, counts };
        this.sqlite.prepare("UPDATE agent_proposals SET result_json = ? WHERE id = ? AND status = 'applying'")
          .run(JSON.stringify({ _exportIntent: { ...intent, output } }), row.id);
        this.d.store.maybeCrash("proposal-export-before-publish");
      },
      afterPublish: (intent: ExportFileIntent, counts: Record<string, number>) => {
        this.d.store.maybeCrash("proposal-export-after-publish");
        this.recordReceipt(row, { fileName: intent.fileName, bytes: intent.bytes, counts });
      },
    };
  }

  roughcutExportHooks(envelope: CommandEnvelope) {
    const row = this.ownerProposal(envelope);
    if (!row) return undefined;
    return {
      validate: () => this.assertCurrent(row),
      registered: (view: RoughcutExportView) => {
        this.assertCurrent(row);
        const output = { export: view };
        this.sqlite.prepare("UPDATE agent_proposals SET result_json = ? WHERE id = ? AND status = 'applying'")
          .run(JSON.stringify({ output }), row.id);
        this.recordReceipt(row, output);
        this.d.store.maybeCrash("proposal-export-job-registered");
      },
    };
  }

  /** A successful job registration is not a successful export: follow its durable completion, cancellation and failure. */
  onRoughcutExport(view: RoughcutExportView): void {
    const rows = this.sqlite.prepare("SELECT * FROM agent_proposals WHERE kind = 'exportRoughcut' AND status = 'applying' AND json_extract(result_json, '$.output.export.id') = ?")
      .all(view.id) as ProposalRow[];
    for (const row of rows) {
      const previous = parseJsonObject(row.result_json) ?? {};
      const pending = view.state === "planned" || view.state === "running";
      const status = pending ? "applying" : view.state === "done" ? "applied" : "failed";
      const error = status === "failed" ? {
        code: view.state === "cancelled" ? "CANCELLED" : view.error?.code ?? "EXECUTION_FAILED",
        message: view.state === "cancelled" ? "粗剪导出已取消，请让 Agent 重新提出" : "粗剪导出未完成，请在粗剪中查看原因并重新提出",
      } : undefined;
      this.sqlite.prepare("UPDATE agent_proposals SET status = ?, decided_at = ?, result_json = ? WHERE id = ? AND status = 'applying'")
        .run(status, pending ? row.decided_at : new Date().toISOString(), JSON.stringify({ ...previous, output: { export: view }, ...(error ? { error } : {}) }), row.id);
      this.d.notify?.("proposal.changed", { sessionId: row.session_id, runId: row.run_id, projectId: row.project_id, proposalId: row.id, status });
    }
  }

  private insertProposal(input: {
    sessionId: string;
    runId: string;
    projectId: string;
    kind: ProposalKind;
    target: ProposalTarget;
    commandId: string;
    commandInput: Record<string, unknown>;
    preview: ProposalPreview;
    reason?: string;
    requestKey?: string;
  }): ProposalCreated {
    return this.sqlite.transaction(() => this.commitProposal(input))();
  }

  private commitProposal(input: {
    sessionId: string;
    runId: string;
    projectId: string;
    kind: ProposalKind;
    target: ProposalTarget;
    commandId: string;
    commandInput: Record<string, unknown>;
    preview: ProposalPreview;
    reason?: string;
    requestKey?: string;
  }): ProposalCreated {
    const existing = input.requestKey ? this.d.store.loadIdempotent(input.requestKey) : undefined;
    if (existing?.status === "ok") {
      const created = existing.value as Omit<ProposalCreated, "proposal">;
      return { ...created, proposal: this.getCard(created.proposalId) };
    }
    const session = this.sqlite.prepare("SELECT project_id FROM agent_sessions WHERE id = ?").get(input.sessionId) as { project_id: string | null } | undefined;
    if (!session || session.project_id !== input.projectId) throw new MangaError("SCOPE_DENIED", "the proposal's conversation is no longer in this project");
    this.checkSessionLimit(input.sessionId);
    const id = createId("prop");
    const now = new Date().toISOString();
    const reason = input.reason?.trim() ? input.reason.trim() : null;
    this.sqlite.prepare(`
      INSERT INTO agent_proposals(
        id, session_id, run_id, project_id, kind, command_id, input_json, preview_json, target_json, reason, status, result_json, created_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
    `).run(
      id,
      input.sessionId,
      input.runId,
      input.projectId,
      input.kind,
      input.commandId,
      JSON.stringify(input.commandInput),
      JSON.stringify(input.preview),
      JSON.stringify(input.target),
      reason,
      now,
    );
    const proposal: ProposalCard = {
      id,
      sessionId: input.sessionId,
      runId: input.runId,
      projectId: input.projectId,
      kind: input.kind,
      target: input.target,
      commandId: input.commandId,
      preview: input.preview,
      reason,
      status: "pending",
      result: null,
      createdAt: now,
      decidedAt: null,
    };
    const created: ProposalCreated = {
      proposalId: id,
      status: "pending",
      summary: `${input.preview.title}（${input.preview.summary}）`,
      proposal,
    };
    if (input.requestKey) {
      const { proposal: _ownerCard, ...reply } = created;
      this.sqlite.prepare("INSERT INTO operations(idempotency_key, command_id, result_json, committed_at) VALUES (?, ?, ?, ?)")
        .run(input.requestKey, `proposal.${input.kind}`, JSON.stringify({ status: "ok", value: reply }), now);
    }
    this.d.notify?.("proposal.changed", { sessionId: input.sessionId, runId: input.runId, projectId: input.projectId, proposalId: id, status: "pending" });
    return created;
  }

  proposeDelete(grant: ScopeGrant, projectId: string, input: { kind: "whiteboard" | "mindmap" | "draft" | "roughcut"; targetId: string; reason?: string }, requestKey?: string): ProposalCreated {
    const ctx = this.assertRunContext(grant, projectId);
    const mod = MODULE_CHECKS[input.kind];
    this.d.requireModule(mod.commandId, mod.label);
    const target = this.withDependencies(this.targetState(input.kind, input.targetId, ctx.projectId), ctx.projectId, "delete");
    this.checkSessionLimit(ctx.sessionId);

    let summary = "";
    const lines: string[] = [];
    const warnings: string[] = [];
    const meta: Record<string, unknown> = {};

    if (input.kind === "whiteboard") {
      const nodes = (this.sqlite.prepare("SELECT COUNT(*) AS n FROM whiteboard_nodes WHERE board_id = ?").get(input.targetId) as { n: number }).n;
      const edges = (this.sqlite.prepare("SELECT COUNT(*) AS n FROM whiteboard_edges WHERE board_id = ?").get(input.targetId) as { n: number }).n;
      summary = `${nodes} 张卡片、${edges} 条连线`;
      meta.nodes = nodes;
      meta.edges = edges;
    } else if (input.kind === "mindmap") {
      const nodes = (this.sqlite.prepare("SELECT COUNT(*) AS n FROM mindmap_nodes WHERE map_id = ?").get(input.targetId) as { n: number }).n;
      summary = `${nodes} 个节点`;
      meta.nodes = nodes;
    } else if (input.kind === "draft") {
      const row = this.sqlite.prepare("SELECT text, version FROM drafts WHERE id = ?").get(input.targetId) as { text: string; version: number };
      const versions = (this.sqlite.prepare("SELECT COUNT(*) AS n FROM draft_versions WHERE draft_id = ?").get(input.targetId) as { n: number }).n;
      const chars = [...row.text].length;
      summary = `第 v${row.version} 版 · ${chars} 字 · ${versions} 个历史版本`;
      meta.version = row.version;
      meta.chars = chars;
      meta.versions = versions;
    } else {
      const stats = this.sqlite.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(out_ms - in_ms), 0) AS ms FROM rough_cut_clips WHERE cut_id = ?").get(input.targetId) as { n: number; ms: number };
      summary = `${stats.n} 个片段 · 共 ${formatDuration(stats.ms)}`;
      meta.clips = stats.n;
      meta.totalMs = stats.ms;
    }

    const backlinks = this.collectBacklinks(input.kind, input.targetId);
    meta.backlinks = backlinks.length;
    if (backlinks.length > 0) {
      const shown = backlinks.slice(0, 5).map((item) => `${SOURCE_KIND_LABELS[item.sourceKind] ?? item.sourceKind}《${item.title}》`).join("、");
      const more = backlinks.length > 5 ? `（还有 ${backlinks.length - 5} 处）` : "";
      lines.push(`反向引用（${backlinks.length} 处）：${shown}${more}`);
      warnings.push("删除后这些引用会显示为已删除");
    }
    warnings.push("删除后不能撤销");

    const preview: ProposalPreview = {
      title: `删除${KIND_LABELS[input.kind]}《${target.title}》`,
      summary,
      lines,
      warnings,
      irreversible: true,
      meta,
    };

    return this.insertProposal({
      ...ctx,
      kind: "delete",
      target,
      commandId: `${input.kind}.delete`,
      commandInput: { [idFieldOf(input.kind)]: input.targetId },
      preview,
      reason: input.reason,
      requestKey,
    });
  }

  proposeRename(grant: ScopeGrant, projectId: string, input: { kind: ProposalTargetKind; targetId?: string; title: string; reason?: string }, requestKey?: string): ProposalCreated {
    const ctx = this.assertRunContext(grant, projectId);
    const mod = MODULE_CHECKS[input.kind];
    this.d.requireModule(mod.commandId, mod.label);
    const newTitle = input.title.trim();
    if (!newTitle || [...newTitle].length > 200) {
      throw new MangaError("VALIDATION_ERROR", "the new title must be between 1 and 200 characters");
    }
    const targetId = input.kind === "project" ? (input.targetId ?? ctx.projectId) : input.targetId;
    if (!targetId) throw new MangaError("VALIDATION_ERROR", "targetId is required when renaming an object");
    const target = this.targetState(input.kind, targetId, ctx.projectId);
    this.checkSessionLimit(ctx.sessionId);

    const warnings: string[] = [];
    let duplicateCount = 0;
    if (input.kind === "project") {
      duplicateCount = (this.sqlite.prepare("SELECT COUNT(*) AS n FROM projects WHERE id <> ? AND name = ?").get(targetId, newTitle) as { n: number }).n;
    } else {
      const table = input.kind === "whiteboard" ? "whiteboards" : input.kind === "mindmap" ? "mindmaps" : input.kind === "draft" ? "drafts" : "rough_cuts";
      duplicateCount = (this.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND id <> ? AND title = ?`).get(ctx.projectId, targetId, newTitle) as { n: number }).n;
    }
    if (duplicateCount > 0) {
      warnings.push(`与项目里已有的同名${KIND_LABELS[input.kind]}《${newTitle}》重名`);
    }

    const preview: ProposalPreview = {
      title: `重命名${KIND_LABELS[input.kind]}：《${target.title}》→《${newTitle}》`,
      summary: `原名称《${target.title}》 → 新名称《${newTitle}》`,
      lines: [],
      warnings,
      irreversible: false,
      meta: { oldTitle: target.title, newTitle, duplicate: duplicateCount > 0 },
    };

    const commandId = input.kind === "project" ? "project.update" : `${input.kind}.rename`;
    const commandInput = input.kind === "project"
      ? { projectId: ctx.projectId, name: newTitle }
      : { [idFieldOf(input.kind)]: targetId, title: newTitle };

    return this.insertProposal({
      ...ctx,
      kind: "rename",
      target,
      commandId,
      commandInput,
      preview,
      reason: input.reason,
      requestKey,
    });
  }

  proposeExportProject(grant: ScopeGrant, projectId: string, input: { reason?: string }, requestKey?: string): ProposalCreated {
    const ctx = this.assertRunContext(grant, projectId);
    this.d.requireModule("project.exportPackage", "projects");
    const baseTarget = this.targetState("project", ctx.projectId, ctx.projectId);
    const fingerprint = projectExportFingerprint(this.d.store, ctx.projectId);
    if (!fingerprint) throw new MangaError("NOT_FOUND", "the project does not exist");
    const target: ProposalTarget = { ...baseTarget, revision: `${baseTarget.revision}:bundle:${fingerprint.digest}` };
    this.checkSessionLimit(ctx.sessionId);

    const detail = this.d.projects.get(ctx.projectId);
    const counts = detail.project.counts;
    const bytes = fingerprint.estimatedBytes;
    const suggestedFileName = `${safeFileName(detail.project.name, "project")}.${PROJECT_PACKAGE_EXTENSION}`;

    const summary = `材料 ${counts.materials} 项 · 白板 ${counts.whiteboards} · 导图 ${counts.mindmaps} · 文稿 ${counts.drafts} · 摘录 ${counts.excerpts} · 粗剪 ${counts.roughCuts} · 词条 ${counts.terms} · 约 ${formatBytes(bytes)}`;
    const preview: ProposalPreview = {
      title: `导出项目包《${target.title}》`,
      summary,
      lines: [
        `建议文件名：${suggestedFileName}`,
        "确认时选择保存位置",
      ],
      warnings: [],
      irreversible: false,
      meta: { counts, estimatedBytes: bytes, suggestedFileName },
    };

    return this.insertProposal({
      ...ctx,
      kind: "exportProject",
      target,
      commandId: "project.exportPackage",
      commandInput: { projectId: ctx.projectId },
      preview,
      reason: input.reason,
      requestKey,
    });
  }

  proposeEditRoughcut(grant: ScopeGrant, projectId: string, input: { cutId: string; label?: string; actions: RoughcutActionInput[]; reason?: string }, requestKey?: string): ProposalCreated {
    const ctx = this.assertRunContext(grant, projectId);
    this.d.requireModule("roughcut.edit", "rough cuts");
    const target = this.targetState("roughcut", input.cutId, ctx.projectId);
    for (const action of input.actions) {
      if (action.type === "add" && !this.d.holdsResource(action.resourceId, ctx.projectId, grant)) {
        throw new MangaError("FORBIDDEN", "that video is not among the project's materials", { details: { resourceId: action.resourceId } });
      }
    }
    const dryRun = this.d.roughcuts.previewEdit(input.cutId, input.actions);
    this.checkSessionLimit(ctx.sessionId);

    const rawLabel = input.label?.trim() || dryRun.steps[0] || "调整片段";
    const opLabel = rawLabel.startsWith("Agent：") ? rawLabel.slice(0, 80) : `Agent：${rawLabel}`.slice(0, 80);

    const summary = `片段数 ${dryRun.beforeClips} 段 → ${dryRun.afterClips} 段 · 总时长 ${formatDuration(dryRun.beforeMs)} → ${formatDuration(dryRun.afterMs)}`;
    const lines = [
      ...dryRun.steps.map((step, index) => `${index + 1}. ${step}`),
      `确认后可在粗剪的撤销列表里撤回（${opLabel}）`,
    ];

    const preview: ProposalPreview = {
      title: `调整粗剪《${target.title}》：${input.actions.length} 步`,
      summary,
      lines,
      warnings: [],
      irreversible: false,
      meta: {
        beforeClips: dryRun.beforeClips,
        afterClips: dryRun.afterClips,
        beforeMs: dryRun.beforeMs,
        afterMs: dryRun.afterMs,
        opLabel,
      },
    };

    return this.insertProposal({
      ...ctx,
      kind: "editRoughcut",
      target,
      commandId: "roughcut.edit",
      commandInput: { cutId: input.cutId, label: opLabel, actions: input.actions },
      preview,
      reason: input.reason,
      requestKey,
    });
  }

  async proposeExportRoughcut(grant: ScopeGrant, projectId: string, input: { cutId: string; fileName?: string; options?: RoughcutExportOptions; reason?: string }, signal?: AbortSignal, requestKey?: string): Promise<ProposalCreated> {
    const ctx = this.assertRunContext(grant, projectId);
    this.d.requireModule("roughcut.export", "rough cuts");
    const target = this.targetState("roughcut", input.cutId, ctx.projectId);
    const { plan } = await this.d.roughcuts.plan(input.cutId, input.options ?? { mode: "merge" }, signal);
    signal?.throwIfAborted();
    this.assertRunContext(grant, projectId);
    if (this.findTargetState("roughcut", input.cutId, ctx.projectId)?.revision !== target.revision) {
      throw new MangaError("PROPOSAL_STALE", "粗剪在生成导出计划时被修改过，请让 Agent 重新提出");
    }
    this.checkSessionLimit(ctx.sessionId);

    const mode = plan.options.mode;
    const modeLabel = mode === "separate" ? "按片段分开导出" : "合并为一个文件";
    const summary = `${modeLabel} · ${plan.clips.length} 个片段 · 请求 ${formatDuration(plan.requestedMs)} → 实际 ${formatDuration(plan.actualMs)}`;
    const lines: string[] = plan.clips.map((clip, idx) => {
      const shift = clip.startShiftMs > 0 ? `（关键帧前移 ${clip.startShiftMs} ms）` : "";
      return `#${idx + 1}《${clip.title || clip.resourceId}》 请求 ${formatClock(clip.requestedInMs)}–${formatClock(clip.requestedOutMs)} → 实际 ${formatClock(clip.actualInMs)}–${formatClock(clip.actualOutMs)}${shift}`;
    });
    lines.push("默认写入作品内容文件夹的粗剪目录");
    const warnings: string[] = [];

    const preview: ProposalPreview = {
      title: `导出粗剪《${plan.title}》`,
      summary,
      lines,
      warnings,
      irreversible: false,
      meta: {
        mode,
        clips: plan.clips.length,
        requestedMs: plan.requestedMs,
        actualMs: plan.actualMs,
        compatible: plan.compatible,
        separable: plan.separable,
        container: plan.container,
        extension: plan.extension,
        problems: plan.problems,
        clipTitles: Object.fromEntries(plan.clips.map((clip) => [clip.clipId, clip.title || clip.resourceId])),
      },
    };

    const commandInput: Record<string, unknown> = {
      cutId: input.cutId,
      ...(input.fileName ? { fileName: input.fileName } : {}),
      ...(input.options ? { options: input.options } : {}),
    };

    return this.insertProposal({
      ...ctx,
      kind: "exportRoughcut",
      target,
      commandId: "roughcut.export",
      commandInput,
      preview,
      reason: input.reason,
      requestKey,
    });
  }

  private rowToCard(row: ProposalRow): ProposalCard {
    const { _exportIntent: _privateIntent, ...result } = parseJsonObject(row.result_json) ?? {};
    return {
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      projectId: row.project_id,
      kind: row.kind,
      target: JSON.parse(row.target_json) as ProposalTarget,
      commandId: row.command_id,
      preview: JSON.parse(row.preview_json) as ProposalPreview,
      reason: row.reason,
      status: row.status,
      result: row.result_json ? result : null,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    };
  }

  private staleVerdict(target: ProposalTarget, current: { revision: string | number } | null): { reason: string; code: "deleted" | "changed" } {
    const label = KIND_LABELS[target.kind] ?? "对象";
    return !current
      ? { reason: `${label}已被删除，请让 Agent 重新提出`, code: "deleted" }
      : { reason: `${label}在提议后被修改过，请让 Agent 重新提出`, code: "changed" };
  }

  /** Checks pending proposals against their target's current revision and marks any changed/deleted ones as `stale`. */
  private refreshRows(rows: ProposalRow[]): ProposalCard[] {
    const now = new Date().toISOString();
    const markStale = this.sqlite.prepare("UPDATE agent_proposals SET status = 'stale', decided_at = ?, result_json = ? WHERE id = ? AND status = 'pending'");
    return rows.map((row) => {
      if (row.status === "pending") {
        const target = JSON.parse(row.target_json) as ProposalTarget;
        const current = this.currentTarget(row);
        if (!current || current.revision !== target.revision) {
          const { reason, code } = this.staleVerdict(target, current);
          const resultJson = JSON.stringify({ reason, code });
          const changed = markStale.run(now, resultJson, row.id).changes;
          if (changed === 1) {
            row = { ...row, status: "stale", decided_at: now, result_json: resultJson };
          }
        }
      }
      return this.rowToCard(row);
    });
  }

  getCard(proposalId: string): ProposalCard {
    const row = this.sqlite.prepare("SELECT * FROM agent_proposals WHERE id = ?").get(proposalId) as ProposalRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the proposal does not exist");
    return this.refreshRows([row])[0]!;
  }

  list(filter: { sessionId?: string; runId?: string; projectId?: string; status?: ProposalStatus } = {}): { proposals: ProposalCard[] } {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.sessionId) { where.push("session_id = ?"); params.push(filter.sessionId); }
    if (filter.runId) { where.push("run_id = ?"); params.push(filter.runId); }
    if (filter.projectId) { where.push("project_id = ?"); params.push(filter.projectId); }
    const sql = `SELECT * FROM agent_proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, rowid ASC`;
    const rows = this.sqlite.prepare(sql).all(...params) as ProposalRow[];
    const cards = this.refreshRows(rows);
    return {
      proposals: filter.status ? cards.filter((card) => card.status === filter.status) : cards,
    };
  }

  /** Proposals of a session grouped by `runId`, with pending ones checked for staleness first. */
  byRunForSession(sessionId: string): Map<string, ProposalCard[]> {
    const rows = this.sqlite.prepare("SELECT * FROM agent_proposals WHERE session_id = ? ORDER BY created_at ASC, rowid ASC").all(sessionId) as ProposalRow[];
    const cards = this.refreshRows(rows);
    const map = new Map<string, ProposalCard[]>();
    for (const card of cards) {
      const list = map.get(card.runId) ?? [];
      list.push(card);
      map.set(card.runId, list);
    }
    return map;
  }

  async apply(actor: Actor, ownerGrantHandle: string, input: { proposalId: string; pathHandle?: string }): Promise<{ proposal: ProposalCard; output: unknown }> {
    const row = this.sqlite.prepare("SELECT * FROM agent_proposals WHERE id = ?").get(input.proposalId) as ProposalRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the proposal does not exist");

    if (row.kind === "exportProject" && row.status === "pending" && !input.pathHandle) {
      throw new MangaError("VALIDATION_ERROR", "导出项目包需要选择保存文件夹", { details: { reason: "pathHandle-required" } });
    }

    const now = new Date().toISOString();
    const taken = this.sqlite.prepare("UPDATE agent_proposals SET status = 'applying', decided_at = ? WHERE id = ? AND status = 'pending'").run(now, row.id);
    if (taken.changes !== 1) {
      const latest = (this.sqlite.prepare("SELECT * FROM agent_proposals WHERE id = ?").get(input.proposalId) as ProposalRow | undefined) ?? row;
      if (latest.status === "stale") {
        const res = parseJsonObject(latest.result_json);
        throw new MangaError("PROPOSAL_STALE", String(res?.reason ?? "目标已被改动或删除，提议已失效"), { details: { proposalId: latest.id, status: latest.status, result: res } });
      }
      throw new MangaError("PROPOSAL_DECIDED", "该提议已处理，不能重复确认", { details: { proposalId: latest.id, status: latest.status } });
    }

    const target = JSON.parse(row.target_json) as ProposalTarget;
    const preview = JSON.parse(row.preview_json) as ProposalPreview;
    const current = this.currentTarget(row);
    if (!current || current.revision !== target.revision) {
      const { reason, code } = this.staleVerdict(target, current);
      this.sqlite.prepare("UPDATE agent_proposals SET status = 'stale', decided_at = ?, result_json = ? WHERE id = ?")
        .run(now, JSON.stringify({ reason, code }), row.id);
      this.d.notify?.("proposal.changed", { sessionId: row.session_id, runId: row.run_id, projectId: row.project_id, proposalId: row.id, status: "stale" });
      throw new MangaError("PROPOSAL_STALE", reason, { details: { proposalId: row.id, reason: code } });
    }

    this.d.store.maybeCrash("proposal-applying");

    const baseInput = JSON.parse(row.input_json) as Record<string, unknown>;
    const commandInput = row.kind === "exportProject" ? { ...baseInput, pathHandle: input.pathHandle } : baseInput;

    const result = await this.d.callOwner(actor, {
      commandId: row.command_id,
      idempotencyKey: row.id,
      input: commandInput,
    }, ownerGrantHandle);

    const decidedAt = new Date().toISOString();
    if (result.status === "ok") {
      this.sqlite.prepare("INSERT OR IGNORE INTO operations(idempotency_key, command_id, result_json, committed_at) VALUES (?, ?, ?, ?)")
        .run(row.id, row.command_id, JSON.stringify(result), decidedAt);
      this.d.store.maybeCrash("proposal-applying-after-command");
      if (row.kind === "exportRoughcut") {
        const view = (result.value as { export: RoughcutExportView }).export;
        this.onRoughcutExport(this.d.roughcuts.exports.get(view.id));
      } else {
        this.sqlite.prepare("UPDATE agent_proposals SET status = 'applied', decided_at = ?, result_json = ? WHERE id = ?")
          .run(decidedAt, JSON.stringify({ output: result.value }), row.id);
      }
      this.d.log.record({
        actorKind: "user",
        actorId: actor.id,
        runId: row.run_id,
        category: "agent",
        action: "proposal.apply",
        objectKind: target.kind,
        objectId: target.targetId,
        objectLabel: target.title,
        summaryKey: "log.proposal.apply",
        summaryParams: { title: preview.title, commandId: row.command_id, proposalId: row.id, origin: "Agent 提出、用户确认" },
        outcome: "ok",
      });
      this.d.notify?.("proposal.changed", { sessionId: row.session_id, runId: row.run_id, projectId: row.project_id, proposalId: row.id, status: this.getCard(row.id).status });
      return { proposal: this.getCard(row.id), output: result.value };
    }

    const err: NonNullable<CommandResult["error"]> = result.error ?? { code: "EXECUTION_FAILED", message: "proposal execution failed", retryable: false, details: {} };
    const status = err.code === "PROPOSAL_STALE" ? "stale" : "failed";
    this.sqlite.prepare("UPDATE agent_proposals SET status = ?, decided_at = ?, result_json = ? WHERE id = ?")
      .run(status, decidedAt, JSON.stringify({ error: err, ...(status === "stale" ? { reason: err.message, code: err.details.reason } : {}) }), row.id);
    this.d.log.record({
      actorKind: "user",
      actorId: actor.id,
      runId: row.run_id,
      category: "agent",
      action: "proposal.apply",
      objectKind: target.kind,
      objectId: target.targetId,
      objectLabel: target.title,
      summaryKey: "log.proposal.apply",
      summaryParams: { title: preview.title, commandId: row.command_id, proposalId: row.id, origin: "Agent 提出、用户确认" },
      outcome: "error",
      errorCode: err.code,
    });
    this.d.notify?.("proposal.changed", { sessionId: row.session_id, runId: row.run_id, projectId: row.project_id, proposalId: row.id, status });
    throw new MangaError(err.code as ErrorCode, err.message, { details: err.details });
  }

  reject(input: { proposalId: string; note?: string }): { proposal: ProposalCard } {
    const row = this.sqlite.prepare("SELECT * FROM agent_proposals WHERE id = ?").get(input.proposalId) as ProposalRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the proposal does not exist");
    if (row.status === "stale") {
      const res = parseJsonObject(row.result_json);
      throw new MangaError("PROPOSAL_STALE", String(res?.reason ?? "目标已被改动或删除，提议已失效"), { details: { proposalId: row.id, status: row.status } });
    }
    if (row.status !== "pending") {
      throw new MangaError("PROPOSAL_DECIDED", "该提议已处理，不能重复拒绝", { details: { proposalId: row.id, status: row.status } });
    }
    const now = new Date().toISOString();
    const resultJson = JSON.stringify({ ...(input.note?.trim() ? { note: input.note.trim() } : {}) });
    const taken = this.sqlite.prepare("UPDATE agent_proposals SET status = 'rejected', decided_at = ?, result_json = ? WHERE id = ? AND status = 'pending'")
      .run(now, resultJson, row.id);
    if (taken.changes !== 1) {
      throw new MangaError("PROPOSAL_DECIDED", "该提议已处理，不能重复拒绝", { details: { proposalId: row.id } });
    }
    this.d.notify?.("proposal.changed", { sessionId: row.session_id, runId: row.run_id, projectId: row.project_id, proposalId: row.id, status: "rejected" });
    return { proposal: this.getCard(row.id) };
  }

  private isModuleEnabled(row: ProposalRow): boolean {
    const target = parseJsonObject(row.target_json) as ProposalTarget | null;
    const mod = target?.kind ? MODULE_CHECKS[target.kind] : undefined;
    try {
      if (mod) this.d.requireModule(mod.commandId, mod.label);
      this.d.requireModule(row.command_id, row.command_id);
      return true;
    } catch (error) {
      if (error instanceof MangaError && error.code === "CAPABILITY_UNAVAILABLE") return false;
      throw error;
    }
  }

  private failDisabledModule(row: ProposalRow, now: string, kept: Record<string, unknown> = {}, exportId?: string): void {
    const error = {
      code: "CAPABILITY_UNAVAILABLE",
      message: "模块已关闭",
      retryable: false,
      details: { reason: "module-disabled" },
    };
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM command_requests WHERE idempotency_key = ? AND command_id = ?").run(row.id, row.command_id);
      this.sqlite.prepare("UPDATE agent_proposals SET status = 'failed', decided_at = COALESCE(decided_at, ?), result_json = ? WHERE id = ?")
        .run(now, JSON.stringify({ ...kept, reason: "模块已关闭", error, recovered: true }), row.id);
    })();
    if (row.kind === "exportRoughcut") {
      this.d.roughcuts.recover();
      if (exportId) {
        try {
          const settled = this.d.roughcuts.exports.get(exportId);
          this.sqlite.prepare("UPDATE agent_proposals SET result_json = ? WHERE id = ?")
            .run(JSON.stringify({ ...kept, output: { export: settled }, reason: "模块已关闭", error, recovered: true }), row.id);
        } catch { /* export row absent */ }
      }
    }
    this.d.notify?.("proposal.changed", { sessionId: row.session_id, runId: row.run_id, projectId: row.project_id, proposalId: row.id, status: "failed" });
  }

  /**
   * Startup recovery (`MangaProductApp.start`): any proposal left in `applying` checks whether the owner command committed an
   * `operations` receipt under the proposal id. A `command_requests` row alone only means the command was started, so it is not
   * evidence that it finished. A completed receipt settles the proposal as `applied` without running a second time; if the owning
   * module is disabled on startup and the work did not finish before shutdown, the proposal settles to terminal `failed`
   * ("模块已关闭", LOOP-33) so re-enabling the module later never executes it; anything else returns to `pending`.
   */
  recover(): { applied: number; reverted: number; failed?: number } {
    const rows = this.sqlite.prepare("SELECT * FROM agent_proposals WHERE status = 'applying'").all() as ProposalRow[];
    let applied = 0;
    let reverted = 0;
    let failed = 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      const moduleEnabled = this.isModuleEnabled(row);
      let op = this.d.store.loadIdempotent(row.id);
      let receipt = this.sqlite.prepare("SELECT command_id FROM operations WHERE idempotency_key = ?").get(row.id) as { command_id: string } | undefined;
      const existing = parseJsonObject(row.result_json) ?? {};
      const intent = existing._exportIntent as (ExportFileIntent & { output: Record<string, unknown> }) | undefined;
      if (!receipt && row.kind === "exportProject" && intent) {
        const finalPath = path.resolve(intent.finalPath);
        const temporaryPath = path.resolve(intent.temporaryPath);
        const sameFolder = path.dirname(finalPath) === path.dirname(temporaryPath);
        if (sameFolder && path.basename(temporaryPath).startsWith(".manga-export-") && path.basename(temporaryPath).endsWith(".part")) {
          let published = false;
          try {
            const stat = fs.lstatSync(finalPath);
            published = stat.isFile() && !stat.isSymbolicLink() && stat.size === intent.bytes
              && createHash("sha256").update(fs.readFileSync(finalPath)).digest("hex") === intent.sha256;
          } catch { /* No complete output: an interrupted write remains pending. */ }
          if (published) {
            this.recordReceipt(row, intent.output);
            op = this.d.store.loadIdempotent(row.id);
            receipt = { command_id: row.command_id };
          }
          fs.rmSync(temporaryPath, { force: true });
        }
      }
      if (op?.status === "ok" && receipt?.command_id === row.command_id) {
        if (row.kind === "exportRoughcut") {
          const view = (op.value as { export?: RoughcutExportView } | undefined)?.export;
          if (view) {
            let latest: RoughcutExportView | undefined;
            try { latest = this.d.roughcuts.exports.get(view.id); } catch { latest = undefined; }
            if (!moduleEnabled && latest?.state !== "done") {
              const { _exportIntent: _privateIntent, ...kept } = existing;
              this.failDisabledModule(row, now, kept, view.id);
              failed += 1;
              continue;
            }
            if (!latest) {
              const error = { code: "INTERRUPTED", message: "粗剪导出记录已不存在，请让 Agent 重新提出" };
              this.sqlite.prepare("UPDATE agent_proposals SET status = 'failed', decided_at = COALESCE(decided_at, ?), result_json = ? WHERE id = ?")
                .run(now, JSON.stringify({ output: op.value, error, recovered: true }), row.id);
              this.d.notify?.("proposal.changed", { sessionId: row.session_id, runId: row.run_id, projectId: row.project_id, proposalId: row.id, status: "failed" });
              failed += 1;
              continue;
            }
            if (latest.state === "planned" || latest.state === "running") {
              this.d.roughcuts.recover();
              try { latest = this.d.roughcuts.exports.get(view.id); } catch { latest = undefined; }
            }
            this.sqlite.prepare("UPDATE agent_proposals SET result_json = ? WHERE id = ?").run(JSON.stringify({ output: op.value, recovered: true }), row.id);
            if (latest) this.onRoughcutExport(latest);
            const settled = (this.sqlite.prepare("SELECT status FROM agent_proposals WHERE id = ?").get(row.id) as { status: ProposalStatus } | undefined)?.status;
            if (settled === "applied") applied += 1;
            else failed += 1;
            continue;
          }
        }
        const { _exportIntent: _privateIntent, ...kept } = existing;
        this.sqlite.prepare("UPDATE agent_proposals SET status = 'applied', decided_at = COALESCE(decided_at, ?), result_json = ? WHERE id = ?")
          .run(now, JSON.stringify({ ...kept, output: op.value ?? { recovered: true }, recovered: true }), row.id);
        applied += 1;
      } else if (!moduleEnabled) {
        const { _exportIntent: _privateIntent, ...kept } = existing;
        this.failDisabledModule(row, now, kept);
        failed += 1;
      } else {
        this.sqlite.transaction(() => {
          // A request without a committed effect may be confirmed after restart with a new host path handle.
          this.sqlite.prepare("DELETE FROM command_requests WHERE idempotency_key = ? AND command_id = ?").run(row.id, row.command_id);
          this.sqlite.prepare("UPDATE agent_proposals SET status = 'pending', decided_at = NULL, result_json = NULL WHERE id = ?").run(row.id);
        })();
        reverted += 1;
      }
    }
    return failed > 0 ? { applied, reverted, failed } : { applied, reverted };
  }

  /**
   * Prepares the concise one-time summary of proposals decided since the last turn in `sessionId`, and returns the mutations that mark
   * them as reported for `runId` so subsequent runs in the same session never carry them again (计划 4.3).
   */
  consumeUnreportedDecisions(sessionId: string, runId: string, maxTokens = Number.POSITIVE_INFINITY): { summaryText: string | null; mutations: Mutation[] } {
    const allRows = this.sqlite.prepare("SELECT * FROM agent_proposals WHERE session_id = ? ORDER BY created_at ASC, rowid ASC").all(sessionId) as ProposalRow[];
    this.refreshRows(allRows);
    const decided = this.sqlite.prepare(`
      SELECT * FROM agent_proposals
      WHERE session_id = ? AND status IN ('applied', 'failed', 'rejected', 'stale')
      ORDER BY COALESCE(decided_at, created_at) ASC, rowid ASC
    `).all(sessionId) as ProposalRow[];

    const lines: string[] = [];
    const mutations: Mutation[] = [];
    const header = "上次以来待审提议的结果（不要自动重试已被用户拒绝的提议；已失效的提议若仍需要请先读取最新状态）：";
    for (const row of decided) {
      const res = parseJsonObject(row.result_json) ?? {};
      if (res.reportedRunId) continue;
      const preview = JSON.parse(row.preview_json) as ProposalPreview;
      let statusLine = "";
      if (row.status === "applied") {
        statusLine = "用户已确认执行";
      } else if (row.status === "rejected") {
        statusLine = res.note ? `用户已拒绝（备注：${[...String(res.note)].slice(0, 120).join("")}）` : "用户已拒绝";
      } else if (row.status === "stale") {
        statusLine = `已失效（${String(res.reason ?? "目标已变化")}）`;
      } else if (row.status === "failed") {
        statusLine = `执行失败（${decisionFailureReason(res.error as { code?: string } | undefined)}）`;
      }
      const line = `- [${row.kind}] ${[...preview.title].slice(0, 160).join("")}：${statusLine}`;
      if (estimateTokens(`${header}\n${[...lines, line].join("\n")}`) > maxTokens) break;
      lines.push(line);
      mutations.push({
        sql: "UPDATE agent_proposals SET result_json = ? WHERE id = ?",
        params: [JSON.stringify({ ...res, reportedRunId: runId }), row.id],
      });
    }

    if (!lines.length) return { summaryText: null, mutations: [] };
    return {
      summaryText: `${header}\n${lines.join("\n")}`,
      mutations,
    };
  }
}
