@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo Set up the virtual environment first. See desktop\README.md.
  pause
  exit /b 1
)
start "Flyleaf Desktop" ".venv\Scripts\pythonw.exe" "run.py"
