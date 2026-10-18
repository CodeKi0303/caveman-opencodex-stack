"""Verify that server-account smoke tests cannot silently use client credentials."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT=Path(__file__).resolve().parents[1]/'scripts/smoke.py'

class Response(io.BytesIO):
    headers={'content-type':'text/event-stream'}

class SmokeAuthTests(unittest.TestCase):
    def run_smoke(self, server_account):
        events=[{'type':'response.output_text.delta','delta':'STACK_OK'},
                {'type':'response.completed','response':{'model':'fixture-model'}}]
        response=Response(b''.join(b'data: '+json.dumps(event).encode()+b'\n' for event in events))
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            (root/'gateway-key').write_text('synthetic-gateway')
            (root/'auth.json').write_text(json.dumps({'tokens':{
                'access_token':'synthetic-client-oauth','account_id':'synthetic-account'}}))
            auth_args=['--server-account'] if server_account else ['--auth-file',str(root/'auth.json')]
            argv=[str(SCRIPT),'--key-file',str(root/'gateway-key'),*auth_args,'--model','fixture-model']
            output=io.StringIO()
            with patch.object(sys,'argv',argv),patch('urllib.request.build_opener') as opener,contextlib.redirect_stdout(output):
                opener.return_value.open.return_value=response
                runpy.run_path(str(SCRIPT),run_name='__main__')
            req=opener.return_value.open.call_args.args[0]
            return dict((k.lower(),v) for k,v in req.header_items()),output.getvalue()

    def test_server_account_uses_gateway_key_without_client_authorization(self):
        headers,output=self.run_smoke(True)
        self.assertEqual(headers['x-caveman-gateway-key'],'synthetic-gateway')
        self.assertNotIn('authorization',headers)
        self.assertNotIn('chatgpt-account-id',headers)
        self.assertEqual(json.loads(output)['authentication'],'server-account')
        self.assertNotIn('synthetic-gateway',output)

    def test_client_login_preserves_oauth_without_printing_credentials(self):
        headers,output=self.run_smoke(False)
        self.assertEqual(headers['authorization'],'Bearer synthetic-client-oauth')
        self.assertEqual(headers['chatgpt-account-id'],'synthetic-account')
        self.assertEqual(json.loads(output)['authentication'],'client-login')
        self.assertNotIn('synthetic-client-oauth',output)

if __name__=='__main__':unittest.main()
