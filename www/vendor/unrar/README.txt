node-unrar-js 2.0.2 (MIT), bundled into one file with esbuild, plus unrar.wasm:
the official RARLAB unRAR source compiled to WebAssembly (freeware, see LICENSE-unrar.txt).
Used only to unpack .cbr comics on the device; Quire never creates RAR files.

Quire patches: the two places that built code from strings are rewritten as plain closures, so the
app's Content-Security-Policy can keep forbidding eval: Emscripten's createNamedFunction (it only
names a wrapper function) and embind's craftInvokerFunction (the same steps, without eval).
The WebAssembly itself needs 'wasm-unsafe-eval', which allows compiling WebAssembly and nothing else.
