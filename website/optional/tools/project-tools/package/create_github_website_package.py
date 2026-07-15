#!/usr/bin/env python3
"""Create a GitHub-ready website source package."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import stat
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
OUTPUT_DIR = ROOT / "packages" / "github-website"


WEBSITE_FILES = [
    ".env.example",
    "config/default-dividend-config.template.json",
    "config/import-templates/overnight-interest-settings.csv",
    "install/install-linux.sh",
    "optional/local-test/WINDOWS_TODAY_TEST.html",
    "optional/local-test/check-runtime.bat",
    "optional/local-test/run_local.py",
    "optional/local-test/start-web.bat",
    "optional/local-test/start-web.command",
    "optional/tests/integration/pluginPortal.test.mjs",
    "optional/tests/integration/webApi.test.mjs",
    "optional/tests/unit/accountScope.test.mjs",
    "optional/tests/unit/calculationAndDryRun.test.mjs",
    "optional/tests/unit/mappingMatcher.test.mjs",
    "optional/tests/unit/patterns.test.mjs",
    "optional/tests/unit/storage.test.mjs",
    "optional/tools/project-tools/dev/load_test_environment.py",
    "optional/tools/project-tools/docs/build_all_docs_html.py",
    "optional/tools/project-tools/package/create_github_website_package.py",
    "optional/tools/project-tools/package/create_portal_packages.py",
    "optional/tools/project-tools/package/create_run_package.py",
    "src/adapters/finnhub/FinnhubDividendClient.mjs",
    "src/adapters/mail/AuditMailComposer.mjs",
    "src/adapters/mock/MockExecutionAdapter.mjs",
    "src/adapters/storage/createLedger.mjs",
    "src/core/calculation/dividendCalculator.mjs",
    "src/core/domain/defaultConfig.mjs",
    "src/core/dry-run/dryRunEngine.mjs",
    "src/core/execution/applyEngine.mjs",
    "src/core/idempotency/idempotencyKey.mjs",
    "src/core/review/reviewPolicy.mjs",
    "src/core/rules/accountScope.mjs",
    "src/core/rules/mappingMatcher.mjs",
    "src/core/rules/patterns.mjs",
    "src/jobs/sync/finnhubSyncJob.mjs",
    "src/storage/migrations/001_initial_schema.sql",
    "src/storage/repositories/SqliteLedger.mjs",
    "src/web/api/pluginPortal.mjs",
    "src/web/api/server.mjs",
    "src/web/ui/app.mjs",
    "src/web/ui/index.html",
    "src/web/ui/styles.css",
]

WEBSITE_REPO_FILES = [
    ".editorconfig",
    ".gitignore",
    "VERSION",
    "index.html",
    "package.json",
    *[f"website/{item}" for item in WEBSITE_FILES],
]


EMPTY_DIRS: list[str] = []


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def mode_for(rel: str) -> int:
    mode = 0o755 if rel.endswith(".py") or rel.endswith(".command") or rel.endswith(".sh") else 0o644
    return (stat.S_IFREG | mode) << 16


def write_file(archive: zipfile.ZipFile, source_rel: str, target_rel: str) -> None:
    path = ROOT / source_rel
    if not path.is_file():
        raise SystemExit(f"Missing GitHub package file: {source_rel}")
    info = zipfile.ZipInfo(target_rel)
    info.external_attr = mode_for(source_rel)
    archive.writestr(info, path.read_bytes())


def write_text(archive: zipfile.ZipFile, target_rel: str, text: str) -> None:
    info = zipfile.ZipInfo(target_rel)
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    archive.writestr(info, text)


def write_empty_dir(archive: zipfile.ZipFile, target_rel: str) -> None:
    info = zipfile.ZipInfo(target_rel)
    info.external_attr = (stat.S_IFDIR | 0o755) << 16
    archive.writestr(info, b"")


def github_install_readme(version: str) -> str:
    return f"""# Dividend Uploader GitHub Website Install

Version: {version}

This package is prepared for uploading the website source to GitHub and then
installing it on a Linux server with `git clone`.

It intentionally excludes runtime data, generated packages, Visual Studio DLL
projects, and official SDK file sets. Build DLL plugin projects separately on
Windows.

## Upload To GitHub

1. Create an empty GitHub repository.
2. Unzip this package locally.
3. Upload or commit the unzipped folder contents to that repository.
4. Keep `.env`, `website/runtime/data/`, `website/runtime/logs/`, and `website/runtime/portal-data/`
   out of GitHub.

## Install On Linux Server

```bash
sudo mkdir -p /opt/dividend-uploader /opt/dividend-uploader-data
sudo chown -R $USER:$USER /opt/dividend-uploader /opt/dividend-uploader-data
git clone https://github.com/<your-org>/<your-repo>.git /opt/dividend-uploader
cd /opt/dividend-uploader
sudo bash website/install/install-linux.sh
```

Create production environment variables:

```text
DIVIDEND_UPLOADER_PORTAL_DATA_DIR=/opt/dividend-uploader-data/portal-data
DIVIDEND_UPLOADER_DB=/opt/dividend-uploader-data/runtime/dividend-uploader.db
DIVIDEND_UPLOADER_ADMIN_USER=<first-admin>
DIVIDEND_UPLOADER_ADMIN_PASSWORD=<temporary-password>
DIVIDEND_UPLOADER_JWT_SECRET=<at-least-32-random-bytes>
DIVIDEND_UPLOADER_HOST=127.0.0.1
DIVIDEND_UPLOADER_PUBLIC_BASE_URL=https://test.appcdn002.com
PORT=4173
```

Start:

```bash
npm start
```

Public plugin URLs:

```text
https://test.appcdn002.com/admin-api/dividend-uploader-public/active-meta.json
https://test.appcdn002.com/admin-api/dividend-uploader-public/active.json
https://test.appcdn002.com/admin-api/dividend-uploader-feedback
```

The base URL above is only the default. Change it in the admin page field
`Configuration / Remote Sync / Plugin sync base URL`, or set
`DIVIDEND_UPLOADER_PUBLIC_BASE_URL` before the first configuration is created.

## Admin Page Flow

1. Use `CSV Data` for daily CSV import, export, and in-page row editing.
2. Use `Configuration / Products` for the low-change product list.
3. Use `Configuration / Environment / Target` for platform, server, and effective time.
4. Use `Configuration / Environment / Time Zone` for the website business timezone
   and plugin timezone source. The default plugin source is the MT4/MT5 server timezone.
5. Use `Configuration / Remote Sync` for the plugin JSON base URL and filename.
6. Click `Apply To JSON`, then save and publish from `Plugin Sync`.

## Upgrade From GitHub

```bash
cd /opt/dividend-uploader
git pull
sudo systemctl restart dividend-uploader.service
```

The data directory `/opt/dividend-uploader-data` must remain outside the GitHub
repository and must not be overwritten during upgrade.
"""


def file_manifest(version: str, files: list[str]) -> str:
    lines = [
        "# Dividend Uploader GitHub Website Package Manifest",
        "",
        f"Version: `{version}`",
        f"Generated: `{dt.datetime.now().isoformat(timespec='seconds')}`",
        "",
        "## Included Files",
        "",
    ]
    lines.extend(f"- `{item}`" for item in files)
    lines.extend(
        [
            "",
            "## Excluded From This GitHub Package",
            "",
            "- `packages/` generated ZIP files",
            "- `website/runtime/` data files",
            "- Visual Studio DLL plugin projects",
            "- official SDK file sets",
            "- local secrets such as `.env`",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = OUTPUT_DIR / f"{stamp}_v{version}"
    out_dir.mkdir(parents=True, exist_ok=True)

    package_name = f"DividendUploader_GITHUB_WEBSITE_REPO_v{version}.zip"
    package_path = out_dir / package_name
    repo_prefix = f"DividendUploader-GitHub-Website-v{version}/"

    with zipfile.ZipFile(package_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for rel in sorted(WEBSITE_REPO_FILES):
            write_file(archive, rel, repo_prefix + rel)
        for rel in EMPTY_DIRS:
            write_empty_dir(archive, repo_prefix + rel)
        write_text(archive, repo_prefix + "GITHUB-INSTALL.txt", github_install_readme(version))
        write_text(archive, repo_prefix + "GITHUB-FILE-MANIFEST.txt", file_manifest(version, sorted(WEBSITE_REPO_FILES)))

    digest = sha256_file(package_path)
    (package_path.with_suffix(package_path.suffix + ".sha256.txt")).write_text(
        f"{digest}  {package_name}\n",
        encoding="utf-8",
    )

    manifest = {
        "version": version,
        "createdAt": dt.datetime.now().isoformat(timespec="seconds"),
        "package": package_name,
        "sha256": digest,
        "fileCount": len(WEBSITE_REPO_FILES) + len(EMPTY_DIRS) + 2,
        "repoPrefix": repo_prefix,
        "excluded": ["packages/", "runtime data", "full official SDK file sets", ".env"],
    }
    (out_dir / "PACKAGE-MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUTPUT_DIR / "LATEST_GITHUB_WEBSITE_PACKAGE.txt").write_text(
        f"Latest GitHub website package: {package_path}\nSHA256: {digest}\n",
        encoding="utf-8",
    )
    print(f"GitHub website package created: {package_path}")
    print(f"SHA256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
