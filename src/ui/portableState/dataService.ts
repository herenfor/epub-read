import type { LibraryOrganization, OrganizationCommand } from "../libraryOrganization";
import type { LibraryRecord } from "../libraryArchive";
import type { PortableStateV3 } from "../../core/portableState/portable-state-types";
import type { Stamp } from "../../core/portableState/portable-register-core";
import type { PortableStateCommandService } from "./service";
import type { ProgressRuntimeStatus } from "./progressRuntimeGate";
import type { DirectoryPlacementBatch, DirectoryPlacementBatchResult } from "../folderImport/placementBatch";
import type { ImportSkippedBook } from "../../platform/saveFileNativeBridge";

export interface PortableActivationResult {
  readonly status: "fresh" | "migrated" | "already-migrated";
  readonly books: number;
  readonly annotations: number;
}

export interface PortableMergeOptions {
  readonly applyPreferences?: boolean;
  readonly migrationMark?: string;
}

export interface PortableLegacyImportInput {
  readonly records: readonly LibraryRecord[];
  readonly organization?: LibraryOrganization;
}

/** C6: the native merge also reports which incoming books it did not accept; Web returns the plain state. */
export type PortableLegacyImportResult = PortableStateV3 & {
  readonly importedBooks?: readonly string[];
  readonly skippedBookCount?: number;
  readonly skippedBooks?: readonly ImportSkippedBook[];
};

/**
 * Integration-facing data surface. Command methods stay the frozen S0 wire;
 * these additional internal methods are used by the ShelfStore facade and do
 * not become UI IPC commands. Native implementations call the corresponding
 * `portable_state_*` internal commands; Web uses the same service directly.
 */
export interface PortableStateDataService extends PortableStateCommandService {
  snapshot(): Promise<PortableStateV3>;
  mergeValidatedState(input: unknown, options?: PortableMergeOptions): Promise<PortableStateV3>;
  /** R3: merge old archive records and organization in one repository transaction. */
  mergeLegacyRecords(input: PortableLegacyImportInput): Promise<PortableLegacyImportResult>;
  /** Local visibility rows created by an archive import without a byte binding. */
  listLocalVisibleHashes(): Promise<readonly string[]>;
  setLocalVisible(hash: string, visible: boolean): Promise<void>;
  getOrganization(): Promise<LibraryOrganization>;
  applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization>;
  mergeOrganization(incoming: LibraryOrganization): Promise<LibraryOrganization>;
  /** Web only: one repository transaction for a directory-import placement batch. */
  commitDirectoryPlacementBatch?(batch: DirectoryPlacementBatch): Promise<DirectoryPlacementBatchResult>;
  reserveStamps(count: number): Promise<Stamp>;
  /** Read-only health probe; must not snapshot, migrate or activate a store. */
  runtimeStatus(): Promise<ProgressRuntimeStatus>;
  activate?(): Promise<PortableActivationResult>;
}
