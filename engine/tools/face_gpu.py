"""The face models for the GPU: SCRFD and AuraFace (real people), deepghs'
anime face detector and CCIP (characters) as TorchScript, for the engine's
Torch runtime (Metal on a Mac), which runs them many times faster than ONNX
Runtime on the CPU.

They are the same models the engine downloads as ONNX, made from the same
weights, so the faces they find and the numbers they give are the same: a
face index can be made with either, or both. Each is checked against its ONNX
file on the pictures given before it is written.

- SCRFD, AuraFace and the anime face detector: converted from their ONNX
  files as they are (onnx2torch).
- CCIP (caformer_b36): timm's CAFormer with CCIP's weights taken from its
  ONNX file (the layers by their names), and CCIP's own attention-pool head
  converted from the file as it is. Converting the whole file is six times
  slower on the GPU.

Run with a PyTorch of the runtime's version (2.13), timm, onnx, onnxruntime,
onnx2torch, numpy and pillow:

    python engine/tools/face_gpu.py --scrfd …/scrfd_10g_bnkps.onnx \
        --auraface …/glintr100.onnx --anime …/face_detect_v1.4_s/model.onnx \
        --ccip …/ccip-caformer_b36-24/model_feat.onnx \
        --photos photos/ --drawings drawings/ --out engine/target/gpu
"""

import argparse
import glob
import os
import tempfile
from pathlib import Path

import numpy as np
import onnx
import onnx.utils
import onnxruntime as ort
import timm
import torch
from onnx import numpy_helper
from onnx2torch import convert
from PIL import Image
from timm.models.metaformer import checkpoint_filter_fn

# What the engine names them (`faces.rs`, PHOTO_GPU and DRAWN_GPU).
NAMES = {"scrfd": "scrfd-10g.pt", "auraface": "auraface.pt", "anime": "anime-face-v1.4s.pt", "ccip": "ccip-b36.pt"}
CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)
# Where the CCIP backbone ends and its head starts.
CCIP_FEATURES = "/backbone/Transpose_output_0"


def planes(img: Image.Image) -> np.ndarray:
    return np.asarray(img, np.float32).transpose(2, 0, 1)[None].copy()


def scrfd_input(img: Image.Image) -> tuple[np.ndarray, float]:
    """As the engine gives it: fitted into 640 × 640 from the top left, the rest dark, around 0."""
    s = min(640 / img.width, 640 / img.height)
    small = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.BILINEAR)
    x = np.full((640, 640, 3), 127.5, np.float32)
    x[: small.height, : small.width] = np.asarray(small, np.float32)
    return ((x - 127.5) / 128).transpose(2, 0, 1)[None].copy(), s


def scrfd_best(outputs: list[np.ndarray]) -> tuple[float, np.ndarray] | None:
    """The surest face: its score and five points (in the 640 square), from the nine outputs."""
    by = lambda k: sorted([o for o in outputs if o.shape[-1] == k], key=lambda o: -o.shape[0])
    best = None
    for (scores, points), stride in zip(zip(by(1), by(10)), (8, 16, 32)):
        i = int(np.argmax(scores[:, 0]))
        if scores[i, 0] >= 0.5 and (best is None or scores[i, 0] > best[0]):
            place, across = i // 2, 640 // stride
            centre = np.array([(place % across) * stride, (place // across) * stride] * 5, np.float32)
            best = (float(scores[i, 0]), (centre + points[i] * stride).reshape(5, 2))
    return best


def cos(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a.ravel(), b.ravel()
    return float(a @ b / np.linalg.norm(a) / np.linalg.norm(b))


def trace(module: torch.nn.Module, example: np.ndarray, out: Path) -> torch.jit.ScriptModule:
    """Traced on the GPU in half precision and saved; loaded back as the engine will."""
    module = module.eval().to("mps").half()
    with torch.no_grad():
        traced = torch.jit.trace(module, torch.from_numpy(example).to("mps").half(), check_trace=False)
    traced.save(str(out))
    print(f"  wrote {out} ({out.stat().st_size / 1e6:.0f} MB)")
    return torch.jit.load(str(out), map_location="mps")


def on_gpu(model: torch.jit.ScriptModule, x: np.ndarray) -> list[np.ndarray]:
    with torch.no_grad():
        out = model(torch.from_numpy(x).to("mps").half())
    return [o.float().cpu().numpy() for o in (out if isinstance(out, (tuple, list)) else [out])]


def cpu(path: str) -> ort.InferenceSession:
    return ort.InferenceSession(path, providers=["CPUExecutionProvider"])


def without_if(path: str, out: str) -> None:
    """CCIP's one If (the head squeezes the pooled token's axis when it is 1, which it always is) as
    the Squeeze it always takes."""
    model = onnx.load(path)
    graph = model.graph
    node = next(n for n in graph.node if n.op_type == "If")
    then = next(a.g for a in node.attribute if a.name == "then_branch")
    squeeze = then.node[0]
    if squeeze.op_type != "Squeeze" or len(then.node) != 1:
        raise SystemExit("CCIP's If isn't the squeeze it was: a different CCIP file?")
    graph.initializer.extend(then.initializer)
    axes = [n for n in graph.node if any(o in squeeze.input[1:] for o in n.output)]
    nodes = []
    for n in graph.node:
        if n in axes:
            continue
        nodes += axes + [onnx.helper.make_node("Squeeze", list(squeeze.input), list(node.output), name=node.name)] if n == node else [n]
    del graph.node[:]
    graph.node.extend(nodes)
    onnx.save(model, out)


def ccip_backbone(path: str) -> torch.nn.Module:
    """timm's caformer_b36 with CCIP's weights: the named ones as they are, the matrices (unnamed in
    the file) by the layer that uses them, transposed back."""
    graph = onnx.load(path).graph
    inits = {i.name: numpy_helper.to_array(i) for i in graph.initializer}
    prefix = "backbone.caformer."
    weights = {k[len(prefix) :]: torch.from_numpy(v.copy()) for k, v in inits.items() if k.startswith(prefix)}
    for n in graph.node:
        if n.op_type != "MatMul" or not n.name.startswith("/backbone/stages."):
            continue
        w = next((i for i in n.input if i in inits and not i.startswith("backbone.")), None)
        if w is not None:
            # /backbone/stages.2/stages.2.0/token_mixer/qkv/MatMul is stages.2.0.token_mixer.qkv
            layer = n.name.strip("/").split("/")[2:-1]
            weights[".".join(layer) + ".weight"] = torch.from_numpy(inits[w].T.copy())
    model = timm.create_model("caformer_b36", pretrained=False, num_classes=0)
    missing, unexpected = model.load_state_dict(checkpoint_filter_fn(weights, model), strict=False)
    missing = [k for k in missing if not k.startswith("head.")]
    if missing or unexpected:
        raise SystemExit(f"CCIP's weights don't fit timm's caformer_b36: missing {missing[:5]}, unexpected {unexpected[:5]}")
    return model


class Ccip(torch.nn.Module):
    def __init__(self, backbone: torch.nn.Module, head: torch.nn.Module):
        super().__init__()
        self.backbone = backbone
        self.head = head

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.backbone.forward_features(x))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ("scrfd", "auraface", "anime", "ccip"):
        ap.add_argument(f"--{name}", required=True, help=f"its ONNX file")
    ap.add_argument("--photos", required=True, help="a folder of photos with faces to compare on")
    ap.add_argument("--drawings", required=True, help="a folder of drawings with faces to compare on")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    torch.set_grad_enabled(False)
    files = lambda d: sorted(f for f in glob.glob(os.path.join(d, "**", "*"), recursive=True) if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
    photos = [Image.open(f).convert("RGB") for f in files(args.photos)]
    drawings = [Image.open(f).convert("RGB") for f in files(args.drawings)]

    print("SCRFD")
    ref = cpu(args.scrfd)
    model = trace(convert(args.scrfd), scrfd_input(photos[0])[0], args.out / NAMES["scrfd"])
    faces = []
    for img in photos:
        x, s = scrfd_input(img)
        mine, theirs = scrfd_best(on_gpu(model, x)), scrfd_best(ref.run(None, {ref.get_inputs()[0].name: x}))
        if (mine is None) != (theirs is None):
            raise SystemExit("SCRFD on the GPU finds a face the ONNX file doesn't, or misses one")
        if theirs:
            moved = float(np.abs(mine[1] - theirs[1]).max())
            if moved > 1:
                raise SystemExit(f"SCRFD on the GPU puts a face's points {moved:.1f} px from the ONNX file's")
            faces.append((img, theirs[1] / s))
    print(f"  the same faces in {len(photos)} photos, their points within a pixel")

    print("AuraFace")
    ref = cpu(args.auraface)
    crops = []
    for img, points in faces:
        x0, y0 = points.min(0) - (points.max(0) - points.min(0))
        x1, y1 = points.max(0) + (points.max(0) - points.min(0))
        crops.append(((planes(img.crop((int(x0), int(y0), int(x1), int(y1))).resize((112, 112), Image.BILINEAR)) - 127.5) / 127.5).astype(np.float32))
    model = trace(convert(args.auraface), crops[0], args.out / NAMES["auraface"])
    worst = min(cos(on_gpu(model, c)[0], ref.run(None, {ref.get_inputs()[0].name: c})[0]) for c in crops)
    if worst < 0.999:
        raise SystemExit(f"AuraFace on the GPU differs from its ONNX file: cos {worst:.4f}")
    print(f"  {len(crops)} faces, agrees {worst:.5f} at worst")

    print("Anime face detector")
    ref = cpu(args.anime)
    inputs = [(planes(img.resize((640, 640), Image.BILINEAR)) / 255).astype(np.float32) for img in drawings]
    model = trace(convert(args.anime), inputs[0], args.out / NAMES["anime"])
    boxes = []
    for img, x in zip(drawings, inputs):
        mine, theirs = on_gpu(model, x)[0][0], ref.run(None, {ref.get_inputs()[0].name: x})[0][0]
        i = int(np.argmax(theirs[4]))
        if (mine[4].max() >= 0.307) != (theirs[4, i] >= 0.307):
            raise SystemExit("the anime face detector on the GPU finds a face the ONNX file doesn't, or misses one")
        if theirs[4, i] >= 0.307:
            moved = float(np.abs(mine[:4, i] - theirs[:4, i]).max())
            if moved > 1 or abs(mine[4, i] - theirs[4, i]) > 0.01:
                raise SystemExit(f"the anime face detector on the GPU differs from its ONNX file: {moved:.1f} px")
            cx, cy, w, h = theirs[:4, i] * [img.width / 640, img.height / 640, img.width / 640, img.height / 640]
            boxes.append((img, (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)))
    print(f"  the same faces in {len(drawings)} drawings, their boxes within a pixel")

    print("CCIP")
    with tempfile.TemporaryDirectory() as work:
        plain, head = os.path.join(work, "ccip.onnx"), os.path.join(work, "head.onnx")
        without_if(args.ccip, plain)
        onnx.utils.extract_model(plain, head, [CCIP_FEATURES], ["output"])
        ccip = Ccip(ccip_backbone(plain), convert(head))
    ref = cpu(args.ccip)
    # The engine's crop: the head and upper body around the face, squeezed to 384 × 384.
    crops = []
    for img, (x0, y0, x1, y1) in boxes:
        fw, fh = x1 - x0, y1 - y0
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2 + fh * 1.6
        crop = img.crop((int(max(0, cx - fw * 2.25)), int(max(0, cy - fh * 3)), int(min(img.width, cx + fw * 2.25)), int(min(img.height, cy + fh * 3))))
        crops.append(((planes(crop.resize((384, 384), Image.BILINEAR)) / 255 - CLIP_MEAN[:, None, None]) / CLIP_STD[:, None, None]).astype(np.float32))
    model = trace(ccip, crops[0], args.out / NAMES["ccip"])
    worst = min(cos(on_gpu(model, c)[0], ref.run(None, {ref.get_inputs()[0].name: c})[0]) for c in crops)
    if worst < 0.999:
        raise SystemExit(f"CCIP on the GPU differs from its ONNX file: cos {worst:.4f}")
    print(f"  {len(crops)} characters, agrees {worst:.5f} at worst")


if __name__ == "__main__":
    main()
