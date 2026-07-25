import { useEffect, useState } from "react";
import { CircleNotch, PencilSimple } from "@phosphor-icons/react";

function normalizeTitle(value) {
  return value.trim().replace(/\s+/g, " ");
}

export function RenameConversationDialog({
  conversation,
  onClose,
  onConfirm,
}) {
  const [title, setTitle] = useState(conversation?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTitle(conversation?.title ?? "");
    setBusy(false);
    setError("");
  }, [conversation?.id, conversation?.title]);

  useEffect(() => {
    if (!conversation) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose?.();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, conversation, onClose]);

  if (!conversation) return null;
  const normalizedTitle = normalizeTitle(title);
  const unchanged = normalizedTitle === normalizeTitle(conversation.title ?? "");

  const confirmRename = async (event) => {
    event.preventDefault();
    if (busy || !normalizedTitle || unchanged) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm?.(conversation, normalizedTitle);
      onClose?.();
    } catch (nextError) {
      setError(nextError?.message || "重命名失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (!busy) onClose?.();
  };

  return (
    <div className="modal-backdrop conversation-rename-backdrop" role="presentation" onMouseDown={close}>
      <form
        className="conversation-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversation-rename-title"
        onSubmit={confirmRename}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <PencilSimple size={19} weight="regular" aria-hidden="true" />
          </span>
          <div>
            <h2 id="conversation-rename-title">重命名工作会话</h2>
            <p>使用清晰的名称区分同一项目中的不同任务。</p>
          </div>
        </header>

        <label htmlFor="conversation-name">
          <span>会话名称</span>
          <input
            id="conversation-name"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={80}
            disabled={busy}
            autoFocus
          />
          <small>{title.length}/80</small>
        </label>
        {error ? <p className="conversation-rename-error" role="alert">{error}</p> : null}

        <footer>
          <button type="button" onClick={close} disabled={busy}>取消</button>
          <button
            className="is-primary"
            type="submit"
            disabled={busy || !normalizedTitle || unchanged}
            aria-busy={busy}
          >
            {busy ? (
              <>
                <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />
                正在保存…
              </>
            ) : "保存名称"}
          </button>
        </footer>
      </form>
    </div>
  );
}
