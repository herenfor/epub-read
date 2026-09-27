import { SelectiveEpubArchive, outputTransferList } from "./selectiveArchive";

let archive: SelectiveEpubArchive | null = null;

self.onmessage = (e: MessageEvent) => {
  const { id, type, bytes, paths } = e.data;
  try {
    if (type === "init") {
      archive = new SelectiveEpubArchive(bytes);
      self.postMessage({
        id,
        type: "init:ok",
        directory: Array.from(archive.directory.values()),
      });
    } else if (type === "extract") {
      if (!archive) throw new Error("归档未初始化");
      const files = archive.extract(paths);
      const entries = Array.from(files.entries());
      const transferList = outputTransferList(files);
      (self as any).postMessage(
        {
          id,
          type: "extract:ok",
          payload: entries,
        },
        transferList
      );
    } else if (type === "close") {
      if (archive) {
        archive.close();
        archive = null;
      }
    }
  } catch (err: any) {
    self.postMessage({
      id,
      error: err?.message || String(err),
    });
  }
};
