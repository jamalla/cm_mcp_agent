"""Tests never reach a live model.

`cm_agent.config` calls `load_dotenv`, so on a machine with a real key in `.env`
the router would make paid API calls during a test run -- and any hiccup would
degrade to the offline router and pass anyway, which is worse: the suite would
look green while proving nothing about either path.

Blanked rather than deleted, because `load_dotenv` does not override a variable
that already exists. Popping it would let the next import of `cm_agent.config`
put the real key back.

The LLM path is exercised deliberately, with a stub client, in test_router_llm.py.
"""

import os

os.environ["OPENAI_API_KEY"] = ""
