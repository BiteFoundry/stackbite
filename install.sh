#!/bin/sh
# StackBite 0.7.6, source commit dc03f58f5ffcbe25edec859d0a3505bd34c4006f.
# macOS installs StackBite 0.6.0 (source commit 060019651abe60485a0cc39e72d99e8756e4aea2) until 0.7.6 has macOS bundles.
set -eu
run=yes
case "${1:-}" in
    '') ;;
    --no-run) run=no; shift ;;
    *) echo 'Usage: sh install.sh [--no-run]' >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo 'Usage: sh install.sh [--no-run]' >&2; exit 2; }
case "$(uname -s):$(uname -m)" in
    Darwin:arm64) version='0.6.0'; url='https://github.com/Shinick-Han/stackbite/releases/download/v0.6.0/stackbite-0.6.0-macos-arm64-060019651abe.tar.gz'; expected='4aafd7acb577c91fd3b16c15d27dced9226a2c72462682e0cbe61f2c3e54d639'; root='stackbite-0.6.0-macos-arm64-060019651abe'; hash=shasum ;;
    Darwin:x86_64) version='0.6.0'; url='https://github.com/Shinick-Han/stackbite/releases/download/v0.6.0/stackbite-0.6.0-macos-x86_64-060019651abe.tar.gz'; expected='bb3ea60fc214a659c93370250693d252aade1e39ef285808847b14b8cde04570'; root='stackbite-0.6.0-macos-x86_64-060019651abe'; hash=shasum ;;
    Linux:x86_64) version='0.7.6'; url='https://github.com/Shinick-Han/stackbite/releases/download/v0.7.6/stackbite-0.7.6-linux-x86_64-dc03f58f5ffc.tar.gz'; expected='22c774ced419c0c454d943c94ea3cd035d9e467de6831f8f5604dc145910d94e'; root='stackbite-0.7.6-linux-x86_64-dc03f58f5ffc'; hash=sha256sum ;;
    *) echo 'StackBite supports macOS arm64/x86_64 and Linux x86_64.' >&2; exit 1 ;;
esac
[ -n "$url" ] || { echo 'This installer has no reviewed release pin for this architecture.' >&2; exit 1; }
stage=$(mktemp -d "${TMPDIR:-/tmp}/stackbite-install.XXXXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf 'Installing StackBite %s...\n' "$version"
curl -fsSL "$url" -o "$stage/archive.tar.gz"
if [ "$hash" = shasum ]; then
    actual=$(shasum -a 256 "$stage/archive.tar.gz")
else
    actual=$(sha256sum "$stage/archive.tar.gz")
fi
actual=${actual%% *}
[ "$actual" = "$expected" ] || { echo 'Archive SHA256 mismatch.' >&2; exit 1; }
tar -xzf "$stage/archive.tar.gz" -C "$stage"
if ! sh "$stage/$root/install.sh" > "$stage/install.log" 2>&1; then
    echo 'StackBite installation failed:' >&2
    tail -c 4096 "$stage/install.log" >&2
    exit 1
fi
launcher=$HOME/.local/bin/stackbite
case ":${PATH:-}:" in
    *:"$HOME/.local/bin":*) ;;
    *)
        profile=
        case "${SHELL:-}" in
            */zsh) profile=${ZDOTDIR:-$HOME}/.zshrc ;;
            */sh|*/dash) profile=$HOME/.profile ;;
            */bash)
                if [ "$hash" = shasum ]; then
                    profile=$HOME/.bash_profile
                    for candidate in .bash_profile .bash_login .profile; do
                        if [ -f "$HOME/$candidate" ] && [ -r "$HOME/$candidate" ]; then
                            profile=$HOME/$candidate
                            break
                        fi
                    done
                else profile=$HOME/.bashrc; fi ;;
        esac
        if [ -n "$profile" ]; then
            line='export PATH="$HOME/.local/bin:$PATH" # StackBite'
            if grep -Fqx "$line" "$profile" 2>/dev/null || (printf '\n%s\n' "$line" >> "$profile") 2>/dev/null; then
                printf 'StackBite is on PATH in new shells (%s).\n' "$profile"
            else
                printf 'Run %s; add %s to your shell PATH for the short command.\n' "$launcher" "$HOME/.local/bin"
            fi
        else
            printf 'Run %s (add %s to PATH if desired).\n' "$launcher" "$HOME/.local/bin"
        fi ;;
esac
printf 'Installed StackBite: %s\n' "$launcher"
cleanup
trap - EXIT HUP INT TERM
if [ "$run" = yes ] && [ -t 1 ]; then
    printf 'Starting StackBite...\n'
    if [ -t 0 ]; then
        "$launcher"
    else
        exec 3<&1
        terminal=$(tty <&3)
        exec 3<&-
        "$launcher" < "$terminal"
    fi
fi
