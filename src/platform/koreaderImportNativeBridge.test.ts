import { describe, expect, it } from "vitest";
import { commitKoreaderProgress, readKoreaderSidecarText } from "./koreaderImportNativeBridge";

describe("KOReader import bridge", () => {
  it("names the read and commit commands and does not send a path, stamp or percent", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const run = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      return new Uint8Array([0x61]).buffer as T;
    };
    await expect(readKoreaderSidecarText("00000000-0000-4000-8000-000000000001", run)).resolves.toBe("a");
    const broken = async <T>(command: string): Promise<T> => {
      calls.push({ command });
      return new Uint8Array([0xff]).buffer as T;
    };
    await expect(readKoreaderSidecarText("00000000-0000-4000-8000-000000000001", broken)).rejects.toMatchObject({ code: "invalid-data" });

    const commit = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      return { progressWritten: 1, progressUnchanged: 0 } as T;
    };
    await commitKoreaderProgress("00000000-0000-4000-8000-000000000001", {
      bookHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetToken: "token",
      progress: {
        locator: {
          locatorVersion: 1,
          chapterPath: "OEBPS/Text/c2.xhtml",
          spineIndexHint: 1,
          target: { kind: "text", textProfile: "visible-codepoints-no-whitespace-v1", offset: 11, snippet: "同一句话。" },
        },
        progressPctHint: 0,
      },
    }, commit);
    const sent = calls.at(-1);
    expect(sent?.command).toBe("koreader_import_commit");
    expect(JSON.stringify(sent?.args)).not.toMatch(/docPath|stamp|deviceId|percentFinished|partialMd5/i);
  });
});
