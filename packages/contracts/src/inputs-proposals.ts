import { z } from "zod";
import { RoughcutAction, RoughcutOptions } from "./inputs-roughcut.ts";

export const PROPOSAL_KINDS = ["delete", "rename", "exportProject", "editRoughcut", "exportRoughcut"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = ["pending", "applying", "applied", "failed", "rejected", "stale"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_TARGET_KINDS = ["whiteboard", "mindmap", "draft", "roughcut", "project"] as const;
export type ProposalTargetKind = (typeof PROPOSAL_TARGET_KINDS)[number];

export type ProposalTarget = {
  kind: ProposalTargetKind;
  targetId: string;
  title: string;
  revision: string;
};

export type ProposalPreview = {
  /** Card title shown in the chat bubble (e.g. `删除白板《分镜草图》`). */
  title: string;
  /** Primary scale/impact line (e.g. `12 张卡片、8 条连线`). */
  summary: string;
  /** Structured detail lines (steps, clip diffs, backlinks, warnings). */
  lines: string[];
  /** Non-blocking warnings (e.g. duplicate name, keyframe shift, backlinks). */
  warnings: string[];
  /** Whether the operation is irreversible (`true` for `delete`). */
  irreversible: boolean;
  /** Extra structured facts for specialized previews (backlink count, clip counts, package bytes, etc.). */
  meta?: Record<string, unknown>;
};

export type ProposalCard = {
  id: string;
  sessionId: string;
  runId: string;
  projectId: string;
  kind: ProposalKind;
  target: ProposalTarget;
  commandId: string;
  preview: ProposalPreview;
  reason: string | null;
  status: ProposalStatus;
  result: Record<string, unknown> | null;
  createdAt: string;
  decidedAt: string | null;
};

export const ProposalDeleteSchema = z.object({
  kind: z.enum(["whiteboard", "mindmap", "draft", "roughcut"]),
  targetId: z.string().min(1).max(256),
  reason: z.string().max(500).optional(),
}).strict();

export const ProposalRenameSchema = z.object({
  kind: z.enum(PROPOSAL_TARGET_KINDS),
  targetId: z.string().min(1).max(256).optional(),
  title: z.string().trim().min(1).max(200),
  reason: z.string().max(500).optional(),
}).strict();

export const ProposalExportProjectSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();

export const ProposalEditRoughcutSchema = z.object({
  cutId: z.string().min(1).max(256),
  label: z.string().max(80).optional(),
  actions: z.array(RoughcutAction).min(1).max(200),
  reason: z.string().max(500).optional(),
}).strict();

export const ProposalExportRoughcutSchema = z.object({
  cutId: z.string().min(1).max(256),
  fileName: z.string().trim().min(1).max(120).optional(),
  options: RoughcutOptions.optional(),
  reason: z.string().max(500).optional(),
}).strict();

export const ProposalApplySchema = z.object({
  proposalId: z.string().min(1).max(256),
  pathHandle: z.string().min(1).max(256).optional(),
}).strict();

export const ProposalRejectSchema = z.object({
  proposalId: z.string().min(1).max(256),
  note: z.string().max(500).optional(),
}).strict();

export const ProposalListSchema = z.object({
  sessionId: z.string().min(1).max(256).optional(),
  runId: z.string().min(1).max(256).optional(),
  projectId: z.string().min(1).max(256).optional(),
  status: z.enum(PROPOSAL_STATUSES).optional(),
}).strict();

export const ProposalCommandInputs = {
  "proposal.delete": ProposalDeleteSchema,
  "proposal.rename": ProposalRenameSchema,
  "proposal.exportProject": ProposalExportProjectSchema,
  "proposal.editRoughcut": ProposalEditRoughcutSchema,
  "proposal.exportRoughcut": ProposalExportRoughcutSchema,
  "proposal.apply": ProposalApplySchema,
  "proposal.reject": ProposalRejectSchema,
  "proposal.list": ProposalListSchema,
};
