#!/usr/bin/env python3
"""secrets_scan.py -- read-only scan for exposed secrets in a directory tree.

A defensive detection-as-code tool. It reads text files under a directory and
flags lines that look like they contain a hardcoded secret (API key, token,
private key, password). It NEVER writes to disk and NEVER prints a secret's
value -- every match is redacted before it is shown.

Usage:
    python secrets_scan.py [ROOT_DIR]

Exit codes:
    0  no secrets found
    1  one or more secrets found   (so this can gate a CI pipeline)
    2  bad usage / path error
"""

# Origin: jon659/security-lab tools/secrets_scan.py, copied 2026-09-02

import re
import sys
from pathlib import Path

# --- What we deliberately do NOT scan -------------------------------------
# Binaries and generated art can't hold source-style secrets and would slow us
# down (and produce noise). Vendor/build dirs aren't ours to audit.
SKIP_DIRS = {
    ".git", ".tmp", "node_modules", "__pycache__",
    ".venv", "venv", "env", "assets", "reports",
    # security-rag additions: scratch/dependencies/build output, not source.
    ".superpowers", "dist",
}
SKIP_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
    ".pdf", ".zip", ".gz", ".tar", ".7z", ".mp4", ".mov", ".mp3",
    ".woff", ".woff2", ".ttf", ".otf", ".exe", ".dll", ".bin", ".pyc",
}
# security-rag addition: the real .env file is gitignored and holds live
# secret values, so a scanner match there is expected, not a leak in the
# repo. .env.example is intentionally NOT in this set -- it should still be
# scanned since it is committed.
SKIP_FILES = {".env"}
MAX_BYTES = 2_000_000  # skip files > ~2 MB; source with secrets is small

# Inline suppression: a line containing this marker is never flagged. Use it to
# annotate known-fake examples (docs, tests) so they stop generating noise.
# Same idea as gitleaks' "gitleaks:allow" comment.
ALLOW_MARKER = "scanner:ignore"


# === YOUR CONTRIBUTION ====================================================
# This function is the brain of the scanner. Everything else is plumbing.
#
# Return a list of (name, compiled_regex) tuples. For each line in each file,
# the scanner tries every regex; a match becomes a finding labelled `name`.
#
# The skill here is BALANCE:
#   - Too loose  -> false positives (every "key = value" lights up) -> noise
#                   that a real team learns to ignore, which hides real leaks.
#   - Too strict -> you miss real keys that don't match a known vendor format.
#
# I've seeded two HIGH-PRECISION patterns below (they almost never false-positive)
# so the tool runs today. Your job: add the higher-recall, judgment-heavy ones.
#
# Ideas to implement (pick what you think earns its keep):
#   1. A GENERIC assignment pattern: a variable whose name contains
#      key/token/secret/password/passwd/apikey, assigned a quoted string of
#      some minimum length. This is where false positives creep in -- decide a
#      sensible minimum length and whether to require quotes.
#   2. Specific vendor tokens with recognizable shapes, e.g.:
#         - Google API key:   AIza followed by 35 url-safe chars
#         - Slack token:      xox[baprs]-...
#         - GitHub PAT:       ghp_ / github_pat_ followed by many chars
#         - Generic bearer:   "Bearer " + a long token
#   3. (Optional) A high-entropy string catch: a long run of base64-ish chars.
#      Powerful but false-positive-prone -- your call whether it's worth it.
#
# Regex tips: use raw strings r"...", and remember re.IGNORECASE via re.I for
# the variable-name part. Test at https://regex101.com if a pattern misbehaves.
def secret_patterns():
    patterns = [
        # High-precision seeds (leave these; they rarely misfire):
        ("Private key block",
         re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
        ("AWS access key id",
         re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),

        # --- Reference patterns (walked through with Jon, 2026-07-17) ------

        # 1. GENERIC SECRET ASSIGNMENT -- the workhorse. Catches lines like:
        #        KIE_API_KEY=sk_live_8f3kd93jdmf83jfk        (fake; scanner:ignore)
        #        password: "hunter2hunter2hunter2"           (fake; scanner:ignore)
        #    Decisions baked in:
        #      - (?i)         -> case-insensitive, so API_KEY and api_key both hit
        #      - the name must CONTAIN key/token/secret/passw -> we anchor on
        #        the *variable name*, not the value, because names are honest
        #      - [:=]         -> matches both "x = y" (code/.env) and "x: y" (YAML/JSON)
        #      - value must be 12+ chars -> "password=test" (4 chars) is almost
        #        always a placeholder; real keys are long. 12 is the judgment call:
        #        low enough to catch short real tokens, high enough to skip dummies.
        #      - quotes OPTIONAL -> .env files don't quote values, and .env is
        #        exactly where real keys live. Requiring quotes would miss them.
        #      - (?!\() at the end -> tuning added after a live run: without it,
        #        `api_key = load_api_key()` matched (the function NAME is 12+
        #        word chars). A function call is code, not a literal secret, and
        #        a call is always followed by "(" -- so we refuse the match if
        #        the next char is an open-paren. One live-run false positive ->
        #        one surgical exclusion. That loop IS detection engineering.
        #      - security-rag live-run tuning (2026-09-02), two more surgical
        #        exclusions in the same spirit:
        #        (a) a value that is ENTIRELY a dotted identifier chain with no
        #            digits (cfg.apiKey, e.API_KEY, process.env.X) is a code
        #            reference, not a literal. Review caught that a looser
        #            "starts with word." version would also hide a hardcoded
        #            JWT (eyJhbGci...9.eyJzdWIi...), so the exclusion requires
        #            the whole value to be letters/underscores and dots, and
        #            to end there. JWT segments carry digits, so they still hit.
        #        (b) a value containing a placeholder WORD as its own segment
        #            (your-key-here, changeme, xxxx) is documentation. Bounded
        #            by non-letters on both sides so a random token that merely
        #            contains "your" is still flagged.
        #        scripts/secrets_scan_selftest.py pins both behaviours in CI.
        ("Generic secret assignment",
         re.compile(r"(?i)[\w.-]*(?:api[_-]?key|token|secret|passw)[\w.-]*"
                    r"\s*[:=]\s*['\"]?"
                    r"(?![A-Za-z_]+(?:\.[A-Za-z_]+)+(?![\w.\-/+]))"
                    r"(?![^\s'\"]*(?<![A-Za-z])(?:your|example|placeholder|changeme|xxxx)(?![A-Za-z]))"
                    r"[A-Za-z0-9_\-./+]{12,}['\"]?(?!\()")),

        # 2. VENDOR-SHAPED TOKENS -- near-zero false positives because these
        #    prefixes are globally unique to one issuer. If you see "ghp_" + 36
        #    chars, it IS a GitHub token; nothing else looks like that.
        ("Google API key",
         re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
        ("GitHub token",
         re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b")),
        ("Slack token",
         re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),

        # 3. BEARER HEADER -- catches a real credential pasted into a curl
        #    command or HTTP snippet in docs/scripts. 20+ chars skips the
        #    literal placeholder "Bearer <token>".
        ("Bearer token in header",
         re.compile(r"(?i)\bBearer\s+[A-Za-z0-9_\-.=/+]{20,}")),

        # DELIBERATELY OMITTED: a high-entropy catch-all (flag any long random-
        # looking string). It finds everything -- including every hash, UUID,
        # and base64 image chunk in the repo. In a workspace with 1,200+ asset
        # files, the noise would drown the signal. Recall isn't free.
    ]
    return patterns
# === END YOUR CONTRIBUTION =================================================


def redact(match_text):
    """Turn a matched secret into something safe to print.

    Keeps just enough to recognize it (first 3 chars) and reveals its length
    class, but never the value.
    e.g. 'AKIAIOSFODNN7EXAMPLE' -> 'AKI...[17 hidden]'.  (fake; scanner:ignore)
    """
    text = match_text.strip().strip("'\"")
    if len(text) <= 4:
        return "*" * len(text)
    return f"{text[:3]}...[{len(text) - 3} hidden]"


def iter_text_files(root):
    """Yield every scannable file under root, skipping vendor dirs and binaries."""
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix.lower() in SKIP_EXT:
            continue
        if path.name in SKIP_FILES:
            continue
        try:
            if path.stat().st_size > MAX_BYTES:
                continue
        except OSError:
            continue
        yield path


def scan_file(path, patterns):
    """Return a list of (lineno, pattern_name, redacted) for one file."""
    findings = []
    try:
        # errors="ignore": a stray binary that slipped through won't crash us.
        with path.open("r", encoding="utf-8", errors="ignore") as fh:
            for lineno, line in enumerate(fh, start=1):
                if ALLOW_MARKER in line:
                    continue  # explicitly suppressed (documented fake/example)
                for name, pattern in patterns:
                    m = pattern.search(line)
                    if m:
                        findings.append((lineno, name, redact(m.group(0))))
    except OSError:
        pass
    return findings


def main(argv):
    root = Path(argv[1]) if len(argv) > 1 else Path.cwd()
    if not root.exists():
        print(f"error: path not found: {root}", file=sys.stderr)
        return 2

    patterns = secret_patterns()
    if not patterns:
        print("warning: no patterns defined -- fill in secret_patterns()", file=sys.stderr)

    total = 0
    print(f"Scanning {root} ...\n")
    for path in iter_text_files(root):
        hits = scan_file(path, patterns)
        if hits:
            rel = path.relative_to(root) if root in path.parents or path == root else path
            print(f"  {rel}")
            for lineno, name, red in hits:
                print(f"    line {lineno}: [{name}] {red}")
            total += len(hits)

    print()
    if total:
        print(f"RESULT: {total} potential secret(s) found. Review each above.")
        return 1
    print("RESULT: no secrets matched. (Clean, or patterns need broadening.)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
