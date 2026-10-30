"""Synthetic contract/transport/authentication tests; real-model benchmark is separate."""
import asyncio
import copy
import json
import logging
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import httpx
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/local-service'))
from app.main import create_app
from app.services.piper_service import PiperService, PiperConfig

def no_speech():
    return PiperService(PiperConfig(voice_path=Path(__file__).parent / "fixtures/missing-voice.onnx"))

from app.schemas.interpret import InterpretRequest, InterpretResponse
from app.services.ollama_client import OllamaClient, OllamaConfig, InterpretationError
from app.services.interpretation_service import InterpretationService, output_schema
from app.services.proposal_validator import validate_proposal
from app.schemas.interpret import ModelProposal

ALL_CASES = json.loads((ROOT / 'tests/fixtures/interpretation-cases.json').read_text())
CASES = [case for case in ALL_CASES if case.get('kind') != 'fault']
FAULT_CASES = [case for case in ALL_CASES if case.get('kind') == 'fault']
ORIGIN = 'chrome-extension://' + 'a' * 32


def proposal(case):
    fact = case['request']['knownFacts']
    return {'updates': [dict(**copy.deepcopy(update), evidence={'source': 'fact' if fact else 'transcript', 'factId': fact[0]['factId'] if fact else None,
            'quote': fact[0]['text'] if fact else case['request']['transcript']}) for update in case['expectedUpdates']],
            'clarifications': [{'question': 'What is the unambiguous date?', 'targetFieldIds': [field]} for field in case['expectedClarificationFields']]}


class FakeModel:
    def __init__(self, output):
        self.output, self.calls = output, []
    async def generate(self, prompt, content, schema):
        self.calls.append((prompt, content, schema))
        if isinstance(self.output, Exception): raise self.output
        return self.output
    async def available(self): return True
    async def close(self): pass


class ContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_40_synthetic_golden_outputs_validate_and_compute_missing(self):
        self.assertEqual(len(CASES), 40)
        for case in CASES:
            with self.subTest(case=case['id']):
                request = InterpretRequest.model_validate(case['request'])
                fake = FakeModel(json.dumps(proposal(case)))
                result = await InterpretationService(fake).interpret(request)
                expected = {item['fieldId'] for item in case['expectedUpdates']}
                self.assertEqual([item.fieldId for item in result.missingFields], [field.fieldId for field in request.fields if field.required and field.fieldId not in expected])
                self.assertEqual(len(fake.calls), int(bool(request.fields)))
                if fake.calls:
                    sent = json.loads(fake.calls[0][1])
                    self.assertEqual(set(sent), {'transcript', 'knownFacts', 'fields'})
                    self.assertNotIn('scanId', sent)
                    # Grammar binds each field to its exact kind and own options.
                    variants = fake.calls[0][2]['properties']['updates']['items']['anyOf']
                    for variant, field in zip(variants, request.fields):
                        self.assertEqual(variant['properties']['fieldId']['const'], field.fieldId)
                        self.assertEqual(variant['properties']['target']['properties']['kind']['const'], field.type)
                        if field.options:
                            self.assertEqual(variant['properties']['target']['properties']['optionId']['enum'], [option.optionId for option in field.options])

    async def test_fixture_fault_cases_have_normalized_errors(self):
        self.assertEqual(len(FAULT_CASES), 10)
        for case in FAULT_CASES:
            with self.subTest(case=case['id']):
                raw = case['modelOutput']
                output = InterpretationError(case['expectedError'], case['status']) if raw is None else json.dumps(raw) if isinstance(raw, dict) else raw
                with self.assertRaises(InterpretationError) as error:
                    await InterpretationService(FakeModel(output)).interpret(InterpretRequest.model_validate(case['request']))
                self.assertEqual(error.exception.code, case['expectedError'])

    async def test_trimming_evidence_cannot_hide_negation_or_uncertainty(self):
        for text in ['My full name is not Alex Thomas.', 'My full name might be Alex Thomas.']:
            case = copy.deepcopy(CASES[0])
            case['request']['transcript'] = text
            raw = proposal(case); raw['updates'] = raw['updates'][:1]
            raw['updates'][0]['evidence']['quote'] = 'Alex Thomas'
            with self.assertRaises(InterpretationError) as error:
                await InterpretationService(FakeModel(json.dumps(raw))).interpret(InterpretRequest.model_validate(case['request']))
            self.assertEqual(error.exception.code, 'unsupported-evidence')

    async def test_polite_filler_is_not_a_name_even_when_quoted_exactly(self):
        for text in ['Thank you.', 'Thank you. Thank you very much.', 'Thanks for watching.']:
            case = copy.deepcopy(CASES[0])
            case['request']['fields'] = case['request']['fields'][:1]
            case['request']['fields'][0]['label'] = 'Name *'
            case['request']['transcript'] = text
            raw = proposal(case)
            raw['updates'] = raw['updates'][:1]
            raw['updates'][0]['target']['value'] = text
            with self.assertRaises(InterpretationError) as error:
                await InterpretationService(FakeModel(json.dumps(raw))).interpret(InterpretRequest.model_validate(case['request']))
            self.assertEqual(error.exception.code, 'unsupported-evidence')

    async def test_invalid_outputs_are_rejected_without_repair(self):
        request = InterpretRequest.model_validate(CASES[0]['request'])
        good = proposal(CASES[0])
        mutations = []
        def change(code, fn):
            value = copy.deepcopy(good); fn(value); mutations.append((code, json.dumps(value)))
        change('unknown-field-id', lambda value: value['updates'][0].update(fieldId='field_' + 'f'*32))
        change('target-type-mismatch', lambda value: value['updates'][0].update(target={'kind':'checkbox','checked':True}))
        change('duplicate-field-update', lambda value: value['updates'].append(copy.deepcopy(value['updates'][0])))
        change('unsupported-evidence', lambda value: value['updates'][0]['target'].update(value='Invented Person'))
        change('unsupported-evidence', lambda value: value['updates'][0]['evidence'].update(quote='PRIVATE not in transcript'))
        change('unsupported-evidence', lambda value: value['updates'][0]['evidence'].update(source='fact'))
        change('invalid-model-output', lambda value: value['updates'][0].update(authorized=True))
        change('unknown-field-id', lambda value: value['clarifications'].append({'question':'Unknown?', 'targetFieldIds':['field_'+'e'*32]}))
        change('proposal-validation-failed', lambda value: value['clarifications'].append({'question':'Conflict?', 'targetFieldIds':[request.fields[0].fieldId]}))
        mutations += [('invalid-model-output', raw) for raw in ['```json\n{}\n```', '{malformed', '{"updates":[],"updates":[],"clarifications":[]}', 'null', '{"updates":[],"clarifications":[],"confidence":NaN}']]
        for code, raw in mutations:
            with self.subTest(code=code, raw=raw[:30]):
                with self.assertRaises(InterpretationError) as error:
                    await InterpretationService(FakeModel(raw)).interpret(request)
                self.assertEqual(error.exception.code, code)

    async def test_options_must_belong_to_the_specific_field(self):
        case = copy.deepcopy(CASES[10])
        raw = proposal(case)
        raw['updates'][0]['target']['optionId'] = 'option_' + 'f'*32
        with self.assertRaises(InterpretationError) as error:
            await InterpretationService(FakeModel(json.dumps(raw))).interpret(InterpretRequest.model_validate(case['request']))
        self.assertEqual(error.exception.code, 'invalid-option-id')
        raw = proposal(case); raw['updates'][0]['evidence']['quote'] = 'Department'
        with self.assertRaises(InterpretationError) as error:
            await InterpretationService(FakeModel(json.dumps(raw))).interpret(InterpretRequest.model_validate(case['request']))
        self.assertEqual(error.exception.code, 'unsupported-evidence')

    async def test_checkbox_is_strict_boolean_and_requires_supported_intent(self):
        case = CASES[30]
        for checked, code in [('true','invalid-model-output'), (False,'unsupported-evidence'), (1,'invalid-model-output')]:
            raw = proposal(case); raw['updates'][0]['target']['checked'] = checked
            with self.assertRaises(InterpretationError) as error:
                await InterpretationService(FakeModel(json.dumps(raw))).interpret(InterpretRequest.model_validate(case['request']))
            self.assertEqual(error.exception.code, code)

    async def test_constraints_reject_invalid_numbers_dates_email_and_length(self):
        values = [('number','121',{'max':'120'}), ('number','1.5',{'step':'1'}), ('number','NaN',{}), ('date','2020-02-31',{}), ('date','2020-01-01',{'min':'2021-01-01'}), ('email','invalid-email',{}), ('text','Alex',{'minLength':5}), ('text','Alex',{'maxLength':3})]
        for kind, value, constraints in values:
            case = copy.deepcopy(CASES[0]); case['request']['transcript'] = value
            case['request']['fields'] = [dict(case['request']['fields'][0], type=kind, constraints=constraints)]
            case['expectedUpdates'] = [{'fieldId':case['request']['fields'][0]['fieldId'], 'target':{'kind':kind,'value':value}}]
            with self.subTest(kind=kind,value=value):
                with self.assertRaises(InterpretationError):
                    await InterpretationService(FakeModel(json.dumps(proposal(case)))).interpret(InterpretRequest.model_validate(case['request']))

    async def test_request_schema_bounds_extras_and_duplicates(self):
        for mutate in [lambda value:value.update(model='remote'), lambda value:value.update(transcript='x'*4097), lambda value:value.update(transcript=' '), lambda value:value['fields'].append(copy.deepcopy(value['fields'][0])), lambda value:value['fields'][0].update(value='PRIVATE'), lambda value:value['fields'][0].update(type='password')]:
            request = copy.deepcopy(CASES[0]['request']); mutate(request)
            with self.assertRaises(ValidationError): InterpretRequest.model_validate(request)

    async def test_generated_contracts_do_not_drift(self):
        sys.path.insert(0, str(ROOT/'scripts'))
        import importlib.util
        spec = importlib.util.spec_from_file_location('contract_generator',ROOT/'scripts/generate-interpret-contracts.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        for path, expected in module.outputs().items(): self.assertEqual(path.read_text(), expected)

    async def test_operational_logs_never_include_transcripts_values_or_prompts(self):
        with self.assertLogs('piko.interpretation', logging.INFO) as logs:
            await InterpretationService(FakeModel(json.dumps(proposal(CASES[0])))).interpret(InterpretRequest.model_validate(CASES[0]['request']))
        self.assertIn('elapsed_ms=',str(logs.output))
        self.assertNotIn('Alex',str(logs.output)); self.assertNotIn('example.test',str(logs.output))


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_remote_alias_or_malformed_listing_cannot_reach_chat(self):
        for mode in ['remote', 'missing-architecture', 'bad-list']:
            calls = []
            async def handler(request):
                calls.append(request.url.path)
                if request.url.path == '/api/tags':
                    return httpx.Response(200, json={'models': None if mode == 'bad-list' else [{'name': 'qwen3.5:2b'}]})
                return httpx.Response(200, json={'remote_host': 'https://remote.test'} if mode == 'remote' else {'model_info': {}})
            client = OllamaClient(transport=httpx.MockTransport(handler))
            try:
                with self.assertRaises(InterpretationError) as error:
                    await client.generate('s', 'c', {})
                self.assertEqual(error.exception.code, 'model-unavailable')
                self.assertNotIn('/api/chat', calls)
            finally:
                await client.close()

    async def test_local_transport_schema_timeout_no_redirect_no_proxy_no_cloud(self):
        calls=[]
        async def handler(request):
            calls.append(request)
            if request.url.path == '/api/tags': return httpx.Response(200,json={'models':[{'name':'qwen3.5:2b'}]})
            if request.url.path == '/api/show': return httpx.Response(200,json={'model_info':{'general.architecture':'qwen35'}})
            body=json.loads(request.content)
            self.assertEqual(body['stream'],False); self.assertEqual(body['think'],False); self.assertEqual(body['options']['temperature'],0)
            self.assertEqual(set(body), {'model','messages','format','stream','think','options'})
            self.assertEqual(body['format'], {'type':'object'})
            return httpx.Response(200,json={'model':'qwen3.5:2b','done':True,'message':{'role':'assistant','content':'{"updates":[],"clarifications":[]}'}})
        async with asyncio.timeout(2):
            client=OllamaClient(transport=httpx.MockTransport(handler))
            try: self.assertEqual(await client.generate('system','bounded',{'type':'object'}),'{"updates":[],"clarifications":[]}')
            finally: await client.close()
        self.assertTrue(all(str(call.url).startswith('http://127.0.0.1:11434/api/') for call in calls))
        for base in ['https://cloud.test','http://localhost:11434','http://127.0.0.1:11434/redirect','http://user:pass@127.0.0.1:11434','http://127.0.0.1:11434?url=x']:
            with self.assertRaises(ValueError): OllamaConfig(base_url=base)
        for model in ['qwen:cloud','bad model','qwen','https://remote/model']:
            with self.assertRaises(ValueError): OllamaConfig(model=model)
        with self.assertRaises(ValueError): OllamaConfig(max_concurrency=2)

    async def test_missing_model_timeout_malformed_oversized_redirect(self):
        modes=['missing','timeout','malformed','oversized','redirect','tool']
        for mode in modes:
            async def handler(request):
                if request.url.path == '/api/tags': return httpx.Response(200,json={'models':[] if mode=='missing' else [{'name':'qwen3.5:2b'}]})
                if request.url.path == '/api/show': return httpx.Response(200,json={'model_info':{'general.architecture':'qwen35'}})
                if mode=='timeout': raise httpx.ReadTimeout('PRIVATE')
                if mode=='malformed': return httpx.Response(200,content=b'PRIVATE',headers={'content-type':'application/json'})
                if mode=='oversized': return httpx.Response(200,content=b'x'*131073,headers={'content-type':'application/json'})
                if mode=='redirect': return httpx.Response(307,headers={'location':'https://remote.test'})
                return httpx.Response(200,json={'model':'qwen3.5:2b','done':True,'message':{'role':'assistant','content':'{}','tool_calls':[{}]}})
            client=OllamaClient(transport=httpx.MockTransport(handler))
            try:
                with self.assertRaises(InterpretationError) as error: await client.generate('s','c',{})
                self.assertEqual(error.exception.code, 'model-unavailable' if mode in ['missing','redirect'] else 'interpretation-timeout' if mode=='timeout' else 'invalid-model-output')
                self.assertNotIn('PRIVATE',str(error.exception))
            finally: await client.close()

    async def test_busy_rejects_without_queue_and_cancellation_releases_lock(self):
        entered=asyncio.Event()
        async def handler(request):
            if request.url.path=='/api/tags': return httpx.Response(200,json={'models':[{'name':'qwen3.5:2b'}]})
            if request.url.path=='/api/show': return httpx.Response(200,json={'model_info':{'general.architecture':'qwen35'}})
            entered.set(); await asyncio.Event().wait()
        client=OllamaClient(transport=httpx.MockTransport(handler))
        first=asyncio.create_task(client.generate('s','c',{})); await entered.wait()
        try:
            with self.assertRaises(InterpretationError) as error: await client.generate('s','c',{})
            self.assertEqual(error.exception.code,'interpretation-busy')
            first.cancel(); await asyncio.gather(first,return_exceptions=True)
            self.assertFalse(client.lock.locked())
        finally: await client.close()


class EndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fake=FakeModel(json.dumps(proposal(CASES[0])))
        self.app=create_app(announce=lambda _line:None,ollama_client=self.fake,piper_service=no_speech())
        self.lifespan=self.app.router.lifespan_context(self.app); await self.lifespan.__aenter__()
        code=self.app.state.pairing.start()
        self.http=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app,client=('127.0.0.1',1)),base_url='http://127.0.0.1:8765',headers={'Origin':ORIGIN})
        pair=await self.http.post('/v1/pair',json={'code':code,'protocol_version':1})
        self.headers={'Authorization':f"Bearer {pair.json()['token']}"}
    async def asyncTearDown(self):
        await self.http.aclose(); await self.lifespan.__aexit__(None,None,None)
    async def test_requires_auth_before_body_and_never_echoes_invalid_input(self):
        self.assertEqual((await self.http.post('/v1/interpret',content='PRIVATE')).status_code,415)
        response=await self.http.post('/v1/interpret',json={**CASES[0]['request'],'extra':'PRIVATE'},headers=self.headers)
        self.assertEqual(response.status_code,422); self.assertEqual(response.json(),{'error':'invalid_request'})
        self.assertEqual(self.fake.calls,[])
        response=await self.http.post('/v1/interpret',content=b'x'*131073,headers={**self.headers,'Content-Type':'application/json'})
        self.assertEqual(response.status_code,413)
        response=await self.http.post('/v1/interpret',content=b'{"scanId":"x","scanId":"y"}',headers={**self.headers,'Content-Type':'application/json'})
        self.assertEqual(response.json(), {'error':'invalid_request'})
        async def chunks():
            yield b'x' * 100000
            yield b'x' * 100000
        response=await self.http.post('/v1/interpret',content=chunks(),headers={**self.headers,'Content-Type':'application/json'})
        self.assertEqual(response.status_code,413)
    async def test_authenticated_endpoint_response_and_capabilities(self):
        response=await self.http.post('/v1/interpret',json=CASES[0]['request'],headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        result=InterpretResponse.model_validate(response.json()); self.assertEqual(len(result.updates),2)
        self.assertEqual(response.headers['cache-control'],'no-store')
        self.assertEqual((await self.http.get('/v1/capabilities',headers=self.headers)).json()['inference'],'ready')
    async def test_revoked_session_cannot_return_generated_result(self):
        response=await self.http.post('/v1/interpret',json=CASES[0]['request'],headers=self.headers)
        self.assertEqual(response.status_code,200)
    async def test_timeout_and_invalid_output_have_safe_errors(self):
        for output,code in [(InterpretationError('interpretation-timeout',504),'interpretation-timeout'),('PRIVATE raw prompt','invalid-model-output')]:
            self.fake.output=output
            response=await self.http.post('/v1/interpret',json=CASES[0]['request'],headers=self.headers)
            self.assertEqual(response.json(),{'error':code})

    async def test_disconnected_request_cancels_generation(self):
        from app.api.interpret import interpret_request
        from starlette.requests import Request
        entered, cancelled = asyncio.Event(), asyncio.Event()
        async def generate(*_args):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        self.fake.generate = generate
        async def disconnected():
            await entered.wait()
            return {'type':'http.disconnect'}
        request = Request({'type':'http','app':self.app}, receive=disconnected)
        with self.assertRaises(InterpretationError) as error:
            await interpret_request(InterpretRequest.model_validate(CASES[0]['request']),request,lambda _request:None)
        self.assertEqual(error.exception.code,'request-cancelled')
        self.assertTrue(cancelled.is_set())

if __name__=='__main__': unittest.main()
