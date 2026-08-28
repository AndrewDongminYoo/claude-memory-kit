import { createHash } from "node:crypto";
import fs from "node:fs";
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
/** Hash the exact bytes that the operator reviewed. */
export function fingerprintContents(contents) {
    return createHash("sha256").update(contents).digest("hex");
}
/** Hash a descriptor without changing its current read position. */
export function fingerprintDescriptor(descriptor) {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
        const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
            return hash.digest("hex");
        }
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
    }
}
export function isTranscriptFingerprint(value) {
    return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}
