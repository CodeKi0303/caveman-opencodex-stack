import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('server_control',Path(__file__).resolve().parents[1]/'scripts/server-control.py')
control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)

GIT_VERSIONS={'@caveman-ai/cli':'4.0.1','@bitkyc08/opencodex':'2.84.0','@openai/codex':'0.162.1'}
RUNNING_VERSIONS={'@caveman-ai/cli':'4.0.2','@bitkyc08/opencodex':'2.88.0','@openai/codex':'0.163.0'}

class ServerControlTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.repo=Path(self.temp.name)
        (self.repo/'stack').write_text('# fixture')
        (self.repo/'data').mkdir()
        self.original={'package.json':json.dumps({'dependencies':GIT_VERSIONS}).encode(),'package-lock.json':b'{"packages":{}}'}
        for p,b in self.original.items():(self.repo/p).write_bytes(b)
    def request(self,**extra):return {'repo':str(self.repo),'action':'update','component':'caveman','version':'4.0.3',**extra}
    def fake(self,failure=False,versions=None,selected='@caveman-ai/cli',target='4.0.3'):
        versions=versions or RUNNING_VERSIONS
        manifests={'package.json':json.dumps({'dependencies':versions}),
            'package-lock.json':json.dumps({'packages':{'':{'dependencies':versions},**{'node_modules/'+k:{'version':v} for k,v in versions.items()}}})}
        def pod(*args,**kw):
            if args[0]=='exec':return types.SimpleNamespace(stdout=json.dumps(manifests if 'package-lock.json' in args[-1] else {name:version for name,version in versions.items() if name in args[-1]}))
            self.assertEqual(args[0],'run');mount=args[args.index('--volume')+1];stage=Path(mount.rsplit(':/work:Z',1)[0]);p=json.loads((stage/'package.json').read_text())
            (stage/'package-lock.json').write_text(json.dumps({'packages':{'':{'dependencies':p['dependencies']},**{'node_modules/'+k:{'version':v} for k,v in p['dependencies'].items()}}}))
        def stage_source(stage):
            stage.mkdir()
            (stage/'source-marker').write_text('source copied')
        def update(_,context):
            self.assertTrue((context/'source-marker').exists())
            dependencies=json.loads((context/'package.json').read_text())['dependencies']
            self.assertEqual(dependencies[selected],target)
            for key,value in versions.items():
                if key!=selected:self.assertEqual(dependencies[key],value)
            for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)
            if failure:raise RuntimeError('fixture update failure')
        return types.SimpleNamespace(config=lambda:{},name=lambda c:'fixture',pod=pod,run=lambda *a,**k:None,
            image_id=lambda c:'fixture-image',runtime_env=lambda c:[],bundle_ca=lambda:None,update=update,stage_source=stage_source,
            cleanup_resolver=lambda container,owner:None)
    def test_invalid_components_and_versions_do_not_execute(self):
        for extra in [{'component':'shell'},{'version':'1.0.0; echo secret'},{'action':'exec'}]:
            with self.assertRaises(ValueError):control.validate(self.request(**extra))
    def test_check_reports_current_configured_and_latest_for_all_three_components(self):
        latest={'@caveman-ai/cli':'4.0.3','@bitkyc08/opencodex':'2.89.0','@openai/codex':'0.164.0'}
        with patch.object(control,'load_stack',return_value=self.fake()),patch.object(control,'registry',side_effect=latest.__getitem__) as registry:
            result=control.execute(self.request(action='check'))
        self.assertEqual(result['components'],{
            label:{'current':RUNNING_VERSIONS[name],'configured':GIT_VERSIONS[name],'latest':latest[name]}
            for label,name in {'caveman':'@caveman-ai/cli','opencodex':'@bitkyc08/opencodex','codex':'@openai/codex'}.items()})
        self.assertEqual({call.args[0] for call in registry.call_args_list},set(latest))
        self.assertFalse((self.repo/'data/operation.lock').exists())
    def test_codex_registry_failure_keeps_other_checks_and_installed_version(self):
        def registry(name):
            if name=='@openai/codex':raise OSError('private registry credentials must not be returned')
            return RUNNING_VERSIONS[name]
        with patch.object(control,'load_stack',return_value=self.fake()),patch.object(control,'registry',side_effect=registry):
            result=control.execute(self.request(action='check'))
        self.assertTrue(result['ok'])
        self.assertEqual(result['components']['codex'],{'current':'0.163.0','configured':'0.162.1','checkError':'REGISTRY_UNAVAILABLE'})
        self.assertEqual(result['components']['caveman']['latest'],'4.0.2')
        self.assertEqual(result['components']['opencodex']['latest'],'2.88.0')
        self.assertNotIn('private registry credentials',json.dumps(result))
    def test_status_reads_latest_mode_without_stack_registry_or_lock(self):
        config=self.repo/'data/state/opencodex/config.json'
        config.parent.mkdir(parents=True)
        # Package metadata need not be parsed for a cheap status read.
        (self.repo/'package.json').write_text('not JSON')
        with patch.object(control,'load_stack',side_effect=AssertionError('stack must not load')),patch.object(control,'registry',side_effect=AssertionError('registry must not be queried')),patch.object(control.fcntl,'flock',side_effect=AssertionError('status must not lock')):
            for mode in ('pool','direct','pool'):
                config.write_text(json.dumps({'providers':{'openai':{'codexAccountMode':mode,'apiKey':'fixture-secret'}},'account':'private@example.test'}))
                result=control.execute(self.request(action='status'))
                self.assertEqual(result,{'ok':True,'authentication':{'mode':mode,'source':'server'}})
                self.assertNotIn('fixture-secret',json.dumps(result))
                self.assertNotIn('private@example.test',json.dumps(result))
        self.assertFalse((self.repo/'data/operation.lock').exists())
        self.assertFalse((self.repo/'data/control-jobs').exists())
    def test_status_missing_or_invalid_mode_stays_unknown(self):
        config=self.repo/'data/state/opencodex/config.json'
        config.parent.mkdir(parents=True)
        unknown={'ok':True,'authentication':{'mode':'unknown','source':'unavailable'}}
        self.assertEqual(control.execute(self.request(action='status')),unknown)
        for data in ('not JSON','null','[]','{}','{"providers":null}',
                '{"providers":{"openai":{}}}',
                '{"providers":{"openai":{"codexAccountMode":"unexpected"}}}',
                '{"providers":{"openai":{"codexAccountMode":{}}}}'):
            with self.subTest(data=data):
                config.write_text(data)
                self.assertEqual(control.execute(self.request(action='status')),unknown)
        config.write_bytes(b'\xff')
        self.assertEqual(control.execute(self.request(action='status')),unknown)
    def test_status_validates_repository_before_reading(self):
        for repo in ('relative/path',str(self.repo/'missing')):
            with self.subTest(repo=repo),self.assertRaisesRegex(ValueError,'INVALID_REPOSITORY'):
                control.execute(self.request(action='status',repo=repo))
        (self.repo/'package-lock.json').unlink()
        with self.assertRaisesRegex(ValueError,'INVALID_REPOSITORY'):
            control.execute(self.request(action='status'))
    def test_success_stages_only_selected_dependency_and_preserves_checkout(self):
        with patch.object(control,'load_stack',return_value=self.fake()),patch.object(control.shutil,'disk_usage',return_value=types.SimpleNamespace(free=10*1024**3)):
            self.assertTrue(control.execute(self.request())['ok'])
        for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)
        self.assertEqual(len(list((self.repo/'backups').glob('control-manifests-*'))),1)
        record=next((self.repo/'data/releases').glob('*/release.json'))
        self.assertEqual(json.loads(record.read_text())['status'],'applied')
    def test_failed_update_preserves_both_manifests_and_records_failure(self):
        with patch.object(control,'load_stack',return_value=self.fake(True)),patch.object(control.shutil,'disk_usage',return_value=types.SimpleNamespace(free=10*1024**3)):
            with self.assertRaises(RuntimeError):control.execute(self.request())
        for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)
        record=next((self.repo/'data/releases').glob('*/release.json'))
        self.assertEqual(json.loads(record.read_text())['status'],'failed')
    def test_selective_update_does_not_downgrade_other_products_after_latest_release(self):
        versions=RUNNING_VERSIONS
        with patch.object(control,'load_stack',return_value=self.fake(versions=versions)),patch.object(control.shutil,'disk_usage',return_value=types.SimpleNamespace(free=10*1024**3)):
            self.assertTrue(control.execute(self.request())['ok'])
        record=next((self.repo/'data/releases').glob('*/package.json'))
        self.assertEqual(json.loads(record.read_text())['dependencies'],{**versions,'@caveman-ai/cli':'4.0.3'})
        for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)
    def test_codex_selective_update_preserves_newer_running_caveman_and_opencodex(self):
        stack=self.fake(selected='@openai/codex',target='0.164.0')
        with patch.object(control,'load_stack',return_value=stack),patch.object(control.shutil,'disk_usage',return_value=types.SimpleNamespace(free=10*1024**3)):
            result=control.execute(self.request(component='codex',version='0.164.0'))
        self.assertEqual((result['ok'],result['component'],result['version']),(True,'codex','0.164.0'))
        release=next((self.repo/'data/releases').glob('control-*'))
        self.assertEqual(json.loads((release/'package.json').read_text())['dependencies'],{**RUNNING_VERSIONS,'@openai/codex':'0.164.0'})
        metadata=json.loads((release/'release.json').read_text())
        self.assertEqual((metadata['status'],metadata['component'],metadata['version']),('applied','codex','0.164.0'))
        backup=next((self.repo/'backups').glob('control-manifests-*'))
        self.assertEqual(json.loads((backup/'package.json').read_text())['dependencies'],RUNNING_VERSIONS)
        for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)
    def test_same_installed_version_is_noop_even_when_git_pin_is_older(self):
        versions={**RUNNING_VERSIONS,'@caveman-ai/cli':'4.0.3'}
        stack=self.fake(versions=versions)
        with patch.object(control,'load_stack',return_value=stack),patch.object(stack,'update') as update:
            self.assertTrue(control.execute(self.request())['unchanged'])
            update.assert_not_called()
        self.assertFalse((self.repo/'backups').exists())
        for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)
    def test_same_codex_installed_version_does_not_rebuild_or_read_runtime_manifests(self):
        stack=self.fake()
        with patch.object(control,'load_stack',return_value=stack),patch.object(stack,'update') as update,patch.object(stack,'pod',wraps=stack.pod) as pod,patch.object(control.shutil,'disk_usage',side_effect=AssertionError('unchanged version must not require build space')):
            result=control.execute(self.request(component='codex',version='0.163.0'))
        self.assertTrue(result['unchanged'])
        update.assert_not_called()
        self.assertEqual(pod.call_count,1)
        self.assertFalse((self.repo/'backups').exists())
        self.assertFalse((self.repo/'data/releases').exists())
        for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)
    def test_resolver_timeout_cleans_owned_container_without_changing_checkout(self):
        stack=self.fake();original_pod=stack.pod
        def timeout(*args,**kw):
            if args[0]=='run':raise subprocess.TimeoutExpired('podman',300)
            return original_pod(*args,**kw)
        with patch.object(control,'load_stack',return_value=stack),patch.object(control.shutil,'disk_usage',return_value=types.SimpleNamespace(free=10*1024**3)),patch.object(stack,'pod',side_effect=timeout),patch.object(stack,'cleanup_resolver') as cleanup,patch.object(stack,'update') as update:
            with self.assertRaises(subprocess.TimeoutExpired):control.execute(self.request())
            cleanup.assert_called_once()
            container,owner=cleanup.call_args.args
            self.assertEqual(container,'caveman-control-resolver-'+owner)
            update.assert_not_called()
        for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)

if __name__=='__main__':unittest.main()
