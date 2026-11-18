"""Run the checkout with its native Qt dependencies installed in your environment."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from flyleaf_desktop.app import main

if __name__ == "__main__":
    raise SystemExit(main())
