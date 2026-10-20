"""Offline execution-only upgrades preserve every image-producing source byte."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('native_package', ROOT / 'scripts/native-render-package.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class QueuePackageTests(unittest.TestCase):
    def base(self, path):
        sources = {
            'src/render-library/workerProtocol.ts': b'maxActiveJobsPerSession: 1,\nmaxActiveJobsPerSession: z.literal(1),\n',
            'render-server/on_demand/validation.py': b'        ("maxContainers", 2),\n',
            'render-server/on_demand/renderer.py': b'unchanged renderer',
            'src/render/prototype/cameras.ts': b'unchanged cameras',
            'public/asset.bin': b'unchanged material',
        }
        return module.write_package(path, {k: module.checksum(v) for k, v in sources.items()}, sources)

    def test_upgrade_preserves_pixel_sources_and_original_package(self):
        with tempfile.TemporaryDirectory() as folder:
            base, output = Path(folder) / 'base', Path(folder) / 'upgrade'
            original = self.base(base)
            result = module.queue_upgrade(base, output)
            self.assertEqual(json.loads((base / 'native-build.json').read_text()), original)
            self.assertEqual(result['compatibleWithWorkerBuildSha256'], original['recipe']['workerBuildSha256'])
            self.assertNotEqual(result['recipe']['workerBuildSha256'], original['recipe']['workerBuildSha256'])
            for key in ('releaseId', 'geometrySha256', 'materialsSha256', 'camerasSha256'):
                self.assertEqual(result['recipe'][key], original['recipe'][key])
            changed = {name for name in original['files'] if original['files'][name] != result['files'][name]}
            self.assertEqual(changed, set(result['changes']))
            self.assertEqual(len(changed), 2)
            for name in set(original['files']) - changed:
                self.assertEqual((base / name).read_bytes(), (output / name).read_bytes())
            with self.assertRaisesRegex(RuntimeError, 'fresh-output-required'):
                module.queue_upgrade(base, output)
            with self.assertRaisesRegex(RuntimeError, 'incompatible-base-worker'):
                module.queue_upgrade(output, Path(folder) / 'twice')

    def test_drift_is_rejected_before_creating_a_package(self):
        with tempfile.TemporaryDirectory() as folder:
            base, output = Path(folder) / 'base', Path(folder) / 'upgrade'
            self.base(base)
            (base / 'render-server/on_demand/renderer.py').write_text('tampered')
            with self.assertRaisesRegex(RuntimeError, 'base-source-drift'):
                module.queue_upgrade(base, output)
            self.assertFalse(output.exists())

    def test_registration_drift_and_escaping_source_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            base, output = Path(folder) / 'base', Path(folder) / 'upgrade'
            original = self.base(base)
            (base / 'recipe.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'base-registration-mismatch'):
                module.queue_upgrade(base, output)
            files = {**original['files'], '../outside': 'a' * 64}
            recipe = module.registration(files)
            (base / 'recipe.json').write_bytes(module.encode(recipe))
            (base / 'native-build.json').write_bytes(module.encode({'files': files, 'recipe': recipe}))
            with self.assertRaisesRegex(RuntimeError, 'unsafe-source-path'):
                module.queue_upgrade(base, output)
            self.assertFalse(output.exists())
