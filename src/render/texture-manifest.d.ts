declare module 'virtual:fury-textures' {
  const manifest: {
    maps: Record<
      string,
      { url: string; sha256: string; width: number; height: number; encodedBytes: number }
    >
  }
  export default manifest
}
