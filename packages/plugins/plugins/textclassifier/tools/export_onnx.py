"""Export THX-01 (encoder + decision head) to ONNX and check it against PyTorch.

Writes <out_dir>/thx01.onnx (+ .onnx.data, 1.3 GB, full precision); quantize_web.py
makes the file the panel loads from it. <model_dir> is a checkout of
https://huggingface.co/doofz/THX-01 (weights, configs and the `thx01` package).
Needs torch, transformers, onnx, onnxscript and onnxruntime.

Usage: python export_onnx.py <model_dir> <out_dir>
"""
import json
import os
import sys
import time

import numpy as np
import torch

MODEL_DIR, OUT_DIR = sys.argv[1], sys.argv[2]
sys.path.insert(0, MODEL_DIR)
import thx01  # noqa: E402
from thx01.common import QTYPES, build_sequence, collate_items, render_options  # noqa: E402

os.makedirs(OUT_DIR, exist_ok=True)
agent = thx01.load(MODEL_DIR, device="cpu")
model = agent.model.eval().float()


class Wrapped(torch.nn.Module):
    """input_ids, attention_mask [B,L]; marker_pos [B,K]; qtype [B] -> raw logits [B,K] (unmasked, untempered)."""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, input_ids, attention_mask, marker_pos, qtype):
        m = self.m
        h = m.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        h = h + m.type_emb(qtype)[:, None, :]
        pad = attention_mask == 0
        for layer in m.head.layers:
            # slow path explicitly (fast path uses a fused op that does not export)
            x = h
            x = x + layer._sa_block(layer.norm1(x), None, pad, is_causal=False)
            x = x + layer._ff_block(layer.norm2(x))
            h = x
        idx = marker_pos[:, :, None].expand(-1, -1, h.size(-1))
        g = torch.gather(h, 1, idx)
        return m.scorer(g).squeeze(-1)


w = Wrapped(model).eval()

# ---- reference inputs: two questions (different K) about one conversation
convo = """User: Hi, I was charged twice for my subscription this month and I want a refund for the duplicate.
Agent: Sorry about that! I can see two charges on the 3rd. I've started a refund for one of them.
User: Thanks. Also the app keeps logging me out every few minutes, which is really annoying."""
questions = {
    "topic": {"type": "choice", "instructions": "What is the main topic of this conversation?",
              "criteria": {"billing": "payments, charges, refunds", "technical": "bugs, crashes, login problems",
                           "shipping": "delivery of physical goods", "smalltalk": "casual chat"}},
    "frustrated": {"type": "noul", "instructions": "Is the user frustrated?"},
}
ref = agent.system_one(convo, questions)
print(json.dumps(ref, indent=1))

items = []
for qid, qd in questions.items():
    q = agent._to_internal(qd)
    seq, markers = build_sequence(agent.tok, convo, q, agent.cfg["max_len"], agent._head_budget(q))
    items.append({"ids": seq, "markers": markers, "qtype": QTYPES[q["t"]]})
b = collate_items([items], agent.tok.pad_token_id)
args = (b["input_ids"], b["attention_mask"], b["marker_pos"], b["qtype"])
with torch.no_grad():
    ref_logits, _ = model(*args[:3], b["marker_mask"], args[3])
    my_logits = w(*args)
print("wrapper vs original max diff:", (ref_logits - my_logits.masked_fill(~b["marker_mask"], -1e4)).abs().max().item())

# save inputs for the JS-side parity test
json.dump({"ids": [it["ids"] for it in items], "markers": [it["markers"] for it in items],
           "qtype": [it["qtype"] for it in items], "logits": ref_logits.tolist(),
           "answers": ref["answers"]}, open(os.path.join(OUT_DIR, "reference.json"), "w"))

out = os.path.join(OUT_DIR, "thx01.onnx")
t = time.time()
B, L, K = torch.export.Dim("batch"), torch.export.Dim("seq", min=8, max=1024), torch.export.Dim("opts")
torch.onnx.export(
    w, args, out, dynamo=True, opset_version=18, external_data=True,
    input_names=["input_ids", "attention_mask", "marker_pos", "qtype"], output_names=["logits"],
    dynamic_shapes={"input_ids": {0: B, 1: L}, "attention_mask": {0: B, 1: L}, "marker_pos": {0: B, 1: K}, "qtype": {0: B}},
)
print("export took %.1fs" % (time.time() - t))

import onnxruntime as ort  # noqa: E402

sess = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
feed = {n: a.numpy() for n, a in zip(["input_ids", "attention_mask", "marker_pos", "qtype"], args)}
o = sess.run(None, feed)[0]
mm = b["marker_mask"].numpy()
print("onnx vs torch max diff (valid markers):", np.abs(o[mm] - ref_logits.numpy()[mm]).max())
