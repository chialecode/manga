export type NoteBlock = {
  id: string;
  type: "paragraph" | "quote" | "embed";
  text: string;
  sourceObjectId?: string;
  targetId?: string;
  targetKind?: "object" | "anchor";
};

export type NoteDocument = {
  id: string;
  revision: number;
  title: string;
  blocks: NoteBlock[];
};

export type LayoutInstance = {
  instanceId: string;
  sourceObjectId: string;
  x: number;
  y: number;
};

export type EditorState = {
  document: NoteDocument;
  layout: LayoutInstance[];
  selection?: { blockId: string; start: number; end: number };
  composing: boolean;
  undo: NoteDocument[];
  redo: NoteDocument[];
};

export function createEditor(document: NoteDocument): EditorState {
  return {
    document,
    layout: [],
    composing: false,
    undo: [],
    redo: [],
  };
}

function cloneDoc(document: NoteDocument): NoteDocument {
  return structuredClone(document);
}

export function applyEdit(state: EditorState, mutate: (document: NoteDocument) => void): EditorState {
  if (state.composing) {
    mutate(state.document);
    return state;
  }
  state.undo.push(cloneDoc(state.document));
  state.redo = [];
  mutate(state.document);
  state.document.revision += 1;
  return state;
}

export function undo(state: EditorState): EditorState {
  const previous = state.undo.pop();
  if (!previous) return state;
  state.redo.push(cloneDoc(state.document));
  state.document = previous;
  return state;
}

export function redo(state: EditorState): EditorState {
  const next = state.redo.pop();
  if (!next) return state;
  state.undo.push(cloneDoc(state.document));
  state.document = next;
  return state;
}

export function splitBlock(document: NoteDocument, blockId: string, offset: number): string {
  const index = document.blocks.findIndex((block) => block.id === blockId);
  if (index < 0) throw new Error("block missing");
  const block = document.blocks[index]!;
  const point = Math.max(0, Math.min(offset, [...block.text].length));
  const chars = [...block.text];
  const rightId = `${block.id}:split:${document.revision}:${index + 1}`;
  block.text = chars.slice(0, point).join("");
  document.blocks.splice(index + 1, 0, {
    id: rightId,
    type: block.type,
    text: chars.slice(point).join(""),
  });
  return rightId;
}

export function mergeBlockWithNext(document: NoteDocument, blockId: string): void {
  const index = document.blocks.findIndex((block) => block.id === blockId);
  const next = index >= 0 ? document.blocks[index + 1] : undefined;
  if (index < 0 || !next) throw new Error("cannot merge");
  document.blocks[index]!.text += next.text;
  document.blocks.splice(index + 1, 1);
}

export function startComposition(state: EditorState): void {
  state.composing = true;
}

export function endComposition(state: EditorState): void {
  state.composing = false;
  state.document.revision += 1;
}

export function shouldSubmitEnter(state: EditorState): boolean {
  return !state.composing;
}

export function moveInstance(state: EditorState, instanceId: string, x: number, y: number): void {
  const instance = state.layout.find((item) => item.instanceId === instanceId);
  if (instance) {
    instance.x = x;
    instance.y = y;
  }
}

export function embedStatus(graph: Record<string, string[]>, from: string, to: string): "ok" | "cycle" | "missing" {
  if (!(to in graph) && graph[to] === undefined) {
    const known = new Set([...Object.keys(graph), ...Object.values(graph).flat()]);
    if (!known.has(to)) return "missing";
  }
  const visiting = new Set<string>();
  const walk = (node: string): boolean => {
    if (node === from) return true;
    if (visiting.has(node)) return false;
    visiting.add(node);
    for (const next of graph[node] ?? []) {
      if (walk(next)) return true;
    }
    visiting.delete(node);
    return false;
  };
  if (walk(to)) return "cycle";
  return "ok";
}
