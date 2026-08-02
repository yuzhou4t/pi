import { useEffect, useState } from "react";
import { CircleNotch, Trash } from "@phosphor-icons/react";

export function DeleteTopicConversationDialog({
  topicConversation,
  onClose,
  onConfirm,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setBusy(false);
    setError("");
  }, [topicConversation?.id]);

  useEffect(() => {
    if (!topicConversation) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose?.();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, topicConversation, onClose]);

  if (!topicConversation) return null;

  const confirmDelete = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm?.(topicConversation);
      onClose?.();
    } catch (nextError) {
      setError(nextError?.message || "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (!busy) onClose?.();
  };

  return (
    <div className="modal-backdrop conversation-delete-backdrop" role="presentation" onMouseDown={close}>
      <section
        className="conversation-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="topic-delete-title"
        aria-describedby="topic-delete-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <Trash size={19} weight="regular" aria-hidden="true" />
          </span>
          <div>
            <h2 id="topic-delete-title">删除这个检索会话？</h2>
            <p id="topic-delete-description">
              “{topicConversation.title || "未命名检索"}”的检索提问和推荐记录将被删除。
            </p>
          </div>
        </header>

        <p className="conversation-delete-note">
          此操作不可恢复。已加入「本月推荐」的论文不受影响，会继续留在每月追踪里。
        </p>
        {error ? <p className="conversation-delete-error" role="alert">{error}</p> : null}

        <footer>
          <button type="button" onClick={close} disabled={busy} autoFocus>取消</button>
          <button
            className="is-danger"
            type="button"
            onClick={confirmDelete}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? (
              <>
                <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />
                正在删除…
              </>
            ) : (
              <>
                <Trash size={15} weight="regular" aria-hidden="true" />
                删除检索会话
              </>
            )}
          </button>
        </footer>
      </section>
    </div>
  );
}
