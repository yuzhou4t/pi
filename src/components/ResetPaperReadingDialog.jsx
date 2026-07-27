import { useEffect, useState } from "react";
import { CircleNotch, Trash } from "@phosphor-icons/react";

export function ResetPaperReadingDialog({
  paperConversation,
  onClose,
  onConfirm,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setBusy(false);
    setError("");
  }, [paperConversation?.id]);

  useEffect(() => {
    if (!paperConversation) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose?.();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, paperConversation, onClose]);

  if (!paperConversation) return null;

  const confirmReset = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm?.(paperConversation);
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
        aria-labelledby="paper-reset-title"
        aria-describedby="paper-reset-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <Trash size={19} weight="regular" aria-hidden="true" />
          </span>
          <div>
            <h2 id="paper-reset-title">删除这篇论文的研读记录？</h2>
            <p id="paper-reset-description">
              “{paperConversation.title || "未命名论文"}”的研读对话、阅读位置和整理中的结论将被删除，这篇论文会从研读列表移除。
            </p>
          </div>
        </header>

        <p className="conversation-delete-note">
          此操作不可恢复。论文会回到「每周追踪」的本周候选里，可重新选择处理方式；全文和五分钟导读仍会保留。
        </p>
        {error ? <p className="conversation-delete-error" role="alert">{error}</p> : null}

        <footer>
          <button type="button" onClick={close} disabled={busy} autoFocus>取消</button>
          <button
            className="is-danger"
            type="button"
            onClick={confirmReset}
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
                删除研读记录
              </>
            )}
          </button>
        </footer>
      </section>
    </div>
  );
}
