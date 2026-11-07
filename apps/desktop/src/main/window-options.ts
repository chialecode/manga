/** Electron-free window contract so tests can check the shell without starting Electron. */
export const productWindow = {
  width: 1280,
  height: 840,
  minWidth: 360,
  minHeight: 360,
  backgroundColor: "#F3F4F7",
  titleBarStyle: "hidden" as const,
  titleBarOverlay: {
    color: "#F3F4F7",
    symbolColor: "#303647",
    height: 36,
  },
  /** The window background and the caption buttons use the app's own page colors (`--color-bg`, `--color-text` in styles.css); a test keeps them equal. */
  /** Windows caption buttons stay outside the drag region. */
  captionReservePx: 138,
};
