export type ObjectScope =
  | { kind: "library" }
  | { kind: "project"; projectId: string };

export type ContentObject<TPayload = unknown> = {
  id: string;
  type: string;
  ownerModuleId: string;
  scope: ObjectScope;
  schemaVersion: number;
  revision: number;
  title: string;
  payload: TPayload;
  attachmentIds: string[];
  preview: { text?: string; thumbnailAttachmentId?: string };
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type ResourceRecord = {
  id: string;
  workId?: string;
  kind: "novel" | "comic" | "video" | "audio" | "web" | "file";
  title: string;
  aliases: string[];
  createdAt: string;
};

export type ResourceRevisionRecord = {
  id: string;
  resourceId: string;
  fingerprint: string;
  parserVersion: string;
  createdAt: string;
};
