import React from "react";
import ReactDOM from "react-dom/client";
import GalleryPage from "./pages/gallery";
import "./globals.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GalleryPage />
  </React.StrictMode>,
);
