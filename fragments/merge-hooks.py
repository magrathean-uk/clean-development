#!/usr/bin/python3 -I
"""Merge a clean-development hooks fragment into Claude settings.json or Codex hooks.json.
Usage: merge-hooks.py FRAGMENT TARGET [--dry-run]
Replaces managed runtime handlers in place, preserving unrelated positional identities.
Missing managed events are appended; ambiguous duplicates/obsolete events are refused.
Other keys/hooks are kept. Positional Codex preferences require manual review
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


def merge_document(original, fragment):
    """Replace managed handlers in place, so unrelated Codex positional IDs stay stable."""
    doc = json.loads(json.dumps(original))
    hooks = doc.setdefault("hooks", {})
    count = 0
    for event, groups in fragment["hooks"].items():
        if len(groups) != 1 or len(groups[0].get("hooks", [])) != 1:
            raise ValueError("release fragment topology changed; review handler identity mapping")
        desired_group = groups[0]
        desired = desired_group["hooks"][0]
        found = []
        for gi, group in enumerate(hooks.get(event, [])):
            for hi, handler in enumerate(group.get("hooks", [])):
                if OLD.search(str(handler.get("command", ""))):
                    invocation = re.fullmatch(r"(?:'([^']+)'|\"([^\"]+)\"|([^\s]+)) (session-start|stop|session-end) (claude|codex)", str(handler.get("command", "")))
                    expected_action = {"SessionStart": "session-start", "Stop": "stop", "SessionEnd": "session-end"}.get(event)
                    if (handler.get("type") != "command" or not invocation or invocation[4] != expected_action
                            or not (invocation[1] or invocation[2] or invocation[3]).endswith("/bin/cd-hook")):
                        raise ValueError("customized managed command requires review: " + event)
                    found.append((gi, hi))
        if len(found) > 1:
            raise ValueError("duplicate managed handlers require review: " + event)
        if not found:
            hooks.setdefault(event, []).append(json.loads(json.dumps(desired_group)))
            continue
        gi, hi = found[0]
        group = hooks[event][gi]
        if len(group["hooks"]) > 1 and group.get("matcher") != desired_group.get("matcher"):
            raise ValueError("shared matcher change would affect unrelated handlers: " + event)
        group["hooks"][hi] = {**group["hooks"][hi], **desired}
        for key, value in desired_group.items():
            if key != "hooks":
                group[key] = value
        count += 1
    for event, groups in hooks.items():
        if event not in fragment["hooks"] and any(OLD.search(str(h.get("command", ""))) for g in groups for h in g.get("hooks", [])):
            raise ValueError("obsolete managed event requires explicit review: " + event)
    return doc, count


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
    original = json.loads(before) if before is not None else {}
    doc, removed = merge_document(original, frag)
    if target.name == "hooks.json" and doc != original and positional_preferences(target.with_name("config.toml"), target):
        raise ValueError("Codex positional disablement/preferences exist; review/remap them explicitly before changing hooks.json")
    text = (json.dumps(doc, indent=2) + "\n").encode()
    if args.dry_run:
        print(f"would reconcile {removed} managed handler(s) in place; unrelated handler positions retained; no writes")
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
    print(f"{target}: reconciled {removed} managed handler(s) in place; recovery copy in {backup_dir}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"merge-hooks: {error}", file=sys.stderr)
        sys.exit(1)
