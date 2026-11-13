import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { registerCodeMirrorView } from "./voice/editable-target.ts";

export function SourceEditor(props: { blockId: string; text: string; onBeforeStep?: () => void; onChange: (text: string) => void; onComposition: (active: boolean) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const initialText = useRef(props.text);
  initialText.current = props.text;
  const onChange = useRef(props.onChange);
  const onComposition = useRef(props.onComposition);
  const onBeforeStep = useRef(props.onBeforeStep);
  onChange.current = props.onChange;
  onComposition.current = props.onComposition;
  onBeforeStep.current = props.onBeforeStep;
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!host.current) return;
    let bridge: ReturnType<typeof registerCodeMirrorView> | null = null;
    const created = new EditorView({
      state: EditorState.create({
        doc: initialText.current,
        // Undo stays on the shared document history, so CodeMirror gets no history of its own.
        extensions: [
          keymap.of([...defaultKeymap]),
          EditorView.updateListener.of((update) => {
            bridge?.onUpdate(update);
            if (update.docChanged) onChange.current(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            compositionstart: () => { onComposition.current(true); return false; },
            compositionend: () => { onComposition.current(false); return false; },
          }),
        ],
      }),
      parent: host.current,
    });
    bridge = registerCodeMirrorView(created, { onBeforeStep: () => onBeforeStep.current?.() });
    view.current = created;
    return () => { bridge?.unregister(); created.destroy(); view.current = null; };
    // The view is rebuilt per block so an external change never writes into another block's buffer.
  }, [props.blockId]);
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    if (instance.state.doc.toString() !== props.text) {
      instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: props.text } });
    }
  }, [props.text]);
  return <div ref={host} data-testid="note-source" data-block-id={props.blockId} className="mt-2 border border-[var(--color-border)] rounded" />;
}
