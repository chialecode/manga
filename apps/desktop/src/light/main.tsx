import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LightApp } from "./light-app.tsx";
import "../renderer/styles.css";
import "./light.css";

// Light open follows the system's light or dark setting (Q-39 item 9); it has no theme setting of its own.
const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => { document.documentElement.dataset.theme = scheme.matches ? "dark" : "light"; };
applyScheme();
scheme.addEventListener("change", applyScheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LightApp />
  </StrictMode>,
);
