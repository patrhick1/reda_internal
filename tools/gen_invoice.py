#!/usr/bin/env python3
"""Generate a one-page PDF invoice with no third-party dependencies.

Uses the PDF base-14 fonts (Helvetica / Helvetica-Bold), so no font embedding
is needed. Currency is written as "NGN" because the naira glyph (U+20A6) is not
present in the base-14 fonts and would render as a missing box.
"""

import datetime

PAGE_W, PAGE_H = 595.28, 841.89  # A4 in points
LEFT, RIGHT = 56.0, PAGE_W - 56.0

INK = (0.11, 0.13, 0.16)      # near-black slate
MUTED = (0.42, 0.45, 0.50)    # grey
RULE = (0.82, 0.84, 0.87)     # light rule
BAND = (0.96, 0.97, 0.98)     # table header fill
ACCENT = (0.05, 0.36, 0.27)   # deep green accent

# ---- invoice data ----------------------------------------------------------
TODAY = datetime.date(2026, 6, 16)
INVOICE_NO = "INV-2026-0616"
AMOUNT = 450000.00

FROM_NAME = "Paschal Okonkwor"
FROM_LINES = ["Software Engineer", "okonkworpaschal@gmail.com"]

BILL_TO = ["Reda Logistics", "Attn: Uzo"]

ITEM_TITLE = "Feature A - Multi-product orders"
ITEM_DESC = [
    "One delivery can hold several real-SKU products instead of being",
    "collapsed into a single generic \"Perfume\" line. Includes the new",
    "delivery_items model, WhatsApp intake + AI line-item extraction,",
    "create/edit/mark-delivered/rollover, per-line stock, updated mobile",
    "screens, and a one-time backfill with a stock-parity guarantee.",
    "Fees, remit and reconciliation are unchanged.",
]

BANK = [
    ("Bank", "Zenith Bank"),
    ("Account name", "Paschal Okonkwor"),
    ("Account number", "2208576721"),
]

NOTES = [
    "Scope reference: Reda - Scope of Work, Feature A (dated 2026-06-13).",
    "Fixed price for the full scope of Feature A as specified.",
]


def money(n: float) -> str:
    return "NGN {:,.2f}".format(n)


# ---- tiny PDF builder ------------------------------------------------------
class PDF:
    def __init__(self):
        self.ops = []

    def _esc(self, s: str) -> str:
        return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

    def text(self, x, y, size, bold, s, color=INK):
        r, g, b = color
        font = "F2" if bold else "F1"
        self.ops.append(f"{r:.3f} {g:.3f} {b:.3f} rg")
        self.ops.append(
            f"BT /{font} {size} Tf {x:.2f} {y:.2f} Td ({self._esc(s)}) Tj ET"
        )

    def text_right(self, x_right, y, size, bold, s, color=INK):
        w = string_width(s, size, bold)
        self.text(x_right - w, y, size, bold, s, color)

    def line(self, x1, y1, x2, y2, color=RULE, width=0.8):
        r, g, b = color
        self.ops.append(f"{r:.3f} {g:.3f} {b:.3f} RG")
        self.ops.append(f"{width:.2f} w {x1:.2f} {y1:.2f} m {x2:.2f} {y2:.2f} l S")

    def rect(self, x, y, w, h, color):
        r, g, b = color
        self.ops.append(f"{r:.3f} {g:.3f} {b:.3f} rg {x:.2f} {y:.2f} {w:.2f} {h:.2f} re f")

    def stream(self) -> bytes:
        return "\n".join(self.ops).encode("latin-1")


# Helvetica AFM widths (per 1000 units) for accurate right-alignment.
_HELV = {
    ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
    '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
    '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
    '@': 1015, 'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778,
    'H': 722, 'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778,
    'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944,
    'X': 667, 'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
    '`': 333, 'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556,
    'h': 556, 'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556,
    'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722,
    'x': 500, 'y': 500, 'z': 500, '{': 334, '|': 260, '}': 334, '~': 584,
}
_HELV_BOLD = dict(_HELV)
for _k, _v in {
    'a': 556, 'b': 611, 'c': 556, 'd': 611, 'e': 556, 'f': 333, 'g': 611, 'h': 611,
    'i': 278, 'j': 278, 'k': 556, 'l': 278, 'm': 889, 'n': 611, 'o': 611, 'p': 611,
    'q': 611, 'r': 389, 's': 556, 't': 333, 'u': 611, 'v': 556, 'w': 778, 'x': 556,
    'y': 556, 'z': 500, ' ': 278, ',': 278, '.': 278, '-': 333,
    '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
    '8': 556, '9': 556,
}.items():
    _HELV_BOLD[_k] = _v


def string_width(s: str, size: float, bold: bool) -> float:
    table = _HELV_BOLD if bold else _HELV
    return sum(table.get(ch, 556) for ch in s) * size / 1000.0


def build() -> bytes:
    p = PDF()
    y = PAGE_H - 64

    # Header
    p.text(LEFT, y, 30, True, "INVOICE")
    p.text_right(RIGHT, y + 6, 11, True, FROM_NAME)
    yy = y - 10
    for ln in FROM_LINES:
        p.text_right(RIGHT, yy, 9.5, False, ln, MUTED)
        yy -= 13
    p.line(LEFT, y - 30, RIGHT, y - 30, ACCENT, 1.6)

    # Meta + Bill To
    y -= 58
    p.text(LEFT, y, 9, True, "BILL TO", MUTED)
    by = y - 15
    for i, ln in enumerate(BILL_TO):
        p.text(LEFT, by, 11 if i == 0 else 10, i == 0, ln)
        by -= 15

    p.text_right(RIGHT - 120, y, 9.5, False, "Invoice no.", MUTED)
    p.text_right(RIGHT, y, 9.5, True, INVOICE_NO)
    p.text_right(RIGHT - 120, y - 16, 9.5, False, "Date issued", MUTED)
    p.text_right(RIGHT, y - 16, 9.5, True, TODAY.strftime("%d %b %Y"))
    p.text_right(RIGHT - 120, y - 32, 9.5, False, "Payment terms", MUTED)
    p.text_right(RIGHT, y - 32, 9.5, True, "Due on receipt")

    # Table header
    y -= 76
    p.rect(LEFT, y - 6, RIGHT - LEFT, 24, BAND)
    p.text(LEFT + 10, y, 9, True, "DESCRIPTION", MUTED)
    p.text_right(RIGHT - 10, y, 9, True, "AMOUNT", MUTED)

    # Item row
    y -= 30
    p.text(LEFT + 10, y, 11.5, True, ITEM_TITLE)
    p.text_right(RIGHT - 10, y, 11.5, True, money(AMOUNT))
    dy = y - 17
    for ln in ITEM_DESC:
        p.text(LEFT + 10, dy, 9, False, ln, MUTED)
        dy -= 12.5
    p.line(LEFT, dy - 2, RIGHT, dy - 2, RULE, 0.8)

    # Totals
    ty = dy - 22
    p.text_right(RIGHT - 130, ty, 10, False, "Subtotal", MUTED)
    p.text_right(RIGHT - 10, ty, 10, False, money(AMOUNT))
    ty -= 18
    p.text_right(RIGHT - 130, ty, 10, False, "Tax", MUTED)
    p.text_right(RIGHT - 10, ty, 10, False, "NGN 0.00")
    ty -= 10
    p.line(RIGHT - 250, ty, RIGHT, ty, RULE, 0.8)
    ty -= 22
    p.rect(RIGHT - 250, ty - 8, 250, 30, BAND)
    p.text(RIGHT - 240, ty, 12, True, "TOTAL DUE")
    p.text_right(RIGHT - 10, ty, 13, True, money(AMOUNT), ACCENT)

    # Payment details
    py = ty - 64
    p.text(LEFT, py, 10, True, "PAYMENT DETAILS")
    p.line(LEFT, py - 8, LEFT + 150, py - 8, ACCENT, 1.2)
    py -= 26
    for label, val in BANK:
        p.text(LEFT, py, 9.5, False, label, MUTED)
        p.text(LEFT + 110, py, 10.5, True, val)
        py -= 18

    # Notes
    py -= 18
    p.text(LEFT, py, 10, True, "NOTES")
    p.line(LEFT, py - 8, LEFT + 150, py - 8, ACCENT, 1.2)
    py -= 24
    for ln in NOTES:
        p.text(LEFT, py, 9.5, False, ln, MUTED)
        py -= 14

    # Footer
    p.line(LEFT, 70, RIGHT, 70, RULE, 0.8)
    p.text(LEFT, 54, 9.5, False, "Thank you.", MUTED)
    p.text_right(RIGHT, 54, 9, False, f"{FROM_NAME}  -  {INVOICE_NO}", MUTED)

    return assemble(p.stream())


def assemble(content: bytes) -> bytes:
    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append(
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] "
        b"/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>"
    )
    objs.append(
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream"
    )
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_pos = len(out)
    n = len(objs) + 1
    out += f"xref\n0 {n}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        b"trailer\n<< /Size " + str(n).encode() + b" /Root 1 0 R >>\n"
        b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF"
    )
    return bytes(out)


if __name__ == "__main__":
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else "Reda_Invoice_FeatureA.pdf"
    with open(path, "wb") as f:
        f.write(build())
    print("wrote", path)
