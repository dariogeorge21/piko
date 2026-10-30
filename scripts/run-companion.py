#!/usr/bin/env python3
"""Run the companion from any working directory using its existing environment."""
import os
from pathlib import Path

service=Path(__file__).resolve().parents[1]/'apps/local-service'
python=service/'.venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
if not python.is_file():raise SystemExit('Create apps/local-service/.venv and install requirements-dev.txt first.')
os.chdir(service)
os.execv(str(python),[str(python),'-m','app'])
