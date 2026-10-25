#!/usr/bin/python3 -I
"""Merge a clean-development hooks fragment into Claude settings.json or Codex hooks.json.
Usage: merge-hooks.py FRAGMENT TARGET [--dry-run]
Removes every existing hook handler whose command mentions a clean-development runtime (0.2.1-0.5.0 under
'Application Support/clean-development', or any other runtime/clean-development/<version>), then appends the
fragment's matcher groups. Other keys/hooks are kept. Positional Codex preferences require manual review
before changing hooks. Real writes preserve a private recovery copy and receipt; preview never writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import uuid

OLD = re.compile(r"Application Support/clean-development|/runtime/clean-development/|/clean-development/runtime/")


def positional_preferences(config, target):
    """Conservative inspection, not a general TOML parser; never execute configuration."""
    if not config.exists():
        return False
    prefix = str(target.absolute()) + ":"
    current = False
    root_state = root_hooks = False
    for line in config.read_text().splitlines():
        header = re.match(r'^\s*\[hooks\.state\.("(?:[^"\\]|\\.)*")\]\s*(?:#.*)?$', line)
        if header:
            root_state = root_hooks = False
            try:
                current = json.loads(header[1]).startswith(prefix)
            except ValueError:
                return True
        elif re.match(r'^\s*\[', line):
            current = False
            compact = re.sub(r'''["'\s]''', '', line).split('#')[0]
            if compact.startswith('[hooks.state.'):
                return True  # unsupported identity spelling needs the host's TOML-aware review
            root_state = compact == '[hooks.state]'
            root_hooks = compact == '[hooks]'
        elif ((root_state and line.strip() and not line.lstrip().startswith('#'))
              or (root_hooks and re.match(r'^\s*state\s*=', line)) or re.match(r'^\s*hooks\s*=', line)):
            return True
        elif current and line.strip() and not line.lstrip().startswith("#") and not re.match(r'^\s*trusted_hash\s*=', line):
            return True
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fragment", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    target = args.target
    if not target.parent.is_dir():
        raise ValueError("target parent must already exist")
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError("refusing a linked or non-regular target")
    before = target.read_bytes() if target.exists() else None
    frag = json.loads(args.fragment.read_text())
    doc = json.loads(before) if before is not None else {}
    original = json.loads(json.dumps(doc))
    hooks = doc.setdefault("hooks", {})
    removed = 0
    for event, groups in list(hooks.items()):
        kept_groups = []
        for group in groups:
            handlers = [h for h in group.get("hooks", []) if not OLD.search(str(h.get("command", "")))]
            removed += len(group.get("hooks", [])) - len(handlers)
            if handlers:
                kept_groups.append({**group, "hooks": handlers})
        if kept_groups:
            hooks[event] = kept_groups
        else:
            del hooks[event]
    for event, groups in frag["hooks"].items():
        hooks.setdefault(event, []).extend(groups)
    if target.name == "hooks.json" and doc != original and positional_preferences(target.with_name("config.toml"), target):
        raise ValueError("Codex positional disablement/preferences exist; review/remap them explicitly before changing hooks.json")
    text = (json.dumps(doc, indent=2) + "\n").encode()
    if args.dry_run:
        print(f"would remove {removed} old handler(s) and add {sum(len(g) for g in frag['hooks'].values())} group(s); no writes")
        return 0
    if text == before:
        print(f"{target}: unchanged")
        return 0
    mode = stat.S_IMODE(target.stat().st_mode) if before is not None else 0o600
    backup_dir = Path.home() / "dev/machine/state/clean-development/hook-backups" / str(uuid.uuid4())
    backup_dir.mkdir(mode=0o700, parents=True)
    if before is not None:
        backup = backup_dir / "original"
        with backup.open("xb") as out:
            os.chmod(backup, 0o600)
            out.write(before); out.flush(); os.fsync(out.fileno())
    receipt = {"target": str(target.absolute()), "status": "prepared", "originalMode": mode,
               "beforeHash": hashlib.sha256(before).hexdigest() if before is not None else None,
               "afterHash": hashlib.sha256(text).hexdigest()}
    (backup_dir / "receipt.json").write_text(json.dumps(receipt) + "\n")
    fd, temp = tempfile.mkstemp(dir=target.parent, prefix=".merge-")
    try:
        with os.fdopen(fd, "wb") as out:
            os.fchmod(out.fileno(), mode); out.write(text); out.flush(); os.fsync(out.fileno())
        if (target.read_bytes() if target.exists() else None) != before:
            raise ValueError("target changed after preview; retaining recovery copy")
        os.replace(temp, target)
    finally:
        Path(temp).unlink(missing_ok=True)
    receipt["status"] = "completed"
    (backup_dir / "receipt.json").write_text(json.dumps(receipt) + "\n")
    print(f"{target}: removed {removed} old handler(s); recovery copy in {backup_dir}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"merge-hooks: {error}", file=sys.stderr)
        sys.exit(1)
