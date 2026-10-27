/** Credential-free native management projection, shared with the connection UI. */
export interface ReaderToolsStatus {
  supported: boolean;
  unsupportedReason: "platform" | "release-build" | null;
  service: "off" | "starting" | "running" | "stopping" | "failed";
  error: { code: "invalid-config" | "bind-failed" | "write-failed" | "failed"; message: string } | null;
  provider: "waiting" | "ready" | "failed";
  providerError: "provider-connect-failed" | "provider-reply-failed" | "provider-channel-failed" | null;
  /** Public instance identity, not a bearer credential. Binds late lifecycle IPC. */
  serviceInstance: string | null;
  initialFromEnv: boolean;
  grantsSource: "env-config" | "default";
  connectionDirectory: string | null;
  clients: Array<{
    clientId: string;
    books: { kind: "all" } | { kind: "listed"; count: number };
    prepareIndex: boolean;
    connectionFile: string | null;
  }>;
  revision: number;
}

export const READER_TOOLS_STATUS_EVENT = "reader-tools-status";
