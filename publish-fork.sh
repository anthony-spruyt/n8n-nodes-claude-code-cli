#!/usr/bin/env bash
#
# Publish the fork's npm package (n8n-nodes-claude-code-cli-aspruyt).
#
# The fork keeps its npm identity — package name, homepage, repository — on a
# dedicated release branch (default: npm-publish-v3). That branch is otherwise
# content-identical to main; sync main into it and bump the version there before
# running this.
#
# Every npm step runs inside Docker on a pinned node image, matching CI, so the
# release build does not depend on whatever node/npm the host happens to have.
#
# Usage:
#   ./publish-fork.sh              # build, verify, then prompt before publishing
#   ./publish-fork.sh --dry-run    # build and verify only, never publishes
#   ./publish-fork.sh --yes        # skip the confirmation prompt
#
# Env overrides: RELEASE_BRANCH, NODE_IMAGE
set -euo pipefail

RELEASE_BRANCH="${RELEASE_BRANCH:-npm-publish-v3}"
NODE_IMAGE="${NODE_IMAGE:-node:24}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
	case "$arg" in
		--dry-run) DRY_RUN=1 ;;
		--yes|-y)  ASSUME_YES=1 ;;
		-h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "unknown argument: $arg" >&2; exit 2 ;;
	esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null || die "docker is required (npm runs in a pinned $NODE_IMAGE container)"
command -v git    >/dev/null || die "git is required"

# Docker Desktop's Windows credential helper fails from WSL; use a clean config
# so image pulls don't try to invoke it.
DOCKER_CONFIG="$(mktemp -d)"
printf '{}' > "$DOCKER_CONFIG/config.json"
export DOCKER_CONFIG

WORKTREE="$(mktemp -d)/release"
cleanup() {
	[ -d "$WORKTREE" ] && git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" 2>/dev/null || true
	rm -rf "$DOCKER_CONFIG" "$(dirname "$WORKTREE")" 2>/dev/null || true
}
trap cleanup EXIT

# Run npm as the invoking user so build output isn't left root-owned.
# HOME must be writable for npm's cache and the login session.
in_docker() {
	docker run --rm "$@" \
		--user "$(id -u):$(id -g)" \
		-e HOME=/tmp \
		-v "$WORKTREE":/w -w /w \
		"$NODE_IMAGE" sh -c "$DOCKER_CMD"
}

step "Fetching $RELEASE_BRANCH"
git -C "$REPO_ROOT" fetch origin "$RELEASE_BRANCH"
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "origin/$RELEASE_BRANCH" >/dev/null
git -C "$WORKTREE" log -1 --format='  %h %ad  %s' --date=short

PKG_NAME=$(grep -m1 '"name"'    "$WORKTREE/package.json" | sed 's/.*: *"\(.*\)".*/\1/')
PKG_VERSION=$(grep -m1 '"version"' "$WORKTREE/package.json" | sed 's/.*: *"\(.*\)".*/\1/')
TARBALL="${PKG_NAME}-${PKG_VERSION}.tgz"

if [ "$PKG_NAME" = "n8n-nodes-claude-code-cli" ]; then
	die "$RELEASE_BRANCH carries the UPSTREAM package name — wrong branch, or the fork rename was lost"
fi

step "Publishing target: $PKG_NAME@$PKG_VERSION"

step "Checking the registry"
DOCKER_CMD="npm view $PKG_NAME@$PKG_VERSION version 2>/dev/null || true"
if [ -n "$(in_docker)" ]; then
	die "$PKG_NAME@$PKG_VERSION is already published — npm versions are immutable. Bump the version on $RELEASE_BRANCH."
fi
DOCKER_CMD="npm view $PKG_NAME version 2>/dev/null || echo '(none)'"
echo "  current latest on npm: $(in_docker)"

step "Installing dependencies"
DOCKER_CMD="npm ci --no-audit --no-fund"
in_docker

step "Building"
DOCKER_CMD="npm run build"
in_docker

step "Linting and testing"
DOCKER_CMD="npm run lint && npm test"
in_docker

step "Packing"
DOCKER_CMD="npm pack --ignore-scripts"
in_docker
[ -f "$WORKTREE/$TARBALL" ] || die "expected tarball $TARBALL was not produced"
echo "  $TARBALL ($(du -h "$WORKTREE/$TARBALL" | cut -f1))"

if [ "$DRY_RUN" = 1 ]; then
	step "Dry run — verified, nothing published"
	# Keep the artifact around for inspection.
	cp "$WORKTREE/$TARBALL" "$REPO_ROOT/$TARBALL"
	echo "  tarball copied to $REPO_ROOT/$TARBALL"
	exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
	printf '\n\033[1;33mPublish %s@%s to npm? This is irreversible. [y/N] \033[0m' "$PKG_NAME" "$PKG_VERSION"
	read -r reply
	case "$reply" in [yY]*) ;; *) echo "aborted"; exit 1 ;; esac
fi

step "Logging in and publishing"
# Web auth: npm prints a npmjs.com URL — open it in your browser and complete
# auth (including MFA) there. --browser=false because the container has none.
# whoami guards against publishing as the wrong account.
# Publishing the tarball skips prepublishOnly, shipping exactly what was tested.
DOCKER_CMD="npm login --auth-type=web --browser=false && npm whoami && npm publish ./$TARBALL"
in_docker -it

step "Published $PKG_NAME@$PKG_VERSION"
