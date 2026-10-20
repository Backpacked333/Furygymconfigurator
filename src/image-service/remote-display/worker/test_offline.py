"""Provider/process-free tests: parse inspected source as data, never execute supervisor or SDK."""
import ast
import hashlib
from pathlib import Path
import runpy
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]


class OfflineWorkerTests(unittest.TestCase):
    def test_audited_public_sdk_rejects_explicit_vm_selection(self):
        audit = runpy.run_path(str(HERE / 'sdk_preflight.py'))
        report = audit['inspect_sdk']()
        self.assertEqual(report['auditPin'], 'modal==1.1.4')
        self.assertEqual(report['sandboxSourceDigest'], 'sha256:baa8a10faf6bfe18a7e1710604d5273bc8484e43fce7a1ef88bdd8d7157a07a9')
        self.assertNotIn('runtime', report['parameters'])
        self.assertFalse(report['dispatchAllowed'])
        self.assertFalse(report['explicitRuntimeSupported'])
        self.assertEqual(report['providerCalls'], 0)
        self.assertIsNone(report['launchPin'])

    def test_sdk_auditor_imports_only_standard_metadata_ast_tools(self):
        module = ast.parse((HERE / 'sdk_preflight.py').read_text())
        imports = []
        for node in ast.walk(module):
            if isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
            if isinstance(node, ast.ImportFrom):
                imports.append(node.module)
        self.assertEqual(set(imports), {'ast', 'hashlib', 'json', 'pathlib'})
        self.assertNotIn('function_runtime', (HERE / 'sdk_preflight.py').read_text())

    def test_frozen_chrome_flags_byte_equal_except_portable_profile(self):
        local = ast.parse((ROOT / 'src/render/display/supervisor.py').read_text())
        remote = ast.parse((HERE / 'supervisor.py').read_text())
        command = next(n.value for n in ast.walk(local) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'args' for t in n.targets))
        frozen_flags = [n.value for n in command.elts if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        flags = next(ast.literal_eval(n.value) for n in remote.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'FLAGS' for t in n.targets))
        self.assertEqual(list(flags), frozen_flags)
        self.assertFalse(any('no-sandbox' in f or 'unsafe' in f or 'swiftshader' in f for f in flags))

    def test_all_supervisor_process_entrypoints_are_unconditionally_held(self):
        module = ast.parse((HERE / 'supervisor.py').read_text())
        functions = {n.name: n for n in module.body if isinstance(n, ast.FunctionDef)}
        held = functions['supervise'].body
        self.assertIsInstance(held[0], ast.If)
        self.assertEqual(held[0].body[0].value.value, 70)
        self.assertIsInstance(held[1], ast.Raise)
        for source in ['os.pidfd_open', 'signal.pidfd_send_signal', 'prctl(36, 1', 'parent_identity(parent) != identity', 'owned', 'exit-observed']:
            self.assertIn(source, (HERE / 'supervisor.py').read_text())

    def test_candidate_cleanup_covers_every_post_spawn_setup_failure(self):
        # AST only: never remove the unconditional admission denial to exercise dead code.
        module = ast.parse((HERE / 'supervisor.py').read_text())
        supervise = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'supervise')
        spawn_index = next(i for i, n in enumerate(supervise.body) if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and ast.unparse(n.value.func) == 'subprocess.Popen')
        protected = supervise.body[spawn_index + 1]
        self.assertIsInstance(protected, ast.Try)
        body = ast.unparse(protected)
        self.assertIn('observations.write', body)
        self.assertIn('selectors.DefaultSelector()', body)
        self.assertIn('reader.register', body)
        cleanup = protected.finalbody
        self.assertIsInstance(cleanup[0], ast.If)
        self.assertEqual(ast.unparse(cleanup[0].test), 'reader is not None')
        close = cleanup[0].body[0]
        self.assertIsInstance(close, ast.Try)
        self.assertTrue(close.handlers)
        self.assertEqual(ast.unparse(cleanup[1]), 'signal_descendants(signal.SIGTERM)')
        self.assertIn('signal_descendants(signal.SIGKILL)', body)

    def test_audit_is_pinned_to_actual_source_bytes_not_version_alone(self):
        audit = runpy.run_path(str(HERE / 'sdk_preflight.py'))
        source = (audit['SDK'] / 'modal/sandbox.py').read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(), audit['AUDIT_SOURCE_SHA256'])


if __name__ == '__main__':
    unittest.main()
