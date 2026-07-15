#!/usr/bin/env python3
"""Create a minimal easy-run package for the Node/Python Web MVP."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import stat
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
OUTPUT_DIR = ROOT / "website" / "optional" / "packages" / "simple-run"


REQUIRED_FILES = [
    ".gitignore",
    "VERSION",
    "index.html",
    "package.json",
    "website/config/default-dividend-config.template.json",
    "website/config/import-templates/overnight-interest-settings.csv",
    "website/optional/local-test/check-runtime.bat",
    "website/optional/local-test/run_local.py",
    "website/optional/local-test/start-web.command",
    "website/optional/local-test/start-web.bat",
    "website/optional/tools/project-tools/dev/load_test_environment.py",
    "website/optional/tools/project-tools/docs/build_all_docs_html.py",
    "website/optional/tools/project-tools/package/create_portal_packages.py",
    "website/src/adapters/finnhub/FinnhubDividendClient.mjs",
    "website/src/adapters/mail/AuditMailComposer.mjs",
    "website/src/adapters/mock/MockExecutionAdapter.mjs",
    "website/src/adapters/storage/createLedger.mjs",
    "website/src/core/calculation/dividendCalculator.mjs",
    "website/src/core/domain/defaultConfig.mjs",
    "website/src/core/dry-run/dryRunEngine.mjs",
    "website/src/core/execution/applyEngine.mjs",
    "website/src/core/idempotency/idempotencyKey.mjs",
    "website/src/core/review/reviewPolicy.mjs",
    "website/src/core/rules/accountScope.mjs",
    "website/src/core/rules/mappingMatcher.mjs",
    "website/src/core/rules/patterns.mjs",
    "website/src/jobs/sync/finnhubSyncJob.mjs",
    "website/src/storage/migrations/001_initial_schema.sql",
    "website/src/storage/repositories/SqliteLedger.mjs",
    "website/src/web/api/server.mjs",
    "website/src/web/api/pluginPortal.mjs",
    "website/src/web/ui/app.mjs",
    "website/src/web/ui/index.html",
    "website/src/web/ui/styles.css",
    "website/optional/tests/integration/webApi.test.mjs",
    "website/optional/tests/integration/pluginPortal.test.mjs",
    "website/optional/tests/unit/accountScope.test.mjs",
    "website/optional/tests/unit/calculationAndDryRun.test.mjs",
    "website/optional/tests/unit/mappingMatcher.test.mjs",
    "website/optional/tests/unit/patterns.test.mjs",
    "website/optional/tests/unit/storage.test.mjs",
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


EMPTY_DIRS = [
    "runtime/data/",
    "runtime/logs/",
    "runtime/portal-data/",
    "packages/plugin-build/",
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_manifest(package_name: str, files: list[str]) -> str:
    lines = [
        "# Dividend Uploader Simple Run Package - File Manifest",
        "",
        f"Package: `{package_name}`",
        f"Generated: `{dt.datetime.now().isoformat(timespec='seconds')}`",
        "",
        "## Required Runtime",
        "",
        "- Python 3.9+",
        "- Node.js 24+",
        "- No npm install is required for this MVP package.",
        "",
        "## Included Files",
        "",
    ]
    lines.extend(f"- `{item}`" for item in files)
    lines.extend(
        [
            "",
            "## Empty Directories Created By Package",
            "",
            "- `runtime/data/` - SQLite test ledger is created here by `run_local.py`.",
            "- `runtime/logs/` - reserved for logs.",
            "- `runtime/portal-data/` - persistent website plugin configuration data; do not overwrite on upgrade.",
            "- `packages/plugin-build/` - Visual Studio plugin DLL output directory.",
            "- `sdk/mt4/` - put official MT4 Server Plugin SDK compile files here.",
            "- `sdk/mt5/` - put or verify official MT5 Server Plugin SDK compile files here.",
        ]
    )
    return "\n".join(lines) + "\n"


def task_checklist() -> str:
    return """# Dividend Uploader Simple Test Checklist

## 1. Unzip

Extract this package to a simple path without special permissions, for example:

- macOS/Linux: `~/DividendUploader`
- Windows: `C:\\DividendUploader`

## 2. Check Runtime

Run:

```bash
python3 --version
node --version
```

Expected:

- Python 3.9 or newer
- Node.js 24 or newer

## 3. Start Page

macOS/Linux:

```bash
python3 run_local.py
```

Windows, recommended:

```bat
start-web.bat
```

Windows, command line:

```bat
py run_local.py
```

Do not run `run_local.py` from Python IDLE for normal use. Use `start-web.bat`
or Command Prompt/PowerShell so any Node/Python error stays visible.

The script will:

- create `runtime/data/dividend-uploader.db`
- load default config
- seed sample dividend records
- start the Web UI
- open `http://127.0.0.1:4173`

The package also includes `config/import-templates/overnight-interest-settings.csv`.
That file is for future system overnight interest parameter updates; it is not
a customer balance import template.

Keep the terminal open while viewing the page. Press `Ctrl+C` to stop.

## 4. View Style

In the browser, confirm these areas render:

- left navigation
- configuration summary cards
- configuration form
- mapping rules table
- manual dividend import panel
- dry-run preview table
- batch history table
- overnight interest settings CSV template exists under `config/import-templates/`

## 5. Run Dry-Run Demo

Click:

1. `Dry Run`
2. Confirm rows appear in the preview table.
3. Confirm matched mask and mapping columns are populated.

## 6. Optional Tests

In another terminal:

```bash
npm test
```

Expected: all tests pass.

## 7. Troubleshooting On Windows

If nothing appears:

1. Double-click `check-runtime.bat`.
2. Confirm Python and Node.js versions are printed.
3. If Node.js is missing, install Node.js 24+ and reopen Command Prompt.
4. Run `start-web.bat` again.

## 8. SDK Notes

The simple package does not include large MT4/MT5 SDK files. It includes
separate SDK locations and Visual Studio plugin projects:

- `sdk/mt4/`
- `sdk/mt5/`
- `plugins/mt4/DividendUploaderMT4RemoteConfigPlugin.sln`
- `plugins/mt5/DividendUploaderMT5RemoteConfigPlugin.sln`

Open the relevant `.sln` on Windows. DLL output goes to `packages/plugin-build/`.
Overnight interest real execution must update system long/short interest values,
not create customer balance/deal operations.
"""


def run_me() -> str:
    return """# Dividend Uploader - Quick Start

最简单方式：

```bash
python3 run_local.py
```

Windows 推荐直接运行：

```bat
start-web.bat
```

Windows 命令行：

```bat
py run_local.py
```

不要从 Python IDLE 里运行 `run_local.py` 作为日常启动方式；如果有错误，IDLE 可能看起来像“没反应”。请用 `start-web.bat`，它会显示错误并暂停。

脚本会自动加载测试环境、启动页面并打开浏览器。

页面地址：

```text
http://127.0.0.1:4173
```

如果只想准备测试数据，不打开页面：

```bash
python3 run_local.py --prepare-only
```

停止服务：在终端按 `Ctrl+C`。

如果没反应，先运行：

```bat
check-runtime.bat
```
"""


def zip_permissions(rel: str) -> int:
    mode = 0o755 if rel.endswith(".py") or rel.endswith(".command") or rel.endswith(".sh") else 0o644
    return (stat.S_IFREG | mode) << 16


def package_path(rel: str) -> str:
    aliases = {
        "website/optional/local-test/check-runtime.bat": "check-runtime.bat",
        "website/optional/local-test/run_local.py": "run_local.py",
        "website/optional/local-test/start-web.bat": "start-web.bat",
        "website/optional/local-test/start-web.command": "start-web.command",
        "website/optional/tools/project-tools/dev/load_test_environment.py": "optional/tools/project-tools/dev/load_test_environment.py",
        "website/optional/tools/project-tools/docs/build_all_docs_html.py": "optional/tools/project-tools/docs/build_all_docs_html.py",
        "website/optional/tools/project-tools/package/create_portal_packages.py": "optional/tools/project-tools/package/create_portal_packages.py",
    }
    return aliases.get(rel, rel.removeprefix("website/"))


def main() -> int:
    missing = [item for item in REQUIRED_FILES if not (ROOT / item).is_file()]
    if missing:
        raise SystemExit(f"Missing required package files: {missing}")

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    package_name = f"{stamp}_DividendUploader_SIMPLE_RUN_WEB_MVP.zip"
    zip_path = OUTPUT_DIR / package_name
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    files = sorted(REQUIRED_FILES)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for directory in EMPTY_DIRS:
            archive.writestr(directory, "")

        packaged_files = []
        for rel in files:
            target = package_path(rel)
            packaged_files.append(target)
            info = zipfile.ZipInfo(target)
            info.external_attr = zip_permissions(rel)
            archive.writestr(info, (ROOT / rel).read_bytes())

        manifest = {
            "packageName": package_name,
            "createdAt": dt.datetime.now().isoformat(timespec="seconds"),
            "profile": "simple-run-web-mvp",
            "requires": ["Python 3.9+", "Node.js 24+"],
            "fileCount": len(packaged_files),
            "emptyDirectories": EMPTY_DIRS,
            "files": packaged_files,
        }
        archive.writestr("RUN-ME.txt", run_me())
        archive.writestr("FILE-MANIFEST.txt", file_manifest(package_name, packaged_files))
        archive.writestr("TASK-CHECKLIST.txt", task_checklist())
        archive.writestr("PACKAGE-MANIFEST.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    digest = sha256_file(zip_path)
    sha_path = zip_path.with_suffix(zip_path.suffix + ".sha256.txt")
    sha_path.write_text(f"{digest}  {package_name}\n", encoding="utf-8")
    latest_path = OUTPUT_DIR / "LATEST_SIMPLE_RUN_PACKAGE.txt"
    latest_path.write_text(
        f"Latest simple run package: {package_name}\nSHA256: {digest}\n",
        encoding="utf-8",
    )

    print(f"Package created: {zip_path}")
    print(f"SHA256: {digest}")
    print(f"Files: {len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
