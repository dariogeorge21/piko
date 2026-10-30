import json
import unittest
from pydantic import ValidationError
from test_interpretation import CASES, FakeModel
from app.schemas.interpret import InterpretRequest
from app.schemas.summary import SummaryRequest
from app.services.interpretation_service import InterpretationService
from app.services.ollama_client import InterpretationError

class SummaryTests(unittest.IsolatedAsyncioTestCase):
    def request(self):
        source=InterpretRequest.model_validate(CASES[0]['request'])
        return SummaryRequest(scanId=source.scanId,fields=source.fields)

    async def test_summary_sends_only_metadata_and_returns_bounded_spoken_text(self):
        model=FakeModel(json.dumps({'summary':'This form asks for your contact details.'}))
        request=self.request()
        result=await InterpretationService(model).summarize(request)
        self.assertEqual(result.scanId,request.scanId)
        content=json.loads(model.calls[0][1])
        self.assertEqual(set(content),{'fields'})
        self.assertNotIn('transcript',content)
        self.assertNotIn('knownFacts',content)
        self.assertEqual(model.calls[0][2]['additionalProperties'],False)

    async def test_invalid_model_summaries_fail_closed(self):
        for output in ['not json',json.dumps({'summary':'<script>hello</script>'}),json.dumps({'summary':'a'*501}),json.dumps({'summary':'Valid text.','updates':[]})]:
            with self.subTest(output=output),self.assertRaises(InterpretationError):
                await InterpretationService(FakeModel(output)).summarize(self.request())

    def test_duplicate_fields_and_answer_properties_are_rejected(self):
        source=self.request().model_dump()
        with self.assertRaises(ValidationError):SummaryRequest.model_validate({**source,'transcript':'PRIVATE'})
        if source['fields']:
            source['fields'].append(source['fields'][0])
            with self.assertRaises(ValidationError):SummaryRequest.model_validate(source)

class ConnectionCompatibilityTests(unittest.TestCase):
    def test_direct_connection_session_fits_the_extension_lifetime_limit(self):
        from app.auth import PairingManager
        manager=PairingManager(lambda:0,lambda:0)
        manager.start()
        token,expires=manager.pair()
        self.assertTrue(token)
        self.assertGreater(expires,0)
        self.assertLessEqual(expires,12*60*60)

class SpokenEmailTests(unittest.TestCase):
    def test_spoken_punctuation_does_not_invent_a_domain_or_alias(self):
        from pathlib import Path
        from app.services.proposal_validator import supported_text
        cases=json.loads((Path(__file__).parent/'fixtures/spoken-email-cases.json').read_text())
        for case in cases:
            with self.subTest(case=case):self.assertEqual(supported_text(case['kind'],case['value'],case['quote']),case['expected'])

class NameExtractionTests(unittest.IsolatedAsyncioTestCase):
    def request(self,text):
        return InterpretRequest(scanId='scan_'+'0'*31+'1',transcript=text,knownFacts=[],fields=[{'fieldId':'field_'+'0'*31+'1','label':'Enter Your Name:','type':'text','required':True,'options':[],'constraints':{}}])

    def proposal(self,request,value):
        from app.schemas.interpret import ModelProposal
        return ModelProposal(updates=[{'fieldId':request.fields[0].fieldId,'target':{'kind':'text','value':value},'evidence':{'source':'transcript','factId':None,'quote':request.transcript}}],clarifications=[])

    def test_name_sentence_is_rejected_but_extracted_value_is_accepted(self):
        from app.services.proposal_validator import validate_proposal
        request=self.request('My name is Dario George.')
        with self.assertRaises(InterpretationError):validate_proposal(request,self.proposal(request,request.transcript))
        validate_proposal(request,self.proposal(request,'Dario George'))

    def test_random_name_is_allowed_only_when_explicitly_requested(self):
        from app.services.proposal_validator import validate_proposal
        for text in ['Use a random name.','Please generate a name.']:
            request=self.request(text)
            validate_proposal(request,self.proposal(request,'Morgan Reed'))
            with self.assertRaises(InterpretationError):validate_proposal(request,self.proposal(request,'random name'))
        request=self.request('My name is Dario George.')
        with self.assertRaises(InterpretationError):validate_proposal(request,self.proposal(request,'Morgan Reed'))

    async def test_one_invalid_evidence_response_gets_one_bounded_validated_regeneration(self):
        request=self.request('My name is Dario George.')
        bad=self.proposal(request,request.transcript).model_dump_json()
        good=self.proposal(request,'Dario George').model_dump_json()
        class RetryModel:
            calls=0
            async def generate(self,*args):
                self.calls+=1
                return bad if self.calls==1 else good
        model=RetryModel();result=await InterpretationService(model).interpret(request)
        self.assertEqual(model.calls,2);self.assertEqual(result.updates[0].target.value,'Dario George')

class FocusedGrammarTests(unittest.TestCase):
    def test_spoken_email_grammar_preserves_original_evidence_and_requires_only_supported_value(self):
        from app.services.interpretation_service import output_schema
        request=InterpretRequest(scanId='scan_'+'0'*31+'1',transcript='My email is Alex at example.test',knownFacts=[],fields=[{'fieldId':'field_'+'0'*31+'1','label':'Email address','type':'email','required':True,'options':[],'constraints':{}}])
        schema=output_schema(request)
        self.assertEqual(schema['$defs']['Evidence']['properties']['quote']['enum'],[request.transcript])
        updates=schema['properties']['updates']
        self.assertEqual(updates['minItems'],1)
        self.assertEqual(updates['items']['anyOf'][0]['properties']['target']['properties']['value']['enum'],['alex@example.test'])
        uncertain=request.model_copy(update={'transcript':'Maybe Alex at example.test'})
        self.assertNotIn('minItems',output_schema(uncertain)['properties']['updates'])
