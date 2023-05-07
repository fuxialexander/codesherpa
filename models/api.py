from typing import List
from pydantic import BaseModel

class CodeExecutionRequest(BaseModel):
    code: List[str]

class CommandExecutionRequest(BaseModel):
    command: str