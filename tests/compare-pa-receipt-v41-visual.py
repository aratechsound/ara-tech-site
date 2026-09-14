import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance


MASKS = {
    1: [
        (0.73, 0.075, 0.94, 0.13),   # mock-only badge area
        (0.065, 0.15, 0.48, 0.18),  # organization
        (0.065, 0.18, 0.40, 0.215), # confirmer name in recipient block
        (0.17, 0.395, 0.50, 0.46),  # real estimate filename and page note
        (0.065, 0.835, 0.42, 0.90), # confirmer in acceptance block
        (0.42, 0.835, 0.78, 0.90),  # accepted_at
        (0.82, 0.94, 0.95, 0.99),   # actual page count
    ],
    2: [
        (0.73, 0.075, 0.94, 0.13),  # mock-only badge area
        (0.065, 0.82, 0.48, 0.87),  # total page-count heading
        (0.82, 0.94, 0.95, 0.99),   # actual page count
    ],
}


def pixel_box(box, size):
    width, height = size
    return tuple(round(value * (width if index % 2 == 0 else height)) for index, value in enumerate(box))


def compare_page(folder, page):
    authority_path = folder / f"authority-page{page}-final.png"
    actual_path = folder / f"actual-page{page}-final.png"
    authority = Image.open(authority_path).convert("RGB")
    actual = Image.open(actual_path).convert("RGB")
    if authority.size != actual.size:
        raise RuntimeError(f"page{page}_size_mismatch:{authority.size}:{actual.size}")

    masked_actual = actual.copy()
    for mask in MASKS[page]:
        box = pixel_box(mask, authority.size)
        masked_actual.paste(authority.crop(box), box)

    side = Image.new("RGB", (authority.width * 2 + 20, authority.height), "white")
    side.paste(authority, (0, 0))
    side.paste(actual, (authority.width + 20, 0))
    side.save(folder / f"page{page}-side-by-side.png")

    overlay = Image.blend(authority, masked_actual, 0.5)
    draw = ImageDraw.Draw(overlay)
    for mask in MASKS[page]:
        draw.rectangle(pixel_box(mask, authority.size), outline=(120, 120, 120), width=1)
    overlay.save(folder / f"page{page}-overlay.png")

    diff = ImageChops.difference(authority, masked_actual)
    ImageEnhance.Contrast(diff).enhance(5).save(folder / f"page{page}-diff.png")
    pixels = list(diff.getdata())
    mae = sum(sum(pixel) for pixel in pixels) / (len(pixels) * 3)
    changed = sum(1 for pixel in pixels if max(pixel) > 12) / len(pixels)
    return {
        "width": authority.width,
        "height": authority.height,
        "masked_regions": [pixel_box(mask, authority.size) for mask in MASKS[page]],
        "mean_absolute_error": round(mae, 6),
        "changed_pixel_ratio_gt_12": round(changed, 6),
        "gate": "PASS" if mae <= 3.0 and changed <= 0.035 else "FAIL",
    }


def main():
    if len(sys.argv) != 2:
        raise RuntimeError("visual evidence directory required")
    folder = Path(sys.argv[1]).resolve()
    result = {f"page{page}": compare_page(folder, page) for page in (1, 2)}
    result["visual_gate"] = "PASS" if all(value["gate"] == "PASS" for value in result.values()) else "FAIL"
    summary_path = folder / "visual-diff-summary.json"
    summary_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    if result["visual_gate"] != "PASS":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
