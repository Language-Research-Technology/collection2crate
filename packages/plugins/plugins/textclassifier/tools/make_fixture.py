"""Write thx01.fixture.json: what THX-01's own Python code produces for a set of
inputs, so the JavaScript port in ../thx01.js can be tested against it without
the model or its 34 MB tokenizer.

The tokenizer is replaced by a stand-in that turns each character into one
token ID. build_sequence only needs encode() and the special token IDs, so the
stand-in exercises all of its budget and truncation logic.

Usage (needs the `thx01` package source, from https://huggingface.co/doofz/THX-01):
    python make_fixture.py <path to the THX-01 checkout> <output json>
"""
import json
import sys

import numpy as np

sys.path.insert(0, sys.argv[1])
from thx01.agent import Agent  # noqa: E402
from thx01.common import QTYPES, build_sequence, clamp_temperature  # noqa: E402


class StubTokenizer:
    mask_token, mask_token_id, cls_token_id, sep_token_id, pad_token_id = "<mask>", 4, 2, 1, 0

    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": [10 + ord(c) % 1000 for c in text]}


CFG = json.load(open(sys.argv[1] + "/rl_agent_config.json"))
tok = StubTokenizer()
agent = Agent.__new__(Agent)
agent.cfg, agent.tok = CFG, tok
agent.temperature = [clamp_temperature(t) for t in CFG["temperature"]]
agent.temperature_by_options = {k: clamp_temperature(v) for k, v in CFG["temperature_by_options"].items()}

many = {"label%02d" % i: "a description of theme number %d with some extra words" % i for i in range(30)}
sequences = [
    ("short", "Hello there.", {"type": "choice", "instructions": "What is it?", "criteria": {"a": "first", "b": "second", "c": ""}}),
    ("list criteria", "Text", {"type": "choice", "instructions": "Pick", "criteria": ["x", "y"]}),
    ("noul default", "Some text", {"type": "noul", "instructions": "Is it about cats?"}),
    ("noul criteria", "Some text", {"type": "noul", "instructions": "Cats?", "criteria": {"true": "it mentions cats", "false": ""}}),
    ("score", "Some text", {"type": "score", "instructions": "How much?", "criteria": ["none", "some", "a lot"]}),
    ("long text truncated", "word " * 600, {"type": "choice", "instructions": "Q", "criteria": {"a": "x", "b": "y"}}),
    ("mask in text", "a <mask> b", {"type": "choice", "instructions": "has <mask>", "criteria": {"k<mask>": "v"}}),
    ("long option cut to 48", "t", {"type": "choice", "instructions": "Q", "criteria": {"k": "z" * 200, "m": "n"}}),
    ("many options grow budget", "text", {"type": "choice", "instructions": "Which?", "criteria": many}),
    ("long question", "text", {"type": "choice", "instructions": "why " * 100, "criteria": {"a": "b"}}),
]
seq_out = []
for name, state, qdef in sequences:
    q = Agent._to_internal(qdef)
    head = agent._head_budget(q)
    ids, markers = build_sequence(tok, state, q, CFG["max_len"], head)
    seq_out.append({"name": name, "state": state, "question": qdef, "headBudget": head, "ids": ids, "markers": markers})

rng = np.random.default_rng(0)
prob_out = []
for qdef in [
    {"type": "choice", "instructions": "q", "criteria": ["a", "b", "c"]},
    {"type": "choice", "instructions": "q", "criteria": ["a", "b", "c", "d", "e", "f", "g"]},
    {"type": "choice", "instructions": "q", "criteria": ["l%d" % i for i in range(12)]},
    {"type": "choice", "instructions": "q", "criteria": ["a", "b"]},
    {"type": "noul", "instructions": "q"},
    {"type": "score", "instructions": "q", "criteria": ["0", "1", "2", "3"]},
]:
    q = Agent._to_internal(qdef)
    k = len(q["crit"]) if q["t"] != "noul" else 2
    logits = (rng.normal(size=(1, k)) * 6).astype(np.float32)
    answers = agent._decode({"q": qdef}, [{"markers": list(range(k))}], logits, np.ones((1, 2)))
    prob_out.append({"question": qdef, "logits": logits[0].tolist(), "answer": answers["q"]})

json.dump({"specialIds": {"cls": 2, "sep": 1, "mask": 4, "pad": 0}, "sequences": seq_out, "probabilities": prob_out},
          open(sys.argv[2], "w"))
print("wrote", sys.argv[2])
