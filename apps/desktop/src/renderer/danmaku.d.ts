// The canvas build of the danmaku engine is a plain module without its own types; it has the same interface as the package's main entry.
declare module "danmaku/dist/esm/danmaku.canvas.js" {
  import Danmaku from "danmaku";
  export default Danmaku;
}
