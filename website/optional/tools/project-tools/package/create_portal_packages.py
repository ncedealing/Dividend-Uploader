#!/usr/bin/env python3
"""Create install, upgrade, and MT4/MT5 plugin source packages."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import stat
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
OUTPUT_DIR = ROOT / "packages" / "plugin-config-portal"


WEBSITE_FILES = [
    ".env.example",
    "config/default-dividend-config.template.json",
    "config/import-templates/overnight-interest-settings.csv",
    "install/install-linux.sh",
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

PLUGIN_AND_SDK_FILES = [
    "plugins/mt4/DividendUploaderMT4RemoteConfigPlugin.cpp",
    "plugins/mt4/PluginDllMain.cpp",
    "plugins/mt4/DividendUploaderMT4RemoteConfigPlugin.sln",
    "plugins/mt4/DividendUploaderMT4RemoteConfigPlugin.vcxproj",
    "plugins/mt4/DividendUploaderMT4RemoteConfigPlugin.vcxproj.filters",
    "plugins/mt5/DividendUploaderMT5RemoteConfigPlugin.cpp",
    "plugins/mt5/PluginDllMain.cpp",
    "plugins/mt5/DividendUploaderMT5RemoteConfigPlugin.sln",
    "plugins/mt5/DividendUploaderMT5RemoteConfigPlugin.vcxproj",
    "plugins/mt5/DividendUploaderMT5RemoteConfigPlugin.vcxproj.filters",
    "sdk/mt4/PUT_MT4_SERVER_PLUGIN_SDK_FILES_HERE.txt",
    "sdk/mt5/PUT_MT5_SERVER_PLUGIN_SDK_FILES_HERE.txt",
]

SITE_FILES = [
    "VERSION",
    "index.html",
    "package.json",
    *[f"website/{item}" for item in WEBSITE_FILES],
]

MT4_FILES = [
    "index.html",
    "plugins/mt4/DividendUploaderMT4RemoteConfigPlugin.cpp",
    "plugins/mt4/PluginDllMain.cpp",
    "plugins/mt4/DividendUploaderMT4RemoteConfigPlugin.sln",
    "plugins/mt4/DividendUploaderMT4RemoteConfigPlugin.vcxproj",
    "plugins/mt4/DividendUploaderMT4RemoteConfigPlugin.vcxproj.filters",
    "sdk/mt4/PUT_MT4_SERVER_PLUGIN_SDK_FILES_HERE.txt",
]

MT5_FILES = [
    "index.html",
    "plugins/mt5/DividendUploaderMT5RemoteConfigPlugin.cpp",
    "plugins/mt5/PluginDllMain.cpp",
    "plugins/mt5/DividendUploaderMT5RemoteConfigPlugin.sln",
    "plugins/mt5/DividendUploaderMT5RemoteConfigPlugin.vcxproj",
    "plugins/mt5/DividendUploaderMT5RemoteConfigPlugin.vcxproj.filters",
    "sdk/mt5/PUT_MT5_SERVER_PLUGIN_SDK_FILES_HERE.txt",
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def mode_for(rel: str) -> int:
    mode = 0o755 if rel.endswith(".py") or rel.endswith(".command") or rel.endswith(".sh") else 0o644
    return (stat.S_IFREG | mode) << 16


def write_files(archive: zipfile.ZipFile, files: list[str], prefix: str = "") -> None:
    missing = [item for item in files if not (ROOT / item).is_file()]
    if missing:
        raise SystemExit(f"Missing package files: {missing}")
    for rel in sorted(files):
        info = zipfile.ZipInfo(f"{prefix}{rel}")
        info.external_attr = mode_for(rel)
        archive.writestr(info, (ROOT / rel).read_bytes())


def write_text(archive: zipfile.ZipFile, name: str, text: str) -> None:
    archive.writestr(name, text)


def install_readme(version: str) -> str:
    return f"""# Dividend Uploader Config Portal Install Package

Version: {version}

This package installs the website control plane for Dividend Uploader remote
MT4/MT5 plugin configuration.

Runtime data is intentionally excluded. Use a persistent data directory such as:

```text
/opt/dividend-uploader-data
```

Required production environment variables:

```text
DIVIDEND_UPLOADER_PORTAL_DATA_DIR=/opt/dividend-uploader-data/portal-data
DIVIDEND_UPLOADER_DB=/opt/dividend-uploader-data/runtime/dividend-uploader.db
DIVIDEND_UPLOADER_ADMIN_USER=<first-admin>
DIVIDEND_UPLOADER_ADMIN_PASSWORD=<temporary-password>
DIVIDEND_UPLOADER_JWT_SECRET=<random-secret>
DIVIDEND_UPLOADER_HOST=127.0.0.1
DIVIDEND_UPLOADER_PUBLIC_BASE_URL=https://test.appcdn002.com
PORT=4173
```

Public plugin URLs:

```text
https://test.appcdn002.com/admin-api/dividend-uploader-public/active-meta.json
https://test.appcdn002.com/admin-api/dividend-uploader-public/active.json
https://test.appcdn002.com/admin-api/dividend-uploader-feedback
```

The plugin sync base URL is configurable in the admin page and is not limited
to the default domain. Use `Configuration / Remote Sync` for URL settings.

Admin page layout:

- `CSV Data`: daily CSV import, export, and in-page row editing.
- `Configuration / Products`: low-change product list.
- `Configuration / Environment / Target`: platform, server, and effective time.
- `Configuration / Environment / Time Zone`: website business timezone and plugin
  timezone source. The default plugin source is the MT4/MT5 server timezone.
- `Plugin Sync`: save and publish the active JSON after clicking `Apply To JSON`.
"""


def upgrade_readme(version: str) -> str:
    return f"""# Dividend Uploader Config Portal Upgrade Package

Version: {version}

This upgrade package contains program files only. It must not overwrite:

- /opt/dividend-uploader-data/portal-data/
- /opt/dividend-uploader-data/runtime/
- /opt/dividend-uploader-data/logs/
- uploaded files
- feedback records
- admin account data

An upgrade or backend restart must not change existing config UUIDs or active
selection. Only a successful admin config save may generate a new UUID.

After copying files, restart the service:

```bash
cd /opt/dividend-uploader
sudo systemctl restart dividend-uploader.service
sudo systemctl status dividend-uploader.service --no-pager -l
```
"""


def create_zip(path: Path, files: list[str], readme: str, prefix: str = "") -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        write_files(archive, files, prefix=prefix)
        write_text(archive, f"{prefix}PACKAGE-README.txt", readme)


def main() -> int:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = OUTPUT_DIR / f"{stamp}_v{version}"
    out_dir.mkdir(parents=True, exist_ok=True)

    packages = {
        f"DividendUploader_CONFIG_PORTAL_INSTALL_v{version}.zip": (SITE_FILES, install_readme(version), ""),
        f"DividendUploader_CONFIG_PORTAL_UPGRADE_v{version}.zip": (SITE_FILES, upgrade_readme(version), ""),
    }

    if all((ROOT / item).is_file() for item in MT4_FILES):
        packages[f"DividendUploader_MT4_REMOTE_CONFIG_PLUGIN_v{version}.zip"] = (
            MT4_FILES,
            "MT4 remote config plugin Visual Studio project package.\nOpen plugins/mt4/DividendUploaderMT4RemoteConfigPlugin.sln on Windows.\nSee index.html for build and install steps.\n",
            "",
        )

    if all((ROOT / item).is_file() for item in MT5_FILES):
        packages[f"DividendUploader_MT5_REMOTE_CONFIG_PLUGIN_v{version}.zip"] = (
            MT5_FILES,
            "MT5 remote config plugin Visual Studio project package.\nOpen plugins/mt5/DividendUploaderMT5RemoteConfigPlugin.sln on Windows.\nSee index.html for build and install steps.\n",
            "",
        )

    manifest = {
        "version": version,
        "createdAt": dt.datetime.now().isoformat(timespec="seconds"),
        "outputDirectory": str(out_dir),
        "packages": [],
        "persistentDataExcluded": [
            "website/runtime/portal-data/",
            "website/runtime/data/",
            "website/runtime/logs/",
            "/opt/dividend-uploader-data/",
        ],
    }

    for name, (files, readme, prefix) in packages.items():
        path = out_dir / name
        create_zip(path, files, readme, prefix=prefix)
        digest = sha256_file(path)
        (path.with_suffix(path.suffix + ".sha256.txt")).write_text(f"{digest}  {name}\n", encoding="utf-8")
        manifest["packages"].append({"name": name, "sha256": digest, "fileCount": len(files)})

    manifest_path = out_dir / "PACKAGE-MANIFEST.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUTPUT_DIR / "LATEST_PORTAL_PACKAGES.txt").write_text(
        f"Latest portal packages: {out_dir}\nVersion: {version}\n",
        encoding="utf-8",
    )
    print(f"Portal packages created: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
