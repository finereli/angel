declare module '*.wasm' {
  const module: WebAssembly.Module
  export default module
}

declare module '@jitl/quickjs-wasmfile-release-asyncify/wasm' {
  const module: WebAssembly.Module
  export default module
}
