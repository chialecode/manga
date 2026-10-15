import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Text from "@tiptap/extension-text";
import { Node, mergeAttributes } from "@tiptap/core";
import { history, redo, undo } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import { contentOf, type Range } from "./draft-model.ts";

const DraftBlock = Node.create({
  name: "draftBlock",
  group: "block",
  content: "text*",
  parseHTML: () => [{ tag: "p" }],
  renderHTML: ({ HTMLAttributes }) => ["p", mergeAttributes(HTMLAttributes), 0],
});

const DraftDocument = Document.extend({
  content: "draftBlock+",
  addProseMirrorPlugins() {
    return [history(), keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo })];
  },
});

type PmDoc = { forEach: (fn: (node: { textContent: string; content: { size: number } }, pos: number) => void) => void };
export const textOf = (doc: PmDoc): string => {
  const lines: string[] = [];
  doc.forEach((node) => lines.push(node.textContent));
  return lines.join("\n");
};

/** The selection as offsets into the draft's text (paragraphs joined by one line break), or `null` when nothing is selected. */
export function selectedRange(doc: PmDoc, selection: { from: number; to: number; empty: boolean }): Range | null {
  if (selection.empty) return null;
  let offset = 0;
  let start = -1;
  let end = -1;
  doc.forEach((node, pos) => {
    const inner = pos + 1;
    const length = node.content.size;
    if (start < 0 && selection.from >= inner && selection.from <= inner + length) start = offset + (selection.from - inner);
    if (end < 0 && selection.to >= inner && selection.to <= inner + length) end = offset + (selection.to - inner);
    offset += length + 1;
  });
  const total = offset - 1;
  // A selection that begins or ends between paragraphs (select all) runs to that end of the text.
  if (start < 0) start = 0;
  if (end < 0) end = total;
  return end > start ? { start, end } : null;
}

/**
 * The text of a draft as paragraphs. `epoch` changes when the text was replaced from outside (a suggestion taken, a version restored); an
 * ordinary edit only reports itself, so typing is never overwritten by what the page has already saved.
 */
export function DraftEditor(props: { text: string; epoch: number; label: string; onChange: (text: string) => void; onSelection: (range: Range | null) => void }) {
  const change = useRef(props.onChange);
  const selection = useRef(props.onSelection);
  change.current = props.onChange;
  selection.current = props.onSelection;
  const editor = useEditor({
    extensions: [DraftDocument, DraftBlock, Text],
    content: contentOf(props.text),
    editorProps: { attributes: { "data-testid": "draft-surface", role: "textbox", "aria-multiline": "true", "aria-label": props.label, class: "draft-surface" } },
    onUpdate: ({ editor: instance }) => change.current(textOf(instance.state.doc)),
    onSelectionUpdate: ({ editor: instance }) => selection.current(selectedRange(instance.state.doc, instance.state.selection)),
  });
  const shown = useRef(props.epoch);
  useEffect(() => {
    if (!editor || editor.isDestroyed || shown.current === props.epoch) return;
    shown.current = props.epoch;
    editor.commands.setContent(contentOf(props.text), { emitUpdate: false });
    selection.current(null);
  }, [editor, props.epoch, props.text]);
  return <EditorContent editor={editor} className="draft-editor" />;
}
