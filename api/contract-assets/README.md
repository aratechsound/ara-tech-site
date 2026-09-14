# PA Receipt V4.1 template provenance

`pa-receipt-v4-1-template.pdf` is the fixed visual authority for the first two
pages of a `PA-FORMAL-V5-20260914-1` receipt. It was printed mechanically from
the Owner-approved source HTML/CSS, not recreated from handwritten PDF layout
code.

- Source: `E:\ダウンロード\pa-est-005-receipt-design-mock-v4-1-final.html`
- Source SHA-256: `f988d8f8d510ad61087d9de8dca7af29eeeca143c938eb63bf379367c10bdb5d`
- Template SHA-256: `d9dc133719b21012ef7522db75502d5e081883c1da5a57fc5a5adafb4e6a8d52`
- Renderer: Microsoft Edge 153, A4 print, background graphics enabled

The print input retained the authority DOM and CSS. An appended print-only rule
hid only values that must come from the accepted snapshot or final composite:

- Page 1: mock badge, customer organization/person, event name, event values,
  estimate filename/revision/page note/amount, cancellation date column,
  payment deadline, confirmer, accepted timestamp, footer page number.
- Page 2: mock badge, event/reference row, page-count note, footer page number.

Edge and WeasyPrint both reserve Page 2's `16.5mm` brand-band geometry but omit
that band's paint in the isolated print. The builder therefore places the exact
cropped Page 1 authority band over Page 2's already-reserved band area. It does
not recreate the band, logo, or text. The Page 2 `appendix` class is also
removed; that class only repeats the base title's existing `21pt` font size.

At runtime the generator validates the template hash, imports both pages
unchanged, overlays only the hidden dynamic values, and then appends the exact
bound estimate PDF pages. A template hash mismatch fails closed.
