import path from "node:path";
import { environmentValue } from "./platform.js";

function escapeCmd(value) {
  return value.replace(/[()\[\]%!^"`<>&|;, *?]/g, (character) => `^${character}`);
}

function quoteWindowsArgument(value) {
  // Quote for the Windows argv parser before protecting cmd.exe metacharacters.
  let quoted = '"';
  let backslashes = 0;
  for (const character of String(value)) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

export function windowsBatchInvocation(command, args, env) {
  if ([command, ...args].some((value) => /[\r\n\0]/.test(String(value)))) {
    throw new Error("Windows batch commands cannot contain newlines or NUL bytes");
  }
  // A .cmd/.bat wrapper expands %* in a second cmd.exe parse, regardless of
  // whether it lives under node_modules/.bin. Protect metacharacters through
  // both parses; the final native executable still receives ordinary argv.
  const escapedArgs = args.map((value) => escapeCmd(escapeCmd(quoteWindowsArgument(value))));
  // An unprotected equals sign also terminates the command token. Arguments
  // already carry their own quotes; keep their established encoding unchanged.
  const escapedCommand = escapeCmd(path.win32.normalize(command)).replace(/=/g, "^=");
  const commandLine = [escapedCommand, ...escapedArgs].join(" ");
  return {
    command: environmentValue(env, "ComSpec") || "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}
