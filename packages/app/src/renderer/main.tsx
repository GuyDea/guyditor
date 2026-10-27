import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";
import "./assemble.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Renderer root element is missing.");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
