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
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import uuid

PACKAGES={'caveman':'@caveman-ai/cli','opencodex':'@bitkyc08/opencodex'}
ACTIONS={'check','catalog','update','connection','status','restart','latest-update','git-update'}

class OperationError(ValueError):
    """A public error code and a private log reference; never raw subprocess output."""
    def __init__(self,code,job_id=None):
        super().__init__(code)
        self.job_id=job_id

def validate(payload):
    if not isinstance(payload,dict) or not isinstance(payload.get('action'),str) or payload['action'] not in ACTIONS:
        raise ValueError('INVALID_OPERATION')
    allowed={'repo','action'}|({'component','version'} if payload['action']=='update' else set())
    if set(payload)-allowed:raise ValueError('INVALID_ARGUMENTS')
    if not isinstance(payload.get('repo'),str):raise ValueError('INVALID_REPOSITORY')
    repo=Path(payload['repo'])
    if not repo.is_absolute() or not (repo/'stack').is_file() or not (repo/'package-lock.json').is_file():
        raise ValueError('INVALID_REPOSITORY')
    if payload['action']=='update' and (not isinstance(payload.get('component'),str) or payload['component'] not in PACKAGES
            or not isinstance(payload.get('version'),str) or not re.fullmatch(r'\d+\.\d+\.\d+',payload['version'])):
        raise ValueError('INVALID_VERSION')
    return repo.resolve()

def require_methods(stack,*methods):
    if any(not callable(getattr(stack,method,None)) for method in methods):
        raise ValueError('SERVER_UPGRADE_REQUIRED')

def git_dirty(repo):
    try:
        result=subprocess.run(['git','-C',str(repo),'status','--porcelain','--untracked-files=normal'],
            capture_output=True,text=True,timeout=15,check=True)
        return bool(result.stdout.strip())
    except (OSError,subprocess.SubprocessError):return None

@contextlib.contextmanager
def job_log(repo,stack):
    logs=repo/'data/control-jobs';logs.mkdir(mode=0o700,parents=True,exist_ok=True)
    logs.chmod(0o700)
    job_id=uuid.uuid4().hex
    descriptor=os.open(logs/(job_id+'.log'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    # Only operation output goes to this private file. Connection/key retrieval
    # deliberately never enters this context.
    with os.fdopen(descriptor,'w') as stream,contextlib.redirect_stdout(stream),contextlib.redirect_stderr(stream):
        old_run=stack.run
        def quiet_run(args,**kw):
            if not kw.get('capture_output'):
                kw.setdefault('stdout',stream);kw.setdefault('stderr',stream)
            return old_run(args,**kw)
        stack.run=quiet_run
        try:yield job_id,stream
        finally:stack.run=old_run

def connection(repo):
    # This response is consumed privately by the local installer over SSH. The
    # admin key and Codex OAuth files are never read, copied, or logged.
    try:
        with (repo/'secrets/gateway-key').open() as stream:raw=stream.read(4098)
    except OSError:raise ValueError('GATEWAY_KEY_UNREADABLE') from None
    value=raw.strip()
    if len(raw)>4097:raise ValueError('GATEWAY_KEY_INVALID')
    if not re.fullmatch(r'[!-~]{16,4096}',value):raise ValueError('GATEWAY_KEY_INVALID')
    return {'ok':True,'gatewayKey':value}

def server_status(repo,stack,config):
    require_methods(stack,'exists','pod','name')
    container=stack.name(config)
    result={'ok':True,'container':container,'exists':bool(stack.exists(container)),
        'status':'absent','running':False,'health':None,'gitDirty':git_dirty(repo)}
    if not result['exists']:return result
    inspected=stack.pod('inspect',container,'--format','{{json .State}}',capture_output=True,text=True,timeout=15)
    state=json.loads(inspected.stdout)
    if not isinstance(state,dict):raise ValueError('CONTAINER_STATE_INVALID')
    result['status']=state.get('Status') if state.get('Status') in (
        'configured','created','running','paused','restarting','removing','stopping','stopped','exited','dead') else 'unknown'
    result['running']=state.get('Running') is True
    health=state.get('Health') or state.get('Healthcheck') or {}
    result['health']=health.get('Status') if isinstance(health,dict) and health.get('Status') in ('starting','healthy','unhealthy') else None
    if result['running']:
        try:
            installed=installed_versions(stack,config)
            result['components']={label:{'current':value} for label,name in PACKAGES.items()
                if isinstance(value:=installed.get(name),str) and re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?',value)}
        except Exception:result['versionError']='VERSION_UNAVAILABLE'
    return result

def installed_versions(stack,config):
    running=stack.pod('exec',stack.name(config),'node','--input-type=module','-e',
        "import fs from 'node:fs';console.log(JSON.stringify(Object.fromEntries(['@caveman-ai/cli','@bitkyc08/opencodex'].map(n=>[n,JSON.parse(fs.readFileSync('/app/node_modules/'+n+'/package.json')).version]))))",
        capture_output=True,text=True,timeout=15)
    return json.loads(running.stdout)

def restart(stack,config,repo):
    # Inspect before stopping. A stopped container still records its exact
    # deployed image, even if a mutable image tag now points somewhere else.
    image=stack.image_id(config)
    if stack.exists(stack.name(config)):
        image=stack.pod('inspect',stack.name(config),'--format','{{.Image}}',capture_output=True,text=True,timeout=15).stdout.strip()
    image=stack.pod('image','inspect',image,'--format','{{.Id}}',capture_output=True,text=True,timeout=15).stdout.strip()
    if not image:raise ValueError('ACTIVE_IMAGE_UNAVAILABLE')
    stack.down(config)
    stack.launch(config,image)
    (repo/'data/active-image').write_text(image+'\n')
    stack.catalog(config)

def git_update(repo,stack):
    # The child CLI holds and transfers operation.lock across git pull + exec.
    # Holding that flock here too would deadlock or reject our own update.
    require_methods(stack,'git_update','update_latest','operation_lock')
    dirty=git_dirty(repo)
    if dirty:raise ValueError('GIT_DIRTY')
    if dirty is None:raise ValueError('GIT_UNAVAILABLE')
    with job_log(repo,stack) as (job_id,stream):
        result=subprocess.run([sys.executable,str(repo/'stack'),'git-update'],
            stdin=subprocess.DEVNULL,stdout=stream,stderr=stream,check=False)
        if result.returncode:raise OperationError('SERVER_OPERATION_FAILED',job_id)
        return {'ok':True,'jobId':job_id,'message':'Git 소스와 최신 안정 버전을 업데이트했습니다. 로컬 모델 목록을 동기화하세요.'}

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

def execute(payload):
    repo=validate(payload)
    if payload['action']=='connection':return connection(repo)
    stack=load_stack(repo)
    require_methods(stack,'config','run','name','pod')
    config=stack.config()
    if payload['action']=='status':return server_status(repo,stack,config)
    if payload['action']=='git-update':return git_update(repo,stack)
    if payload['action']=='latest-update':require_methods(stack,'update_latest')
    if payload['action']=='restart':require_methods(stack,'image_id','exists','down','launch','catalog')
    if payload['action']=='update':require_methods(stack,'stage_source','cleanup_resolver','update','image_id','runtime_env','bundle_ca')
    package=json.loads((repo/'package.json').read_text())
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
        installed=installed_versions(stack,config)
        for label,name in PACKAGES.items():
            row={'current':installed.get(name),'configured':package['dependencies'][name]}
            try:row['latest']=registry(name)
            except Exception:row['checkError']='REGISTRY_UNAVAILABLE'
            versions[label]=row
        return {'ok':True,'components':versions,'container':stack.name(config)}
    with (repo/'data/operation.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('SERVER_BUSY')
        # Child output stays in a private host log. Never return raw package or proxy output.
        with job_log(repo,stack) as (job_id,stream):
            if payload['action']=='catalog':
                stack.catalog(config)
                return {'ok':True,'message':'서버 모델 카탈로그를 갱신했습니다. 로컬 동기화를 실행하세요.','jobId':job_id}
            if payload['action'] in ('restart','latest-update'):
                try:
                    if payload['action']=='restart':restart(stack,config,repo)
                    else:stack.update_latest(config)
                except Exception:raise OperationError('SERVER_OPERATION_FAILED',job_id) from None
                message='기존 이미지로 서버를 재시작했습니다.' if payload['action']=='restart' else '최신 안정 버전을 후보 검증과 백업 후 적용했습니다.'
                return {'ok':True,'message':message,'jobId':job_id}
            name=PACKAGES[payload['component']];version=payload['version']
            if installed_versions(stack,config).get(name)==version:
                return {'ok':True,'unchanged':True,'message':'이미 해당 버전으로 설정되어 있습니다.','jobId':job_id}
            if shutil.disk_usage(repo).free<4*1024**3:raise ValueError('INSUFFICIENT_DISK')
            original,current=runtime_manifests()
            if name not in current['dependencies']:raise ValueError('RUNTIME_MANIFEST_INVALID')
            backup=repo/'backups'/('control-manifests-'+job_id);backup.mkdir(mode=0o700,parents=True)
            for p,data in original.items():(backup/p).write_text(data)
            release=repo/'data/releases'/('control-'+job_id);release.mkdir(mode=0o700,parents=True)
            metadata={'status':'resolving','component':payload['component'],'version':version}
            def record():(release/'release.json').write_text(json.dumps(metadata,indent=2)+'\n')
            record()
            try:
                with tempfile.TemporaryDirectory(prefix='control-lock-',dir=repo/'data') as temporary:
                    stage=Path(temporary)/'source';stack.stage_source(stage)
                    for p,data in original.items():(stage/p).write_text(data)
                    staged=current;staged['dependencies'][name]=version
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
                    if (parsed['packages']['node_modules/'+name]['version']!=version or
                            parsed['packages'].get('',{}).get('dependencies')!=staged['dependencies']):
                        raise ValueError('LOCK_VERSION_MISMATCH')
                    for p in original:shutil.copy2(stage/p,release/p)
                    metadata.update(status='validating',dependencies=staged['dependencies']);record()
                    stack.update(config,context=stage)
                metadata.update(status='applied',image=stack.image_id(config));record()
                return {'ok':True,'component':payload['component'],'version':version,'jobId':job_id,
                    'message':'후보 컨테이너 검사와 백업을 거쳐 적용했습니다. 로컬 모델 목록을 동기화하세요.'}
            except BaseException:
                metadata['status']='failed';record()
                raise

def main():
    os.umask(0o077)
    try:
        payload=json.loads(sys.stdin.read(16385))
        result=execute(payload)
    except ValueError as error:
        code=str(error)
        result={'ok':False,'error':code if re.fullmatch('[A-Z_]+',code) else 'INVALID_INPUT'}
        if isinstance(error,OperationError) and error.job_id:result['jobId']=error.job_id
    except Exception:result={'ok':False,'error':'SERVER_OPERATION_FAILED'}
    print(json.dumps(result,ensure_ascii=False))
    return 0 if result['ok'] else 1

if __name__=='__main__':sys.exit(main())
