/**
 * Cheap, deterministic value score for a session transcript — no LLM.
 *
 * The score estimates "did this session produce durable, memory-worthy
 * knowledge" from signals extractable by reading the jsonl. It is a triage
 * filter: only transcripts at or above SCORE_MIN get an expensive LLM deep read.
 * Weights are tunable constants and are pinned by score.test.ts so a regression
 * that reorders a known-worthy vs known-noise fixture fails loudly.
 *
 * Workspace premise (2026-07-26): this workspace runs GC / memory-curation in
 * dedicated, independent sessions. Those sessions are keyword-dense (many
 * corrections, decisions, commits) and would saturate the top of the ranking —
 * yet they have ALREADY written their own memory, so re-mining them yields
 * mostly duplicates. The `selfCurated` signal detects a session that wrote to
 * memory/rules/MEMORY.md/CLAUDE.md and dampens its score so genuinely
 * un-curated dev sessions rank above it.
 */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Parse Claude Code transcript jsonl into normalized entries; skips bad lines. */
export function parseTranscript(raw) {
    const entries = [];
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue; // corrupt line — skip, do not fail the whole file
        }
        if (typeof obj !== "object" || obj === null)
            continue;
        const rec = obj;
        const message = (rec.message ?? rec);
        const roleRaw = String(message.role ?? rec.type ?? "other");
        const role = roleRaw === "user"
            ? "user"
            : roleRaw === "assistant"
                ? "assistant"
                : "other";
        let text = "";
        let toolUses = 0;
        const writes = [];
        const content = message.content;
        if (typeof content === "string") {
            text = content;
        }
        else if (Array.isArray(content)) {
            for (const block of content) {
                if (typeof block !== "object" || block === null)
                    continue;
                const b = block;
                if (b.type === "text" && typeof b.text === "string") {
                    text += b.text + "\n";
                }
                else if (b.type === "tool_use") {
                    toolUses += 1;
                    if (WRITE_TOOLS.has(String(b.name)) &&
                        b.input &&
                        typeof b.input === "object") {
                        const fp = b.input.file_path;
                        if (typeof fp === "string")
                            writes.push(fp);
                    }
                }
            }
        }
        entries.push({ role, text, toolUses, writes });
    }
    return entries;
}
/** Returns true when nonblank input contains no valid transcript entry. */
export function isUnreadableTranscript(raw) {
    return raw.trim().length > 0 && parseTranscript(raw).length === 0;
}
// --- Signal patterns -------------------------------------------------------
/** Operator corrections/directives — the strongest memory-worthy signal. */
const CORRECTION = /아니라|아닙니다|하지\s*마세요|하지마세요|하지마|대신에|틀렸|잘못|되돌려|\bactually\b|\binstead\b|\bdon't\b|\bdo not\b|\brevert\b|\bnot that\b|\bwrong\b/gi;
/** Decision / post-mortem language. */
const DECISION = /root cause|\bdecided\b|\bdecision\b|turns out|the fix\b|\bgotcha\b|\bTIL\b|\bremember\b|\blesson\b|post-?mortem|the reason|because it|so that we/gi;
/** SVOP honesty markers written during careful work. */
const HONESTY = /\[UNKNOWN\]|\[PARTIAL\]|\[UNCERTAIN\]|\[TOOL_FAILED\]/g;
/** Durable artifacts: commits, PRs, releases. */
const ARTIFACT = /\bgit commit\b|\bgit -C\b|\bgh pr\b|\bpull request\b|\brelease\b|\bpublished\b|\bcommitted\b/gi;
/** Unresolved-error noise — a negative signal. */
const ERROR = /\berror\b|\bfailed\b|\bexception\b|\btraceback\b/gi;
const RESOLUTION = /\bfixed\b|\bresolved\b|\bpasses\b|\bworks now\b|\bgreen\b|\bsucceed/gi;
/** A write target that means the session curated its own memory. */
const CURATION_TARGET = /\/memory\/|\/rules\/|MEMORY\.md$|CLAUDE\.md$|\.claude\/rules/;
const WEIGHTS = {
    correction: 5,
    decision: 2,
    honesty: 1,
    artifact: 3,
    substance: 1, // per (turns/10), capped
};
// Caps raised (2026-07-26) so heavy sessions spread out instead of saturating.
const CAPS = {
    correction: 6,
    decision: 10,
    honesty: 8,
    artifact: 6,
    substance: 5,
};
/** Score multiplier for a self-curated session (its value is already in memory). */
const SELF_CURATED_DAMPEN = 0.4;
/** Default triage threshold; transcripts below this skip the LLM deep read. */
export const SCORE_MIN = 12;
function countMatches(text, re) {
    const m = text.match(re);
    return m ? m.length : 0;
}
export function scoreEntries(entries) {
    const userText = entries
        .filter((e) => e.role === "user")
        .map((e) => e.text)
        .join("\n");
    const allText = entries.map((e) => e.text).join("\n");
    const turns = entries.filter((e) => e.role === "user" || e.role === "assistant").length;
    const toolUses = entries.reduce((n, e) => n + e.toolUses, 0);
    const selfCurated = entries.some((e) => e.writes.some((p) => CURATION_TARGET.test(p)));
    // Corrections only count from user turns (an operator steering the agent).
    const corrections = Math.min(countMatches(userText, CORRECTION), CAPS.correction);
    const decisions = Math.min(countMatches(allText, DECISION), CAPS.decision);
    const honesty = Math.min(countMatches(allText, HONESTY), CAPS.honesty);
    const artifacts = Math.min(countMatches(allText, ARTIFACT), CAPS.artifact);
    const substance = Math.min(turns / 10, CAPS.substance);
    // Negative: many errors with little resolution language.
    const errors = countMatches(allText, ERROR);
    const resolutions = countMatches(allText, RESOLUTION);
    const unresolvedPenalty = errors > 4 && resolutions === 0 ? -3 : 0;
    // A near-empty or tool-only session (no real dialogue) cannot be memory-worthy.
    const trivial = turns < 3 && toolUses < 3;
    const signals = {
        correction: corrections,
        decision: decisions,
        honesty,
        artifact: artifacts,
        substance: Number(substance.toFixed(2)),
        unresolvedPenalty,
        selfCurated: selfCurated ? 1 : 0,
    };
    const raw = trivial
        ? 0
        : Math.max(0, corrections * WEIGHTS.correction +
            decisions * WEIGHTS.decision +
            honesty * WEIGHTS.honesty +
            artifacts * WEIGHTS.artifact +
            substance * WEIGHTS.substance +
            unresolvedPenalty);
    // Self-curated sessions already wrote their memory — dampen so un-curated
    // dev sessions outrank them (workspace premise, 2026-07-26).
    const score = selfCurated ? raw * SELF_CURATED_DAMPEN : raw;
    return { score: Number(score.toFixed(2)), turns, signals };
}
export function scoreTranscript(raw) {
    return scoreEntries(parseTranscript(raw));
}
/** Default cap on how many transcripts of one project earn a deep read. */
export const MAX_PER_PROJECT = 5;
export function parseMaxPerProject(value) {
    const cap = Number(value ?? MAX_PER_PROJECT);
    if (!Number.isInteger(cap) || cap < 0) {
        throw new Error(`invalid MAX_PER_PROJECT: ${value}`);
    }
    return cap;
}
/**
 * Pick the transcripts that earn an expensive LLM deep read: at or above
 * SCORE_MIN, highest score first, at most `cap` per project.
 *
 * Why a cap rather than a higher threshold (measured 2026-08-05, 583-candidate
 * corpus): raising SCORE_MIN does not spread the batch out, it concentrates it.
 * At SCORE_MIN=12, 80% of the 155 above-threshold transcripts came from one
 * project; at 70 it was 98%. The score saturates on long sessions (every cap
 * maxed), so it cannot rank within a project — but it does separate projects.
 * The per-project cap is therefore the lever that diversifies the batch:
 * cap 5 turned 155 deep reads into 21 across 5 projects.
 *
 * `cap <= 0` disables the cap.
 */
export function selectForDeepRead(rows, cap = MAX_PER_PROJECT) {
    const uniqueRows = new Map();
    for (const row of rows) {
        const existing = uniqueRows.get(row.path);
        if (!existing || row.score > existing.score) {
            uniqueRows.set(row.path, row);
        }
    }
    const seen = new Map();
    const out = [];
    for (const row of [...uniqueRows.values()].sort((a, b) => b.score - a.score)) {
        if (row.score < SCORE_MIN)
            continue;
        const taken = seen.get(row.slug) ?? 0;
        if (cap > 0 && taken >= cap)
            continue;
        seen.set(row.slug, taken + 1);
        out.push(row);
    }
    return out;
}
