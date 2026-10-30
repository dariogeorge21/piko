"""Form metadata only; no answers or conversation history."""
from pydantic import Field, field_validator, model_validator
from .interpret import StrictModel, Id, EligibleField, InterpretRequest
from .synthesize import plain_text


class SummaryRequest(StrictModel):
    scanId: Id
    fields: list[EligibleField] = Field(max_length=100)

    @model_validator(mode='after')
    def bounded(self):
        InterpretRequest(scanId=self.scanId, transcript='Form summary', knownFacts=[], fields=self.fields)
        return self


class SummaryText(StrictModel):
    summary: str = Field(min_length=1, max_length=500)

    @field_validator('summary')
    @classmethod
    def spoken_text(cls, value):
        plain_text(value, 500)
        return value


class SummaryResponse(SummaryText):
    scanId: Id
