"""The clean-room guard.

A public repository is a bad place to leak a private trading system. This
script fails the build if anything that belongs to the personal system
appears in the tree or in the commit history.

What it looks for:

* the names of the personal system's components
* the indicator parameter pairs that were reverse engineered from the
  screenshots - the pairs themselves, written either as ``33/101`` or as
  two separate numbers
* the broker account, the server name, the order's magic numbers and the
  machine's addresses, none of which belong in a public repo
* the wallet's private key, which must never leave ``.secrets/``

Run it directly, or let CI run it on every push:

    python scripts/cleanroom_guard.py
    python scripts/cleanroom_guard.py --history
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: Files that are allowed to contain a term, because the term is the point
#: (this file, and the documentation of the rule itself).
ALLOWED = {
    "scripts/cleanroom_guard.py",
    ".github/workflows/cleanroom.yml",
    "CLEANROOM.md",
    "README.md",
}

#: Plain substrings. A hit is a failure.
FORBIDDEN_SUBSTRINGS = [
    # the personal system's component names
    "tsts", "bokk", "sniper", "signal_combo", "bs_detector", "bs detector",
    "safety trade", "ultimate_combo", "drt.pine", "tsts_rules",
    # infrastructure that identifies the owner's own setup
    "81782883", "exness-mt5trial10", "quanttekel", "10562689",
    "84.12.81.247", "20261012",
]

#: Regular expressions for the parameter pairs, written both ways.
FORBIDDEN_PATTERNS = [
    r"\b33\s*/\s*101\b", r"\b83\s*/\s*104\b", r"\b99\s*/\s*100\b",
    r"\b89\s*/\s*109\b", r"\b76\s*/\s*112\b", r"\b62\s*/\s*91\b",
    r"\b14\s*/\s*51\s*/\s*393\b", r"\b12\s*/\s*20\s*/\s*916\b",
    r"\b10\s*/\s*4\s*/\s*90\b",
    # the MACD pairs written as two inputs in one line
    r"fast[^\n]{0,20}33[^\n]{0,20}slow[^\n]{0,20}101",
    r"fast[^\n]{0,20}83[^\n]{0,20}slow[^\n]{0,20}104",
    r"fast[^\n]{0,20}99[^\n]{0,20}slow[^\n]{0,20}100",
]


def tracked_files() -> list:
    try:
        out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True,
                             text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    return [line for line in out.splitlines() if line.strip()]


def scan_text(text: str, name: str) -> list:
    hits = []
    lowered = text.lower()
    for needle in FORBIDDEN_SUBSTRINGS:
        if needle in lowered:
            hits.append(f"{name}: contains {needle!r}")
    for pattern in FORBIDDEN_PATTERNS:
        for match in re.finditer(pattern, text, re.I):
            hits.append(f"{name}: matches {pattern!r} -> {match.group(0)!r}")
    return hits


def scan_tree() -> list:
    hits = []
    for relative in tracked_files():
        if relative in ALLOWED:
            continue
        path = ROOT / relative
        if not path.is_file():
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        if b"\x00" in raw[:2048]:
            continue          # binary
        for encoding in ("utf-8", "utf-16"):
            try:
                text = raw.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            text = raw.decode("latin-1", "replace")
        hits.extend(scan_text(text, relative))
    return hits


def scan_history() -> list:
    """Every blob that has ever been committed."""
    hits = []
    try:
        objects = subprocess.run(
            ["git", "rev-list", "--objects", "--all"], cwd=ROOT,
            capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    seen = set()
    for line in objects.splitlines():
        sha = line.split(" ")[0].strip()
        if not sha or sha in seen:
            continue
        seen.add(sha)
        try:
            kind = subprocess.run(["git", "cat-file", "-t", sha], cwd=ROOT,
                                  capture_output=True, text=True).stdout.strip()
            if kind != "blob":
                continue
            text = subprocess.run(["git", "cat-file", "-p", sha], cwd=ROOT,
                                  capture_output=True).stdout.decode("utf-8", "replace")
        except OSError:
            continue
        # This script defines the forbidden strings, so it necessarily contains
        # them. A blob carrying the guard's own source is the guard, not a
        # leak. The same applies to the CI workflow, which names the script.
        if "FORBIDDEN_SUBSTRINGS" in text or "cleanroom_guard.py" in text:
            continue
        hits.extend(scan_text(text, f"blob:{sha[:10]}"))
    return hits


def scan_secrets() -> list:
    """The wallet private key must not be anywhere in the tree."""
    hits = []
    secret = ROOT.parent / ".secrets" / "wallet.json"
    if not secret.is_file():
        return hits
    import json
    try:
        key = json.loads(secret.read_text(encoding="utf-8")).get("private_key_hex", "")
    except (OSError, ValueError):
        return hits
    if not key:
        return hits
    for relative in tracked_files():
        path = ROOT / relative
        if not path.is_file():
            continue
        try:
            if key.encode() in path.read_bytes():
                hits.append(f"{relative}: contains the wallet PRIVATE KEY")
        except OSError:
            continue
    return hits


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", action="store_true", help="also scan every committed blob")
    args = ap.parse_args()

    hits = scan_tree()
    hits += scan_secrets()
    if args.history:
        hits += scan_history()

    if hits:
        print("CLEAN-ROOM GUARD: FAILED")
        for hit in hits:
            print("  -", hit)
        print()
        print("Nothing from the personal trading system may be published. Remove the")
        print("offending content before pushing - and if it was already pushed, rotate")
        print("whatever was exposed.")
        return 1

    scope = "the working tree, the secrets and every committed blob" if args.history \
        else "the working tree and the secrets"
    print(f"clean-room guard passed - {scope} contain nothing from the personal system")
    return 0


if __name__ == "__main__":
    sys.exit(main())
