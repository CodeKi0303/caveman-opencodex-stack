"""Latest-version resolution and Git update transaction tests; no Podman or registry required."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE=Path(__file__).resolve().parents[1]/'stack'
loader=importlib.machinery.SourceFileLoader('latest_stack_cli',str(SOURCE))
spec=importlib.util.spec_from_loader(loader.name,loader)
m=importlib.util.module_from_spec(spec);loader.exec_module(m)

class LatestTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name);(self.root/'data').mkdir()
        self.dependencies={name:'1.0.0' for name in m.LATEST_PACKAGES}
        self.dependencies['@iarna/toml']='3.0.0'
        (self.root/'package.json').write_text(json.dumps({'dependencies':self.dependencies}))
        (self.root/'package-lock.json').write_text('{"packages":{}}')
        (self.root/'Containerfile').write_text('FROM fixture')
        self.original={name:(self.root/name).read_bytes() for name in ('package.json','package-lock.json')}

    def fake_resolve(self,c,stage):
        versions={name:'2.0.0' for name in m.LATEST_PACKAGES}
        package=json.loads((stage/'package.json').read_text());package['dependencies'].update(versions)
        (stage/'package.json').write_text(json.dumps(package))
        (stage/'package-lock.json').write_text(json.dumps({'packages':{'':{'dependencies':package['dependencies']}}}))
        return versions

    def test_build_context_has_resolved_versions_without_dirtying_checkout_or_copying_secrets(self):
        for dirname in ('secrets','certs','backups','node_modules'):
            (self.root/dirname).mkdir();(self.root/dirname/'private').write_text('not-for-build-context')
        (self.root/'.env').write_text('SECRET=private')
        (self.root/'data/auth.json').write_text('private')
        contexts=[]
        def update(c,context):
            contexts.append(context)
            self.assertEqual(json.loads((context/'package.json').read_text())['dependencies']['@caveman-ai/cli'],'2.0.0')
            for name in ('.env','secrets','certs','data','backups','node_modules'):self.assertFalse((context/name).exists())
        with patch.object(m,'ROOT',self.root),patch.object(m,'resolve_latest',side_effect=self.fake_resolve),patch.object(m,'update',side_effect=update),patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)):
            release=m.update_latest({'IMAGE':'fixture'})
        self.assertEqual(json.loads((release/'release.json').read_text())['status'],'applied')
        self.assertFalse(contexts[0].exists())
        for name,content in self.original.items():self.assertEqual((self.root/name).read_bytes(),content)

    def test_failed_candidate_keeps_original_manifests_and_records_failure(self):
        with patch.object(m,'ROOT',self.root),patch.object(m,'resolve_latest',side_effect=self.fake_resolve),patch.object(m,'update',side_effect=RuntimeError('candidate failed')),patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)):
            with self.assertRaisesRegex(RuntimeError,'candidate failed'):m.update_latest({'IMAGE':'fixture'})
        for name,content in self.original.items():self.assertEqual((self.root/name).read_bytes(),content)
        record=next((self.root/'data/releases').glob('*/release.json'))
        self.assertEqual(json.loads(record.read_text())['status'],'failed')
        self.assertEqual(list((self.root/'data').glob('update-build-*')),[])

    def test_registry_failure_never_builds_or_falls_back_to_old_versions(self):
        with patch.object(m,'ROOT',self.root),patch.object(m,'resolve_latest',side_effect=RuntimeError('registry unavailable')),patch.object(m,'update') as update,patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)):
            with self.assertRaisesRegex(RuntimeError,'registry unavailable'):m.update_latest({'IMAGE':'fixture'})
            update.assert_not_called()
        for name,content in self.original.items():self.assertEqual((self.root/name).read_bytes(),content)

    @unittest.skipUnless(shutil.which('node'),'Node.js is required to exercise the exact resolver program')
    def test_resolver_uses_exact_stable_versions_and_rejects_prerelease_or_bad_lock(self):
        binary=self.root/'bin';binary.mkdir()
        npm=binary/'npm'
        npm.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
if sys.argv[1]=='view':
    print(json.dumps(os.environ.get('TEST_LATEST','2.1.0')))
else:
    p=json.loads(Path('package.json').read_text());deps=p['dependencies']
    lock={'packages':{'':{'dependencies':deps},**{'node_modules/'+k:{'version':v} for k,v in deps.items()}}}
    if os.environ.get('TEST_BAD_LOCK'):lock['packages']['node_modules/@caveman-ai/cli']['version']='0.0.0'
    Path('package-lock.json').write_text(json.dumps(lock))
''');npm.chmod(0o700)
        def pod(*args,**kw):
            script=args[args.index('-e')+1];names=args[-1]
            env={**os.environ,'PATH':str(binary)+os.pathsep+os.environ['PATH']}
            return subprocess.run([shutil.which('node'),'-e',script,names],cwd=self.root,env=env,check=True,capture_output=True,text=True)
        with patch.object(m,'ROOT',self.root),patch.object(m,'pod',side_effect=pod),patch.object(m,'bundle_ca',return_value=None),patch.object(m,'exists',return_value=False):
            self.assertEqual(m.resolve_latest({'IMAGE':'fixture'},self.root),{name:'2.1.0' for name in m.LATEST_PACKAGES})
            deps=json.loads((self.root/'package.json').read_text())['dependencies']
            self.assertEqual(deps['@iarna/toml'],'3.0.0')
            with patch.dict(os.environ,{'TEST_LATEST':'3.0.0-beta.1'}):
                with self.assertRaises(subprocess.CalledProcessError):m.resolve_latest({'IMAGE':'fixture'},self.root)
            with patch.dict(os.environ,{'TEST_BAD_LOCK':'1'}):
                with self.assertRaises(subprocess.CalledProcessError):m.resolve_latest({'IMAGE':'fixture'},self.root)

    def test_timed_out_resolver_removes_owned_container_before_returning(self):
        calls=[];owner=None;container=None
        def pod(*args,**kw):
            nonlocal owner,container
            calls.append(args)
            if args[0]=='run':
                container=args[args.index('--name')+1]
                owner=args[args.index('--label')+1].split('=',1)[1]
                raise subprocess.TimeoutExpired('podman',300)
            if args[0]=='inspect':return SimpleNamespace(stdout=owner+'\n')
            if args[0]=='rm':self.assertEqual(args,('rm','--force',container));return SimpleNamespace()
            self.fail('unexpected resolver operation')
        with patch.object(m,'ROOT',self.root),patch.object(m,'pod',side_effect=pod),patch.object(m,'bundle_ca',return_value=None),patch.object(m,'exists',return_value=True):
            with self.assertRaises(subprocess.TimeoutExpired):m.resolve_latest({'IMAGE':'fixture'},self.root)
        self.assertEqual([args[0] for args in calls],['run','inspect','rm'])
        self.assertTrue(container.startswith('caveman-latest-resolver-'))

    def test_resolver_cleanup_never_removes_an_unowned_container(self):
        with patch.object(m,'exists',return_value=True),patch.object(m,'pod',return_value=SimpleNamespace(stdout='somebody-else\n')) as pod:
            with self.assertRaisesRegex(RuntimeError,'different owner'):m.cleanup_resolver('fixture','expected-owner')
        self.assertEqual([call.args[0] for call in pod.call_args_list],['inspect'])

    def test_post_apply_record_error_reports_that_production_was_updated(self):
        def update(c,context):
            record=next((self.root/'data/releases').glob('*/release.json'))
            record.unlink();record.mkdir()  # Make the final record write fail after deployment succeeds.
        with patch.object(m,'ROOT',self.root),patch.object(m,'resolve_latest',side_effect=self.fake_resolve),patch.object(m,'update',side_effect=update),patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)):
            with self.assertRaisesRegex(RuntimeError,'Update was applied'):m.update_latest({'IMAGE':'fixture'})

class GitUpdateTests(unittest.TestCase):
    def git(self,path,*args):
        return subprocess.run(['git','-C',str(path),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',*args],check=True,capture_output=True,text=True)

    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name);self.origin=self.root/'origin';self.local=self.root/'local'
        self.origin.mkdir();self.git(self.origin,'init','-b','main')
        shutil.copy2(SOURCE,self.origin/'stack')
        (self.origin/'.gitignore').write_text('data/\n.env\n')
        self.git(self.origin,'add','.');self.git(self.origin,'commit','-m','initial')
        self.git(self.root,'clone',str(self.origin),str(self.local))
        (self.local/'data').mkdir();(self.local/'.env').write_text('STACK_NAME=fixture\nIMAGE=fixture\n')

    def test_pull_executes_new_cli_and_preserves_operation_lock(self):
        # The new source records whether another descriptor can take the lock during exec.
        (self.origin/'stack').write_text('''import fcntl,json,os,sys
from pathlib import Path
root=Path(__file__).resolve().parent
fd=int(sys.argv[sys.argv.index('--operation-lock-fd')+1])
assert os.fstat(fd).st_ino==(root/'data/operation.lock').stat().st_ino
locked=False
with (root/'data/operation.lock').open('a') as other:
    try:fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:locked=True
(root/'data/result.json').write_text(json.dumps({'newSource':True,'args':sys.argv[1:],'lockHeld':locked}))
''')
        self.git(self.origin,'add','stack');self.git(self.origin,'commit','-m','new cli')
        subprocess.run(['python3',str(self.local/'stack'),'git-update'],check=True,capture_output=True,text=True)
        result=json.loads((self.local/'data/result.json').read_text())
        self.assertTrue(result['newSource']);self.assertTrue(result['lockHeld'])
        self.assertEqual(result['args'][:2],['update','--latest'])
        self.assertEqual(self.git(self.local,'status','--porcelain').stdout,'')

    def test_dirty_tree_is_rejected_without_pull_or_exec(self):
        (self.local/'local-change').write_text('preserve')
        with patch.object(m,'ROOT',self.local),patch.object(m.os,'execv') as execute:
            with (self.local/'data/operation.lock').open('a') as lock:
                with self.assertRaisesRegex(RuntimeError,'local changes'):m.git_update(lock)
            execute.assert_not_called()
        self.assertEqual((self.local/'local-change').read_text(),'preserve')

    def test_diverged_history_is_rejected_without_reset(self):
        (self.local/'ours').write_text('ours');self.git(self.local,'add','ours');self.git(self.local,'commit','-m','ours')
        original=self.git(self.local,'rev-parse','HEAD').stdout
        (self.origin/'theirs').write_text('theirs');self.git(self.origin,'add','theirs');self.git(self.origin,'commit','-m','theirs')
        with patch.object(m,'ROOT',self.local),patch.object(m.os,'execv') as execute:
            with (self.local/'data/operation.lock').open('a') as lock:
                with self.assertRaises(subprocess.CalledProcessError):m.git_update(lock)
            execute.assert_not_called()
        self.assertEqual(self.git(self.local,'rev-parse','HEAD').stdout,original)
        self.assertTrue((self.local/'ours').exists())

if __name__=='__main__':unittest.main()
