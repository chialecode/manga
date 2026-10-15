import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { BookOpen, Clapperboard, ExternalLink, FileText, Frame, Mic, Network, PenLine, Quote, Scissors, StickyNote } from "lucide-react";
import type { Translator } from "@manga/i18n";
import type { FlowNode, WbRef } from "./whiteboard-model.ts";

type T = Translator["t"];

export type OpenTarget = { kind: string; targetId: string; label: string; opens?: WbRef["opens"] };

/** What the nodes may ask of the board they sit on. The value is stable between renders so a drag does not draw every node again. */
export type BoardActions = {
  t: T;
  /** The node whose text is being edited, if any. */
  editId: string | null;
  edit: (id: string | null) => void;
  update: (id: string, data: Record<string, unknown>) => void;
  resize: (id: string, rect: { x: number; y: number; width: number; height: number }) => void;
  open: (target: OpenTarget) => void;
};
export const BoardContext = createContext<BoardActions | null>(null);
const useBoard = (): BoardActions => {
  const value = useContext(BoardContext);
  if (!value) throw new Error("a board node was drawn outside its board");
  return value;
};

const REF_ICON: Record<string, ReactNode> = {
  work: <BookOpen size={14} aria-hidden="true" />, resource: <FileText size={14} aria-hidden="true" />, anchor: <Quote size={14} aria-hidden="true" />,
  note: <StickyNote size={14} aria-hidden="true" />, recording: <Mic size={14} aria-hidden="true" />, excerpt: <Quote size={14} aria-hidden="true" />,
  whiteboard: <Frame size={14} aria-hidden="true" />, mindmap: <Network size={14} aria-hidden="true" />, draft: <PenLine size={14} aria-hidden="true" />, roughcut: <Scissors size={14} aria-hidden="true" />,
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const colorOf = (value: unknown): string => (typeof value === "string" && value ? value : "none");

/** Leaves an editor only when focus goes outside it, so moving from the title to the body of a card does not end the edit. */
function leaves(event: React.FocusEvent<HTMLElement>): boolean {
  const next = event.relatedTarget as Node | null;
  return !next || !event.currentTarget.contains(next);
}

function Resizer(props: { id: string; selected: boolean; min?: { w: number; h: number } }) {
  const board = useBoard();
  return <NodeResizer isVisible={props.selected} minWidth={props.min?.w ?? 120} minHeight={props.min?.h ?? 48} onResizeEnd={(_, rect) => board.resize(props.id, rect)} />;
}

function Handles() {
  return (<><Handle type="target" position={Position.Left} /><Handle type="source" position={Position.Right} /></>);
}

function CardNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const board = useBoard();
  const { t } = board;
  const stored = data.node.data;
  const editing = board.editId === id;
  const [title, setTitle] = useState(text(stored.title));
  const [body, setBody] = useState(text(stored.text));
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { setTitle(text(stored.title)); setBody(text(stored.text)); titleRef.current?.focus(); } }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = () => {
    board.edit(null);
    if (title !== text(stored.title) || body !== text(stored.text)) board.update(id, { title, text: body });
  };
  return (
    <div className={`wb-node wb-card wb-color-${colorOf(stored.color)}`} data-testid={`wb-node-${id}`} data-kind="card" onDoubleClick={() => board.edit(id)}>
      <Resizer id={id} selected={selected} />
      <Handles />
      {editing ? (
        <div className="wb-editor nodrag nowheel" onBlur={(event) => { if (leaves(event)) commit(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); board.edit(null); } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); } }}>
          <input ref={titleRef} data-testid={`wb-title-${id}`} value={title} placeholder={t("whiteboard.cardTitle")} aria-label={t("whiteboard.cardTitle")} onChange={(event) => setTitle(event.target.value)} />
          <textarea data-testid={`wb-body-${id}`} value={body} placeholder={t("whiteboard.cardText")} aria-label={t("whiteboard.cardText")} onChange={(event) => setBody(event.target.value)} />
        </div>
      ) : (
        <>
          <strong className="wb-card-title">{text(stored.title) || (!text(stored.text) ? t("whiteboard.cardPlaceholder") : "")}</strong>
          {text(stored.text) ? <p className="wb-card-text">{text(stored.text)}</p> : null}
        </>
      )}
    </div>
  );
}

function TextNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const board = useBoard();
  const { t } = board;
  const stored = text(data.node.data.text);
  const editing = board.editId === id;
  const [value, setValue] = useState(stored);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) { setValue(stored); area.current?.focus(); } }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => { board.edit(null); if (value !== stored) board.update(id, { text: value }); };
  return (
    <div className="wb-node wb-text" data-testid={`wb-node-${id}`} data-kind="text" onDoubleClick={() => board.edit(id)}>
      <Resizer id={id} selected={selected} min={{ w: 60, h: 28 }} />
      <Handles />
      {editing ? (
        <textarea ref={area} className="wb-editor nodrag nowheel" data-testid={`wb-body-${id}`} value={value} aria-label={t("whiteboard.addText")} placeholder={t("whiteboard.textPlaceholder")} onChange={(event) => setValue(event.target.value)} onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); board.edit(null); } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); } }} />
      ) : (
        <p className="wb-text-body">{stored || t("whiteboard.textPlaceholder")}</p>
      )}
    </div>
  );
}

function GroupNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const board = useBoard();
  const { t } = board;
  const stored = text(data.node.data.title);
  const editing = board.editId === id;
  const [value, setValue] = useState(stored);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { setValue(stored); input.current?.focus(); } }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => { board.edit(null); if (value !== stored) board.update(id, { title: value }); };
  return (
    <div className={`wb-node wb-group wb-color-${colorOf(data.node.data.color)}`} data-testid={`wb-node-${id}`} data-kind="group">
      <Resizer id={id} selected={selected} min={{ w: 160, h: 120 }} />
      <Handles />
      <div className="wb-group-head" onDoubleClick={() => board.edit(id)}>
        {editing ? (
          <input ref={input} className="nodrag" data-testid={`wb-title-${id}`} value={value} aria-label={t("whiteboard.groupTitle")} onChange={(event) => setValue(event.target.value)} onBlur={commit}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); board.edit(null); } else if (event.key === "Enter") { event.preventDefault(); commit(); } }} />
        ) : (
          <span>{stored || t("whiteboard.groupTitle")}</span>
        )}
      </div>
    </div>
  );
}

function RefNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const board = useBoard();
  const { t } = board;
  const stored = data.node.data;
  const kind = text(stored.refKind);
  const ref = data.ref;
  const state = ref?.state ?? "ok";
  const label = ref?.label || text(stored.label);
  const gone = state !== "ok";
  return (
    <div className={`wb-node wb-ref${gone ? " wb-ref-gone" : ""}`} data-testid={`wb-node-${id}`} data-kind="ref" data-ref-kind={kind} data-state={state}>
      <Resizer id={id} selected={selected} min={{ w: 160, h: 72 }} />
      <Handles />
      <div className="wb-ref-head">
        <span className="wb-ref-kind">{REF_ICON[kind] ?? <Clapperboard size={14} aria-hidden="true" />}{t(`whiteboard.ref.kind.${kind}` as never)}</span>
        {ref?.mode === "snapshot" ? <span className="chip">{t("whiteboard.ref.snapshotTag")}</span> : null}
        {!gone ? <button type="button" className="icon-button nodrag" data-testid={`wb-open-${id}`} aria-label={t("whiteboard.ref.open")} title={t("whiteboard.ref.open")} onClick={() => board.open({ kind, targetId: text(stored.targetId), label, ...(ref?.opens ? { opens: ref.opens } : {}) })}><ExternalLink size={14} /></button> : null}
      </div>
      <strong className="wb-ref-label">{label || t("embed.untitled")}</strong>
      {ref?.summary ? <p className="wb-ref-summary">{ref.summary}</p> : null}
      {gone ? <p className="wb-ref-state" data-testid={`wb-state-${id}`}>{t(`whiteboard.ref.state.${state}` as never)}</p> : null}
    </div>
  );
}

export const WHITEBOARD_NODE_TYPES = {
  card: memo(CardNodeView),
  text: memo(TextNodeView),
  group: memo(GroupNodeView),
  ref: memo(RefNodeView),
};
