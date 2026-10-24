import { RecordsPage } from "../../pages/settings/records-page.tsx";
import { str } from "../model.ts";
import { useServices } from "../services.tsx";
import { useTabEnv } from "../tab-env.tsx";

/**
 * The management tab of the conversations or of the notes with the recordings (A-101, A-102, 交互设计 2.10): the sidebar's "对话管理" and "笔记管理" open it,
 * and a work's page opens the records of that work in it. It lists what the context holds and what the other contexts hold alike; the filters and the
 * paging are the records list's own.
 */
export function RecordsTab() {
  const env = useTabEnv();
  const s = useServices();
  const scope = str(env.model?.target.type) === "conversation" ? "conversation" : "notes";
  return (
    <div className="records-tab" data-testid="records-tab" data-type={scope === "conversation" ? "conversation" : "note"}>
      <div className="settings-view" data-testid="page-records">
        <RecordsPage
          t={s.t}
          formatDate={s.i18n.formatDate}
          scope={scope}
          initialWorkId={str(env.model?.target.workId) || null}
          onOpenNote={(objectId) => s.open.note(objectId)}
          onOpenNoteSource={(objectId) => void s.open.noteSource(objectId)}
          onOpenRecording={(sessionId, workId) => s.reviewRecording({ sessionId, ...(workId ? { workId } : {}) })}
          onError={(message) => s.setError(message)}
          onNotice={s.setNotice}
        />
      </div>
    </div>
  );
}
