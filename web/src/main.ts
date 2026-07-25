import "./app.css";
import { mount } from "svelte";
import { initTheme } from "agentic-ui-kit/theme.svelte.js";
import { loadAndApplyCustomization } from "$lib/customization";
import App from "./App.svelte";

initTheme();
void loadAndApplyCustomization().catch(() => {});

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
