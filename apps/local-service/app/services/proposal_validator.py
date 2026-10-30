"""Independent registry, evidence and native-metadata validation. No repairs."""
import datetime
import re
from decimal import Decimal, InvalidOperation
from ..schemas.interpret import InterpretRequest, ModelProposal, TextTarget, OptionTarget, CheckboxTarget
from .ollama_client import InterpretationError


def fail(code="proposal-validation-failed"):
    raise InterpretationError(code, 502)


def normalized(text: str) -> str:
    return " ".join(text.casefold().split())


NAME_LABELS = {'name', 'full name', 'first name', 'last name', 'given name', 'surname', 'your name', 'enter your name', 'enter full name', 'enter your full name'}
EMAIL_LABELS = {'email', 'email address', 'your email', 'enter your email', 'e-mail', 'e-mail address', 'your email address', 'enter your email address'}


def is_name_field(label: str) -> bool:
    return re.sub(r'(?:[\s:*·•\-_/]|[([]?\s*required(?:\s+question)?\s*[)\]]?)+$', '', normalized(label)).strip() in NAME_LABELS


def is_email_field(label: str) -> bool:
    clean = re.sub(r'(?:[\s:*·•\-_/]|[([]?\s*required(?:\s+question)?\s*[)\]]?)+$', '', normalized(label)).strip()
    return clean in EMAIL_LABELS or bool(re.search(r'\b(?:e-?mail)\b', clean))


def random_name_request(text: str) -> bool:
    return bool(re.fullmatch(r'(?:please )?(?:(?:use|pick|choose) (?:a )?random (?:full |first |last )?name|generate (?:a )?(?:random )?(?:full |first |last )?name|make up (?:a )?name)(?: for me| for this field)?(?: please)?', normalized(text).rstrip('.!?')))


def invalid_name_value(text: str) -> bool:
    words = re.sub(r'[^a-z\s]', ' ', normalized(text))
    words = ' '.join(words.split())
    non_name = re.fullmatch(r'(?:(?:thank you(?: very much| for watching)?|thanks(?: a lot| for watching)?)(?:\s+|$))+', words)
    return (bool(re.match(r"^(?:my (?:full |first |last )?name (?:is|would be)|i am|i['’]m)\b", normalized(text)))
            or bool(non_name) or random_name_request(text) or normalized(text).rstrip('.!?') in {'random name', 'a random name', 'full name'})


def requested_name_value(label: str, value: str, transcript: str, quote: str) -> bool:
    return (is_name_field(label) and random_name_request(transcript) and random_name_request(quote)
            and not invalid_name_value(value) and len(value) <= 100
            and all(char.isalpha() or char in " .'-" for char in value) and any(char.isalpha() for char in value))


def spoken_email_candidates(quote: str) -> list[str]:
    # Deterministic spoken punctuation only. Never infer letters, aliases or a
    # missing domain. The original exact quote is still required as evidence.
    text = normalized(quote)
    text = re.sub(r"\b(?:at\s+the\s+rate(?:\s+of)?|at)\b", "@", text)
    for word, symbol in [('dot', '.'), ('underscore', '_'), ('dash', '-'), ('hyphen', '-')]:
        text = re.sub(r'\b' + word + r'\b', symbol, text)
    text = re.sub(r'\s*([@._-])\s*', r'\1', text)
    clean_text = re.sub(r"^(?:(?:(?:my|the)\s+)?(?:email|e-mail|mail)(?:\s+id|\s+address)?\s+(?:is|would be)|this is|it is|it['’]s|enter|please enter|put)\s+", "", text, flags=re.IGNORECASE).strip()
    clean_text = re.sub(r"^(?:please\s+)?(?:use\s+)?", "", clean_text, flags=re.IGNORECASE).strip()
    match = re.match(r"^([a-z0-9\s._-]+)@([a-z0-9.-]+)$", clean_text)
    if match and "." in match.group(2):
        local_part = re.sub(r"\s+", "", match.group(1))
        domain = match.group(2).rstrip(".")
        if local_part:
            return [f"{local_part}@{domain}"]
    candidates = re.findall(r'[^\s@<>()\[\]{},;:"]+@[a-z0-9.-]+', text)
    return list(dict.fromkeys(candidate.rstrip('.') for candidate in candidates))


def supported_text(kind: str, value: str, quote: str, label: str = "") -> bool:
    if normalized(value) in normalized(quote):
        return True
    return (kind == 'email' or is_email_field(label)) and normalized(value) in spoken_email_candidates(quote)


def validate_proposal(request: InterpretRequest, proposal: ModelProposal):
    fields = {field.fieldId: field for field in request.fields}
    facts = {fact.factId: fact.text for fact in request.knownFacts}
    seen = set()
    for update in proposal.updates:
        field = fields.get(update.fieldId)
        if field is None:
            fail("unknown-field-id")
        if update.fieldId in seen:
            fail("duplicate-field-update")
        seen.add(update.fieldId)
        target, evidence = update.target, update.evidence
        if target.kind != field.type:
            fail("target-type-mismatch")
        source = request.transcript if evidence.source == "transcript" and evidence.factId is None else facts.get(evidence.factId) if evidence.source == "fact" else None
        if source is None or evidence.quote not in source or not evidence.quote.strip():
            fail("unsupported-evidence")
        quote = normalized(evidence.quote)
        offset = source.index(evidence.quote)
        before = re.split(r"[.!?;\n]", source[:offset])[-1]
        after = re.split(r"[.!?;\n]", source[offset + len(evidence.quote):])[0]
        context = normalized(before + evidence.quote + after)
        if re.search(r"\b(maybe|might|uncertain|not certain|not sure|could be|either|possibly)\b", context):
            fail("unsupported-evidence")
        if not isinstance(target, CheckboxTarget) and re.search(r"\b(not|never|don't|isn't|is not)\b", context):
            fail("unsupported-evidence")
        if isinstance(target, OptionTarget):
            option = next((option for option in field.options if option.optionId == target.optionId), None)
            if option is None:
                fail("invalid-option-id")
            if normalized(option.label) not in quote:
                fail("unsupported-evidence")
        elif isinstance(target, CheckboxTarget):
            # Conservative evidence gate; semantic intent still requires review.
            positive = bool(re.search(r"\b(yes|true|checked|check|want|need|have)\b", context))
            negative = bool(re.search(r"\b(no|false|unchecked|uncheck|not|never|don't|do not)\b", context))
            if (target.checked and (not positive or negative)) or (not target.checked and not negative):
                fail("unsupported-evidence")
            if field.required and not target.checked:
                fail()
        elif isinstance(target, TextTarget):
            value, limits = target.value, field.constraints
            try:
                value.encode("utf-8")
            except UnicodeError:
                fail()
            if is_name_field(field.label) and invalid_name_value(value):
                fail('unsupported-evidence')
            if not value.strip() or not (supported_text(field.type, value, evidence.quote, field.label) or field.type == 'text' and len(request.fields) == 1 and requested_name_value(field.label, value, request.transcript, evidence.quote)):
                fail("unsupported-evidence")
            length = len(value.encode("utf-16-le")) // 2
            if (limits.minLength is not None and length < limits.minLength) or (limits.maxLength is not None and length > limits.maxLength):
                fail()
            if field.type != "textarea" and any(char in value for char in "\r\n"):
                fail()
            if field.type == "email" and not re.fullmatch(r"[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*", value):
                fail()
            if field.type in ("number", "date"):
                try:
                    if field.type == "date":
                        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                            fail()
                        parsed = Decimal(datetime.date.fromisoformat(value).toordinal())
                        def bound(text):
                            return Decimal(datetime.date.fromisoformat(text).toordinal())
                        base = Decimal(datetime.date(1970, 1, 1).toordinal())
                    else:
                        if not re.fullmatch(r"-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", value) or len(value) > 128:
                            fail()
                        parsed = Decimal(value)
                        bound = Decimal
                        base = Decimal(0)
                    if not parsed.is_finite():
                        fail()
                    if limits.min is not None:
                        base = bound(limits.min)
                        if not base.is_finite() or parsed < base:
                            fail()
                    if limits.max is not None:
                        maximum = bound(limits.max)
                        if not maximum.is_finite() or parsed > maximum:
                            fail()
                    if limits.step != "any":
                        step = Decimal(limits.step or "1")
                        if not step.is_finite() or step <= 0 or (parsed - base) % step != 0:
                            fail()
                except (ValueError, InvalidOperation, OverflowError):
                    fail()
    clarification_ids = set()
    for clarification in proposal.clarifications:
        ids = clarification.targetFieldIds
        if len(set(ids)) != len(ids) or any(field_id not in fields for field_id in ids):
            fail("unknown-field-id")
        if seen.intersection(ids) or clarification_ids.intersection(ids):
            fail("proposal-validation-failed")
        clarification_ids.update(ids)
