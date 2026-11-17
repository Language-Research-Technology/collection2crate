"""Browser-friendly quantisation using only ops onnxruntime-web has:
  - embedding table -> int8 with a per-row scale (Gather int8 rows, Gather scales, Cast, Mul)
  - MatMul weights   -> MatMulNBits (weight-only, block 32), bits from argv

Usage: python quantize_web.py <out_dir> 8   (writes <out_dir>/thx01_web8.onnx, the file the panel loads)
"""
import os
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

out, bits = sys.argv[1], int(sys.argv[2])
m = onnx.load(os.path.join(out, "thx01.onnx"))
g = m.graph
inits = {i.name: i for i in g.initializer}

# find the embedding Gather: data input is a [256000, 768] initializer
emb_node = next(n for n in g.node if n.op_type == "Gather" and n.input[0] in inits
                and tuple(inits[n.input[0]].dims) == (256000, 768))
W = numpy_helper.to_array(inits[emb_node.input[0]]).astype(np.float32)
scale = np.abs(W).max(1) / 127.0
scale[scale == 0] = 1.0
Wq = np.clip(np.round(W / scale[:, None]), -127, 127).astype(np.int8)
print("embedding int8 max abs err %.5f (weights max %.3f)" % (np.abs(Wq * scale[:, None] - W).max(), np.abs(W).max()))

g.initializer.remove(inits[emb_node.input[0]])
g.initializer.extend([numpy_helper.from_array(Wq, "emb_q8"), numpy_helper.from_array(scale.astype(np.float32), "emb_scale")])
ids, y = emb_node.input[1], emb_node.output[0]
new = [
    helper.make_node("Gather", ["emb_q8", ids], ["emb_rows_q"], axis=0),
    helper.make_node("Cast", ["emb_rows_q"], ["emb_rows_f"], to=TensorProto.FLOAT),
    helper.make_node("Gather", ["emb_scale", ids], ["emb_row_scale"], axis=0),
    helper.make_node("Unsqueeze", ["emb_row_scale", "emb_unsq_axis"], ["emb_row_scale_u"]),
    helper.make_node("Mul", ["emb_rows_f", "emb_row_scale_u"], [y]),
]
g.initializer.append(numpy_helper.from_array(np.array([-1], dtype=np.int64), "emb_unsq_axis"))
idx = list(g.node).index(emb_node)
g.node.remove(emb_node)
for k, n in enumerate(new):
    g.node.insert(idx + k, n)

if bits:
    from onnxruntime.quantization.matmul_nbits_quantizer import DefaultWeightOnlyQuantConfig, MatMulNBitsQuantizer
    q = MatMulNBitsQuantizer(m, algo_config=DefaultWeightOnlyQuantConfig(
        block_size=32, is_symmetric=True, bits=bits, op_types_to_quantize=("MatMul",), quant_axes=(("MatMul", 0),)))
    q.process()
    m = q.model.model

p = os.path.join(out, "thx01_web%d.onnx" % bits)
onnx.save(m, p)
print(p, "%.0f MB" % (os.path.getsize(p) / 1e6))
