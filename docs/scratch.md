# Explicit scratch allocation and logging

Use `clean-development scratch --prefix verification --json` to create a private,
unique directory beneath the selected scratch root. `--dry-run` previews the
allocation without creating it. The selected root must already exist, be writable,
and be outside source. The command never selects another root or recreates a
missing base. Disabled projects remain disabled.

The marker records only the directory identity and creation time. It grants no
pruning authority. Keep original evidence and final deliverables outside disposable
scratch, and handle cleanup through the owning tool.

Shell redirections occur in the parent shell. Wrapping a command cannot relocate
an explicit log or screenshot path. Allocate and validate the directory first,
then derive those paths from the returned `path` field:

```sh
# selected_log is an absolute path within the allocated directory.
clean-development run --session session-only -- swift test > "$selected_log" 2>&1
child_status=$?
tail -50 "$selected_log"
exit "$child_status"
```

Saving the status before displaying the log prevents `tail` from hiding the test
failure. The wrapper preserves the child status; a caller's later shell command
can still replace it. This workflow is opt-in and adds no automatic command log.
Screenshot runners and temporary dependency tools must likewise receive explicit
paths derived from the allocation. Existing caller overrides remain unchanged.
