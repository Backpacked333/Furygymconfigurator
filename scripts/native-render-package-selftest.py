"""Offline closed-package preparation smoke test; reuses installed npm dependencies."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "render-server"))
from on_demand.dispatcher import Dispatcher
from on_demand.journal import Journal
from on_demand.sandbox_runner import extract

with tempfile.TemporaryDirectory() as location:
    base = Path(location)
    root = base / "source"
    state = base / "state"
    state.mkdir()
    if len(sys.argv) == 2:
        shutil.copytree(sys.argv[1], root, ignore=shutil.ignore_patterns('node_modules', '__pycache__'))
    else:
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/native-render-package.py"), str(root)],
            check=True,
            stdout=subprocess.DEVNULL,
        )
    (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    recipe = json.loads((root / "recipe.json").read_text())
    claim = json.loads(
        (ROOT / "src/render-library/fixtures/worker-adapter.json").read_text()
    )["claim"]
    claim.update(
        workerBuildSha256=recipe["workerBuildSha256"],
        recipeBundleSha256=recipe["recipeBundleSha256"],
        deadlineAt="2030-01-01T00:00:00Z",
    )
    if recipe.get('gpuDevice'):
        claim['limits'].update(maxContainers=1, concurrencyPerContainer=2, minContainers=1)
    Journal.initialize(state / "test.db")
    journal = Journal(state / "test.db")
    worker = Dispatcher(None, None, journal, {"recipe": recipe}, root, state)
    worker.verify_source()
    package = worker.prepare_cpu({"claim": claim}, state)
    out = state / "extract"
    out.mkdir()
    with package.open("rb") as source:
        extract(source, out, package.stat().st_size)
    assert (out / "job.json").exists()
    manifest = json.loads((root / "native-build.json").read_text())
    for name in [
        "scripts/native-render-scenery.ts",
        "scripts/native-render-prepare.ts",
        "src/render/buildings.ts",
        "src/render/vegetation.ts",
        "src/render/materials.ts",
        "src/render/prototype/cycles/compile.ts",
        "render-server/fury_render/protocol.py",
    ]:
        assert name in manifest["files"], name
    (root / "scripts/native-render-scenery.ts").write_text("// tampered test double")
    try:
        worker.verify_source()
    except RuntimeError:
        pass
    else:
        raise AssertionError("modified source was accepted")
    journal.db.close()
    print(
        "Closed package prepared and extracted offline; all dependent sources bound; source drift rejected."
    )
