#!/usr/bin/env python3
"""SSH-only controller: fixed operations, no shell commands supplied by the UI."""
import contextlib
import fcntl
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

PACKAGES={'caveman':'@caveman-ai/cli','opencodex':'@bitkyc08/opencodex','codex':'@openai/codex'}

def update_plan(payload):
    batch='updates' in payload
    if batch and ('component' in payload or 'version' in payload):raise ValueError('INVALID_UPDATE_SELECTION')
    updates=payload['updates'] if batch else [{'component':payload.get('component'),'version':payload.get('version')}]
    if not isinstance(updates,list) or not 1<=len(updates)<=len(PACKAGES):raise ValueError('INVALID_UPDATE_SELECTION')
    seen=set();result=[]
    for item in updates:
        if (not isinstance(item,dict) or set(item)!= {'component','version'} or
                not isinstance(item['component'],str) or item['component'] not in PACKAGES or
                not isinstance(item['version'],str) or not re.fullmatch(r'\d+\.\d+\.\d+',item['version'])):
            raise ValueError('INVALID_VERSION')
        if item['component'] in seen:raise ValueError('INVALID_UPDATE_SELECTION')
        seen.add(item['component']);result.append(dict(item))
    return result

def validate(payload):
    if not isinstance(payload,dict) or payload.get('action') not in ('status','check','catalog','update'):
        raise ValueError('INVALID_OPERATION')
    repo=Path(payload.get('repo',''))
    if not repo.is_absolute() or not (repo/'stack').is_file() or not (repo/'package-lock.json').is_file():
        raise ValueError('INVALID_REPOSITORY')
    if payload['action']=='update':update_plan(payload)
    return repo.resolve()

def load_stack(repo):
    loader=importlib.machinery.SourceFileLoader('caveman_control_stack',str(repo/'stack'))
    spec=importlib.util.spec_from_loader(loader.name,loader)
    module=importlib.util.module_from_spec(spec);loader.exec_module(module)
    return module

def registry(package):
    request=urllib.request.Request('https://registry.npmjs.org/'+package.replace('/','%2f')+'/latest',headers={'User-Agent':'caveman-local-control'})
    with urllib.request.urlopen(request,timeout=12) as response:
        data=json.loads(response.read(2*1024*1024))
    version=data.get('version','')
    if not re.fullmatch(r'\d+\.\d+\.\d+',version):raise ValueError('REGISTRY_VERSION_INVALID')
    return version

def execute(payload,job_id=None):
    repo=validate(payload)
    if payload['action']=='status':
        # Poll only the fixed, persisted mode; never load the stack, query an
        # account or disclose any other configuration fields to the browser.
        authentication={'mode':'unknown','source':'unavailable'}
        try:
            persisted=json.loads((repo/'data/state/opencodex/config.json').read_text())
            mode=persisted['providers']['openai']['codexAccountMode']
            if mode in ('pool','direct'):
                authentication={'mode':mode,'source':'server'}
        except (OSError,UnicodeError,ValueError,KeyError,TypeError):
            pass
        return {'ok':True,'authentication':authentication}
    stack=load_stack(repo);config=stack.config()
    package=json.loads((repo/'package.json').read_text())
    def installed_versions():
        running=stack.pod('exec',stack.name(config),'node','--input-type=module','-e',
            "import fs from 'node:fs';console.log(JSON.stringify(Object.fromEntries("+json.dumps([*PACKAGES.values(),'bun'])+".map(n=>[n,JSON.parse(fs.readFileSync('/app/node_modules/'+n+'/package.json')).version]))))",
            capture_output=True,text=True)
        return json.loads(running.stdout)
    def runtime_manifests():
        # Git pins can lag behind a --latest release. Start from the manifests
        # actually deployed so updating one product cannot downgrade the others.
        running=stack.pod('exec',stack.name(config),'node','--input-type=module','-e',
            "import fs from 'node:fs';console.log(JSON.stringify(Object.fromEntries(['package.json','package-lock.json'].map(n=>[n,fs.readFileSync('/app/'+n,'utf8')]))))",
            capture_output=True,text=True)
        files=json.loads(running.stdout)
        if not isinstance(files,dict) or set(files)!= {'package.json','package-lock.json'} or any(not isinstance(value,str) for value in files.values()):
            raise ValueError('RUNTIME_MANIFEST_INVALID')
        current=json.loads(files['package.json']);locked=json.loads(files['package-lock.json'])
        if not isinstance(current.get('dependencies'),dict) or not isinstance(locked.get('packages'),dict):
            raise ValueError('RUNTIME_MANIFEST_INVALID')
        return files,current
    if payload['action']=='check':
        versions={}
        installed=installed_versions()
        for label,name in PACKAGES.items():
            row={'current':installed.get(name),'configured':package['dependencies'][name]}
            try:row['latest']=registry(name)
            except Exception:row['checkError']='REGISTRY_UNAVAILABLE'
            versions[label]=row
        return {'ok':True,'components':versions,'container':stack.name(config)}
    with (repo/'data/operation.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('SERVER_BUSY')
        logs=repo/'data/control-jobs';logs.mkdir(mode=0o700,exist_ok=True)
        job_id=job_id or uuid.uuid4().hex
        log=logs/(job_id+'.log')
        # Child output stays in a private host log. Never return raw package or proxy output.
        with log.open('w') as stream,contextlib.redirect_stdout(stream),contextlib.redirect_stderr(stream):
            old_run=stack.run
            def quiet_run(args,**kw):
                if not kw.get('capture_output'):
                    kw.setdefault('stdout',stream);kw.setdefault('stderr',stream)
                return old_run(args,**kw)
            stack.run=quiet_run
            if payload['action']=='catalog':
                stack.catalog(config)
                return {'ok':True,'message':'서버 모델 카탈로그를 갱신했습니다. 로컬 동기화를 실행하세요.','jobId':job_id}
            plan=update_plan(payload);installed=installed_versions()
            changed=[item for item in plan if installed.get(PACKAGES[item['component']])!=item['version']]
            # OpenCodex is executed by our top-level pinned Bun, including when
            # its nested dependency is overridden by "$bun". An OpenCodex update
            # must also adopt the compatible runtime from this source release.
            runtimes={}
            if any(item['component']=='opencodex' for item in plan) and 'bun' in package['dependencies']:
                bun=package['dependencies']['bun']
                if not isinstance(bun,str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',bun):raise ValueError('RUNTIME_MANIFEST_INVALID')
                runtimes['bun']=bun
            runtime_changed=any(installed.get(name)!=version for name,version in runtimes.items())
            selected={'updates':plan}
            if runtimes:selected['runtimeDependencies']=runtimes
            if 'updates' not in payload:selected.update(plan[0])
            if not changed and not runtime_changed:
                return {'ok':True,'unchanged':True,**selected,'message':'선택한 구성 요소가 이미 해당 버전입니다.','jobId':job_id}
            if shutil.disk_usage(repo).free<4*1024**3:raise ValueError('INSUFFICIENT_DISK')
            original,current=runtime_manifests()
            if any(name not in current['dependencies'] for name in PACKAGES.values()):raise ValueError('RUNTIME_MANIFEST_INVALID')
            backup=repo/'backups'/('control-manifests-'+job_id);backup.mkdir(mode=0o700,parents=True)
            for p,data in original.items():(backup/p).write_text(data)
            release=repo/'data/releases'/('control-'+job_id);release.mkdir(mode=0o700,parents=True)
            metadata={'status':'resolving',**selected,'changed':changed}
            def record():(release/'release.json').write_text(json.dumps(metadata,indent=2)+'\n')
            record()
            try:
                with tempfile.TemporaryDirectory(prefix='control-lock-',dir=repo/'data') as temporary:
                    stage=Path(temporary)/'source';stack.stage_source(stage)
                    for p,data in original.items():(stage/p).write_text(data)
                    staged=current
                    for item in plan:staged['dependencies'][PACKAGES[item['component']]]=item['version']
                    staged['dependencies'].update(runtimes)
                    (stage/'package.json').write_text(json.dumps(staged,indent=2)+'\n')
                    extra=[];ca=stack.bundle_ca()
                    if ca:extra=['--volume',str(ca)+':/tmp/company-ca.pem:ro,z','--env','NODE_EXTRA_CA_CERTS=/tmp/company-ca.pem']
                    container='caveman-control-resolver-'+job_id
                    try:
                        stack.pod('run','--rm','--name',container,'--label','io.caveman-stack.resolver='+job_id,
                            '--network',config.get('BUILD_NETWORK','slirp4netns'),
                            '--volume',str(stage)+':/work:Z','--workdir','/work',*stack.runtime_env(config),*extra,
                            '--entrypoint','npm',stack.image_id(config),'install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund',
                            '--fetch-retries=1','--fetch-timeout=15000',timeout=300)
                    finally:
                        stack.cleanup_resolver(container,job_id)
                    parsed=json.loads((stage/'package-lock.json').read_text())
                    if (any(parsed['packages'].get('node_modules/'+name,{}).get('version')!=staged['dependencies'][name] for name in [*PACKAGES.values(),*runtimes]) or
                            parsed['packages'].get('',{}).get('dependencies')!=staged['dependencies']):
                        raise ValueError('LOCK_VERSION_MISMATCH')
                    for p in original:shutil.copy2(stage/p,release/p)
                    metadata.update(status='validating',dependencies=staged['dependencies']);record()
                    stack.update(config,context=stage)
                metadata.update(status='applied',image=stack.image_id(config));record()
                return {'ok':True,**selected,'changed':changed,'jobId':job_id,
                    'message':'선택한 구성 요소를 한 번의 빌드·후보 검사·백업으로 적용했습니다. 로컬 모델 목록을 동기화하세요.'}
            except BaseException:
                metadata['status']='failed';record()
                raise

def safe_operation(operation):
    try:
        return operation()
    except ValueError as error:
        code=str(error)
        return {'ok':False,'error':code if re.fullmatch('[A-Z_]+',code) else 'INVALID_INPUT'}
    except Exception:return {'ok':False,'error':'SERVER_OPERATION_FAILED'}


def owned_operation(payload):
    """Keep a mutating operation and its lock alive after its SSH parent leaves.

    The parent preserves the existing synchronous JSON protocol. Its child runs
    in a separate session, owns no SSH pipes, and records a private result before
    exiting. Never release operation.lock while a build/swap/rollback continues.
    This does not promise recovery from SIGKILL, power loss or a full service
    cgroup kill; those require the existing snapshot/rollback procedure.
    """
    repo=validate(payload)
    if payload['action'] not in ('update','catalog'):return execute(payload)
    jobs=repo/'data/control-jobs';jobs.mkdir(mode=0o700,exist_ok=True)
    job_id=uuid.uuid4().hex;record_path=jobs/(job_id+'.json')
    def record(value):
        temporary=record_path.with_suffix('.tmp-'+uuid.uuid4().hex)
        try:
            with os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:
                json.dump(value,stream,ensure_ascii=False)
            os.replace(temporary,record_path)
        finally:
            if temporary.exists():temporary.unlink()
    # Close the fork-to-setsid signal race: a just-disconnected SSH session must
    # not terminate the child before it establishes its independent lifecycle.
    blocked={signal.SIGHUP,signal.SIGTERM}
    previous_mask=signal.pthread_sigmask(signal.SIG_BLOCK,blocked)
    try:pid=os.fork()
    except BaseException:
        signal.pthread_sigmask(signal.SIG_SETMASK,previous_mask)
        raise
    if pid:
        signal.pthread_sigmask(signal.SIG_SETMASK,previous_mask)
        os.waitpid(pid,0)
        try:
            saved=json.loads(record_path.read_text())
            if saved.get('status') in ('succeeded','failed') and isinstance(saved.get('result'),dict):return saved['result']
        except (OSError,ValueError,TypeError):pass
        return {'ok':False,'error':'SERVER_WORKER_INTERRUPTED','jobId':job_id}
    try:
        os.setsid()
        for sig in blocked:signal.signal(sig,signal.SIG_IGN)
        signal.pthread_sigmask(signal.SIG_SETMASK,previous_mask)
        with open(os.devnull,'r+b',buffering=0) as null:
            for fd in (0,1,2):os.dup2(null.fileno(),fd)
        started=time.time()
        state={'jobId':job_id,'action':payload['action'],'status':'running','pid':os.getpid(),'started':started}
        record(state)
        result=safe_operation(lambda:execute(payload,job_id=job_id))
        result.setdefault('jobId',job_id)
        record({**state,'status':'succeeded' if result['ok'] else 'failed','finished':time.time(),'result':result})
        os._exit(0 if result['ok'] else 1)
    except BaseException:
        # Output may be gone. Never send traceback, credential material, or raw
        # package-manager logs through an abandoned SSH connection.
        os._exit(1)


def main():
    os.umask(0o077)
    result=safe_operation(lambda:owned_operation(json.loads(sys.stdin.read(16385))))
    try:print(json.dumps(result,ensure_ascii=False),flush=True)
    except BrokenPipeError:
        # The worker result is already durable. Avoid a second flush error when
        # Python shuts down after the remote reader has disappeared.
        with open(os.devnull,'w') as null:os.dup2(null.fileno(),sys.stdout.fileno())
    return 0 if result['ok'] else 1

if __name__=='__main__':sys.exit(main())
