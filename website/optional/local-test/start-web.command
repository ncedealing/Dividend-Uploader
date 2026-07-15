#!/bin/sh
cd "$(dirname "$0")" || exit 1
python3 run_local.py
if [ $? -ne 0 ]; then
  echo ""
  echo "Failed to start Dividend Uploader. Make sure Python 3.9+ and Node.js 24+ are installed."
  read -r -p "Press Enter to close..."
fi
