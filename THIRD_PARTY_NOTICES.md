# Third-party notices / 第三方说明

## ONNX Runtime Web 1.17.3 — `vendor/ort/`
- Files: `ort.min.js`, `ort-wasm.wasm`, `ort-wasm-simd.wasm`
- Copyright (c) Microsoft Corporation. Licensed under the **MIT License** (stated in the header of `ort.min.js`).
- Source: https://github.com/microsoft/onnxruntime · npm package `onnxruntime-web@1.17.3`
- Used to run the cutout model in the browser. If the local files are missing, the page falls back to loading the same version from the jsDelivr CDN.

## U²-Net-P model — `models/u2netp.onnx`
- The ONNX export of **U²-Net-P** distributed with the rembg project (release `v0.0.0`): https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx
- Verified identical to that release: size 4,574,861 bytes · MD5 `8e83ca70e441ab06c318d82300c84806` (the checksum pinned in rembg's source) · SHA-256 `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8` (matches the Hugging Face mirror listings).
- Model: Qin et al., "U²-Net: Going Deeper with Nested U-Structure for Salient Object Detection", Pattern Recognition 2020. Code and weights are released under the **Apache License 2.0**: https://github.com/xuebinqin/U-2-Net
- rembg itself is MIT-licensed (https://github.com/danielgatis/rembg); it is only the download source here, no rembg code is included.

## Images in `assets/`
- `sample.jpg` — AI-generated sample photo (a red classic coupe on a studio background), generated for this project. Check the terms of the image generator you used before redistributing.
- `avatar.png` — the project author's X profile picture, used only in the post preview. **Replace it (and `PROFILE` in `src/config.js`) with your own before reusing this project.**

## Demo GIFs
- `demo-zh.gif`, `demo-en.gif` — screen renders of this app using `assets/sample.jpg` and the author's account in the preview.
