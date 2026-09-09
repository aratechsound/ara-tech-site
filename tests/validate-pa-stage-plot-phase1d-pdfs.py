from pathlib import Path
from pypdf import PdfReader

OUTPUTS = Path(r"C:\Users\user\Documents\Codex\2026-09-09\files-pasted-by-the-user-stage\outputs\audit-stage-plot-phase1d-fix")
EXPECTED = {
    "band-setlist-fixed.pdf": (2, 2),
    "idol-setlist-fixed.pdf": (2, 2),
    "dance-single-mix-fixed.pdf": (1, 1),
    "equipment-fit-fixed.pdf": (1, 1),
    "equipment-overflow-fixed.pdf": (6, 6),
    "setlist-page-break-fixed.pdf": (6, None),
}


def is_landscape(page):
    return float(page.mediabox.width) > float(page.mediabox.height)


readers = {name: PdfReader(str(OUTPUTS / name)) for name in EXPECTED}
for name, (minimum_pages, maximum_pages) in EXPECTED.items():
    reader = readers[name]
    assert len(reader.pages) >= minimum_pages, (name, len(reader.pages))
    assert maximum_pages is None or len(reader.pages) <= maximum_pages, (name, len(reader.pages))
    assert is_landscape(reader.pages[0]), name
    for index, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        assert len(text.strip()) > 100, (name, index + 1, "non-selectable/blank")
        assert "2026/10/18" in text, (name, index + 1, "event date")
        resources = page.get("/Resources")
        assert resources and resources.get("/Font"), (name, index + 1, "font resources")
        if index:
            assert not is_landscape(page), (name, index + 1, "portrait continuation")

band_text = "\n".join(page.extract_text() or "" for page in readers["band-setlist-fixed.pdf"].pages)
assert "01_opening.wav" in band_text and "06_end.wav" in band_text
assert "No." in band_text and "SET LIST" in band_text

dance_text = readers["dance-single-mix-fixed.pdf"].pages[0].extract_text() or ""
assert "dance_mix_final.wav" in dance_text
assert "SET LIST" not in dance_text

fit_text = readers["equipment-fit-fixed.pdf"].pages[0].extract_text() or ""
assert "Brought item 1" in fit_text and "Requested item 1" in fit_text
assert "SET LIST" not in fit_text

overflow = readers["equipment-overflow-fixed.pdf"]
overflow_text = [page.extract_text() or "" for page in overflow.pages]
assert "Brought item 1" not in overflow_text[0]
assert "Brought item 1" in overflow_text[1]
assert "LONG REQUEST 1" in overflow_text[2] and "LONG REQUEST 35" in overflow_text[4]
assert "SET LIST" in overflow_text[5]

long_pages = readers["setlist-page-break-fixed.pdf"].pages[1:]
long_page_count = len(long_pages)
for page_number, page in enumerate(long_pages, start=1):
    text = page.extract_text() or ""
    assert f"{page_number} of {long_page_count}" in text
    assert "long_fixture.wav" in text

print("PASS validate-pa-stage-plot-phase1d-pdfs")
