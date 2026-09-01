const COMMANDS = [
  "scan",
  "audit",
  "link",
  "watch",
  "config",
  "login",
  "pull",
  "publish",
  "init",
  "doctor",
  "completion",
];

const BASH_SCRIPT = `_skillfn_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${COMMANDS.join(" ")}" -- "$cur"))
  fi
}
complete -F _skillfn_completions skillfn
`;

const ZSH_SCRIPT = `#compdef skillfn
_skillfn() {
  local -a commands
  commands=(${COMMANDS.join(" ")})
  _describe 'command' commands
}
_skillfn
`;

const FISH_SCRIPT = COMMANDS.map(
  (c) => `complete -c skillfn -n "__fish_use_subcommand" -a "${c}"`,
).join("\n") + "\n";

export function completionCommand(shell: string): void {
  const scripts: Record<string, string> = { bash: BASH_SCRIPT, zsh: ZSH_SCRIPT, fish: FISH_SCRIPT };
  const script = scripts[shell];
  if (!script) {
    console.error(`Unknown shell "${shell}". Supported: bash, zsh, fish.`);
    process.exitCode = 1;
    return;
  }
  // Prints to stdout only -- the user pipes/redirects this themselves
  // (e.g. `skillfn completion zsh > ~/.zsh/completions/_skillfn`), never written for them.
  console.log(script);
}
