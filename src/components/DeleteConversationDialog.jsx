import { useEffect, useState } from "react";
import { CircleNotch, Trash } from "@phosphor-icons/react";

export function DeleteConversationDialog({
  conversation,
  onClose,
  onConfirm,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setBusy(false);
    setError("");
  }, [conversation?.id]);

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
  const pendingChangeFileCount = Number(conversation.pendingChangeFileCount) || 0;
  const confirmationDisabled = conversation.checking
    || conversation.deleteBlocked
    || Boolean(conversation.checkError);

  const confirmDelete = async () => {
    if (busy || confirmationDisabled) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm?.(conversation);
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
        aria-labelledby="conversation-delete-title"
        aria-describedby="conversation-delete-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <Trash size={19} weight="regular" aria-hidden="true" />
          </span>
          <div>
            <h2 id="conversation-delete-title">删除工作会话？</h2>
            <p id="conversation-delete-description">
              “{conversation.title || "未命名会话"}”的对话、计划、运行记录和未应用修改草稿将被删除。
            </p>
          </div>
        </header>

        <p className="conversation-delete-note">
          {!conversation.checking && pendingChangeFileCount > 0 ? (
            <>
              其中包含 {pendingChangeFileCount} 个尚未应用的修改文件。
              <br />
            </>
          ) : null}
          此操作不可恢复，但不会删除项目文件夹，也不会回滚已经确认写入的修改。
        </p>
        {conversation.checking ? (
          <p className="conversation-delete-checking" role="status">
            <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />
            正在核对最新会话状态…
          </p>
        ) : null}
        {conversation.deleteBlocked && !conversation.checkError ? (
          <p className="conversation-delete-error" role="alert">
            这个会话仍在运行。请先停止当前运行，再删除会话。
          </p>
        ) : null}
        {conversation.checkError ? (
          <p className="conversation-delete-error" role="alert">
            {conversation.checkError}
          </p>
        ) : null}
        {error ? <p className="conversation-delete-error" role="alert">{error}</p> : null}

        <footer>
          <button type="button" onClick={close} disabled={busy} autoFocus>取消</button>
          <button
            className="is-danger"
            type="button"
            onClick={confirmDelete}
            disabled={busy || confirmationDisabled}
            aria-busy={busy}
          >
            {busy || conversation.checking ? (
              <>
                <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />
                {busy ? "正在删除…" : "正在核对…"}
              </>
            ) : conversation.checkError ? "无法核对状态" : conversation.deleteBlocked ? "请先停止运行" : (
              <>
                <Trash size={15} weight="regular" aria-hidden="true" />
                删除会话
              </>
            )}
          </button>
        </footer>
      </section>
    </div>
  );
}
