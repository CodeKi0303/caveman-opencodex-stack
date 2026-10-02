#!/usr/bin/env python3
"""Opt-in authenticated synthetic inference test. Prints no credentials or prompts."""
import argparse
import json
from pathlib import Path
import sqlite3
import urllib.request

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--url',default='http://127.0.0.1:18787/v1')
p.add_argument('--key-file',required=True)
p.add_argument('--auth-file',required=True)
p.add_argument('--model',default='gpt-6.1-sol')
p.add_argument('--state-dir',help='Optional local data/state path: verify CCR original bytes')
a=p.parse_args()
auth=json.loads(Path(a.auth_file).read_text())
tokens=auth.get('tokens',{})
bearer=tokens.get('access_token') or auth.get('OPENAI_API_KEY')
if not bearer:raise SystemExit('No supported credential in supplied auth file')
headers={'Authorization':'Bearer '+bearer,'chatgpt-account-id':tokens.get('account_id',''),
         'x-caveman-gateway-key':Path(a.key_file).read_text().strip(),'Content-Type':'application/json'}
fixture=json.dumps([{'id':i,'state':'healthy','message':'Synthetic health check completed successfully','elapsed_ms':12} for i in range(500)],indent=2)
body={'model':a.model,'stream':True,'store':False,
      'instructions':'Reply exactly STACK_OK. Do not call any tools.',
      'input':[{'role':'user','content':'Acknowledge this synthetic output.'},
               {'type':'function_call','call_id':'fixture','name':'fixture_read','arguments':'{}'},
               {'type':'function_call_output','call_id':'fixture','output':fixture}],
      'tools':[{'type':'function','name':'fixture_read','description':'Synthetic fixture','parameters':{'type':'object','properties':{}}},
               {'type':'function','name':'caveman_retrieve','description':'Recover original','parameters':{'type':'object','properties':{'recovery_handle':{'type':'string'}},'required':['recovery_handle']}}]}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect)
req=urllib.request.Request(a.url.rstrip('/')+'/responses',data=json.dumps(body).encode(),headers=headers)
events=[]
with opener.open(req,timeout=120) as response:
    request_id=response.headers.get('x-cave-request-id')
    assert response.headers.get('content-type','').startswith('text/event-stream')
    for line in response:
        if line.startswith(b'data: ') and line.strip()!=b'data: [DONE]':events.append(json.loads(line[6:]))
completed=next((e for e in events if e.get('type')=='response.completed'),None)
assert completed and ''.join(e.get('delta','') for e in events if e.get('type')=='response.output_text.delta').strip()=='STACK_OK'
report={'sse_completed':True,'requested_model':a.model,'served_model':completed.get('response',{}).get('model')}
if a.state_dir:
    state=Path(a.state_dir)/'caveman'
    with sqlite3.connect(f'file:{state}/caveman.db?mode=ro',uri=True) as db:
        row=db.execute('SELECT recovery_handle,optimization_ids FROM requests WHERE request_id=?',(request_id,)).fetchone()
    assert row and 'caveman-compression' in row[1]
    with sqlite3.connect(f'file:{state}/ccr.db?mode=ro',uri=True) as db:original=db.execute('SELECT original FROM recoveries WHERE handle=?',(row[0],)).fetchone()[0]
    assert (original.encode() if isinstance(original,str) else original)==fixture.encode()
    report.update(compression=True,recovery_exact=True)
print(json.dumps(report))
