import fs from "node:fs";
import path from "node:path";
import { archiveTranscript } from "./archive.ts";
import {
  appendLedger,
  appendCompletedArchive,
  appendPendingArchive,
  pendingArchives,
  type LedgerRecord,
  type Outcome,
} from "./ledger.ts";
import {
  assertDirectTranscriptPath,
  assertSafeTranscriptFile,
  assertSlugInScope,
  isSingleSegmentSlug,
  isSlugInScope,
} from "./scope.ts";

export interface FinalizeOptions {
  transcriptPath: string;
  slug: string;
  score: number;
  outcome: Outcome;
  memoryWritten: string[];
  projectsDir: string;
  archiveDir: string;
  ledgerFile: string;
  scopePrefixes: readonly string[];
  now?: number;
}

export interface RecoveryOptions {
  projectsDir: string;
  archiveDir: string;
  ledgerFile: string;
  scopePrefixes: readonly string[];
  now?: number;
}

export interface RecoveryResult {
  completed: number;
  skippedOutOfScope: number;
  unresolved: Array<{ sessionId: string; reason: string }>;
}

function processedAt(now: number | undefined): string {
  return new Date(now ?? Date.now()).toISOString();
}

function sessionIdFor(transcriptPath: string): string {
  const base = path.basename(transcriptPath);
  return base.slice(0, base.length - path.extname(base).length);
}

function ledgerRecord(
  options: FinalizeOptions,
  archivePath?: string,
): LedgerRecord {
  return {
    session_id: sessionIdFor(options.transcriptPath),
    slug: options.slug,
    processed_at: processedAt(options.now),
    score: options.score,
    outcome: options.outcome,
    memory_written: options.memoryWritten,
    transcript_path: path.resolve(options.transcriptPath),
    archive_path: archivePath,
  };
}

/** Records unreadable input or finalizes an archivable transcript. */
export function finalizeTranscript(options: FinalizeOptions): {
  archivePath?: string;
} {
  assertSlugInScope(options.slug, options.scopePrefixes);
  assertSafeTranscriptFile(
    options.transcriptPath,
    options.slug,
    options.projectsDir,
  );
  const pending = ledgerRecord(options);
  if (options.outcome === "unreadable") {
    appendLedger(options.ledgerFile, pending);
    return {};
  }
  appendPendingArchive(options.ledgerFile, pending);
  const archivePath = archiveTranscript({
    transcriptPath: options.transcriptPath,
    slug: options.slug,
    projectsDir: options.projectsDir,
    archiveDir: options.archiveDir,
    onDestinationReady: (destination) => {
      appendPendingArchive(
        options.ledgerFile,
        ledgerRecord(options, destination),
      );
    },
  });
  appendCompletedArchive(
    options.ledgerFile,
    ledgerRecord(options, archivePath),
  );
  return { archivePath };
}

function isRecordedArchiveFile(
  archivePath: string | undefined,
  slug: string,
  archiveDir: string,
): archivePath is string {
  if (!archivePath || !isSingleSegmentSlug(slug)) {
    return false;
  }
  const archiveRoot = path.resolve(archiveDir);
  const archiveSlugDir = path.join(archiveRoot, slug);
  const candidate = path.resolve(archivePath);
  if (path.dirname(candidate) !== archiveSlugDir || !fs.existsSync(candidate)) {
    return false;
  }
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return false;
  }
  return (
    path.dirname(fs.realpathSync(candidate)) === fs.realpathSync(archiveSlugDir)
  );
}

function completionRecord(
  record: LedgerRecord,
  archivePath: string,
  now?: number,
): LedgerRecord {
  return {
    ...record,
    processed_at: processedAt(now),
    archive_path: archivePath,
  };
}

/** Completes pending archives without reading or writing any memory file. */
export function recoverPendingArchives(
  options: RecoveryOptions,
): RecoveryResult {
  const result: RecoveryResult = {
    completed: 0,
    skippedOutOfScope: 0,
    unresolved: [],
  };
  for (const record of pendingArchives(options.ledgerFile)) {
    if (!isSlugInScope(record.slug, options.scopePrefixes)) {
      result.skippedOutOfScope += 1;
      continue;
    }
    try {
      assertDirectTranscriptPath(
        record.transcript_path,
        record.slug,
        options.projectsDir,
      );
      const recordedArchivePath = record.archive_path;
      if (
        isRecordedArchiveFile(
          recordedArchivePath,
          record.slug,
          options.archiveDir,
        )
      ) {
        if (fs.existsSync(record.transcript_path)) {
          archiveTranscript({
            transcriptPath: record.transcript_path,
            slug: record.slug,
            projectsDir: options.projectsDir,
            archiveDir: options.archiveDir,
            existingArchivePath: recordedArchivePath,
          });
        }
        appendCompletedArchive(
          options.ledgerFile,
          completionRecord(record, recordedArchivePath, options.now),
        );
        result.completed += 1;
      } else if (fs.existsSync(record.transcript_path)) {
        const archivePath = archiveTranscript({
          transcriptPath: record.transcript_path,
          slug: record.slug,
          projectsDir: options.projectsDir,
          archiveDir: options.archiveDir,
          onDestinationReady: (destination) => {
            appendPendingArchive(
              options.ledgerFile,
              completionRecord(record, destination, options.now),
            );
          },
        });
        appendCompletedArchive(
          options.ledgerFile,
          completionRecord(record, archivePath, options.now),
        );
        result.completed += 1;
      } else {
        result.unresolved.push({
          sessionId: record.session_id,
          reason: "source and recorded archive are both unavailable",
        });
      }
    } catch (error) {
      result.unresolved.push({
        sessionId: record.session_id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
