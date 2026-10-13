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

def validate(payload):
    if not isinstance(payload,dict) or payload.get('action') not in ('check','catalog','update'):
        raise ValueError('INVALID_OPERATION')
    repo=Path(payload.get('repo',''))
    if not repo.is_absolute() or not (repo/'stack').is_file() or not (repo/'package-lock.json').is_file():
        raise ValueError('INVALID_REPOSITORY')
    if payload['action']=='update' and (payload.get('component') not in PACKAGES or not re.fullmatch(r'\d+\.\d+\.\d+',payload.get('version',''))):
        raise ValueError('INVALID_VERSION')
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

def execute(payload):
    repo=validate(payload);stack=load_stack(repo);config=stack.config()
    package=json.loads((repo/'package.json').read_text())
    def installed_versions():
        running=stack.pod('exec',stack.name(config),'node','--input-type=module','-e',
            "import fs from 'node:fs';console.log(JSON.stringify(Object.fromEntries(['@caveman-ai/cli','@bitkyc08/opencodex'].map(n=>[n,JSON.parse(fs.readFileSync('/app/node_modules/'+n+'/package.json')).version]))))",
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
        job_id=uuid.uuid4().hex
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
            name=PACKAGES[payload['component']];version=payload['version']
            if installed_versions().get(name)==version:
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
    except Exception:result={'ok':False,'error':'SERVER_OPERATION_FAILED'}
    print(json.dumps(result,ensure_ascii=False))
    return 0 if result['ok'] else 1

if __name__=='__main__':sys.exit(main())
