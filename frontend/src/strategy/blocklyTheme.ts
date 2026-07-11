import * as Blockly from "blockly/core";

const fontStyle = {
  family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  weight: "500",
  size: 11
};

export const forgeDark = Blockly.Theme.defineTheme("forge-dark", {
  name: "forge-dark",
  base: Blockly.Themes.Classic,
  componentStyles: {
    workspaceBackgroundColour: "#0e1116",
    toolboxBackgroundColour: "#10141a",
    toolboxForegroundColour: "#9aa7b3",
    flyoutBackgroundColour: "#151a21",
    flyoutForegroundColour: "#9aa7b3",
    flyoutOpacity: 0.97,
    scrollbarColour: "#222933",
    scrollbarOpacity: 0.45,
    insertionMarkerColour: "#4db6ff",
    insertionMarkerOpacity: 0.35,
    cursorColour: "#4db6ff"
  },
  fontStyle
});

export const forgeLight = Blockly.Theme.defineTheme("forge-light", {
  name: "forge-light",
  base: Blockly.Themes.Classic,
  componentStyles: {
    workspaceBackgroundColour: "#f7f9fb",
    toolboxBackgroundColour: "#ffffff",
    toolboxForegroundColour: "#5f6d7a",
    flyoutBackgroundColour: "#eef1f5",
    flyoutForegroundColour: "#5f6d7a",
    flyoutOpacity: 0.97,
    scrollbarColour: "#c9d2db",
    scrollbarOpacity: 0.55,
    insertionMarkerColour: "#1273c4",
    insertionMarkerOpacity: 0.35,
    cursorColour: "#1273c4"
  },
  fontStyle
});
