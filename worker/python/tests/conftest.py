import sys
from pathlib import Path

PYTHON_ROOT = Path(__file__).resolve().parents[1]
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

REPO_ROOT = PYTHON_ROOT.parents[1]
SAMPLE_PROJECT_DIR = REPO_ROOT / "projects" / "sample"
