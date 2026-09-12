import "./styles.css";
import { bootstrapApp } from "./appBootstrap";

const root = document.getElementById("root");
if (root) {
  void bootstrapApp(root);
}
