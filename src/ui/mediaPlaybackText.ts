import type { MediaPlaybackText } from "../render/mediaPlayback";
import { uiText } from "./localization/UiLanguageProvider";

/** Read the current locale when a chapter/player acts, without reloading it. */
export function readerMediaPlaybackText(): MediaPlaybackText {
  return {
    audio: uiText("reader.media.audio"), video: uiText("reader.media.video"),
    loading: uiText("reader.media.loading"), retry: uiText("reader.media.retry"),
    unavailable: uiText("reader.media.unavailable"), unsupported: uiText("reader.media.unsupported"),
    play: uiText("reader.media.play"),
  };
}
