#!/usr/bin/env python3
"""Read-only hook planning using the fragment merger's existing identity checks."""
import importlib.util
import json
from pathlib import Path
import sys

source, harness, target = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
spec = importlib.util.spec_from_file_location("merge_hooks", source / "fragments/merge-hooks.py")
merger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merger)
try:
    original = json.loads(target.read_bytes()) if target.exists() else {}
    fragment = json.loads((source / f"fragments/{harness}-hooks.json").read_bytes())
    document, _ = merger.merge_document(original, fragment)
    if harness == "codex" and document != original and merger.positional_preferences(target.with_name("config.toml"), target):
        raise ValueError("Codex positional disablement/preferences exist; review/remap them explicitly before changing hooks.json")
    print(json.dumps(document, indent=2))
except (OSError, ValueError) as error:
    print(f"hook preflight: {error}", file=sys.stderr)
    sys.exit(1)
