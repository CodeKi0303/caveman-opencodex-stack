import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('server_control',Path(__file__).resolve().parents[1]/'scripts/server-control.py')
control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)

class ServerControlTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.repo=Path(self.temp.name)
        (self.repo/'stack').write_text('# fixture')
        (self.repo/'data').mkdir()
        self.original={'package.json':json.dumps({'dependencies':{'@caveman-ai/cli':'1.0.0','@bitkyc08/opencodex':'2.0.0'}}).encode(),'package-lock.json':b'{"packages":{}}'}
        for p,b in self.original.items():(self.repo/p).write_bytes(b)
    def request(self,**extra):return {'repo':str(self.repo),'action':'update','component':'caveman','version':'1.1.0',**extra}
    def fake(self,failure=False):
        def pod(*args,**kw):
            if args[0]=='exec':return types.SimpleNamespace(stdout=json.dumps({'@caveman-ai/cli':'1.0.0','@bitkyc08/opencodex':'2.0.0'}))
            self.assertEqual(args[0],'run');mount=args[args.index('--volume')+1];stage=Path(mount.rsplit(':/work:Z',1)[0]);p=json.loads((stage/'package.json').read_text())
            (stage/'package-lock.json').write_text(json.dumps({'packages':{'node_modules/'+k:{'version':v} for k,v in p['dependencies'].items()}}))
        def update(_):
            self.assertEqual(json.loads((self.repo/'package.json').read_text())['dependencies']['@caveman-ai/cli'],'1.1.0')
            if failure:raise RuntimeError('fixture update failure')
        return types.SimpleNamespace(config=lambda:{},name=lambda c:'fixture',pod=pod,run=lambda *a,**k:None,
            image_id=lambda c:'fixture-image',runtime_env=lambda c:[],bundle_ca=lambda:None,update=update)
    def test_invalid_components_and_versions_do_not_execute(self):
        for extra in [{'component':'shell'},{'version':'1.0.0; echo secret'},{'action':'exec'}]:
            with self.assertRaises(ValueError):control.validate(self.request(**extra))
    def test_success_changes_only_selected_dependency_and_saves_manifest_backup(self):
        with patch.object(control,'load_stack',return_value=self.fake()),patch.object(control.shutil,'disk_usage',return_value=types.SimpleNamespace(free=10*1024**3)):
            self.assertTrue(control.execute(self.request())['ok'])
        p=json.loads((self.repo/'package.json').read_text());self.assertEqual(p['dependencies']['@bitkyc08/opencodex'],'2.0.0')
        self.assertEqual(len(list((self.repo/'backups').glob('control-manifests-*'))),1)
    def test_failed_update_restores_both_manifests(self):
        with patch.object(control,'load_stack',return_value=self.fake(True)),patch.object(control.shutil,'disk_usage',return_value=types.SimpleNamespace(free=10*1024**3)):
            with self.assertRaises(RuntimeError):control.execute(self.request())
        for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)

if __name__=='__main__':unittest.main()
