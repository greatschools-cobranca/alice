import importlib.util
import json
import pathlib
import unittest

spec=importlib.util.spec_from_file_location('gate',pathlib.Path(__file__).parents[1]/'setup/ponte/gate.py')
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)

class Response:
    status=200
    def __init__(self,body,content='application/json',status=200):self.body=body;self.content=content;self.status=status
    def getheader(self,name,default=''):return self.content
    def read(self,limit):return self.body[:limit]

class GateTest(unittest.TestCase):
    config={'origin':'https://fixture.test/','mappings':{'fixture':{'version':'v1'}}}
    def run_gate(self,body=None,response=None,config=None):
        response=response or Response(json.dumps(body or {'protocol':2,'routines':[{'id':'fixture','version':'v1','on':True}]}).encode())
        class Connection:
            def __init__(self,host,port,timeout):assert host=='fixture.test';assert timeout<=8
            def request(self,method,path,headers):
                assert method=='GET';assert path=='/api/routines/gate'
                assert 'X-Bridge-Key' not in headers and 'Authorization' not in headers
            def getresponse(self):return response
            def close(self):pass
        return gate.decide(config or self.config,'fixture','v1',connection=Connection)
    def test_known_enabled(self):self.assertEqual(self.run_gate(),(True,'on'))
    def test_off(self):self.assertEqual(self.run_gate({'protocol':2,'routines':[{'id':'fixture','version':'v1','on':False}]}),(False,'off'))
    def test_unknown(self):self.assertFalse(self.run_gate({'protocol':2,'routines':[]})[0])
    def test_old_version(self):self.assertFalse(self.run_gate({'protocol':2,'routines':[{'id':'fixture','version':'v0','on':True}]})[0])
    def test_html_200(self):self.assertFalse(self.run_gate(response=Response(b'<html>login</html>','text/html'))[0])
    def test_redirect(self):self.assertFalse(self.run_gate(response=Response(b'',status=302))[0])
    def test_excessive_response(self):self.assertFalse(self.run_gate(response=Response(b'x'*256001))[0])
    def test_origin_credentials(self):self.assertFalse(self.run_gate(config={**self.config,'origin':'https://secret:password@fixture.test/'})[0])
    def test_old_protocol(self):self.assertFalse(self.run_gate({'protocol':1,'routines':[{'id':'fixture','version':'v1','on':True}]})[0])
    def test_untrusted_truthy_value(self):self.assertFalse(self.run_gate({'protocol':2,'routines':[{'id':'fixture','version':'v1','on':'true'}]})[0])

if __name__=='__main__':unittest.main()
