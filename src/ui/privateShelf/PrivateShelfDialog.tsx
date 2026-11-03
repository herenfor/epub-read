import { useEffect, useRef, useState, type FormEvent } from "react";
import { useUiText } from "../localization/UiLanguageProvider";
import { privateShelfError, type PrivateShelfNative } from "../../platform/privateShelf";

export type PrivateShelfDialogMode = "setup" | "unlock" | "reset";

function LockIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** Same rule as the native check: at least 4 characters, at most 256 UTF-8 bytes. */
function passwordProblem(password: string): "tooShort" | "tooLong" | null {
  if (Array.from(password).length < 4 || !password.trim()) return "tooShort";
  if (new TextEncoder().encode(password).length > 256) return "tooLong";
  return null;
}

/**
 * Set a password, unlock, or clear the private shelf. Native calls run here;
 * the host only learns the outcome. `leftover` opens the clear step for data
 * an interrupted reset left without a password.
 */
export function PrivateShelfDialog(props: {
  mode: PrivateShelfDialogMode;
  native: PrivateShelfNative;
  /** The clear step explains that old data blocks a new password. */
  leftover?: boolean;
  onModeChange(mode: PrivateShelfDialogMode, leftover?: boolean): void;
  onUnlocked(sessionId: string): void;
  onReset(): void;
  onClose(): void;
}) {
  const { t } = useUiText();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    setPassword("");
    setConfirm("");
    setError(null);
    inputRef.current?.focus();
  }, [props.mode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      const failure = privateShelfError(cause);
      if (failure.code === "wrong-password") setError(t("shelfMain.private.wrong"));
      else if (failure.code === "invalid-password") setError(t("shelfMain.private.setup.tooShort"));
      else if (failure.code === "not-configured") props.onModeChange("setup");
      else if (failure.code === "already-configured") props.onModeChange("unlock");
      else if (failure.code === "reset-required") props.onModeChange("reset", true);
      else setError(t("shelfMain.private.failed", { error: failure.message }));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (props.mode === "unlock") {
      if (!password) return;
      void run(async () => props.onUnlocked((await props.native.unlock(password)).sessionId));
    } else if (props.mode === "setup") {
      const problem = passwordProblem(password);
      if (problem) { setError(t(problem === "tooShort" ? "shelfMain.private.setup.tooShort" : "shelfMain.private.setup.tooLong")); return; }
      if (password !== confirm) { setError(t("shelfMain.private.setup.mismatch")); return; }
      void run(async () => {
        await props.native.setup(password);
        props.onUnlocked((await props.native.unlock(password)).sessionId);
      });
    } else {
      void run(async () => {
        await props.native.reset();
        props.onReset();
      });
    }
  };

  const cancel = () => { if (!busyRef.current) props.onClose(); };
  const reset = props.mode === "reset";
  const title = reset ? t("shelfMain.private.reset.title")
    : props.mode === "setup" ? t("shelfMain.private.setup.title") : t("shelfMain.private.unlock.title");
  const submitLabel = busy
    ? t(reset ? "shelfMain.private.reset.running" : "shelfMain.private.checking")
    : t(reset ? "shelfMain.private.reset.submit" : props.mode === "setup" ? "shelfMain.private.setup.submit" : "shelfMain.private.enter");

  return (
    <div className="shelf-confirm-backdrop" onClick={cancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <form onSubmit={submit}>
          <div className={`shelf-confirm-title${reset ? "" : " private-shelf-title"}`}>
            {!reset && <LockIcon />}
            <span>{title}</span>
          </div>
          <div className="shelf-confirm-hint">
            {reset ? (props.leftover ? t("shelfMain.private.reset.leftover") : t("shelfMain.private.reset.hint"))
              : props.mode === "setup" ? t("shelfMain.private.setup.hint") : t("shelfMain.private.unlock.hint")}
          </div>
          {!reset && (
            <div className="private-shelf-fields">
              <input ref={inputRef} className="shelf-dialog-input" type="password" autoComplete={props.mode === "setup" ? "new-password" : "current-password"}
                aria-label={t("shelfMain.private.password")} aria-invalid={error !== null}
                placeholder={props.mode === "setup" ? t("shelfMain.private.setup.password") : t("shelfMain.private.password")}
                value={password} disabled={busy} onChange={(event) => { setPassword(event.target.value); setError(null); }} />
              {props.mode === "setup" && (
                <input className="shelf-dialog-input" type="password" autoComplete="new-password"
                  aria-label={t("shelfMain.private.setup.confirm")} placeholder={t("shelfMain.private.setup.confirm")}
                  value={confirm} disabled={busy} onChange={(event) => { setConfirm(event.target.value); setError(null); }} />
              )}
            </div>
          )}
          {error && <div className="shelf-dialog-error private-shelf-error" role="alert">{error}</div>}
          {props.mode === "setup" && <div className="shelf-confirm-hint">{t("shelfMain.private.setup.forgetNote")}</div>}
          <div className="shelf-confirm-actions">
            {props.mode === "unlock" && (
              <button type="button" className="ui-text-btn is-muted private-shelf-forgot" disabled={busy}
                onClick={() => props.onModeChange("reset")}>{t("shelfMain.private.forgot")}</button>
            )}
            <button type="button" className="shelf-selection-cancel" onClick={cancel} disabled={busy}>{t("appUi.cancel")}</button>
            <button type="submit" className={reset ? "shelf-selection-delete" : "shelf-confirm-primary"}
              disabled={busy || (props.mode === "unlock" && !password)}>{submitLabel}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
