#!/usr/bin/env python3
"""Load a local Dividend Uploader test environment.

The script is intentionally dependency-free. It prepares the ignored runtime
SQLite ledger, imports the default web configuration, seeds a small dividend
record set, and writes sample open positions for dry-run testing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


ROOT = Path(__file__).resolve().parents[4]
DEFAULT_CONFIG_PATH = ROOT / "config" / "default-dividend-config.template.json"
MIGRATION_PATH = ROOT / "src" / "storage" / "migrations" / "001_initial_schema.sql"
DEFAULT_DB_PATH = ROOT / "runtime" / "data" / "dividend-uploader.db"
TEST_POSITIONS_PATH = ROOT / "runtime" / "data" / "test-positions.json"
SUMMARY_PATH = ROOT / "runtime" / "data" / "test-environment.json"
LAUNCH_COMMAND = (
    "python3 website/optional/local-test/run_local.py"
    if ROOT.name == "website"
    else "python3 optional/local-test/run_local.py"
)
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4173
NODE_MIN_MAJOR = 24


SAMPLE_DIVIDEND_RECORDS = [
    {
        "id": "manual:AAPL:2026-06-10:0.24",
        "source": "manual",
        "finnhubSymbol": "AAPL",
        "exDate": "2026-06-10",
        "dividendUnit": "perShare",
        "dividendPerShare": 0.24,
        "currency": "USD",
        "recordRatio": 1,
        "rawPayload": {
            "fixture": True,
            "note": "Local test environment seed record",
        },
    },
    {
        "id": "manual:TSLA:2026-06-10:0.12",
        "source": "manual",
        "finnhubSymbol": "TSLA",
        "exDate": "2026-06-10",
        "dividendUnit": "perShare",
        "dividendPerShare": 0.12,
        "currency": "USD",
        "recordRatio": 1,
        "rawPayload": {
            "fixture": True,
            "note": "Local test environment seed record",
        },
    },
]


SAMPLE_OPEN_POSITIONS = [
    {
        "platform": "mt5",
        "login": 10001,
        "group": "real\\VIP-A",
        "ticket": 9001001,
        "symbol": "AAPL.m",
        "side": "buy",
        "volumeLots": 1.2,
        "currency": "USD",
    },
    {
        "platform": "mt5",
        "login": 10002,
        "group": "real\\VIP-A",
        "ticket": 9001002,
        "symbol": "AAPL.m",
        "side": "sell",
        "volumeLots": 0.5,
        "currency": "USD",
    },
    {
        "platform": "mt4",
        "login": 20001,
        "group": "real\\standard",
        "ticket": 8002001,
        "symbol": "TSLA.m",
        "side": "buy",
        "volumeLots": 0.8,
        "currency": "USD",
    },
]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def load_json(path: Path) -> object:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def reset_sqlite_files(db_path: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        path = Path(f"{db_path}{suffix}")
        if path.exists():
            path.unlink()


def apply_migration(connection: sqlite3.Connection) -> None:
    migration = MIGRATION_PATH.read_text(encoding="utf-8")
    connection.executescript(migration)


def ensure_config_version(connection: sqlite3.Connection, config: dict, force_config: bool) -> int:
    existing = connection.execute(
        "SELECT id FROM config_versions ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if existing and not force_config:
        return int(existing[0])

    timestamp = now_iso()
    cursor = connection.execute(
        """
        INSERT INTO config_versions (version_label, config_json, created_by, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            "python-test-env",
            json_text(config),
            "python-test-loader",
            "load local test environment",
            timestamp,
        ),
    )
    config_version_id = int(cursor.lastrowid)
    connection.execute(
        """
        INSERT INTO audit_logs (
          operator, action, target_type, target_id, reason, source_ip, metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "python-test-loader",
            "config.version.created",
            "config_version",
            str(config_version_id),
            "load local test environment",
            None,
            json_text({"label": "python-test-env"}),
            timestamp,
        ),
    )
    return config_version_id


def upsert_dividend_records(connection: sqlite3.Connection, records: list[dict]) -> int:
    timestamp = now_iso()
    for record in records:
        connection.execute(
            """
            INSERT INTO dividend_records (
              id, source, finnhub_symbol, ex_date, dividend_unit, dividend_per_share,
              dividend_per_lot, currency, record_ratio, raw_payload_json, status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              source = excluded.source,
              finnhub_symbol = excluded.finnhub_symbol,
              ex_date = excluded.ex_date,
              dividend_unit = excluded.dividend_unit,
              dividend_per_share = excluded.dividend_per_share,
              dividend_per_lot = excluded.dividend_per_lot,
              currency = excluded.currency,
              record_ratio = excluded.record_ratio,
              raw_payload_json = excluded.raw_payload_json,
              status = 'active',
              updated_at = excluded.updated_at
            """,
            (
                record["id"],
                record.get("source", "manual"),
                record["finnhubSymbol"],
                record["exDate"],
                record.get("dividendUnit", "perShare"),
                record.get("dividendPerShare"),
                record.get("dividendPerLot"),
                record.get("currency", "USD"),
                record.get("recordRatio", 1),
                json_text(record.get("rawPayload", record)),
                timestamp,
                timestamp,
            ),
        )
    connection.execute(
        """
        INSERT INTO audit_logs (
          operator, action, target_type, target_id, reason, source_ip, metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "python-test-loader",
            "dividend.records.upserted",
            "dividend_records",
            "fixture",
            "load local test environment",
            None,
            json_text({"count": len(records)}),
            timestamp,
        ),
    )
    return len(records)


def table_count(connection: sqlite3.Connection, table: str) -> int:
    return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load Dividend Uploader local test environment.")
    parser.add_argument(
        "--db",
        default=os.environ.get("DIVIDEND_UPLOADER_DB", str(DEFAULT_DB_PATH)),
        help="SQLite ledger path. Defaults to runtime/data/dividend-uploader.db.",
    )
    parser.add_argument(
        "--reset-db",
        action="store_true",
        help="Delete the local test DB/WAL/SHM files before loading fixtures.",
    )
    parser.add_argument(
        "--force-config",
        action="store_true",
        help="Always append a fresh config_versions row from the default config template.",
    )
    parser.add_argument(
        "--prepare-only",
        action="store_true",
        help="Only prepare SQLite fixtures and JSON files; do not start the web UI.",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Start the web service but do not open a browser automatically.",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("DIVIDEND_UPLOADER_HOST", DEFAULT_HOST),
        help=f"Web host to bind. Defaults to {DEFAULT_HOST}.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("DIVIDEND_UPLOADER_PORT", DEFAULT_PORT)),
        help=f"Web port to bind. Defaults to {DEFAULT_PORT}.",
    )
    parser.add_argument(
        "--mock-execution",
        action="store_true",
        help="Enable the local mock execution route for UI testing.",
    )
    parser.add_argument(
        "--no-auto-install",
        action="store_true",
        help="Do not try to install Node.js automatically when it is missing.",
    )
    return parser.parse_args()


def wait_for_health(url: str, process: subprocess.Popen, timeout_seconds: float = 12.0) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=0.5) as response:
                if response.status == 200:
                    return True
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.25)
    return False


def is_windows() -> bool:
    return os.name == "nt"


def find_windows_node_in_common_dirs() -> Optional[str]:
    if not is_windows():
        return None
    roots = [
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        str(Path.home() / "AppData" / "Local" / "Programs"),
        str(Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages"),
    ]
    direct_candidates = []
    for root in roots:
        if not root:
            continue
        direct_candidates.extend(
            [
                Path(root) / "nodejs" / "node.exe",
                Path(root) / "OpenJS" / "NodeJS" / "node.exe",
            ],
        )
    for candidate in direct_candidates:
        if candidate.is_file():
            return str(candidate)

    search_roots = [
        Path(os.environ.get("ProgramFiles", "")),
        Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages",
    ]
    for root in search_roots:
        if not root.is_dir():
            continue
        try:
            for candidate in root.glob("**/node.exe"):
                if candidate.is_file():
                    return str(candidate)
        except OSError:
            continue
    return None


def prepend_path_for_executable(executable: str) -> None:
    folder = str(Path(executable).parent)
    current = os.environ.get("PATH", "")
    paths = current.split(os.pathsep) if current else []
    if folder and folder not in paths:
        os.environ["PATH"] = os.pathsep.join([folder, *paths])


def find_node() -> Optional[str]:
    configured = os.environ.get("DIVIDEND_UPLOADER_NODE")
    candidates = [configured, "node.exe", "node"]
    for candidate in candidates:
        if not candidate:
            continue
        configured_path = Path(candidate)
        if configured_path.is_file():
            return str(configured_path)
        path = shutil.which(candidate)
        if path:
            return path
    windows_node = find_windows_node_in_common_dirs()
    if windows_node:
        prepend_path_for_executable(windows_node)
    return windows_node


def node_major_version(node_path: str) -> Optional[int]:
    try:
        completed = subprocess.run(
            [node_path, "--version"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except OSError:
        return None

    match = re.search(r"v(\d+)", completed.stdout.strip())
    return int(match.group(1)) if match else None


def run_installer_command(command: list[str]) -> bool:
    print("")
    print("Running installer:")
    print(f"  {' '.join(command)}")
    try:
        completed = subprocess.run(command, cwd=ROOT, check=False)
    except OSError as error:
        print(f"Installer command failed to start: {error}", file=sys.stderr)
        return False
    if completed.returncode != 0:
        print(f"Installer exited with code {completed.returncode}.", file=sys.stderr)
        return False
    return True


def install_node_on_windows() -> Optional[str]:
    print("")
    print(f"Node.js {NODE_MIN_MAJOR}+ was not found. Trying automatic Windows installation...")
    print("If Windows asks for permission, allow it and keep this window open.")

    commands = []
    if shutil.which("winget"):
        commands.extend(
            [
                [
                    "winget",
                    "install",
                    "--id",
                    "OpenJS.NodeJS",
                    "--source",
                    "winget",
                    "--scope",
                    "user",
                    "--silent",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
                [
                    "winget",
                    "install",
                    "--id",
                    "OpenJS.NodeJS",
                    "--source",
                    "winget",
                    "--silent",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
                [
                    "winget",
                    "upgrade",
                    "--id",
                    "OpenJS.NodeJS",
                    "--source",
                    "winget",
                    "--silent",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
            ],
        )
    if shutil.which("choco"):
        commands.append(["choco", "install", "nodejs", "-y"])

    if not commands:
        print("No supported Windows package manager was found.", file=sys.stderr)
        print("Install App Installer/winget from Microsoft Store, or install Node.js manually.", file=sys.stderr)
        return None

    for command in commands:
        if not run_installer_command(command):
            continue
        node_path = find_node()
        if node_path and (node_major_version(node_path) or 0) >= NODE_MIN_MAJOR:
            print(f"Node.js is ready: {node_path}")
            return node_path

    node_path = find_node()
    if node_path and (node_major_version(node_path) or 0) >= NODE_MIN_MAJOR:
        print(f"Node.js is ready: {node_path}")
        return node_path
    return None


def install_node_on_macos() -> Optional[str]:
    if sys.platform != "darwin" or not shutil.which("brew"):
        return None
    print("")
    print(f"Node.js {NODE_MIN_MAJOR}+ was not found. Trying Homebrew installation...")
    if run_installer_command(["brew", "install", "node"]) or run_installer_command(["brew", "upgrade", "node"]):
        node_path = find_node()
        if node_path and (node_major_version(node_path) or 0) >= NODE_MIN_MAJOR:
            return node_path
    return None


def ensure_node(auto_install: bool) -> Optional[str]:
    node_path = find_node()
    major = node_major_version(node_path) if node_path else None
    if node_path and major and major >= NODE_MIN_MAJOR:
        return node_path

    if node_path:
        print(f"Node.js {NODE_MIN_MAJOR}+ is required. Found older Node at: {node_path}", file=sys.stderr)
    else:
        print("Node.js was not found on PATH.", file=sys.stderr)

    if auto_install:
        installed = install_node_on_windows() if is_windows() else install_node_on_macos()
        if installed:
            return installed

    print(f"Install Node.js {NODE_MIN_MAJOR}+ from https://nodejs.org/ and reopen this terminal.", file=sys.stderr)
    print(f"Then run: {LAUNCH_COMMAND}", file=sys.stderr)
    return None


def start_web_ui(args: argparse.Namespace, db_path: Path) -> int:
    url = f"http://{args.host}:{args.port}"
    health_url = f"{url}/api/health"
    env = os.environ.copy()
    env["DIVIDEND_UPLOADER_DB"] = str(db_path)
    env["DIVIDEND_UPLOADER_HOST"] = args.host
    env["DIVIDEND_UPLOADER_PORT"] = str(args.port)
    if args.mock_execution:
        env["DIVIDEND_UPLOADER_USE_MOCK_EXECUTION"] = "1"

    node_path = ensure_node(auto_install=not args.no_auto_install)
    if not node_path:
        return 1

    command = [
        node_path,
        "--disable-warning=ExperimentalWarning",
        str(ROOT / "src" / "web" / "api" / "server.mjs"),
    ]

    print("")
    print("Starting Dividend Uploader web UI")
    print(f"  url:       {url}")
    print(f"  database:  {db_path}")
    print(f"  node:      {node_path}")
    print("  stop:      Ctrl+C")
    print("")

    try:
        process = subprocess.Popen(command, cwd=ROOT, env=env)
    except OSError as error:
        print(f"Failed to start web service: {error}", file=sys.stderr)
        return 1
    try:
        if not wait_for_health(health_url, process):
            return_code = process.poll()
            if return_code is None:
                print(f"Web service did not become ready within the timeout: {health_url}", file=sys.stderr)
                process.terminate()
                process.wait(timeout=5)
                return 1
            print(f"Web service exited early with code {return_code}", file=sys.stderr)
            return int(return_code)

        print(f"Web UI is ready: {url}")
        if not args.no_open:
            opened = webbrowser.open(url, new=2, autoraise=True)
            if opened:
                print("Browser opened automatically.")
            else:
                print(f"Could not auto-open a browser. Open this URL manually: {url}")
        else:
            print(f"Open this URL manually: {url}")

        return int(process.wait())
    except KeyboardInterrupt:
        print("")
        print("Stopping Dividend Uploader web UI...")
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        return 0


def main() -> int:
    args = parse_args()
    db_path = Path(args.db).expanduser()
    if not db_path.is_absolute():
        db_path = ROOT / db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)

    if args.reset_db:
        reset_sqlite_files(db_path)

    config = load_json(DEFAULT_CONFIG_PATH)
    connection = sqlite3.connect(db_path)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        apply_migration(connection)
        config_version_id = ensure_config_version(connection, config, args.force_config)
        dividend_count = upsert_dividend_records(connection, SAMPLE_DIVIDEND_RECORDS)
        connection.commit()

        write_json(TEST_POSITIONS_PATH, SAMPLE_OPEN_POSITIONS)
        summary = {
            "loadedAt": now_iso(),
            "databasePath": str(db_path),
            "positionsPath": str(TEST_POSITIONS_PATH),
            "webUrl": f"http://{args.host}:{args.port}",
            "configVersionId": config_version_id,
            "seedDividendRecords": dividend_count,
            "counts": {
                "configVersions": table_count(connection, "config_versions"),
                "dividendRecords": table_count(connection, "dividend_records"),
                "auditLogs": table_count(connection, "audit_logs"),
            },
            "nextCommands": [
                "npm test",
                LAUNCH_COMMAND,
            ],
        }
        write_json(SUMMARY_PATH, summary)
    finally:
        connection.close()

    print("Dividend Uploader test environment loaded")
    print(f"  database:        {db_path}")
    print(f"  config version:  {config_version_id}")
    print(f"  seed dividends:  {dividend_count}")
    print(f"  positions JSON:  {TEST_POSITIONS_PATH}")
    print(f"  summary JSON:    {SUMMARY_PATH}")
    print("")
    if args.prepare_only:
        print("Next:")
        print("  npm test")
        print(f"  {LAUNCH_COMMAND}")
        return 0

    return start_web_ui(args, db_path)


if __name__ == "__main__":
    raise SystemExit(main())
