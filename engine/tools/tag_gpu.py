"""The tag models for the GPU: SigLIP 2's picture half and the PixAI tagger as
TorchScript, for the engine's Torch runtime (Metal on a Mac), which runs them
several times faster than ONNX Runtime on the CPU.

They are the same models the engine downloads as ONNX, so the vectors they
make are the same: an index can be made with either, or both. Each is checked
against its ONNX file on the pictures given (`--check`) before it is written.

- SigLIP 2 (base, 256 px): timm's copy of Google's weights (Apache 2.0).
- PixAI v0.9: WD's EVA02-Large encoder, which PixAI kept as it was, with
  PixAI's own head taken out of its ONNX file (both Apache 2.0).

Run with a PyTorch of the runtime's version (2.13), timm, onnx and
onnxruntime:

    python engine/tools/tag_gpu.py --siglip-onnx …/vision_model_fp16.onnx \
        --pixai-onnx …/model.onnx --check pictures/ --out engine/target/gpu
"""

import argparse
import glob
import os
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import timm
import torch
import torch.nn.functional as F
from onnx import numpy_helper
from PIL import Image

SIGLIP = "vit_base_patch16_siglip_256.v2_webli"
WD_EVA02 = "hf-hub:SmilingWolf/wd-eva02-large-tagger-v3"
PIXAI_HEAD = "/base_module/base_module.1/head/head.0/Gemm"


def pixels(path: str, size: int) -> np.ndarray:
    """A picture as the engine gives it to these models: squeezed to a square, RGB around 0."""
    im = Image.open(path).convert("RGB").resize((size, size), Image.BILINEAR)
    return ((np.asarray(im, dtype=np.float32) / 255 - 0.5) / 0.5).transpose(2, 0, 1)[None]


def cos(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a.ravel(), b.ravel()
    return float(a @ b / np.linalg.norm(a) / np.linalg.norm(b))


class Pooled(torch.nn.Module):
    """SigLIP's picture embedding: the attention-pooled output (the ONNX's `pooler_output`)."""

    def __init__(self, model: torch.nn.Module):
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.model(x)


class Tagger(torch.nn.Module):
    """PixAI as one tensor: its embedding (1024), then each tag's probability (13461)."""

    def __init__(self, model: torch.nn.Module, head: torch.nn.Linear):
        super().__init__()
        self.model = model
        self.head = head

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.model.forward_head(self.model.forward_features(x), pre_logits=True)
        return torch.cat([features, torch.sigmoid(self.head(features))], dim=1)


def pixai_head(path: str) -> torch.nn.Linear:
    model = onnx.load(path, load_external_data=False)
    node = next(n for n in model.graph.node if n.name == PIXAI_HEAD)
    inits = {i.name: i for i in model.graph.initializer}
    weight, bias = (numpy_helper.to_array(inits[name]) for name in node.input[1:3])
    if any(a.name == "transB" and a.i == 0 for a in node.attribute):
        weight = weight.T
    head = torch.nn.Linear(weight.shape[1], weight.shape[0])
    head.weight.data = torch.from_numpy(weight.copy())
    head.bias.data = torch.from_numpy(bias.copy())
    return head


def export(module: torch.nn.Module, size: int, out: Path, onnx_path: str, pictures: list[str], compare) -> None:
    """Traced on the GPU in half precision, checked against the ONNX file, saved."""
    module = module.eval().to("mps").half()
    example = torch.zeros(1, 3, size, size, device="mps", dtype=torch.half)
    with torch.no_grad():
        traced = torch.jit.trace(module, example, check_trace=False)
    traced.save(str(out))
    loaded = torch.jit.load(str(out), map_location="mps")
    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    for p in pictures:
        x = pixels(p, size)
        with torch.no_grad():
            mine = loaded(torch.from_numpy(x).to("mps").half()).float().cpu().numpy()
        theirs = session.run(None, {session.get_inputs()[0].name: x})
        compare(os.path.basename(p), mine, {o.name: v for o, v in zip(session.get_outputs(), theirs)})
    print(f"  wrote {out} ({out.stat().st_size / 1e6:.0f} MB)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--siglip-onnx", required=True)
    ap.add_argument("--pixai-onnx", required=True)
    ap.add_argument("--check", required=True, help="a folder of pictures to compare the two on")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    pictures = sorted(glob.glob(os.path.join(args.check, "*")))
    torch.set_grad_enabled(False)

    print("SigLIP 2, the picture half")
    siglip = Pooled(timm.create_model(SIGLIP, pretrained=True, num_classes=0))

    def same_embedding(name, mine, theirs):
        c = cos(mine, theirs["pooler_output"])
        print(f"  {name}: agrees {c:.5f}")
        if c < 0.999:
            raise SystemExit(f"SigLIP on the GPU differs from its ONNX file on {name}: {c:.4f}")

    export(siglip, 256, args.out / "siglip2-vision.pt", args.siglip_onnx, pictures, same_embedding)

    print("PixAI tagger")
    wd = timm.create_model(WD_EVA02, pretrained=True)
    tagger = Tagger(wd, pixai_head(args.pixai_onnx))

    def same_tags(name, mine, theirs):
        emb, probs = mine[0, :1024], mine[0, 1024:]
        diff = float(np.abs(probs - theirs["prediction"][0]).max())
        c = cos(emb, theirs["embedding"][0])
        top = lambda p: set(np.argsort(-p)[:20][p[np.argsort(-p)[:20]] >= 0.3])
        same = len(top(probs) & top(theirs["prediction"][0])), len(top(theirs["prediction"][0]))
        print(f"  {name}: largest difference {diff:.4f}, embedding agrees {c:.5f}, tags {same[0]}/{same[1]}")
        if diff > 0.05 or c < 0.995:
            raise SystemExit(f"PixAI on the GPU differs from its ONNX file on {name}")

    export(tagger, 448, args.out / "pixai.pt", args.pixai_onnx, pictures, same_tags)


if __name__ == "__main__":
    main()
