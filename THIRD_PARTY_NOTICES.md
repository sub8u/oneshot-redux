# Third-party notices

OneShot Redux includes the following open-source components. Each keeps its own
license; the full texts are included in the `lib/` folder.

| Component | Files | License |
|---|---|---|
| [Tesseract.js](https://github.com/naptha/tesseract.js) | `lib/tesseract/tesseract.min.js`, `lib/tesseract/worker.min.js` | Apache License 2.0 (`lib/tesseract/LICENSE-tesseract.js.md`) |
| [Tesseract.js-core](https://github.com/naptha/tesseract.js-core) (WebAssembly build of the [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) engine) | `lib/tesseract/tesseract-core-simd-lstm.*` | Apache License 2.0 (`lib/tesseract/LICENSE-tesseract.js-core`) |
| [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) English model | `lib/tesseract/lang/eng.traineddata.gz` | Apache License 2.0. Modified: the optional word-dictionary component (`lstm_system_dawg`) was removed to reduce size. See `lib/tesseract/lang/README.txt`. |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase | `lib/qrcode/qrcode.js` | MIT License (notice in the file header) |

"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

## Credit

OneShot Redux is an independent project inspired by **OneShot** (2015), created by
Jason Goldman and Ian Ownbey and designed by Daniel Zarick. It is not affiliated
with or endorsed by them.
