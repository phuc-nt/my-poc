# Kits

Reusable packages built from the PoCs, released as zip files on the repository's GitHub releases. Each kit has a folder here with three files:
- `kit.json`: its name, its version and the files that go in it;
- `KIT.md`: the readme inside the zip;
- `CHANGELOG.md`.

| Kit | Version | From | What it is |
|---|---|---|---|
| [api-test-agent-kit](api-test-agent-kit/KIT.md) | 1.0.0 | PoC 4 | A Playwright Test API suite with the rules, skills, test-case catalogue and tooling that let a coding agent set up, write, maintain and sync API tests |

## Names and versions

- **Kit name**: lowercase words with dashes, ending in `-kit` (`api-test-agent-kit`). It never changes once released.
- **Version**: [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`), set in `kit.json`. Each kit's `CHANGELOG.md` says what each level means for that kit.
- **Git tag and release**: `<kit>-v<version>` (`api-test-agent-kit-v1.0.0`). Each kit has its own series of tags, so kits release independently.
- **Release title**: `<title> v<version>` (`API test agent kit v1.0.0`).
- **Assets**: `<kit>-v<version>.zip`, which holds one folder of the same name, and `<kit>-v<version>.zip.sha256`. Inside the zip, `VERSION` (and every other file listed in `versionFiles`) records the kit, the version and the commit.

## Release a kit

1. Bump the version in `kits/<kit>/kit.json`, write the `CHANGELOG.md` entry and update the table above. Commit and push to `main`.
2. Tag, build from the tag, check, and publish, from the repository root:

```bash
kit=api-test-agent-kit
version=$(node -p "require('./kits/$kit/kit.json').version")
title=$(node -p "require('./kits/$kit/kit.json').title")
tag=$kit-v$version
git tag -a "$tag" -m "$title v$version" && git push origin "$tag"
kits/build.sh "$kit"                 # dist/kits/$tag.zip and .sha256, built from the tag
# Unzip it and read what is inside before publishing: the repository is public.
gh release create "$tag" "dist/kits/$tag.zip" "dist/kits/$tag.zip.sha256" --title "$title v$version" --notes-file notes.md
```

The release notes are the version's `CHANGELOG.md` entry plus the install summary from `KIT.md`.

GitHub marks only one release of the repository as "Latest", whatever the kit. When you release a fix to one kit while another kit has a newer release, pass `--latest=false`.
