"""Self-test for secrets_scan.py: pins what the scanner must catch and must ignore.

Run: python scripts/secrets_scan_selftest.py
Exit 0 when every case behaves; exit 1 with the failing cases listed otherwise.
The values below are fakes built for this test. (scanner:ignore applies to this file's own text.)
"""
import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("secrets_scan", HERE / "secrets_scan.py")
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)
PATTERNS = scanner.secret_patterns()

# KNOWN_GAPS: documented residual misses in secret_patterns(), not asserted
# either way here (not MUST_FLAG, not MUST_IGNORE). Recorded so a future
# tightening pass has a known target instead of rediscovering it.
#   - The generic-secret-assignment exclusion (a) in secrets_scan.py hides any
#     value that is entirely letters, underscores, and dots with no digits, to
#     avoid flagging real code references (cfg.apiKey, process.env.X). A
#     literal secret typed in that same word.word.word shape with no digits,
#     e.g. SECRET=plain.dotted.words, is missed by the same exclusion.
#     Accepted for this gate; see the exclusion (a) comment for the reasoning.

# Lines the scanner MUST flag: real-shaped secrets assigned to secret-ish names.
MUST_FLAG = [
    "API_KEY=sk_live_8f3kd93jdmf83jfk",  # fake, scanner:ignore
    'token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD"',  # fake, scanner:ignore
    "password = hunter2hunter2hunter2",  # fake, scanner:ignore
    "DATABASE_PASSWORD=Xq9v2LmZp4Rt7Wn1",  # fake, scanner:ignore
    'authToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123xyz"',  # fake, scanner:ignore
    "SECRET=a9yourb8c7d6e5f4g3h2",  # fake, scanner:ignore
]

# Lines the scanner MUST NOT flag: code references and documented placeholders.
MUST_IGNORE = [
    "cohereApiKey: e.COHERE_API_KEY,",
    "const client = new Anthropic({ apiKey: cfg.anthropicApiKey });",
    "const client = new CohereClientV2({ token: cfg.cohereApiKey });",
    "COHERE_API_KEY=your-cohere-key-here",
    "ANTHROPIC_API_KEY=your-anthropic-key-here",
    "api_key = load_api_key()",
]


def flagged(line):
    return any(p.search(line) for _, p in PATTERNS)


def main():
    failures = []
    for line in MUST_FLAG:
        if not flagged(line):
            failures.append("MISSED  " + line)
    for line in MUST_IGNORE:
        if flagged(line):
            failures.append("NOISE   " + line)
    if failures:
        print("secrets_scan selftest FAILED:")
        for f in failures:
            print("  " + f)
        return 1
    print(f"secrets_scan selftest OK: {len(MUST_FLAG)} caught, {len(MUST_IGNORE)} ignored")
    return 0


if __name__ == "__main__":
    sys.exit(main())
