#!/usr/bin/env bash
# Builds a kit's release zip from committed files only (git archive), so nothing ignored or uncommitted can get in.
#
#   kits/build.sh <kit> [ref]     ref: the commit to build from (default: the kit's tag, <kit>-v<version>)
#
# Writes dist/kits/<kit>-v<version>.zip and its .sha256 (KIT_OUT=<dir> to change the folder).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

kit=${1:?usage: kits/build.sh <kit> [ref]}
manifest=kits/$kit/kit.json
[ -f "$manifest" ] || { echo "No manifest $manifest" >&2; exit 1; }
field() { node -e 'const m=require(process.argv[1]); const v=m[process.argv[2]]; console.log(Array.isArray(v) ? v.map((e) => typeof e === "string" ? e : e.from + "\t" + e.to).join("\n") : v)' "./$manifest" "$1"; }

[ "$(field name)" = "$kit" ] || { echo "$manifest: name must be $kit" >&2; exit 1; }
version=$(field version)
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "$manifest: version must be MAJOR.MINOR.PATCH" >&2; exit 1; }
tag=$kit-v$version
ref=${2:-$tag}
commit=$(git rev-parse -q --verify "$ref^{commit}") || { echo "$ref is not a commit: tag the release first (see kits/README.md), or pass a ref" >&2; exit 1; }

out=$(mkdir -p "${KIT_OUT:-dist/kits}" && cd "${KIT_OUT:-dist/kits}" && pwd)
stage=$(mktemp -d); trap 'rm -rf "${stage:?}"' EXIT
mkdir -p "$stage/src" "$stage/$tag"
while IFS=$'\t' read -r from to; do
  git archive --format=tar "$commit" -- "$from" | tar -x -C "$stage/src"
  mkdir -p "$(dirname "$stage/$tag/$to")"
  mv "$stage/src/$from" "$stage/$tag/$to"
done < <(field include)
while read -r file; do
  printf '%s %s\ncommit %s\n' "$kit" "$version" "$(git rev-parse --short "$commit")" > "$stage/$tag/$file"
done < <(field versionFiles)

rm -f "${out:?}/${tag:?}.zip" "${out:?}/${tag:?}.zip.sha256"
(cd "$stage" && zip -qrX "$out/$tag.zip" "$tag")
(cd "$out" && shasum -a 256 "$tag.zip" > "$tag.zip.sha256")
echo "$out/$tag.zip ($(find "$stage/$tag" -type f | wc -l | tr -d ' ') files, from $(git rev-parse --short "$commit"))"
