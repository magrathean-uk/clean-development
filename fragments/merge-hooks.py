#!/usr/bin/python3 -I
"""Merge a clean-development 0.6.0 hooks fragment into a Claude settings.json or Codex hooks.json, in place.
Usage: merge-hooks.py FRAGMENT TARGET [--dry-run]
Removes every existing hook handler whose command mentions a clean-development runtime (0.2.1-0.5.0 under
'Application Support/clean-development', or any other runtime/clean-development/<version>), then appends the
fragment's matcher groups. Every other key and hook is kept. Writes TARGET atomically, keeping its mode."""
import json, os, re, sys, tempfile
frag_path, target = sys.argv[1], sys.argv[2]
dry = "--dry-run" in sys.argv
OLD = re.compile(r"Application Support/clean-development|/runtime/clean-development/")
frag = json.load(open(frag_path))
doc = json.load(open(target)) if os.path.exists(target) else {}
hooks = doc.setdefault("hooks", {})
removed = 0
for event, groups in list(hooks.items()):
    kept_groups = []
    for g in groups:
        hs = [h for h in g.get("hooks", []) if not OLD.search(str(h.get("command", "")))]
        removed += len(g.get("hooks", [])) - len(hs)
        if hs:
            kept_groups.append({**g, "hooks": hs})
    if kept_groups:
        hooks[event] = kept_groups
    else:
        del hooks[event]
for event, groups in frag["hooks"].items():
    hooks.setdefault(event, []).extend(groups)
text = json.dumps(doc, indent=2) + "\n"
if dry:
    print(f"would remove {removed} old clean-development handler(s) and add {sum(len(g) for g in frag['hooks'].values())} group(s)")
    sys.exit(0)
mode = os.stat(target).st_mode & 0o777 if os.path.exists(target) else 0o600
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target) or ".", prefix=".merge-")
with os.fdopen(fd, "w") as fh:
    fh.write(text)
os.chmod(tmp, mode)
os.replace(tmp, target)
print(f"{target}: removed {removed} old handler(s), added clean-development 0.6.0 hooks")
