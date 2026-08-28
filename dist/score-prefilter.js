import fs from "node:fs";
import path from "node:path";
import { projectsDir, resolveClaudeRoot } from "./lib/paths.js";
import { isUnreadableTranscript, parseMaxPerProject, scoreTranscript, selectForDeepRead, SCORE_MIN, } from "./lib/score.js";
import { assertDirectTranscriptPath, assertSlugInScope, openSafeTranscriptFile, parseScopeSlugPrefixes, } from "./lib/scope.js";
function transcriptReadErrorCode(error) {
    return error?.code;
}
function isUnreadableTranscriptReadError(error) {
    const code = transcriptReadErrorCode(error);
    return code === "EACCES" || code === "EPERM";
}
function unreadableRow(transcriptPath, slug, error) {
    return {
        path: transcriptPath,
        slug,
        score: 0,
        unreadable: true,
        error: error instanceof Error ? error.message : String(error),
    };
}
function missingRow(transcriptPath, slug, error) {
    return {
        path: transcriptPath,
        slug,
        score: 0,
        missing: true,
        error: error instanceof Error ? error.message : String(error),
    };
}
function main() {
    const scopePrefixes = parseScopeSlugPrefixes();
    const configuredProjectsDir = projectsDir(resolveClaudeRoot());
    const transcriptPaths = [
        ...new Set(process.argv
            .slice(2)
            .filter((argument) => !argument.startsWith("--"))
            .map((argument) => path.resolve(argument))),
    ];
    if (transcriptPaths.length === 0) {
        process.stderr.write("usage: score-prefilter <transcript.jsonl> ...\n");
        process.exit(2);
    }
    const cap = parseMaxPerProject(process.env.MAX_PER_PROJECT);
    const scopedPaths = transcriptPaths.map((transcriptPath) => {
        const slug = path.basename(path.dirname(transcriptPath));
        assertSlugInScope(slug, scopePrefixes);
        assertDirectTranscriptPath(transcriptPath, slug, configuredProjectsDir);
        return { transcriptPath, slug };
    });
    const rows = scopedPaths.map(({ transcriptPath, slug }) => {
        let descriptor;
        try {
            descriptor = openSafeTranscriptFile(transcriptPath, slug, configuredProjectsDir);
        }
        catch (error) {
            if (transcriptReadErrorCode(error) === "ENOENT") {
                return missingRow(transcriptPath, slug, error);
            }
            if (isUnreadableTranscriptReadError(error)) {
                return unreadableRow(transcriptPath, slug, error);
            }
            throw error;
        }
        try {
            const raw = fs.readFileSync(descriptor, "utf8");
            if (isUnreadableTranscript(raw)) {
                return {
                    path: transcriptPath,
                    slug,
                    score: 0,
                    unreadable: true,
                    error: "no valid JSONL transcript entries",
                };
            }
            return { path: transcriptPath, slug, ...scoreTranscript(raw) };
        }
        catch (error) {
            return unreadableRow(transcriptPath, slug, error);
        }
        finally {
            if (descriptor !== undefined) {
                fs.closeSync(descriptor);
            }
        }
    });
    const selectedRows = selectForDeepRead(rows, cap);
    const selected = new Set(selectedRows.map((row) => row.path));
    for (const row of rows) {
        process.stdout.write(JSON.stringify({
            ...row,
            above: !row.unreadable && row.score >= SCORE_MIN,
            selected: selected.has(row.path),
        }) + "\n");
    }
    // Without a summary the caller has to re-aggregate 500 JSON lines to learn
    // what the batch costs. Stubs get their own count because they dominate a
    // real corpus (375 of 583 on the 2026-08-05 run) and explain a low yield
    // that would otherwise read as a broken filter.
    const above = rows.filter((r) => !r.unreadable && r.score >= SCORE_MIN).length;
    const stubs = rows.filter((r) => r.turns !== undefined && r.turns < 3).length;
    const projects = new Set(selectedRows.map((row) => row.slug)).size;
    process.stderr.write(`${rows.length} scored | ${above} above SCORE_MIN=${SCORE_MIN} | ` +
        `${selected.size} selected across ${projects} project(s) ` +
        `(MAX_PER_PROJECT=${cap}) | ${stubs} stub(s) (<3 turns)\n`);
}
main();
