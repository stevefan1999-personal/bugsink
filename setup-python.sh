#!/bin/bash
# Installs Python + dependencies via uv (shipped as npm dep @manzt/uv).
# Called automatically by "npm install" via postinstall hook.
set -e

UV="./node_modules/.bin/uv"
VENV_DIR=".pyenv"

echo "[setup-python] uv version: $($UV version 2>&1)"

# Install a Python if none available
echo "[setup-python] Ensuring Python 3.13 is available..."
$UV python install 3.13 2>&1 || true

# Create venv
if [ ! -f "$VENV_DIR/bin/python" ]; then
    echo "[setup-python] Creating virtualenv..."
    $UV venv "$VENV_DIR" --python 3.13
fi

# Install dependencies
echo "[setup-python] Installing requirements..."
$UV pip install --python "$VENV_DIR/bin/python" -r requirements.txt
$UV pip install --python "$VENV_DIR/bin/python" -e .

echo "[setup-python] Done."
echo "[setup-python] Python: $($VENV_DIR/bin/python --version)"
echo "[setup-python] Gunicorn: $($VENV_DIR/bin/gunicorn --version 2>&1 || echo 'not found')"
