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
            if package['dependencies'][name]==version and installed_versions().get(name)==version:
                return {'ok':True,'unchanged':True,'message':'이미 해당 버전으로 설정되어 있습니다.','jobId':job_id}
            if shutil.disk_usage(repo).free<4*1024**3:raise ValueError('INSUFFICIENT_DISK')
            original={p:(repo/p).read_bytes() for p in ['package.json','package-lock.json']}
            backup=repo/'backups'/('control-manifests-'+job_id);backup.mkdir(mode=0o700,parents=True)
            for p,data in original.items():(backup/p).write_bytes(data)
            changed=False
            try:
                with tempfile.TemporaryDirectory(prefix='control-lock-',dir=repo/'data') as temporary:
                    stage=Path(temporary)
                    for p,data in original.items():(stage/p).write_bytes(data)
                    staged=json.loads(original['package.json']);staged['dependencies'][name]=version
                    (stage/'package.json').write_text(json.dumps(staged,indent=2)+'\n')
                    extra=[];ca=stack.bundle_ca()
                    if ca:extra=['--volume',str(ca)+':/tmp/company-ca.pem:ro,z','--env','NODE_EXTRA_CA_CERTS=/tmp/company-ca.pem']
                    stack.pod('run','--rm','--network',config.get('BUILD_NETWORK','slirp4netns'),
                        '--volume',str(stage)+':/work:Z','--workdir','/work',*stack.runtime_env(config),*extra,
                        '--entrypoint','npm',stack.image_id(config),'install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund')
                    parsed=json.loads((stage/'package-lock.json').read_text())
                    if parsed['packages']['node_modules/'+name]['version']!=version:raise ValueError('LOCK_VERSION_MISMATCH')
                    changed=True
                    for p in original:shutil.copy2(stage/p,repo/p)
                stack.update(config)
                return {'ok':True,'component':payload['component'],'version':version,'jobId':job_id,
                    'message':'후보 컨테이너 검사와 백업을 거쳐 적용했습니다. 로컬 모델 목록을 동기화하세요.'}
            except BaseException:
                if changed:
                    for p,data in original.items():(repo/p).write_bytes(data)
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
