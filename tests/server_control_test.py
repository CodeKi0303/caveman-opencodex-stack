import importlib.util
import fcntl
import io
import json
from pathlib import Path
import subprocess
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
    def fake(self,failure=False,versions=None):
        versions=versions or {'@caveman-ai/cli':'1.0.0','@bitkyc08/opencodex':'2.0.0'}
        manifests={'package.json':json.dumps({'dependencies':versions}),
            'package-lock.json':json.dumps({'packages':{'':{'dependencies':versions},**{'node_modules/'+k:{'version':v} for k,v in versions.items()}}})}
        def pod(*args,**kw):
            if args[0]=='exec':return types.SimpleNamespace(stdout=json.dumps(manifests if 'package-lock.json' in args[-1] else versions))
            self.assertEqual(args[0],'run');mount=args[args.index('--volume')+1];stage=Path(mount.rsplit(':/work:Z',1)[0]);p=json.loads((stage/'package.json').read_text())
            (stage/'package-lock.json').write_text(json.dumps({'packages':{'':{'dependencies':p['dependencies']},**{'node_modules/'+k:{'version':v} for k,v in p['dependencies'].items()}}}))
        def stage_source(stage):
            stage.mkdir()
            (stage/'source-marker').write_text('source copied')
        def update(_,context):
            self.assertTrue((context/'source-marker').exists())
            dependencies=json.loads((context/'package.json').read_text())['dependencies']
            self.assertEqual(dependencies['@caveman-ai/cli'],'1.1.0')
            for key,value in versions.items():
                if key!='@caveman-ai/cli':self.assertEqual(dependencies[key],value)
            for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)
            if failure:raise RuntimeError('fixture update failure')
        return types.SimpleNamespace(config=lambda:{},name=lambda c:'fixture',pod=pod,run=lambda *a,**k:None,
            image_id=lambda c:'fixture-image',runtime_env=lambda c:[],bundle_ca=lambda:None,update=update,stage_source=stage_source,
            cleanup_resolver=lambda container,owner:None)
    def test_invalid_components_and_versions_do_not_execute(self):
        for extra in [{'component':'shell'},{'version':'1.0.0; echo secret'},{'action':'exec'}]:
            with self.assertRaises(ValueError):control.validate(self.request(**extra))
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
        versions={'@caveman-ai/cli':'1.0.0','@bitkyc08/opencodex':'9.0.0','@openai/codex':'5.0.0'}
        with patch.object(control,'load_stack',return_value=self.fake(versions=versions)),patch.object(control.shutil,'disk_usage',return_value=types.SimpleNamespace(free=10*1024**3)):
            self.assertTrue(control.execute(self.request())['ok'])
        record=next((self.repo/'data/releases').glob('*/package.json'))
        self.assertEqual(json.loads(record.read_text())['dependencies'],{**versions,'@caveman-ai/cli':'1.1.0'})
        for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)
    def test_same_installed_version_is_noop_even_when_git_pin_is_older(self):
        versions={'@caveman-ai/cli':'1.1.0','@bitkyc08/opencodex':'9.0.0'}
        stack=self.fake(versions=versions)
        with patch.object(control,'load_stack',return_value=stack),patch.object(stack,'update') as update:
            self.assertTrue(control.execute(self.request())['unchanged'])
            update.assert_not_called()
        self.assertFalse((self.repo/'backups').exists())
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

    def action(self,action,**extra):return {'repo':str(self.repo),'action':action,**extra}

    def assert_operation_locked(self):
        with (self.repo/'data/operation.lock').open('a') as other:
            with self.assertRaises(BlockingIOError):control.fcntl.flock(other,control.fcntl.LOCK_EX|control.fcntl.LOCK_NB)

    def test_action_argument_whitelist_rejects_command_injection_and_malformed_values(self):
        for action in ('connection','status','restart','latest-update','git-update'):
            self.assertEqual(control.validate(self.action(action)),self.repo.resolve())
            for extra in ({'command':'echo secret'},{'component':'caveman'},{'version':'1.2.3'},{'repo':12}):
                with self.assertRaises(ValueError):control.validate(self.action(action,**extra))
        for payload in (None,[],{'action':[]},self.request(component=[]),self.request(version=12)):
            with self.assertRaises(ValueError):control.validate(payload)

    def test_connection_reads_only_gateway_key_without_loading_stack_or_logging(self):
        secrets=self.repo/'secrets';secrets.mkdir()
        gateway='synthetic-gateway-connection-key'
        (secrets/'gateway-key').write_text(gateway+'\n')
        (secrets/'admin-key').write_text('admin-must-not-be-returned')
        output=io.StringIO()
        with patch.object(control,'load_stack') as loader,patch('sys.stdout',output):
            self.assertEqual(control.execute(self.action('connection')),{'ok':True,'gatewayKey':gateway})
            loader.assert_not_called()
        self.assertEqual(output.getvalue(),'')
        self.assertFalse((self.repo/'data/control-jobs').exists())
        for value in ('short','x'*4098,'x'*20+'\n'+'y'*20):
            (secrets/'gateway-key').write_text(value)
            with self.assertRaisesRegex(ValueError,'GATEWAY_KEY_INVALID'):control.execute(self.action('connection'))

    def test_status_uses_actual_container_state_and_filters_private_fields(self):
        stack=self.fake();stack.exists=lambda n:True
        original=stack.pod
        state={'Status':'running','Running':True,'Health':{'Status':'healthy','Log':['hidden-body']},'Error':'hidden-error'}
        def pod(*args,**kw):
            if args[0]=='inspect':
                self.assertEqual(args,('inspect','fixture','--format','{{json .State}}'))
                return types.SimpleNamespace(stdout=json.dumps(state))
            return original(*args,**kw)
        stack.pod=pod
        with patch.object(control,'load_stack',return_value=stack),patch.object(control,'git_dirty',return_value=True):
            result=control.execute(self.action('status'))
        self.assertEqual({key:result[key] for key in ('ok','exists','status','running','health','gitDirty')},
            {'ok':True,'exists':True,'status':'running','running':True,'health':'healthy','gitDirty':True})
        self.assertEqual(result['components']['caveman'],{'current':'1.0.0'})
        self.assertNotIn('hidden',json.dumps(result))

    def test_status_missing_container_does_not_claim_it_is_running(self):
        stack=self.fake();stack.exists=lambda n:False
        with patch.object(control,'load_stack',return_value=stack),patch.object(control,'git_dirty',return_value=None),patch.object(stack,'pod') as pod:
            result=control.execute(self.action('status'));pod.assert_not_called()
        self.assertEqual(result,{'ok':True,'container':'fixture','exists':False,'status':'absent','running':False,'health':None,'gitDirty':None})

    def test_restart_preserves_actual_image_even_for_stopped_container_and_holds_lock(self):
        for exists in (True,False):
            stack=self.fake();stack.exists=lambda n:exists
            sequence=[]
            def pod(*args,**kw):
                self.assert_operation_locked()
                if args[0]=='inspect':
                    self.assertTrue(exists)
                    return types.SimpleNamespace(stdout='sha256:deployed\n')
                self.assertEqual(args,('image','inspect','sha256:deployed' if exists else 'fixture-image','--format','{{.Id}}'))
                return types.SimpleNamespace(stdout='sha256:immutable\n')
            def down(config):self.assert_operation_locked();sequence.append('down')
            def launch(config,image):self.assert_operation_locked();sequence.append(('launch',image))
            def catalog(config):self.assert_operation_locked();sequence.append('catalog')
            stack.pod=pod;stack.down=down;stack.launch=launch;stack.catalog=catalog
            with patch.object(control,'load_stack',return_value=stack):
                result=control.execute(self.action('restart'))
            self.assertTrue(result['ok'])
            self.assertEqual(sequence,['down',('launch','sha256:immutable'),'catalog'])
            self.assertEqual((self.repo/'data/active-image').read_text(),'sha256:immutable\n')
            self.assertTrue((self.repo/'data/control-jobs'/(result['jobId']+'.log')).is_file())

    def test_restart_ownership_failure_does_not_launch_or_rewrite_image(self):
        stack=self.fake();stack.exists=lambda n:True
        stack.pod=lambda *a,**k:types.SimpleNamespace(stdout='sha256:unowned\n')
        stack.launch=lambda *a: self.fail('unowned container must never be replaced')
        stack.catalog=lambda *a: self.fail('unowned container must never be changed')
        def reject(config):raise RuntimeError('Refusing to stop an unowned container')
        stack.down=reject
        with patch.object(control,'load_stack',return_value=stack),self.assertRaisesRegex(control.OperationError,'SERVER_OPERATION_FAILED') as failure:
            control.execute(self.action('restart'))
        self.assertTrue(failure.exception.job_id)
        self.assertFalse((self.repo/'data/active-image').exists())

    def test_latest_update_is_locked_and_does_not_modify_git_manifests(self):
        stack=self.fake()
        def latest(config):self.assert_operation_locked();print('synthetic update output')
        stack.update_latest=latest
        old_run=stack.run
        with patch.object(control,'load_stack',return_value=stack):result=control.execute(self.action('latest-update'))
        self.assertTrue(result['ok']);self.assertIs(stack.run,old_run)
        log=self.repo/'data/control-jobs'/(result['jobId']+'.log')
        self.assertIn('synthetic update output',log.read_text())
        self.assertEqual(log.stat().st_mode&0o777,0o600)
        for p,b in self.original.items():self.assertEqual((self.repo/p).read_bytes(),b)

    def test_unsupported_server_stops_before_partial_writes(self):
        for action in ('latest-update','git-update','restart'):
            with patch.object(control,'load_stack',return_value=self.fake()),self.assertRaisesRegex(ValueError,'SERVER_UPGRADE_REQUIRED'):
                control.execute(self.action(action))
        self.assertEqual(list((self.repo/'data').iterdir()),[])

    def test_git_update_child_owns_lock_without_parent_deadlock(self):
        stack=self.fake();stack.git_update=lambda lock:None;stack.update_latest=lambda config:None;stack.operation_lock=lambda:None
        def run(args,**kwargs):
            self.assertEqual(args,[control.sys.executable,str(self.repo/'stack'),'git-update'])
            self.assertEqual(kwargs['stdin'],subprocess.DEVNULL)
            self.assertFalse(kwargs['check'])
            self.assertIs(kwargs['stdout'],kwargs['stderr'])
            with (self.repo/'data/operation.lock').open('a') as child_lock:
                fcntl.flock(child_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return types.SimpleNamespace(returncode=0)
        with patch.object(control,'load_stack',return_value=stack),patch.object(control,'git_dirty',return_value=False),patch.object(control.subprocess,'run',side_effect=run):
            result=control.execute(self.action('git-update'))
        self.assertTrue(result['ok']);self.assertTrue(result['jobId'])

    def test_git_dirty_is_not_stashed_reset_or_updated(self):
        stack=self.fake();stack.git_update=lambda lock:None;stack.update_latest=lambda config:None;stack.operation_lock=lambda:None
        with patch.object(control,'load_stack',return_value=stack),patch.object(control,'git_dirty',return_value=True),patch.object(control.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'GIT_DIRTY'):control.execute(self.action('git-update'))
            run.assert_not_called()
        self.assertFalse((self.repo/'data/control-jobs').exists())

    def test_busy_server_is_rejected_before_new_job(self):
        stack=self.fake();stack.update_latest=lambda config:self.fail('busy server cannot update')
        with (self.repo/'data/operation.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with patch.object(control,'load_stack',return_value=stack),self.assertRaisesRegex(ValueError,'SERVER_BUSY'):
                control.execute(self.action('latest-update'))
        self.assertFalse((self.repo/'data/control-jobs').exists())

    def test_error_response_never_contains_subprocess_details(self):
        output=io.StringIO()
        with patch('sys.stdin',io.StringIO('{}')),patch('sys.stdout',output),patch.object(control,'execute',side_effect=control.OperationError('SERVER_OPERATION_FAILED','synthetic-job')):
            self.assertEqual(control.main(),1)
        self.assertEqual(json.loads(output.getvalue()),{'ok':False,'error':'SERVER_OPERATION_FAILED','jobId':'synthetic-job'})
        output=io.StringIO()
        with patch('sys.stdin',io.StringIO('{}')),patch('sys.stdout',output),patch.object(control,'execute',side_effect=RuntimeError('private output')):
            self.assertEqual(control.main(),1)
        self.assertNotIn('private',output.getvalue())

if __name__=='__main__':unittest.main()
