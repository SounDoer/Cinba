#!/bin/zsh
# Double-click launcher for the macOS Menu Bar and Desktop controller.

set -u

repository_root=${0:A:h}
typeset -a node_candidates
if [[ -n ${CINBA_NODE:-} ]]; then
  node_candidates+=("$CINBA_NODE")
fi
node_candidates+=(
  /opt/homebrew/opt/node@24/bin/node
  /usr/local/opt/node@24/bin/node
)
if (( $+commands[node] )); then
  node_candidates+=("$commands[node]")
fi

node_command=""
for candidate in "${node_candidates[@]}"; do
  [[ -x "$candidate" ]] || continue
  major_version=$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)
  if [[ "$major_version" == <-> ]] && (( major_version >= 24 )); then
    node_command="$candidate"
    break
  fi
done

if [[ -z "$node_command" ]]; then
  print -u2 "Cinba requires Node.js 24 or newer. Install it, then try again."
  print -n "Press Return to close..."
  read -r
  exit 1
fi

cd "$repository_root" || exit 1
"$node_command" "$repository_root/scripts/cinba.ts" desktop
exit_status=$?
if (( exit_status != 0 )); then
  print
  print -n "Cinba Desktop failed to start. Press Return to close..."
  read -r
fi
exit $exit_status
