import "./styles.css";
import { bootstrapApp } from "./appBootstrap";
import { applyUiMotion, readUiMotion } from "./ui/motionPreference";
import { installMenuEdgeFades } from "./ui/scrollEdgeFade";

// Before the first paint, so a reduced-motion user never sees full animations.
applyUiMotion(readUiMotion());

const root = document.getElementById("root");
if (root) {
  void bootstrapApp(root);
  // Scrolling menus fade the edge that still hides content (global menu rule).
  installMenuEdgeFades(root);
}
