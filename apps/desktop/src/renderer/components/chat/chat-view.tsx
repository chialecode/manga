import { useState, type ReactNode } from "react";
import { useChat, type ChatDeps } from "../../hooks/use-chat.ts";
import type { RecorderHandle } from "../../voice/use-recorder.ts";
import type { StreamNote, StreamVoice } from "../../hooks/use-session-stream.ts";
import type { ComposerProps } from "./composer.tsx";
import { ChatPane } from "./chat-pane.tsx";
import { Capsule } from "./capsule.tsx";
import { MaterialsDialog } from "./materials-dialog.tsx";

export type ChatViewProps = ChatDeps & {
  formatDate: (value: string) => string;
  /** The recording hook, when the voice module is on; the microphone is absent otherwise. */
  recorder: RecorderHandle | null;
  noModel: boolean;
  onSettings: () => void;
  onStop: () => void;
  onRetry: (runId: string) => void;
  /** Whether online search can be offered for the next task (the metadata module). */
  online: boolean;
  resources: Array<{ id: string; title: string }>;
  /** The open resource whose recordings can be taken along, when the voice module is on. */
  recordingsOf?: string | null;
  onAttach: (what: "page" | "frame") => void;
  onJumpNote: (note: StreamNote) => void;
  onJumpVoice: (voice: StreamVoice, source?: StreamVoice["sources"][number]) => void;
  onOpenRecording: (voice: StreamVoice) => void;
  empty: ReactNode;
  wide?: boolean;
  header?: ReactNode;
};

/**
 * The conversation as the right pane and the chat page show it: the message list, the input with its tags, quick tasks and "+" menu,
 * and the capsule that stands in for the pane when it is folded away. One place builds the three from the same `useChat`, so the
 * pane, the page and the capsule can never disagree about what a note or a question does.
 */
export function useChatView(props: ChatViewProps) {
  const { i18n, composer, recorder } = props;
  const t = i18n.t;
  const chat = useChat(props);
  const [materials, setMaterials] = useState(false);
  const context = chat.context;

  const mic: ComposerProps["mic"] = recorder
    ? {
      t,
      state: recorder.state,
      enabled: true,
      toggleKey: recorder.settings.toggleKey,
      onToggle: recorder.toggle,
      onHoldStart: () => { void recorder.begin("hold"); },
      onHoldEnd: recorder.endHold,
      onStop: () => { void recorder.stop("user"); },
    }
    : null;

  const attach: "page" | "frame" | null = context?.kind === "comic" ? "page" : context?.kind === "video" ? "frame" : null;
  const composerProps: ComposerProps = {
    t,
    value: composer.draft,
    onChange: (value) => props.patchComposer({ draft: value }),
    mode: chat.mode,
    onMode: chat.setMode,
    canNote: chat.noteable,
    tags: chat.tags,
    images: composer.images,
    onRemoveTag: chat.removeTag,
    onRemoveImage: chat.removeImage,
    quick: chat.quick,
    onQuick: (task) => { void chat.runQuick(task); },
    noModel: props.noModel,
    onSettings: props.onSettings,
    running: props.running,
    onStop: props.onStop,
    onSend: () => { void chat.send(); },
    sending: chat.sending,
    plus: { attach, online: props.online, subtitle: context?.kind === "video", allowOnline: composer.allowOnline, subtitleAheadMin: composer.subtitleAheadMin, materials: composer.materials.length + composer.noteMaterials.length + composer.recordings.length },
    onAttach: props.onAttach,
    onToggleOnline: () => props.updateComposer((current) => ({ allowOnline: !current.allowOnline })),
    onSubtitleAhead: (minutes) => props.patchComposer({ subtitleAheadMin: minutes }),
    onMaterials: () => setMaterials(true),
    mic,
  };

  const pane = (
    <>
      <ChatPane
        t={t}
        stream={chat.stream}
        formatDate={props.formatDate}
        wide={props.wide}
        header={props.header}
        empty={props.empty}
        composer={composerProps}
        actions={{
          onJumpNote: props.onJumpNote,
          onJumpVoice: props.onJumpVoice,
          onEditNote: (note, text) => chat.editNote(note.id, text),
          onDeleteNote: (note) => chat.deleteNote(note.id),
          onQuoteNote: (note) => chat.quoteNote(note),
          onOpenRecording: props.onOpenRecording,
          onRetry: props.onRetry,
        }}
      />
      {materials ? (
        <MaterialsDialog
          t={t}
          resources={props.resources}
          materials={composer.materials}
          noteMaterials={composer.noteMaterials}
          onMaterials={(ids) => props.patchComposer({ materials: ids })}
          onNoteMaterials={(ids) => props.patchComposer({ noteMaterials: ids })}
          recordingsOf={props.recordingsOf}
          recordings={composer.recordings}
          onRecordings={(ids) => props.patchComposer({ recordings: ids })}
          formatDate={props.formatDate}
          onClose={() => setMaterials(false)}
        />
      ) : null}
    </>
  );

  const capsule = <Capsule t={t} mic={mic} tagLabel={chat.tags[0]?.label} onNote={chat.noteable ? chat.sendNote : undefined} />;
  return { chat, pane, capsule };
}
