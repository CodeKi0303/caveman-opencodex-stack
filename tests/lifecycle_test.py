"""No Podman/auth needed. Checks real persistent files and transient Unix sockets."""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

p=Path(__file__).resolve().parents[1]/'stack'
loader=importlib.machinery.SourceFileLoader('stack_cli',str(p))
spec=importlib.util.spec_from_loader(loader.name,loader)
m=importlib.util.module_from_spec(spec);loader.exec_module(m)

class StateTests(unittest.TestCase):
    def test_podman_outlives_systemd_update_worker_without_losing_proxy_settings(self):
        worker={'INVOCATION_ID':'fixture-invocation','SYSTEMD_EXEC_PID':'123',
                'NOTIFY_SOCKET':'/run/systemd/notify','HTTPS_PROXY':'http://fixture-proxy:3128','KEEP_BUILD_SETTING':'yes'}
        for explicit in (False,True):
            with self.subTest(explicit=explicit),patch.dict(os.environ,worker,clear=True),patch.object(m,'run') as run:
                given=dict(worker)
                m.pod('run','--detach','fixture',**({'env':given} if explicit else {}))
                env=run.call_args.kwargs['env']
                self.assertEqual(env,{'HTTPS_PROXY':'http://fixture-proxy:3128','KEEP_BUILD_SETTING':'yes'})
                self.assertEqual(given,worker)
                self.assertEqual(os.environ['INVOCATION_ID'],'fixture-invocation')
                command=run.call_args.args[0]
                self.assertEqual(command[0],'systemd-run')
                self.assertIn('--scope',command)
                self.assertEqual(command[-4:],['podman','run','--detach','fixture'])

    def test_detached_systemd_launch_uses_matching_system_or_user_scope(self):
        for uid in (0,1000):
            with self.subTest(uid=uid),patch.dict(os.environ,{'INVOCATION_ID':'worker'},clear=True),patch.object(m.os,'geteuid',return_value=uid),patch.object(m,'run') as run:
                m.pod('run','--detach','fixture')
                command=run.call_args.args[0]
                self.assertEqual('--user' in command,uid!=0)
                self.assertTrue(any(arg.startswith('--unit=caveman-podman-') for arg in command))
                self.assertIn('/usr/bin/env',command)
                self.assertNotIn('INVOCATION_ID',run.call_args.kwargs['env'])

    def test_direct_launch_and_attached_workers_do_not_create_scopes(self):
        cases=[({},('run','--detach','fixture')),
               ({'INVOCATION_ID':'worker'},('run','--rm','fixture','npm','install')),
               ({'INVOCATION_ID':'worker'},('exec','fixture','node','health.mjs'))]
        for env,args in cases:
            with self.subTest(args=args,env=env),patch.dict(os.environ,env,clear=True),patch.object(m,'run') as run:
                m.pod(*args)
                self.assertEqual(run.call_args.args[0],['podman',*args])

    def test_published_ports_keep_internal_listeners_private(self):
        cases=[
            ({'ADMIN_PORT':'20100'},True,['192.168.50.61:18787:8080','192.168.50.61:20100:10100']),
            ({'ADMIN_PORT':'20100','ADMIN_BIND_ADDRESS':'127.0.0.1'},True,['192.168.50.61:18787:8080','127.0.0.1:20100:10100']),
            ({'ADMIN_PORT':''},True,['192.168.50.61:18787:8080']),
            ({'ADMIN_PORT':'20100'},False,[]),
        ]
        for extra,publish,expected in cases:
            with self.subTest(extra=extra,publish=publish),tempfile.TemporaryDirectory() as tmp:
                c={'STACK_NAME':'fixture','IMAGE':'test','BIND_ADDRESS':'192.168.50.61','PORT':'18787',**extra}
                with patch.object(m,'ROOT',Path(tmp)),patch.object(m,'exists',return_value=False),patch.object(m,'pod') as pod,patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=0)):
                    m.launch(c,image='test',publish=publish)
                args=pod.call_args.args
                ports=[args[i+1] for i,x in enumerate(args) if x=='--publish']
                self.assertEqual(ports,expected)

    def test_backup_skips_ipc_and_keeps_data_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            r=Path(tmp);source=r/'state';source.mkdir();(source/'ccr.db').write_bytes(b'fixture-db')
            (source/'alias').symlink_to('ccr.db')
            with socket.socket(socket.AF_UNIX) as sock:
                sock.bind(str(source/'native.sock'))
                m.copy_state(source,r/'backup')
            self.assertEqual((r/'backup/ccr.db').read_bytes(),b'fixture-db')
            self.assertTrue((r/'backup/alias').is_symlink())
            self.assertFalse((r/'backup/native.sock').exists())

    def test_failed_live_candidate_restores_image_and_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            r=Path(tmp);(r/'data/state').mkdir(parents=True);(r/'data/state/ccr.db').write_text('original')
            (r/'data/active-image').write_text('old-id')
            b=r/'backups/test';(b/'state').mkdir(parents=True);(b/'state/ccr.db').write_text('original')
            calls=[]
            def launch(c,image=None,container=None,state=None,publish=True):
                calls.append((image,publish))
                if image=='candidate-id' and publish:
                    (r/'data/state/ccr.db').write_text('migrated')
                    raise RuntimeError('synthetic candidate failure')
            def pod(*args,**kw):
                return SimpleNamespace(stdout=('old-id' if args[2]=='old-id' else 'candidate-id')+'\n')
            with patch.object(m,'ROOT',r),patch.object(m,'build'),patch.object(m,'pod',side_effect=pod),patch.object(m,'snapshot',return_value=b),patch.object(m,'launch',side_effect=launch),patch.object(m,'catalog'),patch.object(m,'down'),patch.object(m.subprocess,'run'):
                with self.assertRaisesRegex(RuntimeError,'previous image and state restored'):
                    m.update({'IMAGE':'localhost/test:dev','STACK_NAME':'fixture'})
            self.assertEqual((r/'data/state/ccr.db').read_text(),'original')
            self.assertEqual((r/'data/active-image').read_text().strip(),'old-id')
            self.assertEqual(calls[-1],('old-id',True))

if __name__=='__main__':unittest.main()
