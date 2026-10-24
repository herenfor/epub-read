import { useEffect, useMemo, useState } from "react";
import { cloudSyncNative, type CloudSyncProgressSource } from "../../platform/cloudSyncNative";
import { currentUiLocale, useUiText } from "../localization/UiLanguageProvider";
import { cloudSyncSupported } from "./cloudSyncStore";
import "./cloudSync.css";

export interface ProgressSourceCandidate {
  readonly key: string;
  /** The stamp's event device id: who wrote this version. */
  readonly deviceId: string;
  readonly progressPct: number;
  /** The version's own updatedAtMs, never a cloud file time. */
  readonly updatedAtMs: number;
}

function formatWhen(ms: number): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(currentUiLocale(), {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * The progress versions to choose from when a book opens with more than one:
 * the writing device and its time first, the position second, newest on top.
 * Device names are a local, display-only lookup; while it runs or when it
 * fails the choice stays fully usable and an unknown writer reads as such.
 */
export function ProgressSourceChoices<C extends ProgressSourceCandidate>(props: {
  candidates: readonly C[];
  onChoose(candidate: C): void;
}) {
  const { t } = useUiText();
  const [sources, setSources] = useState<ReadonlyMap<string, CloudSyncProgressSource> | null>(null);
  // Keyed by content: a re-render with an equal candidate list must not look the names up again.
  const idsKey = [...new Set(props.candidates.map((c) => c.deviceId))].join(",");
  const deviceIds = useMemo(() => idsKey.split(","), [idsKey]);

  useEffect(() => {
    let cancelled = false;
    const done = (list: readonly CloudSyncProgressSource[]): void => {
      if (!cancelled) setSources(new Map(list.map((source) => [source.eventDeviceId, source])));
    };
    if (!cloudSyncSupported()) done([]);
    else cloudSyncNative.progressSources(deviceIds).then(done, () => done([]));
    return () => { cancelled = true; };
  }, [deviceIds]);

  const ordered = useMemo(
    () => [...props.candidates].sort((left, right) => right.updatedAtMs - left.updatedAtMs),
    [props.candidates],
  );

  const deviceLabel = (deviceId: string): string | null => {
    if (!sources) return null;
    const source = sources.get(deviceId);
    if (source?.isLocal) return t("cloudSync.source.local");
    return source?.deviceName || t("cloudSync.source.unknown");
  };

  return <div className="progress-source-list">
    {ordered.map((candidate) => {
      const device = deviceLabel(candidate.deviceId);
      return <button key={candidate.key} type="button" className="progress-source-item" onClick={() => props.onChoose(candidate)}>
        <span className="progress-source-head">
          <strong className={device === null ? "is-pending" : undefined}>{device ?? " "}</strong>
          <time dateTime={new Date(candidate.updatedAtMs).toISOString()}>{formatWhen(candidate.updatedAtMs)}</time>
        </span>
        <span className="progress-source-where">{t("cloudSync.source.position", { percent: Math.round(candidate.progressPct) })}</span>
      </button>;
    })}
  </div>;
}
