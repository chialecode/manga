/** Electron-free window contract so tests can check the shell without starting Electron. */
export const productWindow = {
  width: 1280,
  height: 840,
  minWidth: 360,
  minHeight: 360,
  backgroundColor: "#FBFAFC",
  titleBarStyle: "hidden" as const,
  titleBarOverlay: {
    color: "#FBFAFC",
    symbolColor: "#29232F",
    height: 36,
  },
  /** Windows caption buttons stay outside the drag region. */
  captionReservePx: 138,
};
